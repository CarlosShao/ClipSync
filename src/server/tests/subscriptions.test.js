import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import pool from '../src/db/pool.js';
import { authHeaders, ensureAuthUser } from './test-helpers.js';

// 延迟导入 app，避免触发 server.listen()
let app;
beforeAll(async () => {
  const mod = await import('../src/index.js');
  app = mod.app;
});

describe('Subscription API', () => {
  // P0-C/C1：本文件原来写的是 `authToken = 'test-token'` +
  // `if (process.env.NODE_ENV !== 'test') expect([401,403])`——
  // 后者在测试环境**一条断言都不执行**，等于把「未认证必须被拒」这条判据整体作废。
  // 现在：真签名 token + 真库账号，未认证用例无条件断言 401。
  let auth;

  beforeAll(async () => {
    await ensureAuthUser(pool);
    auth = authHeaders();
  });

  describe('GET /api/subscriptions/plans', () => {
    it('should return subscription plans list', async () => {
      const res = await request(app)
        .get('/api/subscriptions/plans')
        .set(auth);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('plans');
      expect(Array.isArray(res.body.plans)).toBe(true);
    });

    it('plans 是公开目录，匿名可读（路由未挂 authenticateToken，见 routes/subscriptions.js:15）', async () => {
      const res = await request(app).get('/api/subscriptions/plans');
      expect(res.status).toBe(200);
    });

    it('需要身份的 current 端点必须拒绝未认证请求', async () => {
      const res = await request(app).get('/api/subscriptions/current');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/subscriptions/current', () => {
    it('should return current user subscription', async () => {
      const res = await request(app)
        .get('/api/subscriptions/current')
        .set(auth);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('subscription');
    });
  });

  describe('POST /api/subscriptions/subscribe（2026-10-03 停用，审计 M4）', () => {
    it('返回 410 ENDPOINT_RETIRED，并指向 create-order', async () => {
      // 原用例是 it.skip 且断言旧行为（200 + order + paymentParams）——
      // 那个行为早已不存在，且该端点会绕过 create-order 的全部闸门建出付不掉的订单。
      const res = await request(app)
        .post('/api/subscriptions/subscribe')
        .set(auth)
        .send({ planId: '00000000-0000-0000-0000-000000000000' });

      expect(res.status).toBe(410);
      expect(res.body.code).toBe('ENDPOINT_RETIRED');
      expect(res.body.useInstead).toBe('/api/payments/create-order');
    });

    it('不再往 payment_orders 写任何订单（停用不能只停在返回码上）', async () => {
      const before = await pool.query('SELECT COUNT(*)::int AS n FROM payment_orders');
      await request(app)
        .post('/api/subscriptions/subscribe')
        .set(auth)
        .send({ planId: '00000000-0000-0000-0000-000000000000' });
      const after = await pool.query('SELECT COUNT(*)::int AS n FROM payment_orders');
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });
});
