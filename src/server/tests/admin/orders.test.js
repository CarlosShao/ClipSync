/**
 * Admin Console 订单/退款/对账 APIs 单测（Admin Console · T-A3）
 *
 * 覆盖（routes/admin/orders.js 挂载在 /api/admin 后的完整中间件链）：
 *  - GET  /orders        分页壳 { list, total, page, pageSize } + 行字段映射（Order 契约）
 *  - GET  /orders?status=refunding 伪状态口径（refunded 且 metadata 无 refund_amount）
 *  - GET  /orders/:orderNo 详情与 404
 *  - POST /orders/:orderNo/refund —— §4-A1 改造后本路由是**薄壳**：
 *      权限/原因/部分退款闸在前，资金动作全部委托 services/refund.js#refundPaidOrder
 *      （本文件用 vi.mock 把它换成可编程的桩，只验接线与错误壳映射）；
 *      真实退款的资金不变量在 tests/payment-refund.test.js 与
 *      tests/refund-service.test.js（真库）里锁。
 *  - GET  /reconciliation 三渠道对账行（含空渠道补 0）+ 未识别渠道行（§4-A4）
 *  - 无权限 403
 *
 * 全离线：vi.mock db/pool + middleware/auth + services/refund，
 * pool.query 以 SQL 片段特征分发 mock 结果（与 adminRoutes.test.js 同风格）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/pool.js', () => {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return { pool, default: pool };
});

// 用例间通过该对象切换 authenticateToken 注入的身份（vi.hoisted 保证提升可见）
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

// 退款服务薄壳化：路由只负责「权限 + 入参闸 + 错误壳映射 + 管理动作审计」，
// 打款/落库由 services/refund.js 承担 —— 真实实现在真库测试里跑。
// RefundError 必须是**同一个类**，否则路由里的 `err instanceof RefundError` 失效。
const refundState = vi.hoisted(() => ({ impl: null }));

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
  const refundPaidOrder = vi.fn(async (arg) => {
    if (refundState.impl) return refundState.impl(arg);
    throw new Error('refundPaidOrder 桩未设置');
  });
  return { RefundError, refundPaidOrder, default: { RefundError, refundPaidOrder } };
});

import express from 'express';
import request from 'supertest';
import { pool } from '../../src/db/pool.js';
import { clearPermCache } from '../../src/middleware/adminAuth.js';
import { refundPaidOrder } from '../../src/services/refund.js';
import adminRouter from '../../src/routes/admin/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  refundPaidOrder.mockClear();
  refundState.impl = null;
  // 默认身份：super_admin（退款/对账权限用例的基准身份）
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

// ── 夹具：ORDER_SELECT 输出形态的订单行 ──
function makeOrderRow(overrides = {}) {
  return {
    id: '0b6f2c1e-1111-4aaa-9bbb-000000000001',
    subscription_id: 'a1b2c3d4-1111-4aaa-9bbb-00000000aaaa',
    order_no: 'CS20260905204188',
    out_trade_no: '42000023452026090588',
    transaction_id: '42000023452026090588',
    user_id: '11111111-1111-4111-8111-111111111111',
    amount: '99.00',
    currency: 'CNY',
    status: 'paid',
    created_at: new Date('2026-09-05T12:41:00Z'),
    paid_at: new Date('2026-09-05T12:42:00Z'),
    channel: 'wechat',
    refund_amount: null,
    user_nickname: '林小明',
    user_phone: '13812342765',
    plan_display_name: '专业版',
    plan_name: 'Pro',
    billing_cycle: 'yearly',
    ...overrides,
  };
}

describe('GET /api/admin/orders —— 订单分页列表', () => {
  it('返回分页壳 { list, total, page, pageSize }，行字段符合 Order 契约', async () => {
    pool.query.mockImplementation(async (sql) => {
      // RB-06：GET 读侧也走 requirePerm('admin.orders.view')，先放行权限查询
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.orders.view' }], rowCount: 1 };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 3 }], rowCount: 1 };
      if (sql.includes('FROM payment_orders po')) {
        return { rows: [makeOrderRow(), makeOrderRow({ order_no: 'CS20260905184402' })], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/orders?page=2&pageSize=10');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.page).toBe(2);
    expect(res.body.data.pageSize).toBe(10);
    expect(res.body.data.list).toHaveLength(2);

    const order = res.body.data.list[0];
    expect(order).toMatchObject({
      orderNo: 'CS20260905204188',
      outTradeNo: '42000023452026090588',
      userId: '11111111-1111-4111-8111-111111111111',
      userLabel: '林小明',
      planLabel: '专业版 · 年付',
      channel: 'wechat',
      currency: 'CNY',
      amount: 99,
      refundAmount: null,
      status: 'paid',
    });

    // 分页参数：LIMIT/OFFSET 追加在筛选参数之后（page=2 → offset=10）
    const [lastSql, lastParams] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(lastSql).toContain('ORDER BY po.created_at DESC');
    expect(lastParams.slice(-2)).toEqual([10, 10]);
  });

  it('status=refunding 伪状态：过滤口径为 refunded 且 metadata 无 refund_amount', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.orders.view' }], rowCount: 1 };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      if (sql.includes('FROM payment_orders po')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/orders?status=refunding');

    expect(res.status).toBe(200);
    const [listSql] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(listSql).toContain("po.status = 'refunded'");
    expect(listSql).toContain("po.metadata->>'refund_amount' IS NULL");
  });

  it('status=refunded 过滤口径为 refunded 且 metadata 有 refund_amount；status=paid 走参数化等值', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.orders.view' }], rowCount: 1 };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      if (sql.includes('FROM payment_orders po')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    await request(buildApp()).get('/api/admin/orders?status=refunded');
    const [refundedSql] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(refundedSql).toContain("po.metadata->>'refund_amount' IS NOT NULL");

    pool.query.mockClear();
    await request(buildApp()).get('/api/admin/orders?status=paid');
    const [paidSql, paidParams] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(paidSql).toContain('po.status = $1');
    expect(paidParams[0]).toBe('paid');
  });

  it('非法筛选参数返回 400 { code: 4000 }', async () => {
    // RB-06：读侧 requirePerm 需先放行（参数校验在路由 handler 内）
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.orders.view' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/orders?status=bogus');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);

    const res2 = await request(buildApp()).get('/api/admin/orders?channel=paypal');
    expect(res2.status).toBe(400);
    expect(res2.body.code).toBe(4000);

    const res3 = await request(buildApp()).get('/api/admin/orders?dateFrom=not-a-date');
    expect(res3.status).toBe(400);
    expect(res3.body.code).toBe(4000);
    // 权限查询之外不得有任何订单查询（参数校验先于 DB）
    expect(pool.query.mock.calls.some(([sql]) => !sql.includes('perm_key'))).toBe(false);
  });

  it('q 关键字匹配订单号/商户单号/第三方流水号（ILIKE）', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.orders.view' }], rowCount: 1 };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      if (sql.includes('FROM payment_orders po')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    await request(buildApp()).get('/api/admin/orders?q=CS2026');

    const [sql, params] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).toContain('po.order_no ILIKE $1');
    expect(sql).toContain('po.out_trade_no ILIKE $1');
    expect(sql).toContain('po.transaction_id ILIKE $1');
    expect(params[0]).toBe('%CS2026%');
  });
});

describe('GET /api/admin/orders/:orderNo —— 订单详情', () => {
  it('命中订单返回 Order 全字段', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.orders.view' }], rowCount: 1 };
      if (sql.includes('FROM payment_orders po')) return { rows: [makeOrderRow()], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/orders/CS20260905204188');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.orderNo).toBe('CS20260905204188');
    expect(res.body.data.paidAt).toBe('2026-09-05T12:42:00.000Z');
  });

  it('订单不存在返回 404 { code: 40404 }', async () => {
    // RB-06：读侧 requirePerm 先放行，DB 空行 → 404
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.orders.view' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/orders/CS99999999999999');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 40404, message: '订单不存在' });
  });
});

describe('POST /api/admin/orders/:orderNo/refund —— 退款（§4-A1 薄壳）', () => {
  const REFUND_BODY = { amount: 99, reason: '用户重复支付' };

  /** 服务层成功返回值（与 services/refund.js 的实现同形状） */
  function serviceResult(orderRow, refundAmount = 99) {
    return {
      ok: true,
      order: {
        id: orderRow.id,
        orderNo: orderRow.order_no,
        amount: Number(orderRow.amount),
        refundAmount,
        currency: orderRow.currency,
        status: 'refunded',
        refundedAt: '2026-09-19T10:00:00.000Z',
      },
      entitlement: { subscriptionId: orderRow.subscription_id, subscriptionCanceled: true },
      channel: {
        name: 'alipay',
        fund_status: 'Y',
        trade_no: '202609192200000000',
        out_request_no: orderRow.order_no,
      },
    };
  }

  /**
   * 桩：权限放行 + 订单定位 + 审计写入 + 退款后回读。
   * 第 1 次 ORDER_SELECT 返回原始（paid）行，第 2 次（退款后回读）返回 refunded 行。
   */
  function mockRefundFlow(orderRow, captured, { found = true } = {}) {
    let selects = 0;
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key')) {
        return { rows: [{ perm_key: 'admin.orders.refund' }], rowCount: 1 };
      }
      if (sql.includes('FROM payment_orders po') && sql.includes('WHERE po.order_no = $1')) {
        selects += 1;
        if (!found) return { rows: [], rowCount: 0 };
        if (selects === 1) return { rows: [orderRow], rowCount: 1 };
        return {
          rows: [{ ...orderRow, status: 'refunded', refund_amount: '99.00' }],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        // 注意：superAdminAudit 中间件也会写一条 action='super_admin_action' 的行，
        // 因此这里收集全部审计写入，断言时按 action 精挑。
        captured.audits = (captured.audits || []).concat([{ sql, params }]);
        return { rows: [], rowCount: 1 };
      }
      // 真实退款服务已被 vi.mock 接管；这里若被调用说明路由绕过了服务
      if (sql.includes('UPDATE payment_orders') || sql.includes('UPDATE user_subscriptions')) {
        captured.illegalDirectWrite = sql;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  /** 从全部审计写入里挑出本路由自己写的管理动作行（superAdminAudit 也会写一行） */
  function adminRefundAudit(captured) {
    return (captured.audits || []).find((a) => a.params[1] === 'admin.orders.refund');
  }

  it('委托 refundPaidOrder：全额退款成功，响应仍是 Order 契约（回读映射）', async () => {
    const captured = {};
    const orderRow = makeOrderRow();
    mockRefundFlow(orderRow, captured);
    refundState.impl = async () => serviceResult(orderRow);

    const res = await request(buildApp())
      .post('/api/admin/orders/CS20260905204188/refund')
      .send(REFUND_BODY);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({
      orderNo: 'CS20260905204188',
      status: 'refunded',
      refundAmount: 99,
    });

    // 只把「谁授权、为什么退、从哪来」交给服务；不带 amount（服务一律全额）
    expect(refundPaidOrder).toHaveBeenCalledTimes(1);
    expect(refundPaidOrder.mock.calls[0][0]).toMatchObject({
      orderNo: 'CS20260905204188',
      actorUserId: 'u-super',
      reason: '用户重复支付',
    });
    expect(refundPaidOrder.mock.calls[0][0]).not.toHaveProperty('amount');

    // 路由不得再自己改订单/订阅（假退款实现的痕迹必须清零）
    expect(captured.illegalDirectWrite).toBeUndefined();

    // 管理动作审计（资金审计 payment_refund 由服务写，两者并存）
    const audit = adminRefundAudit(captured);
    expect(audit).toBeTruthy();
    expect(audit.params[0]).toBe('u-super');
    expect(audit.params[2]).toBe('payment_order');
    const details = JSON.parse(audit.params[4]);
    expect(details).toMatchObject({
      orderNo: 'CS20260905204188',
      amount: 99,
      reason: '用户重复支付',
      channel: 'alipay',
      fund_status: 'Y',
      subscriptionCanceled: true,
    });
  });

  it('amount 缺省 = 全额放行；amount 等于订单全额（含 99 与 99.00）同样放行', async () => {
    const captured = {};
    const orderRow = makeOrderRow(); // amount '99.00'
    mockRefundFlow(orderRow, captured);
    refundState.impl = async () => serviceResult(orderRow);

    expect(
      (await request(buildApp()).post('/api/admin/orders/CS20260905204188/refund').send({ reason: 'a' }))
        .status
    ).toBe(200);
    expect(
      (await request(buildApp())
        .post('/api/admin/orders/CS20260905204188/refund')
        .send({ amount: '99.00', reason: 'a' })).status
    ).toBe(200);
    expect(refundPaidOrder).toHaveBeenCalledTimes(2);
  });

  it('部分退款一律 400 PARTIAL_REFUND_NOT_SUPPORTED，且不碰服务（§4-A1 本期不支持部分退款）', async () => {
    const captured = {};
    mockRefundFlow(makeOrderRow(), captured);
    refundState.impl = async () => {
      throw new Error('不应被调用');
    };

    for (const bad of [9.9, 50, 100, 'abc', 0]) {
      const res = await request(buildApp())
        .post('/api/admin/orders/CS20260905204188/refund')
        .send({ amount: bad, reason: '协商部分退款' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(4000);
      expect(res.body.error_code).toBe('PARTIAL_REFUND_NOT_SUPPORTED');
      expect(res.body.orderAmount).toBe(99);
    }
    expect(refundPaidOrder).not.toHaveBeenCalled();
    expect(adminRefundAudit(captured)).toBeUndefined();
  });

  it('月付订单全额退款同样走真实退款（旧「年付才收回权益」口径已废）', async () => {
    const captured = {};
    const orderRow = makeOrderRow({ billing_cycle: 'monthly', amount: '9.90' });
    mockRefundFlow(orderRow, captured);
    refundState.impl = async () => serviceResult(orderRow, 9.9);

    const res = await request(buildApp())
      .post('/api/admin/orders/CS20260905204188/refund')
      .send({ reason: '月付误购' });

    expect(res.status).toBe(200);
    expect(refundPaidOrder).toHaveBeenCalledTimes(1);
  });

  it('服务抛 ORDER_NOT_REFUNDABLE → 400 { code: 40005 }，不写管理审计', async () => {
    const captured = {};
    mockRefundFlow(makeOrderRow({ status: 'pending' }), captured);
    const { RefundError } = await import('../../src/services/refund.js');
    refundState.impl = async () => {
      throw new RefundError(400, 'ORDER_NOT_REFUNDABLE', 'Order is not paid, cannot refund', {
        orderNo: 'CS20260905204188',
        status: 'pending',
      });
    };

    const res = await request(buildApp())
      .post('/api/admin/orders/CS20260905204188/refund')
      .send({ reason: '未支付就想退' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 40005, refundCode: 'ORDER_NOT_REFUNDABLE' });
    expect(adminRefundAudit(captured)).toBeUndefined();
  });

  it('服务抛 REFUND_CHANNEL_FAILED → 502 + 中文 message + channelError（钱没退就不显示已退款）', async () => {
    const captured = {};
    mockRefundFlow(makeOrderRow(), captured);
    const { RefundError } = await import('../../src/services/refund.js');
    refundState.impl = async () => {
      throw new RefundError(502, 'REFUND_CHANNEL_FAILED', 'Refund failed at payment channel', {
        orderNo: 'CS20260905204188',
        channelError: { code: '40004', subCode: 'REFUND_AMOUNT_EXCEED', message: 'x' },
      });
    };

    const res = await request(buildApp())
      .post('/api/admin/orders/CS20260905204188/refund')
      .send({ reason: '渠道失败' });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe(5020);
    expect(res.body.message).toContain('订单保持已支付');
    expect(res.body.channelError).toMatchObject({ code: '40004' });
    expect(adminRefundAudit(captured)).toBeUndefined();
  });

  it('服务抛 ALREADY_REFUNDED → 409 { code: 40901 }', async () => {
    const captured = {};
    mockRefundFlow(makeOrderRow({ status: 'refunded' }), captured);
    const { RefundError } = await import('../../src/services/refund.js');
    refundState.impl = async () => {
      throw new RefundError(409, 'ALREADY_REFUNDED', 'Order already refunded', {
        orderNo: 'CS20260905204188',
      });
    };

    const res = await request(buildApp())
      .post('/api/admin/orders/CS20260905204188/refund')
      .send({ reason: '重复点' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40901);
  });

  it('非支付宝渠道：订单定位后由服务抛 REFUND_CHANNEL_UNSUPPORTED → 400 { code: 40006 }', async () => {
    const captured = {};
    mockRefundFlow(makeOrderRow(), captured);
    const { RefundError } = await import('../../src/services/refund.js');
    refundState.impl = async () => {
      throw new RefundError(400, 'REFUND_CHANNEL_UNSUPPORTED', 'Channel mock cannot be refunded online', {
        orderNo: 'CS20260905204188',
        channel: 'mock',
      });
    };

    const res = await request(buildApp())
      .post('/api/admin/orders/CS20260905204188/refund')
      .send({ reason: 'mock 单' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40006);
    expect(res.body.refundCode).toBe('REFUND_CHANNEL_UNSUPPORTED');
  });

  it('缺退款原因返回 400 { code: 4000 }，不调服务', async () => {
    const captured = {};
    mockRefundFlow(makeOrderRow(), captured);

    const res = await request(buildApp())
      .post('/api/admin/orders/CS20260905204188/refund')
      .send({ amount: 99, reason: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
    expect(refundPaidOrder).not.toHaveBeenCalled();
  });

  it('订单不存在返回 404 { code: 40404 }，不调服务', async () => {
    mockRefundFlow(makeOrderRow(), {}, { found: false });

    const res = await request(buildApp())
      .post('/api/admin/orders/CS99999999999999/refund')
      .send({ reason: '不存在' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 40404, message: '订单不存在' });
    expect(refundPaidOrder).not.toHaveBeenCalled();
  });

  it('无 admin.orders.refund 权限返回 403 { code: 4030 }，不执行退款', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [], rowCount: 0 }; // 权限点未授予
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp())
      .post('/api/admin/orders/CS20260905204188/refund')
      .send(REFUND_BODY);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.orders.refund' });
    expect(refundPaidOrder).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/reconciliation —— 对账报告', () => {
  it('返回固定三渠道行（无数据渠道补 0）与近 30 天口径；未识别渠道不混入微信', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.orders.reconcile' }], rowCount: 1 };
      if (sql.includes('GROUP BY 1')) {
        return {
          rows: [{ channel: 'alipay', paid_count: 86, paid_amount: 28410, refund_amount: 119.6 }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/reconciliation');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(typeof res.body.data.generatedAt).toBe('string');
    expect(res.body.data.rows).toHaveLength(3);
    expect(res.body.data.rows[1]).toEqual({
      channel: 'alipay',
      label: '支付宝',
      paidCount: 86,
      paidAmount: 28410,
      refundAmount: 119.6,
    });
    expect(res.body.data.rows[0]).toMatchObject({ channel: 'wechat', label: '微信支付', paidCount: 0 });
    expect(res.body.data.rows[2]).toMatchObject({ channel: 'stripe', label: 'Stripe', paidCount: 0 });

    const [aggSql] = pool.query.mock.calls.find(([s]) => s.includes('GROUP BY 1'));
    expect(aggSql).toContain("INTERVAL '30 days'");
    expect(aggSql).toContain("po.status IN ('paid', 'refunded')");
    // §4-A4：认不出的渠道归 unknown，绝不再兜底成 wechat
    expect(aggSql).toContain("ELSE 'unknown'");
    expect(aggSql).not.toContain("ELSE 'wechat'");
  });

  it('存在未识别渠道订单时追加第 4 行（合计不得静默少钱，§4-A4）', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.orders.reconcile' }], rowCount: 1 };
      if (sql.includes('GROUP BY 1')) {
        return {
          rows: [
            { channel: 'alipay', paid_count: 3, paid_amount: 30, refund_amount: 0 },
            { channel: 'unknown', paid_count: 2, paid_amount: 20, refund_amount: 5 },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/reconciliation');
    const rows = res.body.data.rows;
    expect(rows).toHaveLength(4);
    expect(rows[3]).toEqual({
      channel: 'unknown',
      label: '未识别渠道（mock/历史单）',
      paidCount: 2,
      paidAmount: 20,
      refundAmount: 5,
    });
  });

  it('无 admin.orders.reconcile 权限返回 403 { code: 4030 }', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/reconciliation');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.orders.reconcile' });
  });
});
