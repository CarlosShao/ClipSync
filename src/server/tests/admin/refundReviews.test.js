/**
 * Admin Console · 退款审核路由错误壳单测（routes/admin/refundReviews.js）
 *
 * 重点锁 H3 的冷却分支：approve 打在卡住的 processing 单上、且距上次认领不足 2 分钟时，
 * 服务层抛 REFUND_REQUEST_PROCESSING。该错误此前会落到 refundErrorToAdmin 的默认分支
 * → **HTTP 409 却带 code=5000**「退款执行失败」，管理台会把「稍后再点」误读成「打款失败」。
 * 这里断言它现在有显式 40904 数字码 + 稳定中文文案，并保留 extra
 * （status / orderNo / retryAfterSeconds，前端用它拼「请等待约 N 秒」）。
 *
 * 全离线：vi.mock db/pool + middleware/auth + services/refund + services/refundRequest。
 * 服务层的真实语义（查单、释放重试、渠道幂等）在 tests/refund-request.test.js（真库）里锁。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/pool.js', () => {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return { pool, default: pool };
});

const authState = vi.hoisted(() => ({ user: null }));

vi.mock('../../src/middleware/auth.js', () => ({
  authenticateToken: vi.fn((req, _res, next) => {
    if (authState.user) {
      req.user = { ...authState.user };
      req.userId = authState.user.userId;
    }
    next();
  }),
  optionalAuth: vi.fn((req, _res, next) => next()),
}));

// RefundError 必须是**同一个类**：路由里的 `err instanceof RefundError` 来自 services/refund.js
vi.mock('../../src/services/refund.js', () => {
  class RefundError extends Error {
    constructor(status, code, message, extra = {}) {
      super(message);
      this.name = 'RefundError';
      this.status = status;
      this.code = code;
      this.extra = extra;
    }
  }
  return {
    RefundError,
    refundPaidOrder: vi.fn(async () => {
      throw new Error('refundPaidOrder 桩未设置');
    }),
    default: { RefundError },
  };
});

const reviewState = vi.hoisted(() => ({ approve: null, reject: null, list: null }));

vi.mock('../../src/services/refundRequest.js', () => ({
  approveRefundRequest: vi.fn(async (arg) => reviewState.approve(arg)),
  rejectRefundRequest: vi.fn(async (arg) => reviewState.reject(arg)),
  listRefundRequestsForAdmin: vi.fn(async (arg) => reviewState.list(arg)),
}));

import express from 'express';
import request from 'supertest';
import { pool } from '../../src/db/pool.js';
import { clearPermCache } from '../../src/middleware/adminAuth.js';
import { RefundError } from '../../src/services/refund.js';
import adminRouter from '../../src/routes/admin/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

beforeEach(() => {
  clearPermCache();
  pool.query.mockReset();
  // 权限放行：requirePerm 按 perm_key 查询，返回一行即视为有权限
  pool.query.mockImplementation(async (sql) =>
    sql.includes('perm_key') ? { rows: [{ perm_key: 'ok' }], rowCount: 1 } : { rows: [], rowCount: 0 }
  );
  reviewState.approve = null;
  reviewState.reject = null;
  reviewState.list = null;
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

describe('POST /api/admin/refund-reviews/:id/approve —— 错误壳分流', () => {
  it('REFUND_REQUEST_PROCESSING（2 分钟冷却）→ 409 + code 40904 + 保留 retryAfterSeconds', async () => {
    reviewState.approve = async () => {
      throw new RefundError(
        409,
        'REFUND_REQUEST_PROCESSING',
        'Refund request is still being processed by another attempt, please retry shortly',
        { status: 'processing', orderNo: 'ORD-X', retryAfterSeconds: 42 }
      );
    };

    const res = await request(buildApp()).post('/api/admin/refund-reviews/r-1/approve').send({});

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 40904,
      message: '该申请正在处理中，请稍后重试',
      refundCode: 'REFUND_REQUEST_PROCESSING',
      status: 'processing',
      orderNo: 'ORD-X',
      retryAfterSeconds: 42,
    });
    // 关键回归点：绝不能落到默认的 5000（HTTP 409 却报「退款执行失败」）
    expect(res.body.code).not.toBe(5000);
  });

  it('REFUND_REQUEST_NOT_PENDING → 40903（显式分支不回退）', async () => {
    reviewState.approve = async () => {
      throw new RefundError(409, 'REFUND_REQUEST_NOT_PENDING', 'already handled', {
        status: 'approved',
        orderNo: 'ORD-Y',
      });
    };

    const res = await request(buildApp()).post('/api/admin/refund-reviews/r-2/approve').send({});

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 40903, message: '该申请已处理，不能重复操作' });
  });

  it('REFUND_REQUEST_NOT_FOUND → 404 40404（申请单自身错误先于渠道错误分流）', async () => {
    reviewState.approve = async () => {
      throw new RefundError(404, 'REFUND_REQUEST_NOT_FOUND', 'not found');
    };

    const res = await request(buildApp()).post('/api/admin/refund-reviews/r-3/approve').send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 40404, message: '退款申请不存在' });
  });

  it('渠道类错误仍走 refundErrorToAdmin 映射表（同一错误在两页说同一句话）', async () => {
    reviewState.approve = async () => {
      throw new RefundError(502, 'REFUND_CHANNEL_FAILED', 'channel failed');
    };

    const res = await request(buildApp()).post('/api/admin/refund-reviews/r-4/approve').send({});

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      code: 5020,
      message: '渠道退款失败，订单保持已支付（资金未退回）',
      refundCode: 'REFUND_CHANNEL_FAILED',
    });
  });
});
