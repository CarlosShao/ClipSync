import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import pool from '../src/db/pool.js';
import { clearPermCache } from '../src/middleware/adminAuth.js';
import { refundPaidOrder, RefundError } from '../src/services/refund.js';

/**
 * 退款服务真库集成测试（§4-A1：真实退款逻辑抽到 services/refund.js 后唯一的事实来源）
 *
 * 锁死两件事：
 *   A. **服务本身**的资金不变量（原来只在 POST /api/payments/refund 上验过）：
 *      渠道 fund_status='Y' 才动库；订单 refunded + refunded_at、订阅 canceled +
 *      canceled_at、users 冗余回 free、payment_refund 审计；失败/未确认一律不改状态。
 *   B. **管理台退款路由** POST /api/admin/orders/:orderNo/refund 已经是薄壳：
 *      它退的是**真钱**（与 A 同一条实现），并且
 *        - 部分金额 → 400 PARTIAL_REFUND_NOT_SUPPORTED（绝不留下「标了 refunded 但钱没退」）；
 *        - 非支付宝渠道（mock/历史单）→ 400，旧的记账式假退款通道已死；
 *        - 无 admin.orders.refund 权限 → 403，连渠道都不碰。
 *
 * 离线：支付宝网关用 vi.stubGlobal('fetch') 打桩，响应原文用测试内自生成密钥签名，
 * 所以 callGateway 的响应验签是真跑的。
 */

const ADMIN_USER_ID = '00000000-0000-0000-0000-0000000000a1';
const VICTIM_USER_ID = '00000000-0000-0000-0000-0000000000a2';
const ENV_KEYS = ['ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY'];
const REFUND_KEY = 'alipay_trade_refund_response';

const { privateKey: PRIV, publicKey: PUB } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

function signWith(str) {
  const s = crypto.createSign('RSA-SHA256');
  s.update(str, 'utf8');
  return s.sign(PRIV, 'base64');
}

