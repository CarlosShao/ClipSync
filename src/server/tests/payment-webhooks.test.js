import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import pool from '../src/db/pool.js';
import { ensureAuthUser } from './test-helpers.js';

/**
 * 支付回调路由可达性回归测试
 *
 * 防复发目标：这些路由曾经**完全不可达**，且没有任何测试覆盖 ——
 *   - 文档所写的 `POST /api/webhooks/alipay` 实际是 **404**（路由从未注册在该路径）
 *   - handler 实际定义在 payments.js 内，随其挂在 `/api/payments` 之下，
 *     而该挂载点统一加了 authenticateToken + csrfProtection，因此真实地址
 *     `POST /api/payments/webhooks/alipay` 永远返回 **401 Access token required**
 *     （支付宝服务器没有本站 JWT，必然被拒）
 *
 * 后果是「用户付了钱、订阅永远不开通」，且因为压根触发不到，问题一直不可见。
 *
 * 本文件锁定两条不变量：
 *   1. `/api/webhooks/*` 必须可达 —— **不能**是 404（路由存在）
 *   2. 必须**不要求登录** —— 不能是 401「Access token required」
 *      （未配置凭据时应是 503，验签失败应是 401 + body 'failure'，即"到了业务层"）
 */

let app;

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[payment-webhooks] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }
  const mod = await import('../src/index.js');
  app = mod.app;
});

/** 判断响应是否"到达了业务层"（而非被挂载/鉴权层挡下） */
function reachedBusinessLayer(res) {
  // 404 = 路由不存在；401 且提示缺 token = 被认证中间件挡下
  if (res.status === 404) return false;
  const body = typeof res.body === 'object' ? JSON.stringify(res.body) : String(res.text || '');
  if (res.status === 401 && /Access token required|token/i.test(body) && !body.includes('failure')) {
    return false;
  }
  return true;
}

describe('支付回调路由可达性', () => {
  it('POST /api/webhooks/alipay 不是 404（路由已注册）', async () => {
    const res = await request(app)
      .post('/api/webhooks/alipay')
      .type('form')
      .send({ out_trade_no: 'ORD_TEST', trade_status: 'TRADE_SUCCESS' });

    expect(res.status).not.toBe(404);
    expect(reachedBusinessLayer(res)).toBe(true);
  });

  it('POST /api/webhooks/alipay 不要求登录（渠道服务器没有 JWT）', async () => {
    const res = await request(app)
      .post('/api/webhooks/alipay')
      .type('form')
      .send({ out_trade_no: 'ORD_TEST', trade_status: 'TRADE_SUCCESS' });

    // 未带 Authorization，若被 authenticateToken 拦住会是 401 + "Access token required"
    expect(res.status).not.toBe(401);
    // 未配置公钥时应为 503（明确失败，而非"信任未验签报文"）
    expect([200, 400, 401, 403, 500, 503]).toContain(res.status);
  });

  it('未验签的支付宝回调必须被拒（不得凭未验签报文开通订阅）', async () => {
    const res = await request(app)
      .post('/api/webhooks/alipay')
      .type('form')
      .send({ out_trade_no: 'ORD_FORGED', trade_status: 'TRADE_SUCCESS', sign: 'forged' });

    // 无论公钥是否配置，都必须拒绝：503（未配置）或 401（验签失败）
    expect([401, 503]).toContain(res.status);
    if (res.status === 401) {
      expect(String(res.text)).toBe('failure');
    }
  });

  it('POST /api/webhooks/stripe 不是 404 且不要求登录', async () => {
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 'test')
      .send({ type: 'checkout.session.completed' });

    expect(res.status).not.toBe(404);
    expect(reachedBusinessLayer(res)).toBe(true);
  });

  it('回调路径不经过 CSRF（表单 POST 不得被 403 CSRF_INVALID 拦下）', async () => {
    const res = await request(app)
      .post('/api/webhooks/alipay')
      .type('form')
      .send({ out_trade_no: 'ORD_TEST', trade_status: 'TRADE_SUCCESS' });

    const body = JSON.stringify(res.body || {});
    expect(body).not.toContain('CSRF_INVALID');
    expect(res.status).not.toBe(403);
  });
});

