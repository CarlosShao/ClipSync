import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import pool from '../src/db/pool.js';
import { getTestApp } from './test-helpers.js';
import { invalidateFlagsCache } from '../src/utils/featureFlags.js';
// 窗口天数按服务的常量走（测试不各写一份 7，否则改了常量测试还绿着 = 假绿）
import { SELF_REFUND_WINDOW_DAYS } from '../src/services/refundPolicy.js';

/**
 * 真实退款集成测试（POST /api/payments/refund，任务板 #10 第二步 + 属主自助退款）
 *
 * 锁死的不变量（都是这条链路出过的事故）：
 *   1. **只有渠道回 fund_status='Y' 才动本地数据**：渠道失败/未知时订单必须还是 paid
 *      （上一版假退款是反过来的：只改库、钱不退，用户"退款成功"但订阅没了）；
 *   2. 退款成功 → 订单 refunded + refunded_at、订阅 canceled + canceled_at、
 *      users 冗余订阅状态回 free（退款即收回权益）；
 *   3. 权限（产品决策 2026-09-19 变更）：**订单属主本人可自助退款**，但要过风控闸
 *      （只退「最近一笔已支付订单」+ paid_at 7 天窗口内）；非属主仍需 is_admin，
 *      管理员不受这两道闸限制；
 *   4. 防探测：既非属主又非管理员的调用方，拿到的响应与「订单不存在」**完全同壳**，
 *      绝不承认该订单存在；
 *   5. 渠道侧幂等：out_request_no 用订单号，且已退款订单二次请求被本地 409 挡住；
 *   6. GET /api/payments/refundable-orders 的 refundable/reasonCode 与实际能不能退
 *      同源（列表说可退 → 端点必然退得动；列表说的理由 → 就是端点拒绝的理由）。
 *
 * 离线：支付宝网关用 vi.stubGlobal('fetch') 打桩，响应原文用测试内自生成密钥签名，
 * 因此 callGateway 的**响应验签**是真的在跑（伪造报文会验签失败）。
 */

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_PHONE = '+86test-refund-0001';
// 另一个真实用户：用于「退别人的订单」用例（测试环境 req.user 固定是 TEST_USER_ID，
// 所以「他人」只能通过把订单落到别的 user_id 上来构造）
const OTHER_USER_ID = '00000000-0000-0000-0000-0000000000f1';
const OTHER_PHONE = '+86test-refund-oth1';
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

