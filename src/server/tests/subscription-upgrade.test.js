import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import pool from '../src/db/pool.js';
import { getTestApp } from './test-helpers.js';
import { markOrderPaid } from '../src/services/orderFulfillment.js';
import { roundToCent } from '../src/services/proration.js';

/**
 * 订阅升级差价折抵集成测试（任务板 #15）
 *
 * 覆盖两条链路：
 *   A. POST /api/payments/create-order —— 档位判定（同套餐 409 / 降档 409 / 升档折抵建单）
 *      与订单金额、metadata.proration；无 active 订阅时维持全价新订（含年付）。
 *   B. services/orderFulfillment.markOrderPaid —— 升级单履约「新套餐建 active 订阅 +
 *      旧订阅置 canceled」，以及「同套餐最多一条 active」不变量（重复支付只顺延不插行）。
 *
 * 折抵算法本身（边界值）在 tests/proration.test.js 里锁；这里只验**取数与落库**。
 *
 * 两点实现约定：
 *   - 测试环境 authenticateToken 固定注入 TEST_USER_ID（见 src/middleware/auth.js），
 *     所以路由用例一律操作该用户；
 *   - 支付宝网关只到 buildPagePayUrl（纯本地算 URL）为止，**不发任何网络请求**，
 *     密钥对由用例内自生成。
 */

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_PHONE = '+86test-upgrade-0001';
const ENV_KEYS = ['ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY', 'ALIPAY_NOTIFY_URL'];

const { privateKey: PRIV, publicKey: PUB } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

let app;
const savedEnv = {};
/** { Pro: { id, monthly, yearly }, Enterprise: {...} } —— 价格读 DB，避免与联调期改价打架 */
const plan = {};

