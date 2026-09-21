import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import pool from '../src/db/pool.js';
import { getTestApp } from './test-helpers.js';
import { invalidateFlagsCache } from '../src/utils/featureFlags.js';
import { clearRefundSettingsCache } from '../src/services/refundPolicy.js';
import {
  approveRefundRequest,
  rejectRefundRequest,
  listRefundRequestsForAdmin,
} from '../src/services/refundRequest.js';

/**
 * 两段式退款（任务板 #40~#43）：申请不动钱、审核才动钱。
 *
 * 钉死的资金不变量：
 *   1. **申请阶段零渠道调用**：POST /refund-request 之后 fetch 桩一次都没被调过，
 *      订单必须还是 paid（refunded 只能表示"款已退出去"，这条对账不变量不能让
 *      "申请中"污染）；
 *   2. 申请即收回权益：订阅 canceled + users 按剩余生效订阅重算（回 free）；
 *   3. 一条订单只允许一个在途申请（部分唯一索引兜并发双击）；
 *   4. 时限后台可配：改 system_configs 之后 3 天前的单从"可退"变"超窗"；
 *   5. 审核通过才真打款（stub 网关），重复审核不会退第二次钱；
 *   6. 驳回要还原权益；但用户若已另购新订阅就不还原旧订阅（避免又造出两条 active）。
 *
 * 用户侧走真 HTTP 路由（supertest），审核侧直接调服务层 —— 管理台端点的 HTTP 壳
 * 已有 tests/admin/orders.test.js 的离线范式覆盖，这里要验的是资金与权益语义。
 */

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_PHONE = '+86test-reqref-01';
const OTHER_USER_ID = '00000000-0000-0000-0000-0000000000f2';
const OTHER_PHONE = '+86test-reqref-oth1';
const ENV_KEYS = ['ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY'];
const REFUND_KEY = 'alipay_trade_refund_response';
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** 与 payment-refund.test.js 同口径：签响应节点的**值**，不含 "key": 前缀 */
function stubGatewayResponse(payload) {
  const valueText = JSON.stringify(payload);
  const body = `{"${REFUND_KEY}":${valueText},"sign":"${signWith(valueText)}"}`;
  const fn = vi.fn(async () => ({ text: async () => body }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const savedEnv = {};
let app;

async function seedOrder({
  status = 'paid',
  paymentMethod = 'alipay',
  amount = 9.9,
  withSubscription = true,
  subscriptionId: existingSubscriptionId = null,
  userId = TEST_USER_ID,
  paidAt,
} = {}) {
  let subscriptionId = existingSubscriptionId || null;
  // 显式给了 subscriptionId = 这笔单挂在既有订阅上（模拟同一订阅下的连续续费单）
  if (!subscriptionId && withSubscription) {
    const sub = await pool.query(
      `INSERT INTO user_subscriptions
         (user_id, plan_id, status, billing_cycle, start_date, end_date,
          current_period_start, current_period_end, created_at, updated_at)
       VALUES ($1, (SELECT id FROM subscription_plans WHERE name = 'Pro'),
               'active', 'monthly', NOW(), NOW() + INTERVAL '1 month',
               NOW(), NOW() + INTERVAL '30 day', NOW(), NOW())
       RETURNING id`,
      [userId]
    );
    subscriptionId = sub.rows[0].id;
    await pool.query('UPDATE users SET subscription_status = $2, current_subscription_id = $1 WHERE id = $3', [
      subscriptionId,
      'pro',
      userId,
    ]);
  }
  const orderNo = `ORDRQ${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const order = await pool.query(
    `INSERT INTO payment_orders
       (user_id, subscription_id, plan_id, order_no, amount, currency,
        payment_method, payment_channel, status, paid_at, transaction_id, created_at, updated_at, metadata)
     VALUES ($1, $2, (SELECT id FROM subscription_plans WHERE name = 'Pro'), $3, $4, 'CNY',
             $5, $5, $6, $7, '202609202200000000', NOW(), NOW(), '{}'::jsonb)
     RETURNING id, order_no`,
    [
      userId,
      subscriptionId,
      orderNo,
      amount,
      paymentMethod,
      status,
      status === 'paid' || status === 'refunded' ? (paidAt === undefined ? new Date() : paidAt) : null,
    ]
  );
  return { orderId: order.rows[0].id, orderNo: order.rows[0].order_no, subscriptionId };
}

const readRow = async (sql, params) => (await pool.query(sql, params)).rows[0];
const readOrder = (id) => readRow('SELECT * FROM payment_orders WHERE id = $1', [id]);
const readSub = (id) => (id ? readRow('SELECT * FROM user_subscriptions WHERE id = $1', [id]) : null);
const readUser = (id = TEST_USER_ID) =>
  readRow('SELECT subscription_status, current_subscription_id FROM users WHERE id = $1', [id]);
const readRequest = (orderId) =>
  readRow('SELECT * FROM refund_requests WHERE order_id = $1 ORDER BY requested_at DESC LIMIT 1', [orderId]);

/** 直接写配置表（等价管理台 PUT /api/admin/refund-settings），并失效读侧 TTL 缓存 */
async function setRefundConfig({ windowDays, reviewBusinessDays }) {
  const pairs = [
    ['refund_self_window_days', windowDays],
    ['refund_review_business_days', reviewBusinessDays],
  ].filter(([, v]) => v !== undefined);
  for (const [key, value] of pairs) {
    await pool.query(
      `UPDATE system_configs SET config_value = to_jsonb($2::text) WHERE config_key = $1`,
      [key, String(value)]
    );
  }
  clearRefundSettingsCache();
}

async function cleanup() {
  for (const userId of [TEST_USER_ID, OTHER_USER_ID]) {
    await pool.query('DELETE FROM refund_requests WHERE user_id = $1', [userId]).catch(() => {});
    await pool.query('DELETE FROM payment_orders WHERE user_id = $1', [userId]).catch(() => {});
    await pool.query('DELETE FROM user_subscriptions WHERE user_id = $1', [userId]).catch(() => {});
  }
  await setRefundConfig({ windowDays: 7, reviewBusinessDays: 3 });
}

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[refund-request] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }
  app = (await getTestApp()).app;

  for (const [id, phone, nick] of [
    [TEST_USER_ID, TEST_PHONE, '两段式退款测试用户'],
    [OTHER_USER_ID, OTHER_PHONE, '两段式退款他人用户'],
  ]) {
    await pool.query(
      `INSERT INTO users (id, phone, nickname, password_hash, subscription_status, created_at, updated_at)
       VALUES ($1, $2, $3, 'test_hash', 'free', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [id, phone, nick]
    );
  }
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ALIPAY_APP_ID = '2021000000000000';
  process.env.ALIPAY_PRIVATE_KEY = PRIV;
  process.env.ALIPAY_PUBLIC_KEY = PUB;
}, 60000);

beforeEach(async () => {
  await cleanup();
  await pool.query(
    "UPDATE users SET subscription_status = 'free', current_subscription_id = NULL WHERE id = $1",
    [TEST_USER_ID]
  );
  await pool.query('UPDATE feature_flags SET enabled = true, updated_at = NOW() WHERE flag_key = $1', [
    'enable_subscription',
  ]);
  invalidateFlagsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await cleanup().catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [OTHER_USER_ID]).catch(() => {});
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await pool.end().catch(() => {});
});