/** 生成一个"确实来自支付宝"的响应体（原文子串 + 对应签名） */
function stubGatewayResponse(payload) {
  const nodeText = `"${REFUND_KEY}":${JSON.stringify(payload)}`;
  const body = `{${nodeText},"sign":"${signWith(nodeText)}"}`;
  const fn = vi.fn(async () => ({ text: async () => body }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

// 管理端身份由这里注入（middleware/auth 被 mock）；requirePerm 仍打真库 RBAC。
// vi.hoisted：mock 工厂在静态 import 阶段就会被调用，普通 const 会踩 TDZ。
const authState = vi.hoisted(() => ({ user: null }));

vi.mock('../src/middleware/auth.js', () => ({
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
import { default as adminRouter } from '../src/routes/admin/index.js';

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

const savedEnv = {};
let adminRoleId = null;
let planId = null;

async function seedOrder({
  status = 'paid',
  paymentMethod = 'alipay',
  amount = 9.9,
  withSubscription = true,
} = {}) {
  let subscriptionId = null;
  if (withSubscription) {
    const sub = await pool.query(
      `INSERT INTO user_subscriptions
         (user_id, plan_id, status, billing_cycle, start_date, end_date,
          current_period_start, current_period_end, created_at, updated_at)
       VALUES ($1, $2, 'active', 'monthly', NOW(), NOW() + INTERVAL '1 month',
               NOW(), NOW() + INTERVAL '30 day', NOW(), NOW())
       RETURNING id`,
      [VICTIM_USER_ID, planId]
    );
    subscriptionId = sub.rows[0].id;
    await pool.query(
      `UPDATE users SET subscription_status = 'pro', current_subscription_id = $1 WHERE id = $2`,
      [subscriptionId, VICTIM_USER_ID]
    );
  }

  const orderNo = `ORDSV${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const order = await pool.query(
    `INSERT INTO payment_orders
       (user_id, subscription_id, plan_id, order_no, amount, currency,
        payment_method, payment_channel, status, paid_at, transaction_id, created_at, updated_at, metadata)
     VALUES ($1, $2, $3, $4, $5, 'CNY', $6, $6, $7, $8, '202609192200000000', NOW(), NOW(), '{}')
     RETURNING id, order_no`,
    [
      VICTIM_USER_ID,
      subscriptionId,
      planId,
      orderNo,
      amount,
      paymentMethod,
      status,
      status === 'paid' ? new Date() : null,
    ]
  );
  return { orderId: order.rows[0].id, orderNo: order.rows[0].order_no, subscriptionId };
}

async function readOrder(orderId) {
  const { rows } = await pool.query('SELECT * FROM payment_orders WHERE id = $1', [orderId]);
  return rows[0];
}

async function readSubscription(subscriptionId) {
  if (!subscriptionId) return null;
  const { rows } = await pool.query('SELECT * FROM user_subscriptions WHERE id = $1', [subscriptionId]);
  return rows[0];
}

async function auditRows(action, resourceId) {
  const { rows } = await pool.query(
    `SELECT action, status, details FROM audit_logs WHERE action = $1 AND resource_id = $2`,
    [action, String(resourceId)]
  );
  return rows;
}

/**
 * 临时角色：持有 admin.orders.refund 的**自定义**角色。
 * 为什么不直接用 super_admin —— 迁移 037 的 trg_protect_super_admin 触发器
 * 保证「全库只有一个超管」，测试再插一个超管会被 SUPER_ADMIN_EXISTS_ALREADY 拒掉。
 * 这也顺带证明管理台退款走的是 RBAC 权限点，而不是「是不是超管」。
 */
const TEST_ROLE_KEY = 'test_refund_admin';

async function ensureRefundAdminRole() {
  const { rows } = await pool.query(
    `INSERT INTO roles (role_key, name, level, is_system, is_assignable, description)
     VALUES ($1, '退款服务测试角色', 60, false, true, 'tests/refund-service.test.js 临时角色')
     ON CONFLICT (role_key) DO UPDATE SET level = EXCLUDED.level
     RETURNING id`,
    [TEST_ROLE_KEY]
  );
  const roleId = rows[0].id;
  const { rows: perms } = await pool.query(
    `SELECT id FROM permissions WHERE perm_key = 'admin.orders.refund'`
  );
  if (perms.length === 0) throw new Error('[refund-service] 权限点 admin.orders.refund 未入库');
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [roleId, perms[0].id]
  );
  return roleId;
}

async function cleanup() {
  // ⚠️ 清理条件一律走索引列（user_id）：clipsync_test 的 audit_logs 里有超大 details 行，
  // 任何整表表达式扫描（resource_id::text IN 子查询 / details LIKE）都要 30s+，用例会超时。
  await pool.query(`DELETE FROM audit_logs WHERE user_id = ANY($1)`, [[ADMIN_USER_ID, VICTIM_USER_ID]]).catch(() => {});
  await pool.query(`DELETE FROM invoices WHERE user_id = $1`, [VICTIM_USER_ID]).catch(() => {});
  await pool.query(`DELETE FROM payment_orders WHERE user_id = $1`, [VICTIM_USER_ID]).catch(() => {});
  await pool.query(`DELETE FROM user_subscriptions WHERE user_id = $1`, [VICTIM_USER_ID]).catch(() => {});
  await pool
    .query(
      `UPDATE users SET subscription_status = 'free', current_subscription_id = NULL WHERE id = $1`,
      [VICTIM_USER_ID]
    )
    .catch(() => {});
}

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[refund-service] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }

  adminRoleId = await ensureRefundAdminRole();

  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, role_id, is_admin, subscription_status, created_at, updated_at)
     VALUES ($1, '+86tradmin0001', '退款服务测试管理员', 'test_hash', $2, true, 'free', NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET role_id = EXCLUDED.role_id, is_admin = true`,
    [ADMIN_USER_ID, adminRoleId]
  );
  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, subscription_status, created_at, updated_at)
     VALUES ($1, '+86trvictim0001', '退款服务测试用户', 'test_hash', 'free', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [VICTIM_USER_ID]
  );

  const plans = await pool.query(`SELECT id FROM subscription_plans WHERE name = 'Pro'`);
  planId = plans.rows[0]?.id;
  if (!planId) throw new Error('[refund-service] 缺少 Pro 套餐种子数据');

  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ALIPAY_APP_ID = '2021000000000000';
  process.env.ALIPAY_PRIVATE_KEY = PRIV;
  process.env.ALIPAY_PUBLIC_KEY = PUB;

  clearPermCache();
  await cleanup();
}, 60000);

beforeEach(async () => {
  await cleanup();
  clearPermCache();
  authState.user = {
    userId: ADMIN_USER_ID,
    roleKey: TEST_ROLE_KEY,
    roleLevel: 60,
    isAdmin: true,
  };
  process.env.ALIPAY_APP_ID = '2021000000000000';
  process.env.ALIPAY_PRIVATE_KEY = PRIV;
  process.env.ALIPAY_PUBLIC_KEY = PUB;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await cleanup().catch(() => {});
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[ADMIN_USER_ID, VICTIM_USER_ID]]).catch(() => {});
  await pool.query(`DELETE FROM roles WHERE role_key = $1`, [TEST_ROLE_KEY]).catch(() => {});
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await pool.end().catch(() => {});
});

// ───────────────────────── A. 服务本身 ─────────────────────────

describe('refundPaidOrder · 服务真库行为', () => {
  it('全额退款成功：订单 refunded、订阅 canceled、users 回 free、写 payment_refund 审计', async () => {
    const { orderId, orderNo, subscriptionId } = await seedOrder({ amount: 9.9 });
    const fn = stubGatewayResponse({
      code: '10000',
      msg: 'Success',
      trade_no: '202609192200000000',
      out_trade_no: orderNo,
      fund_status: 'Y',
      refund_amount: '9.90',
    });

    const result = await refundPaidOrder({
      orderId,
      actorUserId: ADMIN_USER_ID,
      reason: '误购，全额退',
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });

    expect(result).toMatchObject({
      ok: true,
      order: { orderNo, amount: 9.9, refundAmount: 9.9, status: 'refunded' },
      entitlement: { subscriptionId, subscriptionCanceled: true },
      channel: { name: 'alipay', fund_status: 'Y', out_request_no: orderNo },
    });
    expect(result.order.refundedAt).toBeTruthy();

    // 请求报文：全额 + out_request_no=订单号（渠道侧幂等）
    const biz = JSON.parse(new URLSearchParams(fn.mock.calls[0][1].body).get('biz_content'));
    expect(biz).toEqual({ out_trade_no: orderNo, refund_amount: '9.90', out_request_no: orderNo });

    const order = await readOrder(orderId);
    expect(order.status).toBe('refunded');
    expect(order.refunded_at).toBeTruthy();
    expect(Number(order.metadata.refund_amount)).toBe(9.9);
    expect(order.metadata.refund_by).toBe(ADMIN_USER_ID);
    expect(order.metadata.alipay_refund.fund_status).toBe('Y');

    const sub = await readSubscription(subscriptionId);
    expect(sub.status).toBe('canceled');
    expect(sub.canceled_at).toBeTruthy();
    expect(sub.auto_renew).toBe(false);

    const user = await pool.query(
      'SELECT subscription_status, current_subscription_id FROM users WHERE id = $1',
      [VICTIM_USER_ID]
    );
    expect(user.rows[0].subscription_status).toBe('free');
    expect(user.rows[0].current_subscription_id).toBeNull();

    const audits = await auditRows('payment_refund', orderId);
    expect(audits).toHaveLength(1);
    expect(audits[0].status).toBe('success');
    expect(audits[0].details.orderNo).toBe(orderNo);
    expect(audits[0].details.reason).toBe('误购，全额退');
  });

  it('orderNo 入参等价可用（管理台只有业务单号）', async () => {
    const { orderNo } = await seedOrder();
    stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });
    const result = await refundPaidOrder({ orderNo, actorUserId: ADMIN_USER_ID, reason: 'x' });
    expect(result.order.status).toBe('refunded');
  });

  it('缺入参 → 400 MISSING_ORDER_KEY', async () => {
    const err = await refundPaidOrder({ actorUserId: ADMIN_USER_ID }).catch((e) => e);
    expect(err).toBeInstanceOf(RefundError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('MISSING_ORDER_KEY');
  });

  it('未支付订单 → 400 ORDER_NOT_REFUNDABLE，不碰渠道', async () => {
    const { orderId, orderNo } = await seedOrder({ status: 'pending' });
    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y' });

    const err = await refundPaidOrder({ orderNo, actorUserId: ADMIN_USER_ID, reason: 'x' }).catch((e) => e);
    expect(err.code).toBe('ORDER_NOT_REFUNDABLE');
    expect(err.status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
    expect((await readOrder(orderId)).status).toBe('pending');
  });

  it('非支付宝渠道（mock 历史单）→ 400 REFUND_CHANNEL_UNSUPPORTED，绝不打款', async () => {
    const { orderId, orderNo } = await seedOrder({ paymentMethod: 'mock' });
    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y' });

    const err = await refundPaidOrder({ orderNo, actorUserId: ADMIN_USER_ID, reason: 'x' }).catch((e) => e);
    expect(err.code).toBe('REFUND_CHANNEL_UNSUPPORTED');
    expect(err.status).toBe(400);
    expect(err.extra.channel).toBe('mock');
    expect(fn).not.toHaveBeenCalled();
    expect((await readOrder(orderId)).status).toBe('paid');
  });

  it('已退款订单 → 409 ALREADY_REFUNDED（本地幂等闸）', async () => {
    const { orderNo } = await seedOrder();
    stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });
    await refundPaidOrder({ orderNo, actorUserId: ADMIN_USER_ID, reason: '第一次' });

    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });
    const err = await refundPaidOrder({ orderNo, actorUserId: ADMIN_USER_ID, reason: '第二次' }).catch((e) => e);
    expect(err.code).toBe('ALREADY_REFUNDED');
    expect(err.status).toBe(409);
    expect(fn).not.toHaveBeenCalled();
  });

  it('渠道业务失败（code≠10000）→ 502 REFUND_CHANNEL_FAILED，订单仍 paid + 写 failure 审计', async () => {
    const { orderId, orderNo, subscriptionId } = await seedOrder();
    stubGatewayResponse({
      code: '40004',
      msg: 'Business Failed',
      sub_code: 'REFUND_AMOUNT_EXCEED',
      sub_msg: '退款金额超过可退金额',
    });

    const err = await refundPaidOrder({ orderNo, actorUserId: ADMIN_USER_ID, reason: 'x' }).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.code).toBe('REFUND_CHANNEL_FAILED');
    expect(err.extra.channelError).toMatchObject({ code: '40004', subCode: 'REFUND_AMOUNT_EXCEED' });

    const order = await readOrder(orderId);
    expect(order.status).toBe('paid');
    expect(order.refunded_at).toBeNull();
    expect((await readSubscription(subscriptionId)).status).toBe('active');

    const audits = await auditRows('payment_refund', orderId);
    expect(audits).toHaveLength(1);
    expect(audits[0].status).toBe('failure');
    expect(audits[0].details.stage).toBe('channel_call');
  });

  it("fund_status='C' → 502 REFUND_NOT_CONFIRMED，订单仍 paid", async () => {
    const { orderId, orderNo, subscriptionId } = await seedOrder();
    stubGatewayResponse({ code: '10000', msg: 'Success', fund_status: 'C', refund_amount: '9.90' });

    const err = await refundPaidOrder({ orderNo, actorUserId: ADMIN_USER_ID, reason: 'x' }).catch((e) => e);
    expect(err.code).toBe('REFUND_NOT_CONFIRMED');
    expect((await readOrder(orderId)).status).toBe('paid');
    expect((await readSubscription(subscriptionId)).status).toBe('active');
  });

  it('渠道未配置凭据 → 503 ALIPAY_NOT_CONFIGURED（不静默假退款）', async () => {
    const { orderId, orderNo } = await seedOrder();
    delete process.env.ALIPAY_PRIVATE_KEY;
    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y' });

    const err = await refundPaidOrder({ orderNo, actorUserId: ADMIN_USER_ID, reason: 'x' }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.code).toBe('ALIPAY_NOT_CONFIGURED');
    expect(fn).not.toHaveBeenCalled();
    expect((await readOrder(orderId)).status).toBe('paid');
  });

  it('并发双退：只有一次落库生效，另一次 409（行锁复核）', async () => {
    const { orderId, orderNo, subscriptionId } = await seedOrder();
    stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });

    const [a, b] = await Promise.allSettled([
      refundPaidOrder({ orderNo, actorUserId: ADMIN_USER_ID, reason: '并发 1' }),
      refundPaidOrder({ orderNo, actorUserId: ADMIN_USER_ID, reason: '并发 2' }),
    ]);

    const ok = [a, b].filter((r) => r.status === 'fulfilled');
    const failed = [a, b].filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(RefundError);
    expect(failed[0].reason.status).toBe(409);

    const order = await readOrder(orderId);
    expect(order.status).toBe('refunded');
    // 只有一条退款审计（成功）；失败那次是 409 前置/复核拦截，不落 payment_refund
    expect(await auditRows('payment_refund', orderId)).toHaveLength(1);
    expect((await readSubscription(subscriptionId)).status).toBe('canceled');
  });
});