async function seedOrder({
  status = 'paid',
  paymentMethod = 'alipay',
  amount = 9.9,
  withSubscription = true,
  userId = TEST_USER_ID,
  paidAt,
  metadata = {},
} = {}) {
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
      [userId]
    );
    subscriptionId = sub.rows[0].id;
  }

  const orderNo = `ORDRF${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const order = await pool.query(
    `INSERT INTO payment_orders
       (user_id, subscription_id, plan_id, order_no, amount, currency,
        payment_method, payment_channel, status, paid_at, transaction_id, created_at, updated_at, metadata)
     VALUES ($1, $2, (SELECT id FROM subscription_plans WHERE name = 'Pro'), $3, $4, 'CNY',
             $5, $5, $6, $7, '202609192200000000', NOW(), NOW(), $8)
     RETURNING id, order_no`,
    [
      userId,
      subscriptionId,
      orderNo,
      amount,
      paymentMethod,
      status,
      // 只有已支付（含已退款）订单才有 paid_at / 渠道交易号，造数据要贴近真实；
      // 显式传 null 是「paid 但没有 paid_at」的脏数据分支（自助闸对此按超窗拒退）
      status === 'paid' || status === 'refunded' ? (paidAt === undefined ? new Date() : paidAt) : null,
      JSON.stringify(metadata),
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

/** 直接写库切开关 + 失效本进程缓存（等价管理台 PATCH /api/admin/flags/:key） */
async function setFlag(key, enabled) {
  await pool.query('UPDATE feature_flags SET enabled = $2, updated_at = NOW() WHERE flag_key = $1', [
    key,
    enabled,
  ]);
  invalidateFlagsCache();
}

/** 两个测试用户的订单/订阅/发票一律清空（用例之间的「最近一笔已支付订单」必须只有构造出来的那些） */
async function cleanupOrders() {
  for (const userId of [TEST_USER_ID, OTHER_USER_ID]) {
    await pool.query('DELETE FROM invoices WHERE user_id = $1', [userId]).catch(() => {});
    await pool.query('DELETE FROM payment_orders WHERE user_id = $1', [userId]).catch(() => {});
    await pool.query('DELETE FROM user_subscriptions WHERE user_id = $1', [userId]).catch(() => {});
  }
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
  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, subscription_status, created_at, updated_at)
     VALUES ($1, $2, '退款他人订单用户', 'test_hash', 'free', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [OTHER_USER_ID, OTHER_PHONE]
  );
  const u = await pool.query('SELECT is_admin FROM users WHERE id = $1', [TEST_USER_ID]);
  wasAdmin = Boolean(u.rows[0]?.is_admin);

  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ALIPAY_APP_ID = '2021000000000000';
  process.env.ALIPAY_PRIVATE_KEY = PRIV;
  process.env.ALIPAY_PUBLIC_KEY = PUB;
}, 60000);

beforeEach(async () => {
  await cleanupOrders();
  await pool.query("UPDATE users SET is_admin = true, subscription_status = 'free', current_subscription_id = NULL WHERE id = $1", [TEST_USER_ID]);
  // 开关默认打开（关开关的用例自己关、自己复原；这里再兜一道，避免别的文件残留）
  await setFlag('enable_subscription', true);
  // 凭据类用例会在用例内改 env，这里统一复位，避免污染后续用例
  process.env.ALIPAY_APP_ID = '2021000000000000';
  process.env.ALIPAY_PRIVATE_KEY = PRIV;
  process.env.ALIPAY_PUBLIC_KEY = PUB;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await cleanupOrders().catch(() => {});
  await setFlag('enable_subscription', true).catch(() => {});
  // 还原测试用户的管理员标记（该 id 被多个测试文件共用）
  await pool.query('UPDATE users SET is_admin = $1 WHERE id = $2', [wasAdmin, TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [OTHER_USER_ID]).catch(() => {});
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await pool.end().catch(() => {});
});

describe('权限与参数守卫', () => {
  it('非属主 + 非管理员 → 404 ORDER_NOT_FOUND（与「订单不存在」同壳），且完全不碰渠道', async () => {
    await pool.query('UPDATE users SET is_admin = false WHERE id = $1', [TEST_USER_ID]);
    const { orderId, orderNo } = await seedOrder({ userId: OTHER_USER_ID, withSubscription: false });
    const fn = stubGatewayResponse({ code: '10000', msg: 'Success', fund_status: 'Y', refund_amount: '9.90' });

    const res = await request(app).post('/api/payments/refund').send({ orderNo, reason: '测试' });

    // 防探测：别人的单 = 不存在的单，一字不差（不承认存在、不泄露状态、不泄露属主）
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Order not found', code: 'ORDER_NOT_FOUND', orderNo });
    expect(fn).not.toHaveBeenCalled();
    expect((await readOrder(orderId)).status).toBe('paid');
  });

  it('属主本人（非管理员）自助退款 → 200，产品决策 2026-09-19 变更', async () => {
    await pool.query('UPDATE users SET is_admin = false WHERE id = $1', [TEST_USER_ID]);
    const { orderId, orderNo } = await seedOrder();
    stubGatewayResponse({ code: '10000', msg: 'Success', fund_status: 'Y', refund_amount: '9.90' });

    const res = await request(app).post('/api/payments/refund').send({ orderNo });

    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({ orderNo, status: 'refunded' });
    // 不传 reason 时自助分支兜底「用户自助退款」（管理台分支仍是「管理员退款」）
    expect((await readOrder(orderId)).metadata.refund_reason).toBe('用户自助退款');
    expect((await readOrder(orderId)).metadata.refund_by).toBe(TEST_USER_ID);
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
    expect(res.body.code).toBe('ORDER_NOT_FOUND');
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

describe('属主自助退款风控闸（管理员分支不受这两道闸限制）', () => {
  it('不是最近一笔已支付订单 → 409 NOT_LATEST_PAID_ORDER，不碰渠道、两单都不动', async () => {
    await pool.query('UPDATE users SET is_admin = false WHERE id = $1', [TEST_USER_ID]);
    const old = await seedOrder({ paidAt: new Date(Date.now() - 2 * DAY_MS) });
    await seedOrder({ paidAt: new Date() });
    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });

    const res = await request(app).post('/api/payments/refund').send({ orderNo: old.orderNo });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_LATEST_PAID_ORDER');
    expect(res.body.error).toBeTruthy();
    expect(fn).not.toHaveBeenCalled();
    expect((await readOrder(old.orderId)).status).toBe('paid');
  });

  it('paid_at 超出 7 天窗口 → 409 REFUND_WINDOW_EXPIRED，extra 带 paidAt', async () => {
    await pool.query('UPDATE users SET is_admin = false WHERE id = $1', [TEST_USER_ID]);
    const paidAt = new Date(Date.now() - (SELF_REFUND_WINDOW_DAYS + 3) * DAY_MS);
    const { orderId, orderNo } = await seedOrder({ paidAt });
    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });

    const res = await request(app).post('/api/payments/refund').send({ orderNo });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REFUND_WINDOW_EXPIRED');
    expect(new Date(res.body.paidAt).getTime()).toBe(paidAt.getTime());
    expect(res.body.windowDays).toBe(SELF_REFUND_WINDOW_DAYS);
    expect(fn).not.toHaveBeenCalled();
    expect((await readOrder(orderId)).status).toBe('paid');
  });

  it('窗口内（6 天前付款）且是最近一笔 → 200，边界不卡死正常自助退款', async () => {
    await pool.query('UPDATE users SET is_admin = false WHERE id = $1', [TEST_USER_ID]);
    const { orderNo } = await seedOrder({ paidAt: new Date(Date.now() - 6 * DAY_MS) });
    stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });

    const res = await request(app).post('/api/payments/refund').send({ orderNo });

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('refunded');
  });

  it('paid 但 paid_at 为空（脏数据）→ 409 REFUND_WINDOW_EXPIRED（时间说不清就不退，fail closed）', async () => {
    await pool.query('UPDATE users SET is_admin = false WHERE id = $1', [TEST_USER_ID]);
    const { orderNo } = await seedOrder({ paidAt: null });
    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });

    const res = await request(app).post('/api/payments/refund').send({ orderNo });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REFUND_WINDOW_EXPIRED');
    expect(res.body.paidAt).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('管理员退「非最近 + 超窗」的他人订单 → 200（两道自助闸只约束属主）', async () => {
    const victim = await seedOrder({
      userId: OTHER_USER_ID,
      withSubscription: false,
      paidAt: new Date(Date.now() - 30 * DAY_MS),
    });
    // 属主自己后来又付了一笔更新的单：自助分支下 victim 的旧单是退不掉的
    const newer = await seedOrder({ userId: OTHER_USER_ID, withSubscription: false, paidAt: new Date() });
    const fn = stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });

    const res = await request(app).post('/api/payments/refund').send({ orderNo: victim.orderNo, reason: '客服处理' });

    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect((await readOrder(victim.orderId)).status).toBe('refunded');
    expect((await readOrder(newer.orderId)).status).toBe('paid');
  });

  it('同一笔退款请求走 orderId（UUID 主键）定位，与 orderNo 等价', async () => {
    await pool.query('UPDATE users SET is_admin = false WHERE id = $1', [TEST_USER_ID]);
    const { orderId, orderNo } = await seedOrder();
    stubGatewayResponse({ code: '10000', fund_status: 'Y', refund_amount: '9.90' });

    const res = await request(app).post('/api/payments/refund').send({ orderId });

    expect(res.status).toBe(200);
    expect(res.body.order.orderNo).toBe(orderNo);
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

describe('GET /api/payments/refundable-orders —— 申请退款弹窗清单', () => {
  /** 列表响应的便捷视图：[orderNo, status, refundable, reasonCode] */
  const view = (orders) =>
    orders.map((o) => [o.orderNo, o.status, o.refundable, o.reasonCode ?? null]);

  it('各 reasonCode 一次覆盖：可退 / 已退 / 渠道不支持 / 不是最近一笔；且只回自己的单', async () => {
    await pool.query('UPDATE users SET is_admin = false WHERE id = $1', [TEST_USER_ID]);
    const newest = await seedOrder({ paidAt: new Date() });
    const stripe = await seedOrder({ paymentMethod: 'stripe', paidAt: new Date(Date.now() - DAY_MS), withSubscription: false });
    const older = await seedOrder({ paidAt: new Date(Date.now() - 2 * DAY_MS), withSubscription: false });
    const refunded = await seedOrder({ status: 'refunded', paidAt: new Date(Date.now() - 5 * DAY_MS), withSubscription: false });
    // 别人的单绝不能出现在我的清单里（即便它更新、更可退）
    const foreign = await seedOrder({ userId: OTHER_USER_ID, withSubscription: false, paidAt: new Date(Date.now() + DAY_MS) });
    const pending = await seedOrder({ status: 'pending', withSubscription: false });

    const res = await request(app).get('/api/payments/refundable-orders');

    expect(res.status).toBe(200);
    expect(view(res.body.orders)).toEqual([
      [newest.orderNo, 'paid', true, null],
      [stripe.orderNo, 'paid', false, 'CHANNEL_UNSUPPORTED'],
      [older.orderNo, 'paid', false, 'NOT_LATEST_PAID_ORDER'],
      [refunded.orderNo, 'refunded', false, 'ALREADY_REFUNDED'],
    ]);
    expect(res.body.orders.map((o) => o.orderNo)).not.toContain(foreign.orderNo);
    expect(res.body.orders.map((o) => o.orderNo)).not.toContain(pending.orderNo);
    expect(res.body.windowDays).toBe(SELF_REFUND_WINDOW_DAYS);
  });

  it('最近一笔但已超窗 → REFUND_WINDOW_EXPIRED（与 POST /refund 的拒绝理由同源）', async () => {
    await pool.query('UPDATE users SET is_admin = false WHERE id = $1', [TEST_USER_ID]);
    const paidAt = new Date(Date.now() - (SELF_REFUND_WINDOW_DAYS + 1) * DAY_MS);
    const { orderNo } = await seedOrder({ paidAt });

    const res = await request(app).get('/api/payments/refundable-orders');

    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0]).toMatchObject({
      orderNo,
      status: 'paid',
      refundable: false,
      reasonCode: 'REFUND_WINDOW_EXPIRED',
    });
    expect(new Date(res.body.orders[0].paidAt).getTime()).toBe(paidAt.getTime());

    // 同源证明：清单说不可退的那一单，接口也确实退不掉（同一个理由码）
    const denied = await request(app).post('/api/payments/refund').send({ orderNo });
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe('REFUND_WINDOW_EXPIRED');
  });

  it('清单说可退的那一单，接口真的退得动（列表与强制点不能漂移）', async () => {
    await pool.query('UPDATE users SET is_admin = false WHERE id = $1', [TEST_USER_ID]);
    const { orderNo } = await seedOrder();
    const listed = await request(app).get('/api/payments/refundable-orders');
    expect(listed.body.orders[0]).toMatchObject({ orderNo, refundable: true, reasonCode: null });

    stubGatewayResponse({ code: '10000', msg: 'Success', fund_status: 'Y', refund_amount: '9.90' });
    const res = await request(app).post('/api/payments/refund').send({ orderNo });
    expect(res.status).toBe(200);
  });

  it('升级折抵单：originalAmount/creditAmount 取 metadata.proration，普通单回退实付/0', async () => {
    const upgrade = await seedOrder({
      amount: 5.5,
      metadata: { proration: { originalPrice: 19.9, creditAmount: 14.4, finalAmount: 5.5 } },
    });
    const plain = await seedOrder({ amount: 9.9, paidAt: new Date(Date.now() - 3 * DAY_MS), withSubscription: false });

    const res = await request(app).get('/api/payments/refundable-orders');
    const byNo = Object.fromEntries(res.body.orders.map((o) => [o.orderNo, o]));

    expect(byNo[upgrade.orderNo]).toMatchObject({ amount: 5.5, originalAmount: 19.9, creditAmount: 14.4 });
    expect(byNo[plain.orderNo]).toMatchObject({ amount: 9.9, originalAmount: 9.9, creditAmount: 0 });
    // 可退金额永远是实付全额（本服务无部分退款），折抵字段只用于展示
    expect(byNo[upgrade.orderNo].amount).toBe(5.5);
  });

  it('只回溯最近 10 条（按 paid_at 倒序）', async () => {
    for (let i = 0; i < 12; i += 1) {
      await seedOrder({ paidAt: new Date(Date.now() - i * DAY_MS), withSubscription: false });
    }
    const res = await request(app).get('/api/payments/refundable-orders');
    expect(res.body.orders).toHaveLength(10);
    expect(res.body.orders[0].refundable).toBe(true);
    expect(res.body.orders.every((o) => o.status === 'paid')).toBe(true);
  });

  it('enable_subscription 关闭 → 503 SUBSCRIPTION_DISABLED（与收款/退款端点同口径）', async () => {
    await seedOrder();
    await setFlag('enable_subscription', false);
    try {
      const res = await request(app).get('/api/payments/refundable-orders');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SUBSCRIPTION_DISABLED');
      expect(res.body.flagDisabled).toBe('enable_subscription');
    } finally {
      await setFlag('enable_subscription', true);
    }
  });
});
