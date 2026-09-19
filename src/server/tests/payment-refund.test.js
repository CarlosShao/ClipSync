import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import pool from '../src/db/pool.js';
import { getTestApp } from './test-helpers.js';

/**
 * 真实退款集成测试（POST /api/payments/refund，任务板 #10 第二步）
 *
 * 锁死的四条不变量（都是这条链路出过的事故）：
 *   1. **只有渠道回 fund_status='Y' 才动本地数据**：渠道失败/未知时订单必须还是 paid
 *      （上一版假退款是反过来的：只改库、钱不退，用户"退款成功"但订阅没了）；
 *   2. 退款成功 → 订单 refunded + refunded_at、订阅 canceled + canceled_at、
 *      users 冗余订阅状态回 free（退款即收回权益）；
 *   3. 管理员校验（产品决策：客服通道，无用户自助入口）；
 *   4. 渠道侧幂等：out_request_no 用订单号，且已退款订单二次请求被本地 409 挡住。
 *
 * 离线：支付宝网关用 vi.stubGlobal('fetch') 打桩，响应原文用测试内自生成密钥签名，
 * 因此 callGateway 的**响应验签**是真的在跑（伪造报文会验签失败）。
 */

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_PHONE = '+86test-refund-0001';
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

const savedEnv = {};
let wasAdmin = false;
let app;