/** 清掉本用户的全部支付/订阅痕迹（各用例 beforeEach 与 before/afterAll 都调） */
async function cleanupUserState() {
  await pool.query('DELETE FROM invoices WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM payment_orders WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool
    .query('DELETE FROM user_subscriptions WHERE user_id = $1', [TEST_USER_ID])
    .catch(() => {});
  await pool
    .query(
      `UPDATE users SET subscription_status = 'free', current_subscription_id = NULL WHERE id = $1`,
      [TEST_USER_ID]
    )
    .catch(() => {});
}

async function getOrder(orderNo) {
  const res = await pool.query('SELECT * FROM payment_orders WHERE order_no = $1', [orderNo]);
  return res.rows[0];
}

/**
 * 造一条 active 订阅 + 它对应的已支付订单。
 * 「实付金额」走的正是这笔订单的 amount（不是套餐标价）。
 *
 * @param {object} p
 * @param {string} p.planId
 * @param {'monthly'|'yearly'} [p.billingCycle]
 * @param {number} p.paidAmount    实付金额（元）
 * @param {number} p.daysRemaining 距到期天数
 * @param {number} p.cycleDays     该周期总天数
 */
async function seedActiveSubscription({ planId, billingCycle = 'monthly', paidAmount, daysRemaining, cycleDays }) {
  const sub = await pool.query(
    `INSERT INTO user_subscriptions
       (user_id, plan_id, status, billing_cycle, start_date, end_date,
        current_period_start, current_period_end, created_at, updated_at)
     VALUES ($1, $2, 'active', $3,
             NOW() - INTERVAL '${cycleDays - daysRemaining} day',
             NOW() + INTERVAL '${daysRemaining} day',
             NOW() - INTERVAL '${cycleDays - daysRemaining} day',
             NOW() + INTERVAL '${daysRemaining} day',
             NOW(), NOW())
     RETURNING id`,
    [TEST_USER_ID, planId, billingCycle]
  );
  const subscriptionId = sub.rows[0].id;

  const orderNo = `ORDTEST${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  await pool.query(
    `INSERT INTO payment_orders
       (user_id, subscription_id, plan_id, order_no, amount, currency, payment_method,
        payment_channel, status, paid_at, created_at, updated_at, metadata)
     VALUES ($1, $2, $3, $4, $5, 'CNY', 'alipay', 'alipay', 'paid', NOW(), NOW(), NOW(), $6)`,
    [
      TEST_USER_ID,
      subscriptionId,
      planId,
      orderNo,
      paidAmount,
      JSON.stringify({ seed: true }),
    ]
  );

  return { subscriptionId, orderNo };
}

/** 手工建一条待支付订单（直接测履约，不绕 create-order 的入参校验） */
async function seedPendingOrder({ amount, metadata, subscriptionId = null }) {
  const orderNo = `ORDTEST${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const res = await pool.query(
    `INSERT INTO payment_orders
       (user_id, subscription_id, plan_id, order_no, amount, currency, payment_method,
        payment_channel, status, created_at, updated_at, metadata)
     VALUES ($1, $2, $3, $4, $5, 'CNY', 'alipay', 'alipay', 'pending', NOW(), NOW(), $6)
     RETURNING id, order_no`,
    [TEST_USER_ID, subscriptionId, metadata.planId || null, orderNo, amount, JSON.stringify(metadata)]
  );
  return res.rows[0];
}

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[subscription-upgrade] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }

  const { app: loaded } = await getTestApp();
  app = loaded;

  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, created_at, updated_at)
     VALUES ($1, $2, '升级折抵测试用户', 'test_hash', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, TEST_PHONE]
  );

  const plans = await pool.query(
    `SELECT id, name, price_monthly, price_yearly FROM subscription_plans WHERE name = ANY($1)`,
    [['Pro', 'Enterprise']]
  );
  for (const p of plans.rows) {
    plan[p.name] = {
      id: p.id,
      monthly: parseFloat(p.price_monthly),
      yearly: parseFloat(p.price_yearly),
    };
  }
  if (!plan.Pro || !plan.Enterprise) {
    throw new Error('[subscription-upgrade] 缺少 Pro/Enterprise 套餐种子数据');
  }
  if (!(plan.Enterprise.monthly > plan.Pro.monthly)) {
    throw new Error('[subscription-upgrade] 测试前提：Enterprise 档位价必须高于 Pro');
  }

  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ALIPAY_APP_ID = '2021000000000000';
  process.env.ALIPAY_PRIVATE_KEY = PRIV;
  process.env.ALIPAY_PUBLIC_KEY = PUB;
  process.env.ALIPAY_NOTIFY_URL = 'https://api.example.test/api/webhooks/alipay';

  await cleanupUserState();
}, 60000);

afterEach(async () => {
  await cleanupUserState();
});

afterAll(async () => {
  await cleanupUserState().catch(() => {});
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await pool.end().catch(() => {});
});

