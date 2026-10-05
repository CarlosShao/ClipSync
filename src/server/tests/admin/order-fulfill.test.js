/**
 * 人工补履约单测（POST /api/admin/orders/:orderNo/fulfill，2026-10-05 新增）
 *
 * 这个端点补的是「渠道回调丢了 ⇒ 用户付了钱、订单还是 pending」这个洞。它触碰资金，
 * 所以最该钉死的**不是**"能不能履约成功"，而是**拒绝的边界**：
 *
 *   ① ★渠道说没付款 ⇒ 一律拒，且**绝不调用 markOrderPaid**（不能凭管理员一句话凭空发货）；
 *   ② ★渠道调用失败 / 渠道没回金额 ⇒ 一律拒（fail-closed，核实不了就不发）；
 *   ③ ★金额闸不能被绕过：必须把**渠道回的 total_amount** 作为 expectedAmount 传下去
 *      （否则"渠道金额与订单不符"这一层就白设了）；
 *   ④ 已关闭/失败的单**不补履约**（服务里就写着"需人工介入退款"，那条口径已有，别另立）；
 *   ⑤ 非支付宝渠道（mock/历史单）不查渠道、不履约。
 *
 * 全离线：pool 与 queryTrade / markOrderPaid 都被 mock，只验**路由的编排与闸门**。
 *（markOrderPaid 自身的幂等/金额/事务不变量由它自己的用例覆盖。）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/pool.js', () => {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return { pool, default: pool };
});

const authState = vi.hoisted(() => ({ user: null }));
const mocks = vi.hoisted(() => ({
  queryTrade: vi.fn(),
  markOrderPaid: vi.fn(),
}));

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

// 只替换这两个函数，其余实现保持真实（避免影响 refund.js 等对同模块的其它 import）
// 注：本文件是 .js，不能用 importOriginal<T>() 的泛型写法
vi.mock('../../src/utils/alipay.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, queryTrade: mocks.queryTrade };
});
vi.mock('../../src/services/orderFulfillment.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, markOrderPaid: mocks.markOrderPaid };
});

import express from 'express';
import request from 'supertest';
import { pool } from '../../src/db/pool.js';
import { clearPermCache } from '../../src/middleware/adminAuth.js';
import adminRouter from '../../src/routes/admin/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

const ORDER_NO = 'ORD1791168406074pxsh8y';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  mocks.queryTrade.mockReset();
  mocks.markOrderPaid.mockReset();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

/** 造一条订单行（ORDER_SELECT 的字段子集，够本路由用） */
function mockOrder({ status = 'pending', channel = 'alipay', amount = 19.89 } = {}) {
  const orderRow = { id: 'order-1', order_no: ORDER_NO, user_id: 'u-1', amount, status, channel };
  pool.query.mockImplementation(async (sql, params) => {
    if (sql.includes('perm_key')) {
      const requested = params?.[1];
      return requested === 'admin.orders.refund'
        ? { rows: [{ perm_key: requested }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM payment_orders po') && sql.includes('WHERE po.order_no = $1')) {
      return { rows: [orderRow], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return orderRow;
}

function findAuditCall(action) {
  return pool.query.mock.calls.find(([sql, params]) => {
    return sql.includes('INSERT INTO audit_logs') && params[1] === action;
  });
}

const fulfill = (body, orderNo = ORDER_NO) =>
  request(buildApp()).post(`/api/admin/orders/${orderNo}/fulfill`).send(body);

describe('补履约 · ★渠道未确认到账一律拒（不能凭空发货）', () => {
  it('★渠道说未支付（WAIT_BUYER_PAY）→ 409，且**绝不调用 markOrderPaid**', async () => {
    mockOrder();
    mocks.queryTrade.mockResolvedValue({ paid: false, tradeStatus: 'WAIT_BUYER_PAY', tradeNo: null, raw: {} });

    const res = await fulfill({ reason: '用户说付了' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('CHANNEL_NOT_PAID');
    expect(res.body.channelTradeStatus).toBe('WAIT_BUYER_PAY');
    // 核心反例：一个履约动作都不能发生
    expect(mocks.markOrderPaid).not.toHaveBeenCalled();
  });

  it('★渠道查询失败（未配置/网络）→ 503，且不履约', async () => {
    mockOrder();
    mocks.queryTrade.mockRejectedValue(new Error('ALIPAY_NOT_CONFIGURED'));

    const res = await fulfill({ reason: '核实' });

    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('CHANNEL_QUERY_FAILED');
    expect(mocks.markOrderPaid).not.toHaveBeenCalled();
  });

  it('★渠道已支付但**没回金额** → 409，且不履约（fail-closed：无从核对就不发）', async () => {
    mockOrder();
    mocks.queryTrade.mockResolvedValue({
      paid: true,
      tradeStatus: 'TRADE_SUCCESS',
      tradeNo: 'ali-1',
      raw: { trade_status: 'TRADE_SUCCESS' },
    });

    const res = await fulfill({ reason: '核实' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('CHANNEL_AMOUNT_MISSING');
    expect(mocks.markOrderPaid).not.toHaveBeenCalled();
  });
});

describe('补履约 · ★核实通过后按真实口径履约', () => {
  it('★把渠道回的 total_amount 作为 expectedAmount 传下去（金额闸不能被绕过）', async () => {
    const order = mockOrder({ amount: 19.89 });
    mocks.queryTrade.mockResolvedValue({
      paid: true,
      tradeStatus: 'TRADE_SUCCESS',
      tradeNo: 'ali-20261005',
      raw: { trade_status: 'TRADE_SUCCESS', total_amount: '19.89' },
    });
    mocks.markOrderPaid.mockResolvedValue({ ok: true, changed: true, order: { id: order.id } });

    const res = await fulfill({ reason: '回调丢失，人工补' });

    expect(res.status).toBe(200);
    expect(mocks.queryTrade).toHaveBeenCalledWith(ORDER_NO);
    expect(mocks.markOrderPaid).toHaveBeenCalledTimes(1);
    const arg = mocks.markOrderPaid.mock.calls[0][0];
    expect(arg.orderNo).toBe(ORDER_NO);
    expect(arg.channel).toBe('alipay');
    expect(arg.transactionId).toBe('ali-20261005');
    // ★金额闸：必须是渠道侧金额，而不是"订单自己的金额"（那等于自证）
    expect(arg.expectedAmount).toBe('19.89');
    expect(arg.rawPayload.source).toBe('admin_manual_fulfill');

    const audit = findAuditCall('admin.order.manual_fulfill');
    expect(audit).toBeTruthy();
    const payload = audit[1].map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('|');
    expect(payload).toContain('TRADE_SUCCESS');
    expect(payload).toContain('回调丢失');
  });

  it('渠道金额与订单金额不符 → 409 且如实回传（服务端会落 amount_mismatch 留痕）', async () => {
    mockOrder({ amount: 19.89 });
    mocks.queryTrade.mockResolvedValue({
      paid: true,
      tradeStatus: 'TRADE_SUCCESS',
      tradeNo: 'ali-x',
      raw: { total_amount: '0.01' },
    });
    mocks.markOrderPaid.mockResolvedValue({
      ok: false,
      changed: false,
      reason: 'amount_mismatch',
      order: { id: 'order-1' },
    });

    const res = await fulfill({ reason: '核实' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40905);
    expect(res.body.reason).toBe('amount_mismatch');
    expect(res.body.message).toContain('0.01');
  });

  it('并发竞态：markOrderPaid 返回 already_paid → 200 但文案说清不是我做的、且不写补履约审计', async () => {
    mockOrder();
    mocks.queryTrade.mockResolvedValue({
      paid: true,
      tradeStatus: 'TRADE_SUCCESS',
      tradeNo: 'ali-y',
      raw: { total_amount: '19.89' },
    });
    mocks.markOrderPaid.mockResolvedValueOnce({ ok: true, changed: false, reason: 'already_paid' });

    const res = await fulfill({ reason: 'x' });

    // 目标状态已达成 ⇒ 按成功回（与 webhook 把 already_paid 当 success 同口径）
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('渠道回调');
    expect(res.body.message).toContain('无需重复');
    // 但不该留下"管理员补了履约"的审计 —— 货不是这次开的
    expect(findAuditCall('admin.order.manual_fulfill')).toBeUndefined();
  });

  it('并发竞态：markOrderPaid 返回 order_cancelled → 409，不谎报成功', async () => {
    mockOrder();
    mocks.queryTrade.mockResolvedValue({
      paid: true,
      tradeStatus: 'TRADE_SUCCESS',
      tradeNo: 'ali-z',
      raw: { total_amount: '19.89' },
    });
    mocks.markOrderPaid.mockResolvedValueOnce({
      ok: false,
      changed: false,
      reason: 'order_cancelled',
    });

    const res = await fulfill({ reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('退款');
  });
});

describe('补履约 · 不该走的单一律早退（连渠道都不查）', () => {
  it('订单已 paid → 409 且不查渠道', async () => {
    mockOrder({ status: 'paid' });
    const res = await fulfill({ reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('ALREADY_PAID');
    expect(mocks.queryTrade).not.toHaveBeenCalled();
  });

  it('★订单已 cancelled → 409 且不查渠道（既有口径：这种残留单走退款，不发货）', async () => {
    mockOrder({ status: 'cancelled' });
    const res = await fulfill({ reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('ORDER_NOT_PAYABLE');
    expect(res.body.message).toContain('退款');
    expect(mocks.queryTrade).not.toHaveBeenCalled();
    expect(mocks.markOrderPaid).not.toHaveBeenCalled();
  });

  it('订单 failed / refunded → 409', async () => {
    mockOrder({ status: 'failed' });
    expect((await fulfill({ reason: 'x' })).body.reason).toBe('ORDER_NOT_PAYABLE');
    mockOrder({ status: 'refunded' });
    expect((await fulfill({ reason: 'x' })).body.reason).toBe('ALREADY_REFUNDED');
  });

  it('★非支付宝渠道（mock/历史单）→ 409 且不查渠道（核实不了就不发）', async () => {
    mockOrder({ channel: 'unknown' });
    const res = await fulfill({ reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('CHANNEL_UNVERIFIABLE');
    expect(mocks.queryTrade).not.toHaveBeenCalled();
  });
});

describe('补履约 · 入参与权限', () => {
  it('缺原因 → 400；原因超长 → 400；订单不存在 → 404', async () => {
    mockOrder();
    expect((await fulfill({})).status).toBe(400);
    expect((await fulfill({ reason: '  ' })).status).toBe(400);
    expect((await fulfill({ reason: 'x'.repeat(201) })).status).toBe(400);

    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key')) {
        return params?.[1] === 'admin.orders.refund'
          ? { rows: [{ perm_key: params[1] }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    expect((await fulfill({ reason: 'x' })).status).toBe(404);
  });

  it('无 admin.orders.refund 权限 → 403', async () => {
    mockOrder();
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key')) {
        return params?.[1] === 'admin.orders.view'
          ? { rows: [{ perm_key: params[1] }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await fulfill({ reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(4030);
    expect(mocks.markOrderPaid).not.toHaveBeenCalled();
  });
});