describe('POST /api/payments/refund-request · 申请阶段绝不动钱', () => {
  it('申请成功 → 201：订单仍 paid、订阅 canceled、用户回 free、渠道零调用', async () => {
    const { orderId, orderNo, subscriptionId } = await seedOrder();
    const fn = stubGatewayResponse({ code: '10000', msg: 'Success' });

    const res = await request(app).post('/api/payments/refund-request').send({ orderNo, reason: '用不上' });

    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ orderNo, status: 'pending', amount: 9.9 });
    expect(res.body.reviewBusinessDays).toBe(3);
    // 最关键的一条：申请阶段一次渠道调用都不许有
    expect(fn).not.toHaveBeenCalled();

    expect((await readOrder(orderId)).status).toBe('paid');
    expect((await readSub(subscriptionId)).status).toBe('canceled');
    expect(await readUser()).toMatchObject({ subscription_status: 'free', current_subscription_id: null });

    const rr = await readRequest(orderId);
    expect(rr.status).toBe('pending');
    expect(rr.entitlement_snapshot.subscriptionId).toBe(String(subscriptionId));
    expect(rr.entitlement_snapshot.currentPeriodEnd).toBeTruthy();
  });

  it('同一订单重复申请 → 409 REFUND_REQUEST_PENDING，且只有一条在途申请', async () => {
    const { orderId, orderNo } = await seedOrder();
    stubGatewayResponse({ code: '10000' });

    await request(app).post('/api/payments/refund-request').send({ orderNo });
    const again = await request(app).post('/api/payments/refund-request').send({ orderNo });

    expect(again.status).toBe(409);
    expect(again.body.code).toBe('REFUND_REQUEST_PENDING');
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM refund_requests WHERE order_id = $1 AND status = 'pending'",
      [orderId]
    );
    expect(rows[0].n).toBe(1);
  });

  it('别人的订单 → 404 ORDER_NOT_FOUND（与「不存在」同壳，防探测）', async () => {
    const { orderNo } = await seedOrder({ userId: OTHER_USER_ID });
    const fn = stubGatewayResponse({ code: '10000' });

    const res = await request(app).post('/api/payments/refund-request').send({ orderNo });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ORDER_NOT_FOUND');
    expect(fn).not.toHaveBeenCalled();
  });

  it('超时限 → 409 REFUND_WINDOW_EXPIRED，extra 带 paidAt/windowDays', async () => {
    const paidAt = new Date(Date.now() - 10 * DAY_MS);
    const { orderId } = await seedOrder({ paidAt });
    const fn = stubGatewayResponse({ code: '10000' });

    const res = await request(app).post('/api/payments/refund-request').send({ orderId });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REFUND_WINDOW_EXPIRED');
    expect(res.body.windowDays).toBe(7);
    expect(fn).not.toHaveBeenCalled();
    expect(await readRequest(orderId)).toBeUndefined();
  });

  it('不是当前生效订阅的锚点单 → 409 NOT_CURRENT_SUB_ORDER（防顺移退历史单）', async () => {
    const older = await seedOrder({ paidAt: new Date(Date.now() - 2 * DAY_MS) });
    const newer = await seedOrder({ paidAt: new Date() });
    stubGatewayResponse({ code: '10000' });

    const res = await request(app).post('/api/payments/refund-request').send({ orderNo: older.orderNo });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_CURRENT_SUB_ORDER');
    // 新单仍是锚点，可以退
    const ok = await request(app).post('/api/payments/refund-request').send({ orderNo: newer.orderNo });
    expect(ok.status).toBe(201);
  });

  it('非支付宝渠道 → 409 CHANNEL_UNSUPPORTED（不退也申请不了）', async () => {
    const { orderNo } = await seedOrder({ paymentMethod: 'stripe' });
    const fn = stubGatewayResponse({ code: '10000' });

    const res = await request(app).post('/api/payments/refund-request').send({ orderNo });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHANNEL_UNSUPPORTED');
    expect(fn).not.toHaveBeenCalled();
  });

  it('缺 orderNo/orderId → 400', async () => {
    const res = await request(app).post('/api/payments/refund-request').send({});
    expect(res.status).toBe(400);
  });
});