describe('create-order · 无 active 订阅（维持现状：全价新订）', () => {
  it('月付：金额 = price_monthly，无 proration，metadata 带 planId/billingCycle', async () => {
    const res = await request(app)
      .post('/api/payments/create-order')
      .send({ planId: plan.Pro.id, billingCycle: 'monthly' });

    expect(res.status).toBe(200);
    expect(res.body.order.amount).toBe(plan.Pro.monthly);
    expect(res.body.proration).toBeNull();
    expect(res.body.order.paymentParams.channel).toBe('alipay');
    expect(res.body.order.paymentParams.cashierUrl).toContain('openapi.alipay.com/gateway.do');

    const row = await getOrder(res.body.order.orderNo);
    expect(Number(row.amount)).toBe(plan.Pro.monthly);
    expect(row.plan_id).toBe(plan.Pro.id);
    expect(row.metadata.planId).toBe(plan.Pro.id);
    expect(row.metadata.billingCycle).toBe('monthly');
    expect(row.metadata.proration).toBeUndefined();
  });

  it('年付：金额 = price_yearly（billingCycle=yearly 支持）', async () => {
    const res = await request(app)
      .post('/api/payments/create-order')
      .send({ planId: plan.Pro.id, billingCycle: 'yearly' });

    expect(res.status).toBe(200);
    expect(res.body.order.amount).toBe(plan.Pro.yearly);
    expect(res.body.order.originalAmount).toBe(plan.Pro.yearly);
    expect(res.body.order.creditAmount).toBe(0);
    expect((await getOrder(res.body.order.orderNo)).metadata.billingCycle).toBe('yearly');
  });

  it('套餐未配价（如 Free 的 0 元）→ 400 PLAN_PRICE_MISSING，不留 0 元订单', async () => {
    const free = await pool.query("SELECT id FROM subscription_plans WHERE name = 'Free'");
    const res = await request(app)
      .post('/api/payments/create-order')
      .send({ planId: free.rows[0].id, billingCycle: 'monthly' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PLAN_PRICE_MISSING');
    const left = await pool.query('SELECT COUNT(*)::int AS n FROM payment_orders WHERE user_id = $1', [TEST_USER_ID]);
    expect(left.rows[0].n).toBe(0);
  });
});

describe('create-order · 档位判定', () => {
  it('同套餐重复购买 → 409 ALREADY_SUBSCRIBED', async () => {
    await seedActiveSubscription({
      planId: plan.Pro.id,
      paidAmount: plan.Pro.monthly,
      daysRemaining: 15,
      cycleDays: 30,
    });

    const res = await request(app).post('/api/payments/create-order').send({ planId: plan.Pro.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_SUBSCRIBED');
    expect(res.body.error).toBeTruthy();
  });

  it('降档（Enterprise 在期，买 Pro）→ 409 DOWNGRADE_NOT_ALLOWED', async () => {
    await seedActiveSubscription({
      planId: plan.Enterprise.id,
      paidAmount: plan.Enterprise.monthly,
      daysRemaining: 20,
      cycleDays: 30,
    });

    const res = await request(app).post('/api/payments/create-order').send({ planId: plan.Pro.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOWNGRADE_NOT_ALLOWED');
  });

  it('已到期（周期结束但状态未清扫）不算 active：按全价新订', async () => {
    await pool.query(
      `INSERT INTO user_subscriptions
         (user_id, plan_id, status, billing_cycle, current_period_start, current_period_end,
          start_date, end_date, created_at, updated_at)
       VALUES ($1, $2, 'active', 'monthly',
               NOW() - INTERVAL '40 day', NOW() - INTERVAL '10 day',
               NOW() - INTERVAL '40 day', NOW() - INTERVAL '10 day', NOW(), NOW())`,
      [TEST_USER_ID, plan.Pro.id]
    );

    const res = await request(app).post('/api/payments/create-order').send({ planId: plan.Pro.id });
    expect(res.status).toBe(200);
    expect(res.body.order.amount).toBe(plan.Pro.monthly);
    expect(res.body.proration).toBeNull();
  });
});

describe('create-order · 升档折抵', () => {
  it('Pro 半程 → Enterprise：订单金额 = 新价 - 半程残值，proration 明细入库', async () => {
    const { subscriptionId } = await seedActiveSubscription({
      planId: plan.Pro.id,
      paidAmount: plan.Pro.monthly,
      daysRemaining: 15,
      cycleDays: 30,
    });

    const res = await request(app).post('/api/payments/create-order').send({ planId: plan.Enterprise.id });

    expect(res.status).toBe(200);
    const expectedCredit = roundToCent(plan.Pro.monthly * 0.5);
    const expectedFinal = roundToCent(plan.Enterprise.monthly - expectedCredit);
    // 本用例的基准价（9.9 / 19.9）下即 4.95 与 14.95
    expect(expectedCredit).toBeCloseTo(4.95, 2);
    expect(expectedFinal).toBeCloseTo(14.95, 2);

    expect(res.body.order.amount).toBe(expectedFinal);
    expect(res.body.order.originalAmount).toBe(plan.Enterprise.monthly);
    expect(res.body.order.creditAmount).toBe(expectedCredit);
    expect(res.body.proration).toMatchObject({
      originalPrice: plan.Enterprise.monthly,
      creditAmount: expectedCredit,
      finalAmount: expectedFinal,
      remainingDays: 15,
      cycleDays: 30,
      oldSubscriptionId: subscriptionId,
      oldPlanId: plan.Pro.id,
      newPlanId: plan.Enterprise.id,
    });

    const row = await getOrder(res.body.order.orderNo);
    expect(Number(row.amount)).toBe(expectedFinal);
    expect(row.metadata.proration.oldSubscriptionId).toBe(subscriptionId);
    expect(row.metadata.proration.finalAmount).toBe(expectedFinal);
  });

  it('残值取「实付金额」而非套餐标价（上期折抵过的钱不再折第二遍）', async () => {
    // 标价 99 的 Pro 年付，本单实付只有 49.50 → 残值按 49.5 算，而不是 99
    const { subscriptionId } = await seedActiveSubscription({
      planId: plan.Pro.id,
      billingCycle: 'yearly',
      paidAmount: 49.5,
      daysRemaining: 182,
      cycleDays: 365,
    });

    const res = await request(app).post('/api/payments/create-order').send({ planId: plan.Enterprise.id });
    expect(res.status).toBe(200);

    const credit = res.body.proration.creditAmount;
    // 49.5 × 182/365 ≈ 24.69（若误用标价 99 会变成 ≈ 49.37）
    expect(credit).toBeGreaterThan(plan.Enterprise.monthly); // 残值已超过新价 → 兜底
    expect(credit).toBeLessThan(30);
    expect(res.body.proration.oldSubscriptionId).toBe(subscriptionId);
    expect(res.body.order.amount).toBe(0.01);
    expect(res.body.proration.finalAmount).toBe(0.01);
  });

  it('subscriptionId + planId 同时传（/subscribe 式升级单）：订单挂旧订阅，目标取 planId', async () => {
    const { subscriptionId } = await seedActiveSubscription({
      planId: plan.Pro.id,
      paidAmount: plan.Pro.monthly,
      daysRemaining: 15,
      cycleDays: 30,
    });

    const res = await request(app)
      .post('/api/payments/create-order')
      .send({ subscriptionId, planId: plan.Enterprise.id, billingCycle: 'monthly' });

    expect(res.status).toBe(200);
    const expectedFinal = roundToCent(plan.Enterprise.monthly - roundToCent(plan.Pro.monthly * 0.5));
    expect(res.body.order.amount).toBe(expectedFinal);

    const row = await getOrder(res.body.order.orderNo);
    expect(row.subscription_id).toBe(subscriptionId);
    expect(row.plan_id).toBe(plan.Enterprise.id);
  });
});

describe('markOrderPaid · 升级单履约', () => {
  it('新套餐建 active 订阅（完整周期），旧订阅置 canceled + canceled_at', async () => {
    const { subscriptionId: oldSubId } = await seedActiveSubscription({
      planId: plan.Pro.id,
      paidAmount: plan.Pro.monthly,
      daysRemaining: 15,
      cycleDays: 30,
    });

    const amount = roundToCent(plan.Enterprise.monthly - roundToCent(plan.Pro.monthly * 0.5));
    const order = await seedPendingOrder({
      amount,
      metadata: {
        planId: plan.Enterprise.id,
        billingCycle: 'monthly',
        proration: { oldSubscriptionId: oldSubId, creditAmount: roundToCent(plan.Pro.monthly * 0.5), finalAmount: amount },
      },
    });

    const result = await markOrderPaid({ orderNo: order.order_no, channel: 'alipay', expectedAmount: amount });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const subs = await pool.query(
      `SELECT id, plan_id, status, canceled_at, billing_cycle, current_period_start, current_period_end
         FROM user_subscriptions WHERE user_id = $1`,
      [TEST_USER_ID]
    );
    const oldRow = subs.rows.find((r) => r.id === oldSubId);
    const newRows = subs.rows.filter((r) => r.plan_id === plan.Enterprise.id);

    expect(oldRow.status).toBe('canceled');
    expect(oldRow.canceled_at).toBeTruthy();
    expect(newRows).toHaveLength(1);
    expect(newRows[0].status).toBe('active');
    expect(newRows[0].billing_cycle).toBe('monthly');
    // 周期从履约时刻起算一个完整月（不接续旧周期）
    expect(new Date(newRows[0].current_period_start).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(newRows[0].current_period_end).getTime()).toBeGreaterThan(
      Date.now() + 27 * 24 * 3600 * 1000
    );

    const orderRow = await pool.query('SELECT status, subscription_id FROM payment_orders WHERE id = $1', [order.id]);
    expect(orderRow.rows[0].status).toBe('paid');
    expect(orderRow.rows[0].subscription_id).toBe(newRows[0].id);

    const userRow = await pool.query(
      'SELECT subscription_status, current_subscription_id FROM users WHERE id = $1',
      [TEST_USER_ID]
    );
    expect(userRow.rows[0].subscription_status).toBe('enterprise');
    expect(userRow.rows[0].current_subscription_id).toBe(newRows[0].id);
  });

  it('同一升级单被重复支付（回调 + 轮询双到）→ 不插第二条 active，只顺延周期', async () => {
    const { subscriptionId: oldSubId } = await seedActiveSubscription({
      planId: plan.Pro.id,
      paidAmount: plan.Pro.monthly,
      daysRemaining: 15,
      cycleDays: 30,
    });
    const amount = roundToCent(plan.Enterprise.monthly - roundToCent(plan.Pro.monthly * 0.5));
    const meta = {
      planId: plan.Enterprise.id,
      billingCycle: 'monthly',
      proration: { oldSubscriptionId: oldSubId },
    };
    const first = await seedPendingOrder({ amount, metadata: meta });
    const second = await seedPendingOrder({ amount, metadata: meta });

    expect((await markOrderPaid({ orderNo: first.order_no, channel: 'alipay' })).ok).toBe(true);
    const before = await pool.query(
      `SELECT id, current_period_end FROM user_subscriptions
        WHERE user_id = $1 AND plan_id = $2 AND status = 'active'`,
      [TEST_USER_ID, plan.Enterprise.id]
    );
    expect(before.rows).toHaveLength(1);

    expect((await markOrderPaid({ orderNo: second.order_no, channel: 'alipay' })).ok).toBe(true);
    const after = await pool.query(
      `SELECT id, current_period_end FROM user_subscriptions
        WHERE user_id = $1 AND plan_id = $2 AND status = 'active'`,
      [TEST_USER_ID, plan.Enterprise.id]
    );
    expect(after.rows).toHaveLength(1); // 同套餐最多一条 active
    expect(after.rows[0].id).toBe(before.rows[0].id);
    expect(new Date(after.rows[0].current_period_end) > new Date(before.rows[0].current_period_end)).toBe(true);

    const active = await pool.query(
      `SELECT COUNT(*)::int AS n FROM user_subscriptions WHERE user_id = $1 AND status = 'active'`,
      [TEST_USER_ID]
    );
    expect(active.rows[0].n).toBe(1);
  });

  it('无 proration 的同套餐订单（续费兜底）→ 顺延已有订阅，不插新行、不写 canceled_at', async () => {
    const { subscriptionId } = await seedActiveSubscription({
      planId: plan.Pro.id,
      paidAmount: plan.Pro.monthly,
      daysRemaining: 10,
      cycleDays: 30,
    });

    const order = await seedPendingOrder({
      amount: plan.Pro.monthly,
      metadata: { planId: plan.Pro.id, billingCycle: 'monthly' },
    });
    expect((await markOrderPaid({ orderNo: order.order_no, channel: 'alipay' })).ok).toBe(true);

    const subs = await pool.query(
      'SELECT id, status, canceled_at FROM user_subscriptions WHERE user_id = $1',
      [TEST_USER_ID]
    );
    expect(subs.rows).toHaveLength(1);
    expect(subs.rows[0].id).toBe(subscriptionId);
    expect(subs.rows[0].status).toBe('active');
    expect(subs.rows[0].canceled_at).toBeNull();
  });
});