// ───────────────────────── B. 管理台退款路由（薄壳） ─────────────────────────

describe('POST /api/admin/orders/:orderNo/refund —— 真库端到端（A1 修复后必须动真钱）', () => {
  it('全额退款成功：与 /api/payments/refund 同一实现，订单/订阅/权益全部真实变更', async () => {
    const { orderId, orderNo, subscriptionId } = await seedOrder({ amount: 9.9 });
    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });

    const res = await request(buildAdminApp())
      .post(`/api/admin/orders/${orderNo}/refund`)
      .send({ reason: '管理台退款' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({ orderNo, status: 'refunded', refundAmount: 9.9 });

    // 真的打了款（旧记账实现这里一个渠道请求都不会发）
    expect(fn).toHaveBeenCalledTimes(1);

    const order = await readOrder(orderId);
    expect(order.status).toBe('refunded');
    expect(order.refunded_at).toBeTruthy();
    const sub = await readSubscription(subscriptionId);
    expect(sub.status).toBe('canceled');
    expect(sub.canceled_at).toBeTruthy();

    // 资金审计（服务写）+ 管理动作审计（路由写），两者都在
    expect(await auditRows('payment_refund', orderId)).toHaveLength(1);
    const adminAudit = await auditRows('admin.orders.refund', orderId);
    expect(adminAudit).toHaveLength(1);
    expect(adminAudit[0].details).toMatchObject({
      orderNo,
      amount: 9.9,
      reason: '管理台退款',
      channel: 'alipay',
      fund_status: 'Y',
      subscriptionCanceled: true,
      targetUserId: VICTIM_USER_ID,
    });
  });

  it('带 amount=全额（9.9 / "9.90"）放行；缺省同样放行', async () => {
    stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });
    const { orderNo } = await seedOrder({ amount: 9.9 });
    expect(
      (await request(buildAdminApp()).post(`/api/admin/orders/${orderNo}/refund`).send({ amount: 9.9, reason: 'r' }))
        .status
    ).toBe(200);

    stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });
    const second = await seedOrder({ amount: 9.9 });
    expect(
      (await request(buildAdminApp())
        .post(`/api/admin/orders/${second.orderNo}/refund`)
        .send({ amount: '9.90', reason: 'r' })).status
    ).toBe(200);
  });

  it('部分金额 → 400 PARTIAL_REFUND_NOT_SUPPORTED，订单保持 paid、不碰渠道', async () => {
    const { orderId, orderNo } = await seedOrder({ amount: 99 });
    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y' });

    const res = await request(buildAdminApp())
      .post(`/api/admin/orders/${orderNo}/refund`)
      .send({ amount: 50, reason: '协商部分退款' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
    expect(res.body.error_code).toBe('PARTIAL_REFUND_NOT_SUPPORTED');
    expect(res.body.orderAmount).toBe(99);
    expect(fn).not.toHaveBeenCalled();

    const order = await readOrder(orderId);
    expect(order.status).toBe('paid');
    expect(order.metadata.refund_amount).toBeUndefined();
    expect(await auditRows('admin.orders.refund', orderId)).toHaveLength(0);
  });

  it('mock 渠道订单在管理台退不掉（旧的记账式假退款通道已删除）', async () => {
    const { orderId, orderNo } = await seedOrder({ paymentMethod: 'mock' });
    stubGatewayResponse({ code: '10000', fund_status: 'Y' });

    const res = await request(buildAdminApp())
      .post(`/api/admin/orders/${orderNo}/refund`)
      .send({ reason: 'mock 单想要退款' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 40006, refundCode: 'REFUND_CHANNEL_UNSUPPORTED' });
    const order = await readOrder(orderId);
    expect(order.status).toBe('paid');
    // 关键：订单绝不能被「标记为已退款」
    expect(order.metadata.refund_amount).toBeUndefined();
  });

  it('未支付订单 → 400 { code: 40005 }（沿用管理台原错误码）', async () => {
    const { orderNo } = await seedOrder({ status: 'pending' });
    stubGatewayResponse({ code: '10000', fund_status: 'Y' });

    const res = await request(buildAdminApp())
      .post(`/api/admin/orders/${orderNo}/refund`)
      .send({ reason: '没付钱' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 40005, refundCode: 'ORDER_NOT_REFUNDABLE' });
  });

  it('渠道退款失败 → 502，管理台不得显示「已退款」', async () => {
    const { orderNo } = await seedOrder();
    stubGatewayResponse({ code: '40004', msg: 'Business Failed', sub_code: 'REFUND_AMOUNT_EXCEED' });

    const res = await request(buildAdminApp())
      .post(`/api/admin/orders/${orderNo}/refund`)
      .send({ reason: '渠道会失败' });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe(5020);
    expect(res.body.refundCode).toBe('REFUND_CHANNEL_FAILED');
    expect(res.body.channelError.code).toBe('40004');
  });

  it('缺原因 → 400；订单不存在 → 404', async () => {
    stubGatewayResponse({ code: '10000', fund_status: 'Y' });
    const { orderNo } = await seedOrder();
    expect(
      (await request(buildAdminApp()).post(`/api/admin/orders/${orderNo}/refund`).send({ reason: '  ' })).status
    ).toBe(400);
    expect(
      (await request(buildAdminApp()).post('/api/admin/orders/ORDNOTEXIST000000/refund').send({ reason: 'x' })).status
    ).toBe(404);
  });

  it('无 admin.orders.refund 权限（内置 admin 角色）→ 403，且不碰渠道', async () => {
    const { rows } = await pool.query(`SELECT id FROM roles WHERE role_key = 'admin'`);
    const { orderId, orderNo } = await seedOrder();
    await pool.query('UPDATE users SET role_id = $1 WHERE id = $2', [rows[0].id, ADMIN_USER_ID]);
    clearPermCache();
    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y' });

    const res = await request(buildAdminApp())
      .post(`/api/admin/orders/${orderNo}/refund`)
      .send({ reason: '越权退款' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.orders.refund' });
    expect(fn).not.toHaveBeenCalled();
    expect((await readOrder(orderId)).status).toBe('paid');

    await pool.query('UPDATE users SET role_id = $1 WHERE id = $2', [adminRoleId, ADMIN_USER_ID]);
    clearPermCache();
  });
});