describe('退款时限改为后台可配置', () => {
  it('时限配成 3 天后，5 天前的单从「可退」变「超窗」；配成 30 天则放行', async () => {
    const paidAt = new Date(Date.now() - 5 * DAY_MS);
    const first = await seedOrder({ paidAt });
    stubGatewayResponse({ code: '10000' });

    await setRefundConfig({ windowDays: 3 });
    const denied = await request(app).post('/api/payments/refund-request').send({ orderNo: first.orderNo });
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe('REFUND_WINDOW_EXPIRED');
    expect(denied.body.windowDays).toBe(3);

    await setRefundConfig({ windowDays: 30 });
    const allowed = await request(app).post('/api/payments/refund-request').send({ orderNo: first.orderNo });
    expect(allowed.status).toBe(201);
    expect(allowed.body.request.windowDaysAtRequest).toBe(30);
  });

  it('列表接口的 windowDays / reviewBusinessDays 跟着配置走', async () => {
    await seedOrder();
    await setRefundConfig({ windowDays: 2, reviewBusinessDays: 5 });

    const res = await request(app).get('/api/payments/refundable-orders');

    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(2);
    expect(res.body.reviewBusinessDays).toBe(5);
  });
});

describe('GET /api/payments/refundable-orders · 在途申请标注', () => {
  it('申请后该单 refundable=false + REFUND_REQUEST_PENDING + refundRequest 带 id；其它单不受影响', async () => {
    const older = await seedOrder({ paidAt: new Date(Date.now() - 2 * DAY_MS) });
    // 同一订阅挂两笔已付单（真实续费形态）：新单才是锚点
    const newer = await seedOrder({ paidAt: new Date(), subscriptionId: older.subscriptionId });
    stubGatewayResponse({ code: '10000' });
    const submitted = await request(app).post('/api/payments/refund-request').send({ orderNo: newer.orderNo });
    expect(submitted.status).toBe(201);

    const res = await request(app).get('/api/payments/refundable-orders');
    const byNo = Object.fromEntries(res.body.orders.map((o) => [o.orderNo, o]));

    expect(byNo[newer.orderNo]).toMatchObject({ refundable: false, reasonCode: 'REFUND_REQUEST_PENDING' });
    expect(byNo[newer.orderNo].refundRequest).toMatchObject({
      id: submitted.body.request.id,
      status: 'pending',
    });
    // 锚点随订阅 canceled 消失：旧单也不会因此变成可退
    expect(byNo[older.orderNo].refundable).toBe(false);
    expect(byNo[older.orderNo].refundRequest).toBeNull();
  });

  it('GET /refund-requests/mine 只回自己的申请', async () => {
    const mine = await seedOrder();
    stubGatewayResponse({ code: '10000' });
    await request(app).post('/api/payments/refund-request').send({ orderNo: mine.orderNo });

    const res = await request(app).get('/api/payments/refund-requests/mine');

    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0]).toMatchObject({ orderNo: mine.orderNo, status: 'pending' });
  });
});

