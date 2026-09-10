/**
 * Admin Console 订单/退款/对账 APIs 单测（Admin Console · T-A3）
 *
 * 覆盖（routes/admin/orders.js 挂载在 /api/admin 后的完整中间件链）：
 *  - GET  /orders        分页壳 { list, total, page, pageSize } + 行字段映射（Order 契约）
 *  - GET  /orders?status=refunding 伪状态口径（refunded 且 metadata 无 refund_amount）
 *  - GET  /orders/:orderNo 详情与 404
 *  - POST /orders/:orderNo/refund 退款成功（状态/审计/年付全额退款取消订阅联动）
 *  - 退款金额超限 400 / 非 paid 订单 400 / 缺原因 400 / 无权限 403
 *  - GET  /reconciliation 三渠道对账行（含空渠道补 0）+ 无权限 403
 *
 * 全离线：vi.mock db/pool + middleware/auth（authenticateToken 按用例注入身份），
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

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
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

describe('POST /api/admin/orders/:orderNo/refund —— 退款（高危）', () => {
  const REFUND_BODY = { amount: 99, reason: '用户重复支付' };

  function mockRefundFlow(orderRow, captured) {
    pool.query.mockImplementation(async (sql, params) => {
      // 权限校验（requirePerm）→ 放行
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.orders.refund' }], rowCount: 1 };
      // 退款回读订单
      if (sql.includes('FROM payment_orders po') && sql.includes('WHERE po.order_no = $1')) {
        return { rows: [orderRow], rowCount: 1 };
      }
      if (sql.includes('UPDATE payment_orders')) {
        captured.updateOrder = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE user_subscriptions')) {
        captured.updateSub = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        captured.audit = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  it('年付全额退款成功：订单置 refunded、metadata 落退款信息、审计、订阅联动取消', async () => {
    const captured = {};
    mockRefundFlow(makeOrderRow(), captured);

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

    // 订单更新：status='refunded' + metadata 退款四要素
    expect(captured.updateOrder.sql).toContain("status = 'refunded'");
    expect(captured.updateOrder.sql).toContain('metadata');
    const meta = JSON.parse(captured.updateOrder.params[1]);
    expect(meta.refund_amount).toBe(99);
    expect(meta.refund_reason).toBe('用户重复支付');
    expect(meta.refund_by).toBe('u-super');
    expect(meta.refunded_at).toBeTruthy();

    // 年付全额退款 → 订阅联动取消（status='canceled'）
    expect(captured.updateSub).toBeTruthy();
    expect(captured.updateSub.sql).toContain("'canceled'");
    expect(captured.updateSub.params[0]).toBe('a1b2c3d4-1111-4aaa-9bbb-00000000aaaa');

    // 审计：action=admin.orders.refund，details 含 orderNo/amount/reason
    // （logAuditEvent INSERT 参数序：[$1 user_id, $2 action, $3 resource_type, $4 resource_id, $5 details, ...]）
    expect(captured.audit).toBeTruthy();
    expect(captured.audit.params[0]).toBe('u-super');
    expect(captured.audit.params[1]).toBe('admin.orders.refund');
    expect(captured.audit.params[2]).toBe('payment_order');
    const details = JSON.parse(captured.audit.params[4]);
    expect(details).toMatchObject({
      orderNo: 'CS20260905204188',
      amount: 99,
      reason: '用户重复支付',
    });
  });

  it('月付部分退款成功但不联动取消订阅', async () => {
    const captured = {};
    mockRefundFlow(makeOrderRow({ billing_cycle: 'monthly' }), captured);

    const res = await request(buildApp())
      .post('/api/admin/orders/CS20260905204188/refund')
      .send({ amount: 9.9, reason: '部分退款' });

    expect(res.status).toBe(200);
    expect(res.body.data.refundAmount).toBe(9.9);
    expect(captured.updateSub).toBeUndefined(); // 非年付全额退款不取消订阅
  });

  it('年付但部分退款不取消订阅', async () => {
    const captured = {};
    mockRefundFlow(makeOrderRow(), captured);

    await request(buildApp())
      .post('/api/admin/orders/CS20260905204188/refund')
      .send({ amount: 50, reason: '协商部分退款' });

    expect(captured.updateSub).toBeUndefined();
  });

  it('退款金额超限返回 400 { code: 4000 }，且不产生任何写操作', async () => {
    const captured = {};
    mockRefundFlow(makeOrderRow(), captured);

    const res = await request(buildApp())
      .post('/api/admin/orders/CS20260905204188/refund')
      .send({ amount: 100, reason: '超额退款' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
    expect(captured.updateOrder).toBeUndefined();
    expect(captured.updateSub).toBeUndefined();
  });

  it('非 paid 订单返回 400 { code: 40005 }', async () => {
    const captured = {};
    mockRefundFlow(makeOrderRow({ status: 'pending' }), captured);

    const res = await request(buildApp())
      .post('/api/admin/orders/CS20260905204188/refund')
      .send(REFUND_BODY);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40005);
    expect(captured.updateOrder).toBeUndefined();
  });

  it('缺退款原因返回 400 { code: 4000 }', async () => {
    const captured = {};
    mockRefundFlow(makeOrderRow(), captured);

    const res = await request(buildApp())
      .post('/api/admin/orders/CS20260905204188/refund')
      .send({ amount: 99, reason: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
    expect(captured.updateOrder).toBeUndefined();
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
  });
});

describe('GET /api/admin/reconciliation —— 对账报告', () => {
  it('返回固定三渠道行（无数据渠道补 0）与近 30 天口径', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.orders.reconcile' }], rowCount: 1 };
      if (sql.includes('GROUP BY 1')) {
        return {
          rows: [{ channel: 'wechat', paid_count: 86, paid_amount: 28410, refund_amount: 119.6 }],
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
    expect(res.body.data.rows[0]).toEqual({
      channel: 'wechat',
      label: '微信支付',
      paidCount: 86,
      paidAmount: 28410,
      refundAmount: 119.6,
    });
    expect(res.body.data.rows[1]).toMatchObject({ channel: 'alipay', label: '支付宝', paidCount: 0 });
    expect(res.body.data.rows[2]).toMatchObject({ channel: 'stripe', label: 'Stripe', paidCount: 0 });

    const [aggSql] = pool.query.mock.calls.find(([s]) => s.includes('GROUP BY 1'));
    expect(aggSql).toContain("INTERVAL '30 days'");
    expect(aggSql).toContain("po.status IN ('paid', 'refunded')");
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
