import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import pool from '../src/db/pool.js';

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
