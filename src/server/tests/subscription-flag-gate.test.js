import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import pool from '../src/db/pool.js';
import { getTestApp } from './test-helpers.js';
import { invalidateFlagsCache, isFlagEnforced } from '../src/utils/featureFlags.js';

/**
 * §4-F2：enable_subscription 开关的服务端强制点（真库 clipsync_test）
 *
 * 修前的样子：管理台把「启用订阅功能」关掉，只影响权益判定
 * （planFeature / subscriptionCheck 按 Free 处理），**收钱链路完全不看它** ——
 * 老客户端或直接 curl 照样 POST /api/payments/create-order 建单收款、
 * 照样退款。即矩阵 F2 那一行「钱照常收」= 开关关不死支付。
 *
 * 修后：create-order 与 refund 各有一道闸，关闭时 503 { code:'SUBSCRIPTION_DISABLED' }。
 * 本文件锁三件事：
 *   1. 关闭时两条端点都 503，且**库里一条订单都不多**（不是先建单再报错）；
 *   2. 打开后立刻恢复（同一套凭据、同一入参 → create-order 200），
 *      证明闸只认开关，不会把正常支付链路误杀；
 *   3. AN-10 自检：enable_subscription 在 featureFlags 的强制点扫描里必须是 true
 *      （否则管理台 flags 接口的 enforced 会如实报 false，等于又回到「有开关无强制点」）。
 *
 * 顺序细节：/refund 的闸在**权限判定之后** —— 未授权调用方只能看到 404
 * （「不存在」与「不是你的单」同壳，2026-09-19 属主自助退款上线后的口径），
 * 不会从 503 里读出「这个功能被关了」。
 */

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_PHONE = '+86test-flaggate1';
const ENV_KEYS = ['ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY', 'ALIPAY_NOTIFY_URL'];

const { privateKey: PRIV, publicKey: PUB } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

let app;
let planId = null;
let wasAdmin = false;
const savedEnv = {};

/** 直接写库切开关 + 失效本进程缓存（等价管理台 PATCH /api/admin/flags/:key） */
async function setFlag(key, enabled) {
  await pool.query(
    'UPDATE feature_flags SET enabled = $2, updated_at = NOW() WHERE flag_key = $1',
    [key, enabled]
  );
  invalidateFlagsCache();
}

async function countOrders() {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM payment_orders WHERE user_id = $1',
    [TEST_USER_ID]
  );
  return rows[0].n;
}

async function cleanup() {
  await pool.query('DELETE FROM invoices WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM payment_orders WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM user_subscriptions WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
}

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[subscription-flag-gate] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }

  app = (await getTestApp()).app;

  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, subscription_status, created_at, updated_at)
     VALUES ($1, $2, '开关闸测试用户', 'test_hash', 'free', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, TEST_PHONE]
  );
  const u = await pool.query('SELECT is_admin FROM users WHERE id = $1', [TEST_USER_ID]);
  wasAdmin = Boolean(u.rows[0]?.is_admin);

  const { rows } = await pool.query(`SELECT id FROM subscription_plans WHERE name = 'Pro'`);
  planId = rows[0]?.id;
  if (!planId) throw new Error('[subscription-flag-gate] 缺少 Pro 套餐种子数据');

  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ALIPAY_APP_ID = '2021000000000000';
  process.env.ALIPAY_PRIVATE_KEY = PRIV;
  process.env.ALIPAY_PUBLIC_KEY = PUB;
  process.env.ALIPAY_NOTIFY_URL = 'https://api.example.test/api/webhooks/alipay';

  await cleanup();
}, 60000);

beforeEach(async () => {
  await pool.query(
    `UPDATE users SET is_admin = true, subscription_status = 'free', current_subscription_id = NULL WHERE id = $1`,
    [TEST_USER_ID]
  );
  await setFlag('enable_subscription', true);
  await cleanup();
});

afterAll(async () => {
  await setFlag('enable_subscription', true).catch(() => {});
  await cleanup().catch(() => {});
  await pool
    .query('UPDATE users SET is_admin = $1 WHERE id = $2', [wasAdmin, TEST_USER_ID])
    .catch(() => {});
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await pool.end().catch(() => {});
});