describe('审核通过才真打款', () => {
  it('approve → 渠道被调一次、订单 refunded、申请 approved', async () => {
    const { orderId, orderNo, subscriptionId } = await seedOrder();
    const submitted = await request(app).post('/api/payments/refund-request').send({ orderNo });
    const requestId = submitted.body.request.id;

    const fn = stubGatewayResponse({ code: '10000', msg: 'Success', refund_fee: '9.90' });
    const result = await approveRefundRequest({ requestId, actorUserId: OTHER_USER_ID, reason: 'ok' });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.order).toMatchObject({ orderNo, status: 'refunded', refundAmount: 9.9 });
    expect((await readOrder(orderId)).status).toBe('refunded');
    expect((await readSub(subscriptionId)).status).toBe('canceled');
    expect((await readRequest(orderId)).status).toBe('approved');
  });

  it('重复审核 → 第二次 409 且渠道不再被调（不会退两次钱）', async () => {
    const { orderId, orderNo } = await seedOrder();
    const submitted = await request(app).post('/api/payments/refund-request').send({ orderNo });

    stubGatewayResponse({ code: '10000', refund_fee: '9.90' });
    await approveRefundRequest({ requestId: submitted.body.request.id, actorUserId: OTHER_USER_ID });

    const fn = stubGatewayResponse({ code: '10000', refund_fee: '9.90' });
    await expect(
      approveRefundRequest({ requestId: submitted.body.request.id, actorUserId: OTHER_USER_ID })
    ).rejects.toMatchObject({ code: 'REFUND_REQUEST_NOT_PENDING' });
    expect(fn).not.toHaveBeenCalled();
    expect((await readOrder(orderId)).status).toBe('refunded');
  });

  it('渠道失败 → 申请退回 pending（管理员可重试），订单保持 paid、权益不恢复', async () => {
    const { orderId, subscriptionId } = await seedOrder();
    const submitted = await request(app)
      .post('/api/payments/refund-request')
      .send({ orderNo: (await readOrder(orderId)).order_no });

    const fn = stubGatewayResponse({ code: '40004', msg: 'Business Failed', sub_code: 'REFUND_AMOUNT_EXCEED' });
    await expect(
      approveRefundRequest({ requestId: submitted.body.request.id, actorUserId: OTHER_USER_ID })
    ).rejects.toMatchObject({ status: 502, code: 'REFUND_CHANNEL_FAILED' });
    expect(fn).toHaveBeenCalledTimes(1);

    expect((await readOrder(orderId)).status).toBe('paid');
    expect((await readRequest(orderId)).status).toBe('pending');
    expect((await readSub(subscriptionId)).status).toBe('canceled');
    expect((await readUser()).subscription_status).toBe('free');
  });
});

