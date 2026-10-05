import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import pool from '../src/db/pool.js';
import { getTestApp, authHeaders } from './test-helpers.js';
import { invalidateFlagsCache } from '../src/utils/featureFlags.js';
import { roundToCent } from '../src/services/proration.js';

/**
 * POST /api/payments/upgrade-quote —— 升级折抵**试算**（2026-10-05）
 *
 * 端点存在的理由：抵扣明细要在用户点「升级」那一刻就显示，而**绝不能靠先建一条 pending
 * 单来换明细** —— 那会同时破坏三条语义：95s 过期、24h 关单扫描、以及
 * `enable_subscription` 关闭时不建单。
 *
 * 本文件锁两件事（其余金额边界在 tests/proration.test.js）：
 *   A. **试算 == 实收**：quote.finalAmount 必须逐分等于随后 create-order 的 order.amount。
 *      一旦两者能漂移，界面上就会冒出「试算 ¥19.89、实收 ¥19.90」这种解释不清的差额，
 *      且方向不可控（少收=资损，多收=投诉）。这是本次改动最核心的不变量。
 *   B. **试算不建单**：反复调 quote，payment_orders 计数必须一动不动。
 *
 * 另覆盖赠期场景（订阅有 active 但**没有支付订单**）：此时折抵按套餐标价折算，
 * creditSource 必须如实报 'plan' —— 明细里绝不能把它说成「你付过这笔钱」。
 */

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
// users.phone 是 varchar(20)，测试手机号必须短于它（加了前缀很容易超长）
const TEST_PHONE = '+86test-quote-0001';
const ENV_KEYS = ['ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY', 'ALIPAY_NOTIFY_URL'];

const { privateKey: PRIV, publicKey: PUB } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

let app;
const savedEnv = {};
/** { Free: {...}, Pro: {...}, Enterprise: {...} } —— 价格读 DB，避免与联调期改价打架 */
const plan = {};

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

async function countOrders() {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM payment_orders WHERE user_id = $1',
    [TEST_USER_ID]
  );
  return rows[0].n;
}

/**
 * 造一条 active 订阅；`paidAmount === null` 表示**不建支付订单**（= 管理台赠期出来的订阅）。
 *
 * @param {object} p
 * @param {string} p.planId
 * @param {number|null} p.paidAmount 实付金额（元）；null = 无支付记录
 * @param {number} p.daysRemaining   距到期天数
 * @param {number} p.cycleDays       该周期总天数
 */