describe('enable_subscription 关闭 → 收钱链路必须关门（F2）', () => {
  it('create-order 503 SUBSCRIPTION_DISABLED，且库里不多一张 pending 单', async () => {
    await setFlag('enable_subscription', false);
    const before = await countOrders();

    const res = await request(app).post('/api/payments/create-order').send({ planId });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SUBSCRIPTION_DISABLED');
    expect(res.body.error).toBeTruthy();
    expect(res.body.flagDisabled).toBe('enable_subscription');
    expect(await countOrders()).toBe(before);
  });

  it('mock 渠道也一样被拦（关开关后不能留一条「白送订阅」的后门）', async () => {
    await setFlag('enable_subscription', false);
    const sub = await pool.query(
      `INSERT INTO user_subscriptions
         (user_id, plan_id, status, billing_cycle, start_date, end_date,
          current_period_start, current_period_end, created_at, updated_at)
       VALUES ($1, $2, 'expired', 'monthly', NOW(), NOW(), NOW(), NOW(), NOW(), NOW())
       RETURNING id`,
      [TEST_USER_ID, planId]
    );

    const before = await countOrders();
    const res = await request(app)
      .post('/api/payments/create-order')
      .send({ subscriptionId: sub.rows[0].id, paymentMethod: 'mock' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SUBSCRIPTION_DISABLED');
    expect(await countOrders()).toBe(before);
  });

  it('refund 503 SUBSCRIPTION_DISABLED（管理员校验通过之后才判开关）', async () => {
    const { rows } = await pool.query(
      `INSERT INTO payment_orders
         (user_id, plan_id, order_no, amount, currency, payment_method, payment_channel,
          status, paid_at, transaction_id, created_at, updated_at, metadata)
       VALUES ($1, $2, $3, 9.9, 'CNY', 'alipay', 'alipay', 'paid', NOW(), '202609192200000001', NOW(), NOW(), '{}')
       RETURNING order_no`,
      [TEST_USER_ID, planId, `ORDFLG${Date.now()}${Math.random().toString(36).slice(2, 6)}`]
    );
    await setFlag('enable_subscription', false);

    const res = await request(app).post('/api/payments/refund').send({ orderNo: rows[0].order_no });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SUBSCRIPTION_DISABLED');
    const after = await pool.query('SELECT status, refunded_at FROM payment_orders WHERE order_no = $1', [
      rows[0].order_no,
    ]);
    expect(after.rows[0].status).toBe('paid');
    expect(after.rows[0].refunded_at).toBeNull();
  });

  it('非属主（非管理员）即便开关关闭也吃 404（先判权限/存在性，不从 503 泄露功能状态）', async () => {
    await pool.query('UPDATE users SET is_admin = false WHERE id = $1', [TEST_USER_ID]);
    await setFlag('enable_subscription', false);

    const res = await request(app).post('/api/payments/refund').send({ orderNo: 'ORDNOTEXIST000001' });
    // 属主自助退款上线后（2026-09-19），/refund 先定位订单再判权限：
    // 「不存在」与「不是你的单」一律 404 ORDER_NOT_FOUND，未授权调用方永远读不到开关状态
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ORDER_NOT_FOUND');
  });
});

describe('enable_subscription 打开 → 正常链路不受影响', () => {
  it('create-order 恢复 200 并返回收银台 URL（闸不会误杀真实支付）', async () => {
    const res = await request(app)
      .post('/api/payments/create-order')
      .send({ planId, billingCycle: 'monthly' });

    expect(res.status).toBe(200);
    expect(res.body.order.paymentParams.cashierUrl).toContain('openapi.alipay.com/gateway.do');
    expect(await countOrders()).toBe(1);
  });

  it('refund 过闸：不再 503，继续走真实退款的分流校验（此处订单不存在 → 404）', async () => {
    const res = await request(app).post('/api/payments/refund').send({ orderNo: 'ORDNOTEXIST000002' });
    expect(res.status).toBe(404);
    expect(res.body.code).not.toBe('SUBSCRIPTION_DISABLED');
  });

  it('AN-10：开关扫描已认到本端点的强制点（管理台 flags 接口 enforced 才不会被谎报）', async () => {
    expect(isFlagEnforced('enable_subscription')).toBe(true);
  });
});