async function seedOrder({ status = 'paid', paymentMethod = 'alipay', amount = 9.9, withSubscription = true } = {}) {
  let subscriptionId = null;
  if (withSubscription) {
    const sub = await pool.query(
      `INSERT INTO user_subscriptions
         (user_id, plan_id, status, billing_cycle, start_date, end_date,
          current_period_start, current_period_end, created_at, updated_at)
       VALUES ($1, (SELECT id FROM subscription_plans WHERE name = 'Pro'),
               'active', 'monthly', NOW(), NOW() + INTERVAL '1 month',
               NOW(), NOW() + INTERVAL '30 day', NOW(), NOW())
       RETURNING id`,
      [TEST_USER_ID]
    );
    subscriptionId = sub.rows[0].id;
  }

  const orderNo = `ORDRF${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const order = await pool.query(
    `INSERT INTO payment_orders
       (user_id, subscription_id, plan_id, order_no, amount, currency,
        payment_method, payment_channel, status, paid_at, transaction_id, created_at, updated_at, metadata)
     VALUES ($1, $2, (SELECT id FROM subscription_plans WHERE name = 'Pro'), $3, $4, 'CNY',
             $5, $5, $6, $7, '202609192200000000', NOW(), NOW(), '{}')
     RETURNING id, order_no`,
    [
      TEST_USER_ID,
      subscriptionId,
      orderNo,
      amount,
      paymentMethod,
      status,
      // 只有已支付订单才有 paid_at / 渠道交易号，造数据要贴近真实
      status === 'paid' ? new Date() : null,
    ]
  );
  return { orderId: order.rows[0].id, orderNo: order.rows[0].order_no, subscriptionId };
}

async function readOrder(orderId) {
  const res = await pool.query('SELECT * FROM payment_orders WHERE id = $1', [orderId]);
  return res.rows[0];
}

async function readSubscription(subscriptionId) {
  if (!subscriptionId) return null;
  const res = await pool.query('SELECT * FROM user_subscriptions WHERE id = $1', [subscriptionId]);
  return res.rows[0];
}

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[payment-refund] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }

  const loaded = await getTestApp();
  app = loaded.app;

  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, subscription_status, created_at, updated_at)
     VALUES ($1, $2, '退款测试用户', 'test_hash', 'free', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, TEST_PHONE]
  );
  const u = await pool.query('SELECT is_admin FROM users WHERE id = $1', [TEST_USER_ID]);
  wasAdmin = Boolean(u.rows[0]?.is_admin);

  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ALIPAY_APP_ID = '2021000000000000';
  process.env.ALIPAY_PRIVATE_KEY = PRIV;
  process.env.ALIPAY_PUBLIC_KEY = PUB;
}, 60000);

beforeEach(async () => {
  await pool.query('DELETE FROM invoices WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM payment_orders WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM user_subscriptions WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query("UPDATE users SET is_admin = true, subscription_status = 'free', current_subscription_id = NULL WHERE id = $1", [TEST_USER_ID]);
  // 凭据类用例会在用例内改 env，这里统一复位，避免污染后续用例
  process.env.ALIPAY_APP_ID = '2021000000000000';
  process.env.ALIPAY_PRIVATE_KEY = PRIV;
  process.env.ALIPAY_PUBLIC_KEY = PUB;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await pool.query('DELETE FROM invoices WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM payment_orders WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM user_subscriptions WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  // 还原测试用户的管理员标记（该 id 被多个测试文件共用）
  await pool.query('UPDATE users SET is_admin = $1 WHERE id = $2', [wasAdmin, TEST_USER_ID]).catch(() => {});
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await pool.end().catch(() => {});
});

describe('权限与参数守卫', () => {
  it('非管理员 → 403 ADMIN_REQUIRED，且完全不碰渠道', async () => {
    await pool.query('UPDATE users SET is_admin = false WHERE id = $1', [TEST_USER_ID]);
    const { orderNo } = await seedOrder();
    const fn = stubGatewayResponse({ code: '10000', msg: 'Success', fund_status: 'Y', refund_amount: '9.90' });

    const res = await request(app).post('/api/payments/refund').send({ orderNo, reason: '测试' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
    expect(fn).not.toHaveBeenCalled();
  });

  it('缺 orderId/orderNo → 400', async () => {
    const res = await request(app).post('/api/payments/refund').send({});
    expect(res.status).toBe(400);
  });

  it('订单不存在 → 404', async () => {
    const res = await request(app)
      .post('/api/payments/refund')
      .send({ orderNo: 'ORD_NOT_EXIST_9999' });
    expect(res.status).toBe(404);
  });

  it('未支付订单 → 400 ORDER_NOT_REFUNDABLE（不调渠道）', async () => {
    const { orderNo } = await seedOrder({ status: 'pending' });
    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y' });

    const res = await request(app).post('/api/payments/refund').send({ orderNo });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORDER_NOT_REFUNDABLE');
    expect(fn).not.toHaveBeenCalled();
  });

  it('非支付宝渠道订单 → 400 REFUND_CHANNEL_UNSUPPORTED', async () => {
    const { orderNo } = await seedOrder({ paymentMethod: 'stripe' });
    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y' });

    const res = await request(app).post('/api/payments/refund').send({ orderNo });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REFUND_CHANNEL_UNSUPPORTED');
    expect(fn).not.toHaveBeenCalled();
  });

  it('支付宝凭据未配置 → 503 ALIPAY_NOT_CONFIGURED（不静默假退款）', async () => {
    const { orderId, orderNo } = await seedOrder();
    delete process.env.ALIPAY_PRIVATE_KEY;
    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y' });

    const res = await request(app).post('/api/payments/refund').send({ orderNo });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ALIPAY_NOT_CONFIGURED');
    expect(fn).not.toHaveBeenCalled();
    expect((await readOrder(orderId)).status).toBe('paid');
  });
});

describe('退款成功（fund_status=Y）', () => {
  it('订单置 refunded + refunded_at，订阅置 canceled + canceled_at，用户权益收回', async () => {
    const { orderId, orderNo, subscriptionId } = await seedOrder({ amount: 9.9 });
    const fn = stubGatewayResponse({
      code: '10000',
      msg: 'Success',
      trade_no: '202609192200000000',
      out_trade_no: orderNo,
      fund_status: 'Y',
      refund_amount: '9.90',
    });

    const res = await request(app).post('/api/payments/refund').send({ orderId, reason: '用户误购' });

    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({ orderNo, amount: 9.9, refundAmount: 9.9, status: 'refunded' });
    expect(res.body.order.refundedAt).toBeTruthy();
    expect(res.body.channel).toMatchObject({ name: 'alipay', fund_status: 'Y' });
    expect(res.body.entitlement.subscriptionCanceled).toBe(true);

    // 请求报文：全额 + out_request_no=订单号（渠道侧幂等）
    const biz = JSON.parse(new URLSearchParams(fn.mock.calls[0][1].body).get('biz_content'));
    expect(biz).toEqual({ out_trade_no: orderNo, refund_amount: '9.90', out_request_no: orderNo });

    const order = await readOrder(orderId);
    expect(order.status).toBe('refunded');
    expect(order.refunded_at).toBeTruthy();
    // metadata.refund_amount 与 admin-console「已退款」口径对齐
    expect(Number(order.metadata.refund_amount)).toBe(9.9);
    expect(order.metadata.refund_reason).toBe('用户误购');
    expect(order.metadata.alipay_refund.fund_status).toBe('Y');

    const sub = await readSubscription(subscriptionId);
    expect(sub.status).toBe('canceled');
    expect(sub.canceled_at).toBeTruthy();

    const user = await pool.query('SELECT subscription_status, current_subscription_id FROM users WHERE id = $1', [TEST_USER_ID]);
    expect(user.rows[0].subscription_status).toBe('free');
    expect(user.rows[0].current_subscription_id).toBeNull();

    const audit = await pool.query(
      `SELECT action, status, details FROM audit_logs
        WHERE action = 'payment_refund' AND resource_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [String(orderId)]
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].details.orderNo).toBe(orderNo);
  });

  it('已退款订单二次请求 → 409 ALREADY_REFUNDED，不再打款', async () => {
    const { orderId, orderNo } = await seedOrder();
    stubGatewayResponse({ code: '10000', fund_status: 'Y', out_trade_no: orderNo, refund_amount: '9.90' });
    expect((await request(app).post('/api/payments/refund').send({ orderNo })).status).toBe(200);

    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });
    const res = await request(app).post('/api/payments/refund').send({ orderId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_REFUNDED');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('退款失败：本地状态一律不动', () => {
  it('渠道业务失败（code≠10000）→ 502 REFUND_CHANNEL_FAILED，订单仍 paid、订阅仍 active', async () => {
    const { orderId, orderNo, subscriptionId } = await seedOrder();
    stubGatewayResponse({
      code: '40004',
      msg: 'Business Failed',
      sub_code: 'REFUND_AMOUNT_EXCEED',
      sub_msg: '退款金额超过可退金额',
      out_trade_no: orderNo,
    });

    const res = await request(app).post('/api/payments/refund').send({ orderNo });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('REFUND_CHANNEL_FAILED');
    expect(res.body.channelError).toMatchObject({ code: '40004', subCode: 'REFUND_AMOUNT_EXCEED' });

    const order = await readOrder(orderId);
    expect(order.status).toBe('paid');
    expect(order.refunded_at).toBeNull();
    expect((await readSubscription(subscriptionId)).status).toBe('active');
  });

  it("code=10000 但 fund_status='C'（退款失败）→ 502 REFUND_NOT_CONFIRMED", async () => {
    const { orderId, orderNo, subscriptionId } = await seedOrder();
    stubGatewayResponse({ code: '10000', msg: 'Success', fund_status: 'C', refund_amount: '9.90' });

    const res = await request(app).post('/api/payments/refund').send({ orderNo });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('REFUND_NOT_CONFIRMED');
    expect((await readOrder(orderId)).status).toBe('paid');
    expect((await readSubscription(subscriptionId)).status).toBe('active');
  });

  it('响应报文被篡改（签名对不上）→ 502，订单仍 paid（S3 口径延伸到退款）', async () => {
    const { orderId, orderNo } = await seedOrder();
    const nodeText = `"${REFUND_KEY}":${JSON.stringify({ code: '10000', fund_status: 'Y', refund_amount: '9.90' })}`;
    const tampered = `{${nodeText.replace('9.90', '99.00')},"sign":"${signWith(nodeText)}"}`;
    vi.stubGlobal('fetch', vi.fn(async () => ({ text: async () => tampered })));

    const res = await request(app).post('/api/payments/refund').send({ orderNo });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('REFUND_CHANNEL_FAILED');
    expect((await readOrder(orderId)).status).toBe('paid');
  });
});