describe('驳回要还原权益', () => {
  it('驳回 → 订阅回 active、用户回 pro、申请 rejected、订单仍 paid', async () => {
    const { orderId, orderNo, subscriptionId } = await seedOrder();
    const submitted = await request(app).post('/api/payments/refund-request').send({ orderNo });

    const fn = stubGatewayResponse({ code: '10000' });
    const result = await rejectRefundRequest({
      requestId: submitted.body.request.id,
      actorUserId: OTHER_USER_ID,
      reason: '已使用超过 3 天，协商部分退款',
    });

    expect(fn).not.toHaveBeenCalled();
    expect(result.entitlementRestored).toBe(true);
    expect((await readSub(subscriptionId)).status).toBe('active');
    expect(await readUser()).toMatchObject({ subscription_status: 'pro' });
    expect((await readOrder(orderId)).status).toBe('paid');
    expect((await readRequest(orderId))).toMatchObject({ status: 'rejected' });
  });

  it('驳回时必须带理由，否则 400', async () => {
    const { orderNo } = await seedOrder();
    const submitted = await request(app).post('/api/payments/refund-request').send({ orderNo });

    await expect(
      rejectRefundRequest({ requestId: submitted.body.request.id, actorUserId: OTHER_USER_ID })
    ).rejects.toMatchObject({ status: 400, code: 'REFUND_REJECT_REASON_REQUIRED' });
  });

  it('用户在审核期间又买了新订阅 → 不还原旧订阅（绝不制造两条 active）', async () => {
    const old = await seedOrder();
    const submitted = await request(app).post('/api/payments/refund-request').send({ orderNo: old.orderNo });

    // 模拟用户重新下单并履约成功：新订阅 active，users 指向新订阅
    const fresh = await seedOrder({ paidAt: new Date() });
    await pool.query('UPDATE users SET subscription_status = $2, current_subscription_id = $1 WHERE id = $3', [
      fresh.subscriptionId,
      'pro',
      TEST_USER_ID,
    ]);

    const result = await rejectRefundRequest({
      requestId: submitted.body.request.id,
      actorUserId: OTHER_USER_ID,
      reason: '已另购新套餐',
    });

    expect(result.entitlementRestored).toBe(false);
    expect((await readSub(old.subscriptionId)).status).toBe('canceled');
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM user_subscriptions WHERE user_id = $1 AND status = 'active' AND current_period_end > NOW()",
      [TEST_USER_ID]
    );
    expect(rows[0].n).toBe(1);
    expect((await readUser()).current_subscription_id).toBe(String(fresh.subscriptionId));
  });
});

describe('管理台审核列表查询', () => {
  it('pending 列表带出用户/套餐/订单信息；通过后 reviewedByName 出现在 approved 列表', async () => {
    const { orderNo } = await seedOrder();
    stubGatewayResponse({ code: '10000', refund_fee: '9.90' });
    const submitted = await request(app).post('/api/payments/refund-request').send({ orderNo });

    const pending = await listRefundRequestsForAdmin({ status: 'pending' });
    expect(pending.total).toBe(1);
    // 不断言 userName 的具体值：TEST_USER_ID 是多套测试共用的账号行（昵称会被别的
    // 文件写成别的名字），这里只要求 JOIN 真的取到了列 —— 列名写错会直接 500/undefined
    expect(pending.items[0]).toMatchObject({
      orderNo,
      status: 'pending',
      amount: 9.9,
      planName: 'Pro',
      userId: TEST_USER_ID,
    });
    expect(typeof pending.items[0].userName).toBe('string');

    await approveRefundRequest({ requestId: submitted.body.request.id, actorUserId: OTHER_USER_ID });

    const approved = await listRefundRequestsForAdmin({ status: 'approved' });
    expect(approved.items[0]).toMatchObject({
      orderNo,
      status: 'approved',
      reviewedByName: '两段式退款他人用户',
    });

    // 'all' 不过滤 + 分页参数生效（全程只有这一条申请：pending 与 approved 是同一行的前后态）
    const all = await listRefundRequestsForAdmin({ status: 'all', page: 1, pageSize: 1 });
    expect(all.pageSize).toBe(1);
    expect(all.total).toBe(1);
    expect(all.items).toHaveLength(1);
  });
});