describe('支付安全 - 生产环境不得白送订阅', () => {
  it('create-order 拒绝未知支付渠道', async () => {
    const res = await request(app)
      .post('/api/payments/create-order')
      .send({ subscriptionId: 'x', paymentMethod: 'wechat_pay' });

    // 无 token 会被鉴权拦截（400/401/403 都可接受）；关键是不能 200 成功
    expect(res.status).not.toBe(200);
  });

  it('create-order 未带凭据时不得成功', async () => {
    const res = await request(app)
      .post('/api/payments/create-order')
      .send({ subscriptionId: 'x' });

    expect(res.status).not.toBe(200);
  });
});

/**
 * M1（2026-10-03 审计）：`webhookIdempotencyMiddleware` 已从回调路由摘除。
 *
 * 它有三个真实危害，两条用例分别钉住其中两条：
 *   ① 只钩 `res.json`，会把 Stripe 分支的失败响应也缓存 24h →
 *      后续重试全部命中同一个错误响应，事件再也处理不了；
 *   ② 缓存命中时直接短路，**跳过验签**；且 key 无渠道前缀，
 *      任意人可经 Stripe 端点写入 key 来干扰支付宝回调。
 *
 * 修后真正承担幂等的是履约层 `markOrderPaid`（订单行锁 + 状态判定），
 * 它对重复投递本身安全，因此不需要（也不应该有）传输层的缓存短路。
 */
describe('M1：回调不得被传输层缓存短路（幂等由履约层保证）', () => {
  it('同一 Stripe 事件重复投递：状态必须一致，绝不能第二次被缓存回放成 200', async () => {
    const body = { id: 'evt_m1_no_cache_regression', type: 'checkout.session.completed' };

    const first = await request(app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 'forged')
      .send(body);
    const second = await request(app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 'forged')
      .send(body);

    // 旧中间件下：首次失败被缓存 → 第二次短路成 200。这里必须两次一致且都不是 200。
    expect(second.status).toBe(first.status);
    expect(second.status).not.toBe(200);
  });

  it('不能经 Stripe 端点写入缓存来短路支付宝回调（跨渠道 key 撞车）', async () => {
    const sharedId = 'M1_SHARED_KEY_REGRESSION';

    // 先让 Stripe 分支收到一个同 id 的请求（旧实现会把它写进 webhook-<id> 缓存）
    await request(app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 'forged')
      .send({ id: sharedId, type: 'checkout.session.completed' });

    // 再用同一个值当 trade_no 打支付宝：仍必须走验签并被拒
    const res = await request(app)
      .post('/api/webhooks/alipay')
      .type('form')
      .send({
        out_trade_no: 'ORD_M1_SHARED',
        trade_no: sharedId,
        trade_status: 'TRADE_SUCCESS',
        sign: 'forged',
      });

    expect([401, 503]).toContain(res.status);
    if (res.status === 401) expect(String(res.text)).toBe('failure');
  });
});

/**
 * M2（2026-10-03 审计）：商户身份校验必须 fail-closed。
 *
 * 原写法 `if (expectedAppId && appId && appId !== expectedAppId)` 有三重前置条件 ——
 * env 漏配或报文缺 app_id 时整条校验**静默跳过**，此时唯一剩下的防线只有金额比对：
 * 攻击者拿自己的商户号、用受害者的 out_trade_no 与相同金额下单付款，就能取得一份
 * **合法签名**的通知打进来，白拿订阅。
 *
 * 本组用例用**真签名**（自建 RSA2 密钥对）走完整链路，只让 app_id / seller_id 出错，
 * 从而确定"被拒"是因为身份校验而不是验签。
 */
