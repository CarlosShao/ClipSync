import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import pool from '../src/db/pool.js';
import { getTestApp, authHeaders } from './test-helpers.js';

/**
 * GET /api/subscriptions/current 的 `purchaseBacked`（2026-10-05 owner 实测反馈）
 *
 * 现场：管理台给一个**从未付过钱**的账号赠期了一个月 Pro，桌面端「个人资料 → 套餐管理」
 * 立刻出现了「申请退款」入口；点开只有一堆不可退的历史单。
 *
 * 根因：入口判据是客户端算的 `paidActive` —— 它拿**套餐目录价 > 0** 推出来
 * （useSubscriptionAccess.ts:182），所以赠期/试用出来的订阅和真金白银买的订阅长得一模一样。
 *
 * 修法：把「有没有付过钱」这件事放回服务端判定，判据直接复用自助退款锚点查询
 * （refundPolicy.findSelfRefundAnchorOrderId）—— 于是「入口可见」与「服务端认为存在
 * 可退锚点」永远是同一个谓词。本文件逐场景钉住这个谓词。
 */

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
// users.phone 是 varchar(20)，测试手机号必须短于它（加了前缀很容易超长）
const TEST_PHONE = '+86test-purbak-01';

let app;
let proPlanId = null;

async function cleanupUserState() {
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

/** 造一条订阅；endOffsetDays 为负表示已过期 */
async function seedSubscription({ planId, status = 'active', endOffsetDays = 30 }) {
  const res = await pool.query(
    `INSERT INTO user_subscriptions
       (user_id, plan_id, status, billing_cycle, start_date, end_date,
        current_period_start, current_period_end, created_at, updated_at)
     VALUES ($1, $2, $3, 'monthly',
             NOW() - INTERVAL '1 day',
             NOW() + INTERVAL '${endOffsetDays} day',
             NOW() - INTERVAL '1 day',
             NOW() + INTERVAL '${endOffsetDays} day',
             NOW(), NOW())
     RETURNING id`,
    [TEST_USER_ID, planId, status]
  );
  return res.rows[0].id;
}

async function seedOrder({ planId, subscriptionId, status = 'paid', amount = 49.5 }) {
  const orderNo = `ORDTEST${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  await pool.query(
    `INSERT INTO payment_orders
       (user_id, subscription_id, plan_id, order_no, amount, currency, payment_method,
        payment_channel, status, paid_at, created_at, updated_at, metadata)
     VALUES ($1, $2, $3, $4, $5, 'CNY', 'alipay', 'alipay', $6, NOW(), NOW(), NOW(), '{}')`,
    [TEST_USER_ID, subscriptionId, planId, orderNo, amount, status]
  );
}

async function fetchCurrent() {
  const res = await request(app).get('/api/subscriptions/current').set(authHeaders());
  expect(res.status).toBe(200);
  return res.body;
}

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[purchase-backed] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }

  const { app: loaded } = await getTestApp();
  app = loaded;

  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, created_at, updated_at)
     VALUES ($1, $2, '赠期判据测试用户', 'test_hash', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, TEST_PHONE]
  );

  const p = await pool.query(
    `SELECT id FROM subscription_plans WHERE name = $1 AND is_active = true`,
    ['Pro']
  );
  if (p.rows.length === 0) throw new Error('[purchase-backed] 缺少 Pro 套餐种子数据');
  proPlanId = p.rows[0].id;

  await cleanupUserState();
}, 60000);

beforeEach(async () => {
  await cleanupUserState();
});

afterAll(async () => {
  await cleanupUserState().catch(() => {});
  await pool.end().catch(() => {});
});

describe('purchaseBacked：赠期出来的订阅不得冒出退款入口', () => {
  it('无任何订阅 → false', async () => {
    const body = await fetchCurrent();
    expect(body.subscription).toBeNull();
    expect(body.purchaseBacked).toBe(false);
  });

  it('★赠期场景：active 订阅但没有任何支付订单 → false', async () => {
    // 这正是现场：管理台 UPDATE user_subscriptions SET plan_id=pro, status='active'
    // 赠期不需要用户付过钱，所以订阅长得跟真买的一样（客户端 paidActive 也为 true）
    await seedSubscription({ planId: proPlanId, endOffsetDays: 30 });

    const body = await fetchCurrent();
    expect(body.subscription).not.toBeNull();
    expect(body.subscription.status).toBe('active');
    // 关键断言：服务端必须说「没人付过钱」
    expect(body.purchaseBacked).toBe(false);
  });

  it('真实已付订单支撑的 active 订阅 → true', async () => {
    const subId = await seedSubscription({ planId: proPlanId, endOffsetDays: 30 });
    await seedOrder({ planId: proPlanId, subscriptionId: subId, status: 'paid' });

    const body = await fetchCurrent();
    expect(body.purchaseBacked).toBe(true);
  });

  it('订单已退款（status=refunded）不算付过钱 → false', async () => {
    const subId = await seedSubscription({ planId: proPlanId, endOffsetDays: 30 });
    await seedOrder({ planId: proPlanId, subscriptionId: subId, status: 'refunded' });

    const body = await fetchCurrent();
    expect(body.purchaseBacked).toBe(false);
  });

  it('订阅已过期（period_end 在过去）→ false', async () => {
    const subId = await seedSubscription({ planId: proPlanId, endOffsetDays: -1 });
    await seedOrder({ planId: proPlanId, subscriptionId: subId, status: 'paid' });

    const body = await fetchCurrent();
    expect(body.purchaseBacked).toBe(false);
  });

  it('订阅已 canceled → false', async () => {
    const subId = await seedSubscription({
      planId: proPlanId,
      status: 'canceled',
      endOffsetDays: 30,
    });
    await seedOrder({ planId: proPlanId, subscriptionId: subId, status: 'paid' });

    const body = await fetchCurrent();
    expect(body.purchaseBacked).toBe(false);
  });

  it('有已付订单但挂在别的订阅上 → false（锚点必须指向当前生效订阅）', async () => {
    // 当前生效订阅：赠期出来的，没有订单
    await seedSubscription({ planId: proPlanId, endOffsetDays: 30 });
    // 另一条历史订阅 + 它的已付订单
    const otherSubId = await seedSubscription({
      planId: proPlanId,
      status: 'canceled',
      endOffsetDays: -10,
    });
    await seedOrder({ planId: proPlanId, subscriptionId: otherSubId, status: 'paid' });

    const body = await fetchCurrent();
    expect(body.purchaseBacked).toBe(false);
  });
});