async function seedActiveSubscription({ planId, paidAmount = null, daysRemaining, cycleDays }) {
  const sub = await pool.query(
    `INSERT INTO user_subscriptions
       (user_id, plan_id, status, billing_cycle, start_date, end_date,
        current_period_start, current_period_end, created_at, updated_at)
     VALUES ($1, $2, 'active', 'monthly',
             NOW() - INTERVAL '${cycleDays - daysRemaining} day',
             NOW() + INTERVAL '${daysRemaining} day',
             NOW() - INTERVAL '${cycleDays - daysRemaining} day',
             NOW() + INTERVAL '${daysRemaining} day',
             NOW(), NOW())
     RETURNING id`,
    [TEST_USER_ID, planId]
  );
  const subscriptionId = sub.rows[0].id;

  if (paidAmount != null) {
    const orderNo = `ORDTEST${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    await pool.query(
      `INSERT INTO payment_orders
         (user_id, subscription_id, plan_id, order_no, amount, currency, payment_method,
          payment_channel, status, paid_at, created_at, updated_at, metadata)
       VALUES ($1, $2, $3, $4, $5, 'CNY', 'alipay', 'alipay', 'paid', NOW(), NOW(), NOW(), $6)`,
      [TEST_USER_ID, subscriptionId, planId, orderNo, paidAmount, JSON.stringify({ seed: true })]
    );
  }

  return { subscriptionId };
}

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[upgrade-quote] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }

  const { app: loaded } = await getTestApp();
  app = loaded;

  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, created_at, updated_at)
     VALUES ($1, $2, '试算测试用户', 'test_hash', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, TEST_PHONE]
  );

  const plans = await pool.query(
    `SELECT id, name, price_monthly, price_yearly FROM subscription_plans WHERE name = ANY($1)`,
    [['Free', 'Pro', 'Enterprise']]
  );
  for (const p of plans.rows) {
    plan[p.name] = {
      id: p.id,
      monthly: parseFloat(p.price_monthly),
      yearly: parseFloat(p.price_yearly),
    };
  }
  if (!plan.Pro || !plan.Enterprise || !plan.Free) {
    throw new Error('[upgrade-quote] 缺少 Free/Pro/Enterprise 套餐种子数据');
  }
  // 本文件的两条前提：升档要有差价可折、目标套餐要有价可算
  if (!(plan.Enterprise.monthly > plan.Pro.monthly)) {
    throw new Error('[upgrade-quote] 测试前提：Enterprise 档位价必须高于 Pro');
  }
  if (!(plan.Pro.monthly > 0)) {
    throw new Error('[upgrade-quote] 测试前提：Pro 必须有价（0 元套餐会走 PLAN_PRICE_MISSING）');
  }

  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ALIPAY_APP_ID = '2021000000000000';
  process.env.ALIPAY_PRIVATE_KEY = PRIV;
  process.env.ALIPAY_PUBLIC_KEY = PUB;
  process.env.ALIPAY_NOTIFY_URL = 'https://api.example.test/api/webhooks/alipay';

  // 收钱链路是开关强制点：本文件全程需要它是开的（flag-gate 文件会切它）
  await pool.query(
    "UPDATE feature_flags SET enabled = true, updated_at = NOW() WHERE flag_key = 'enable_subscription'"
  );
  invalidateFlagsCache();

  await cleanupUserState();
}, 60000);

beforeEach(async () => {
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

const auth = authHeaders();

function quote(body) {
  return request(app).post('/api/payments/upgrade-quote').set(auth).send(body);
}

describe('升级试算 · 升档折抵', () => {
  // 金额一律**由套餐价推导**（而不是写死 49.5）：联调期改价是常态，
  // 写死数字的用例迟早因为「Pro 被改成 0.01」而变成一条假红线。
  const PAID = () => plan.Enterprise.monthly;

  it('字段齐备：实付/已使用/剩余可抵扣/差额/天数/有效期都能算出来', async () => {
    // 实付 = 0.4 × 新价 ⇒ 残值 ≈ 0.2 × 新价，差额 ≈ 0.8 × 新价（不会触发下限）
    const paidAmount = roundToCent(PAID() * 0.4);
    const { subscriptionId } = await seedActiveSubscription({
      planId: plan.Pro.id,
      paidAmount,
      daysRemaining: 15,
      cycleDays: 30,
    });

    const res = await quote({ planId: plan.Enterprise.id, billingCycle: 'monthly' });
    expect(res.status).toBe(200);
    const q = res.body.quote;

    expect(q.planId).toBe(plan.Enterprise.id);
    expect(q.billingCycle).toBe('monthly');
    expect(q.originalPrice).toBeCloseTo(plan.Enterprise.monthly, 2);
    // 实付来自该订阅的**已支付订单**，不是套餐标价
    expect(q.paidAmount).toBeCloseTo(paidAmount, 2);
    expect(q.creditSource).toBe('order');
    expect(q.oldSubscriptionId).toBe(subscriptionId);
    expect(q.oldPlanId).toBe(plan.Pro.id);
    expect(q.currentPeriodEnd).toBeTruthy();
    expect(q.cycleDays).toBeCloseTo(30, 0);
    expect(q.remainingDays).toBeGreaterThan(14.9);
    expect(q.remainingDays).toBeLessThanOrEqual(15);

    // 线性口径：残值 = 实付 × 剩余比例 ≈ 实付 × 15/30（毫秒级误差来自 seeded NOW()）
    expect(q.creditAmount).toBeGreaterThan(paidAmount * 0.49);
    expect(q.creditAmount).toBeLessThan(paidAmount * 0.51);
    // 没有触发下限（残值 < 新价）
    expect(q.creditAmount).toBeLessThan(plan.Enterprise.monthly);
    // 已使用 + 剩余可抵扣 = 实付（分解不丢钱、也不凭空多钱）
    expect(roundToCent(q.usedAmount + q.creditAmount)).toBeCloseTo(paidAmount, 2);
    expect(q.usedAmount).toBeGreaterThan(0);
    // 差额 = 新价 − 折抵
    expect(q.finalAmount).toBeCloseTo(roundToCent(plan.Enterprise.monthly - q.creditAmount), 2);
  });

  it('残值高于新价时：差额落到 0.01 下限，绝不产出 0 元/负数单', async () => {
    // 实付 = 3 × 新价 ⇒ 残值 ≈ 1.5 × 新价 > 新价
    const paidAmount = roundToCent(PAID() * 3);
    await seedActiveSubscription({
      planId: plan.Pro.id,
      paidAmount,
      daysRemaining: 15,
      cycleDays: 30,
    });

    const res = await quote({ planId: plan.Enterprise.id, billingCycle: 'monthly' });
    expect(res.status).toBe(200);
    const q = res.body.quote;

    expect(q.creditAmount).toBeGreaterThan(plan.Enterprise.monthly);
    expect(q.finalAmount).toBe(0.01);
    expect(q.creditAmount).toBeLessThanOrEqual(paidAmount);
    // usedAmount = 实付 − 残值：下限只影响**差额**，不影响这条分解（残值高于新价时
    // 超出部分不会退给用户，这是 proration.js 既有的边界口径，见 tests/proration.test.js）
    expect(q.usedAmount).toBeCloseTo(roundToCent(paidAmount - q.creditAmount), 2);
    expect(q.usedAmount).toBeGreaterThan(0);
  });

  it('★核心不变量：试算金额逐分等于随后建单的实收金额', async () => {
    await seedActiveSubscription({
      planId: plan.Pro.id,
      paidAmount: 49.5,
      daysRemaining: 15,
      cycleDays: 30,
    });

    const q = await quote({ planId: plan.Enterprise.id, billingCycle: 'monthly' });
    expect(q.status).toBe(200);

    const co = await request(app)
      .post('/api/payments/create-order')
      .set(auth)
      .send({ planId: plan.Enterprise.id, billingCycle: 'monthly' });
    expect(co.status).toBe(200);

    // toBe 而非 toBeCloseTo：这里要的就是「一分都不差」
    expect(Number(co.body.order.amount)).toBe(q.body.quote.finalAmount);
  });

  it('★试算不建单：连调 3 次，payment_orders 计数一动不动', async () => {
    await seedActiveSubscription({
      planId: plan.Pro.id,
      paidAmount: 49.5,
      daysRemaining: 15,
      cycleDays: 30,
    });
    const before = await countOrders();

    for (let i = 0; i < 3; i += 1) {
      const res = await quote({ planId: plan.Enterprise.id, billingCycle: 'monthly' });
      expect(res.status).toBe(200);
    }

    expect(await countOrders()).toBe(before);
  });
});

describe('升级试算 · 赠期订阅（有 active、无支付订单）', () => {
  it('creditSource 必须是 plan，且不允许把标价说成实付', async () => {
    await seedActiveSubscription({
      planId: plan.Pro.id,
      paidAmount: null,
      daysRemaining: 15,
      cycleDays: 30,
    });

    const res = await quote({ planId: plan.Enterprise.id, billingCycle: 'monthly' });
    expect(res.status).toBe(200);
    const q = res.body.quote;

    // 没有支付记录 ⇒ 折抵基准回退套餐标价，并如实标注来源
    expect(q.creditSource).toBe('plan');
    expect(q.paidAmount).toBeCloseTo(plan.Pro.monthly, 2);
    // 折抵不得超过实付口径的基准金额
    expect(q.creditAmount).toBeLessThanOrEqual(roundToCent(plan.Pro.monthly));
    expect(q.usedAmount).toBeGreaterThanOrEqual(0);
    expect(roundToCent(q.usedAmount + q.creditAmount)).toBeCloseTo(plan.Pro.monthly, 2);
  });

  it('赠期订阅的试算金额同样等于实收金额', async () => {
    await seedActiveSubscription({
      planId: plan.Pro.id,
      paidAmount: null,
      daysRemaining: 15,
      cycleDays: 30,
    });

    const q = await quote({ planId: plan.Enterprise.id, billingCycle: 'monthly' });
    const co = await request(app)
      .post('/api/payments/create-order')
      .set(auth)
      .send({ planId: plan.Enterprise.id, billingCycle: 'monthly' });
    expect(q.status).toBe(200);
    expect(co.status).toBe(200);
    expect(Number(co.body.order.amount)).toBe(q.body.quote.finalAmount);
  });
});

describe('升级试算 · 无 active 订阅（全价新订）', () => {
  it('无折抵字段为 0/null，差额 = 套餐标价', async () => {
    const res = await quote({ planId: plan.Enterprise.id, billingCycle: 'monthly' });
    expect(res.status).toBe(200);
    const q = res.body.quote;

    expect(q.creditAmount).toBe(0);
    expect(q.finalAmount).toBeCloseTo(plan.Enterprise.monthly, 2);
    expect(q.originalPrice).toBeCloseTo(plan.Enterprise.monthly, 2);
    expect(q.paidAmount).toBeNull();
    expect(q.usedAmount).toBeNull();
    expect(q.creditSource).toBeNull();
    expect(q.remainingDays).toBeNull();
    expect(q.currentPeriodEnd).toBeNull();
  });

  it('年付按 price_yearly 计价（与 create-order 同口径）', async () => {
    const q = await quote({ planId: plan.Enterprise.id, billingCycle: 'yearly' });
    expect(q.status).toBe(200);
    expect(q.body.quote.finalAmount).toBeCloseTo(roundToCent(plan.Enterprise.yearly), 2);
    expect(q.body.quote.billingCycle).toBe('yearly');
  });
});

describe('升级试算 · 失败形状与 create-order 完全一致', () => {
  it('同套餐 → 409 ALREADY_SUBSCRIBED（带上 subscriptionId）', async () => {
    const { subscriptionId } = await seedActiveSubscription({
      planId: plan.Pro.id,
      paidAmount: 0.01,
      daysRemaining: 20,
      cycleDays: 30,
    });

    const res = await quote({ planId: plan.Pro.id, billingCycle: 'monthly' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_SUBSCRIBED');
    expect(res.body.subscriptionId).toBe(subscriptionId);
  });

  it('降档 → 409 DOWNGRADE_NOT_ALLOWED', async () => {
    await seedActiveSubscription({
      planId: plan.Enterprise.id,
      paidAmount: 19.9,
      daysRemaining: 20,
      cycleDays: 30,
    });

    const res = await quote({ planId: plan.Pro.id, billingCycle: 'monthly' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOWNGRADE_NOT_ALLOWED');
  });

  it('0 元套餐 → 400 PLAN_PRICE_MISSING（绝不产出 0 元单）', async () => {
    const res = await quote({ planId: plan.Free.id, billingCycle: 'monthly' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PLAN_PRICE_MISSING');
  });

  it('缺 planId → 400', async () => {
    const res = await quote({ billingCycle: 'monthly' });
    expect(res.status).toBe(400);
  });

  it('不存在的 planId → 404 Plan not found', async () => {
    const res = await quote({
      planId: '00000000-0000-0000-0000-0000000000ff',
      billingCycle: 'monthly',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Plan not found');
  });

  it('未认证 → 401', async () => {
    const res = await request(app)
      .post('/api/payments/upgrade-quote')
      .send({ planId: plan.Enterprise.id });
    expect(res.status).toBe(401);
  });
});