describe('M2：商户身份校验 fail-closed（真签名，只让身份字段出错）', () => {
  const ENV_KEYS_M2 = ['ALIPAY_APP_ID', 'ALIPAY_PUBLIC_KEY', 'ALIPAY_SELLER_ID', 'ALIPAY_PRIVATE_KEY'];
  const saved = {};
  const { privateKey: PRIV, publicKey: PUB } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  /** 复刻 buildSignString 的口径：ASCII 升序、剔除空值、回调验签还要排 sign_type */
  function buildSignString(params) {
    return Object.keys(params)
      .filter((k) => k !== 'sign' && k !== 'sign_type')
      .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
  }

  function signedNotify(overrides = {}) {
    const params = {
      app_id: '2021000000000000',
      out_trade_no: 'ORD_M2_TEST',
      trade_no: '2026100422000000001',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '9.90',
      sign_type: 'RSA2',
      ...overrides,
    };
    for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(buildSignString(params), 'utf8');
    return { ...params, sign: signer.sign(PRIV, 'base64') };
  }

  beforeAll(() => {
    for (const k of ENV_KEYS_M2) saved[k] = process.env[k];
    process.env.ALIPAY_PUBLIC_KEY = PUB;
    process.env.ALIPAY_APP_ID = '2021000000000000';
    delete process.env.ALIPAY_SELLER_ID;
  });

  afterAll(() => {
    for (const k of ENV_KEYS_M2) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('签名有效但报文缺 app_id → 401', async () => {
    const res = await request(app)
      .post('/api/webhooks/alipay')
      .type('form')
      .send(signedNotify({ app_id: undefined }));

    expect(res.status).toBe(401);
    expect(String(res.text)).toBe('failure');
  });

  it('签名有效但 app_id 是别人的商户号 → 401（跨商户重放）', async () => {
    const res = await request(app)
      .post('/api/webhooks/alipay')
      .type('form')
      .send(signedNotify({ app_id: '2088999999999999' }));

    expect(res.status).toBe(401);
    expect(String(res.text)).toBe('failure');
  });

  it('本商户未配置 ALIPAY_APP_ID → 503（无法确认身份就绝不收）', async () => {
    const prev = process.env.ALIPAY_APP_ID;
    delete process.env.ALIPAY_APP_ID;
    try {
      const res = await request(app).post('/api/webhooks/alipay').type('form').send(signedNotify());
      expect(res.status).toBe(503);
      expect(String(res.text)).toBe('failure');
    } finally {
      process.env.ALIPAY_APP_ID = prev;
    }
  });

  it('配了 ALIPAY_SELLER_ID 时 seller_id 不匹配 → 401', async () => {
    process.env.ALIPAY_SELLER_ID = '2088000000000001';
    try {
      const res = await request(app)
        .post('/api/webhooks/alipay')
        .type('form')
        .send(signedNotify({ seller_id: '2088000000000002' }));

      expect(res.status).toBe(401);
      expect(String(res.text)).toBe('failure');
    } finally {
      delete process.env.ALIPAY_SELLER_ID;
    }
  });

  it('app_id 与 seller_id 都对 → 越过身份校验（订单不存在 → 500 让支付宝重试）', async () => {
    process.env.ALIPAY_SELLER_ID = '2088000000000001';
    try {
      const res = await request(app)
        .post('/api/webhooks/alipay')
        .type('form')
        .send(signedNotify({ seller_id: '2088000000000001', out_trade_no: 'ORD_M2_NOT_EXIST' }));

      // 身份校验通过后进入履约：订单不存在 → 500 failure（让支付宝重试，留人工排查窗口）
      expect(res.status).toBe(500);
      expect(String(res.text)).toBe('failure');
    } finally {
      delete process.env.ALIPAY_SELLER_ID;
    }
  });
});

/**
 * M6（2026-10-03 审计）：`TRADE_CLOSED` 通知必须把本地 pending 订单收口。
 *
 * 修前只被"记日志并确认收到"忽略 → 本地订单仍是 pending，前端继续轮询、每次轮询
 * 继续打渠道查单，直到 24h 后 sweep 才关。
 *
 * ⚠️ 边界：`TRADE_CLOSED` 也可能是「全额退款后交易关闭」，**绝不能覆盖终态**
 * （那会抹掉资金事实）。所以这里同时钉住"paid 订单不受影响"。
 */
describe('M6：TRADE_CLOSED 收口 pending 订单，但不覆盖终态', () => {
  const M6_APP_ID = '2021000000000000';
  const { privateKey: PRIV6, publicKey: PUB6 } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  function buildSignString6(params) {
    return Object.keys(params)
      .filter((k) => k !== 'sign' && k !== 'sign_type')
      .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
  }

  function signedNotify6(overrides = {}) {
    const params = {
      app_id: M6_APP_ID,
      trade_status: 'TRADE_CLOSED',
      sign_type: 'RSA2',
      ...overrides,
    };
    for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(buildSignString6(params), 'utf8');
    return { ...params, sign: signer.sign(PRIV6, 'base64') };
  }

  const saved6 = {};
  let orderSeq = 0;
  const createdOrders = [];

  async function seedOrder(status) {
    const orderNo = `ORDM6${Date.now()}${orderSeq++}`;
    // 注意：status 只当一次参数用（同一参数既进列又参与比较会让 PG 推断出不一致类型）
    const paidAt = status === 'paid' ? new Date() : null;
    const { rows } = await pool.query(
      `INSERT INTO payment_orders
         (user_id, order_no, amount, currency, payment_method, payment_channel, status, paid_at, metadata)
       VALUES ((SELECT id FROM users LIMIT 1), $1, 9.9, 'CNY', 'alipay', 'alipay', $2, $3, '{}'::jsonb)
       RETURNING order_no`,
      [orderNo, status, paidAt]
    );
    createdOrders.push(rows[0].order_no);
    return rows[0].order_no;
  }

  beforeAll(async () => {
    // 全局测试清理会把 users 清空，而 payment_orders.user_id 是 NOT NULL → 先确保有账号行
    await ensureAuthUser(pool);
    for (const k of ['ALIPAY_PUBLIC_KEY', 'ALIPAY_APP_ID', 'ALIPAY_SELLER_ID']) saved6[k] = process.env[k];
    process.env.ALIPAY_PUBLIC_KEY = PUB6;
    process.env.ALIPAY_APP_ID = M6_APP_ID;
    delete process.env.ALIPAY_SELLER_ID;
  });

  afterAll(async () => {
    for (const k of Object.keys(saved6)) {
      if (saved6[k] === undefined) delete process.env[k];
      else process.env[k] = saved6[k];
    }
    if (createdOrders.length) {
      await pool
        .query('DELETE FROM payment_orders WHERE order_no = ANY($1::text[])', [createdOrders])
        .catch(() => {});
    }
  });

  it('pending 订单收到 TRADE_CLOSED → 本地置 cancelled 并留痕', async () => {
    const orderNo = await seedOrder('pending');

    const res = await request(app)
      .post('/api/webhooks/alipay')
      .type('form')
      .send(signedNotify6({ out_trade_no: orderNo, trade_no: 'T_M6_1' }));

    expect(res.status).toBe(200);
    expect(String(res.text)).toBe('success');

    const { rows } = await pool.query(
      'SELECT status, metadata FROM payment_orders WHERE order_no = $1',
      [orderNo]
    );
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].metadata.closed_by_channel).toBe(true);
  });

  it('已 paid 的订单收到 TRADE_CLOSED（全额退款后关单）→ 状态绝不被覆盖', async () => {
    const orderNo = await seedOrder('paid');

    const res = await request(app)
      .post('/api/webhooks/alipay')
      .type('form')
      .send(signedNotify6({ out_trade_no: orderNo, trade_no: 'T_M6_2' }));

    expect(res.status).toBe(200);
    const { rows } = await pool.query('SELECT status FROM payment_orders WHERE order_no = $1', [orderNo]);
    expect(rows[0].status).toBe('paid'); // 资金事实不能被关单通知抹掉
  });
});
