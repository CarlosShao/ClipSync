/**
 * Admin Console 订阅管理 APIs 单测（Admin Console · T-A3）
 *
 * 覆盖（routes/admin/subscriptions.js 挂载在 /api/admin 后的完整中间件链）：
 *  - GET  /api/admin/subscriptions        分页壳 + 用户摘要/套餐名字段映射
 *  - POST /api/admin/subscriptions/:id/grant
 *      - 同套餐赠期：current_period_end 延长 months 个月 + status='active' + 审计
 *      - 换套餐：plan_id 切换 + 审计 details.switchedPlan
 *      - 缺 reason / months 非法 → 400 { code: 4000 }
 *      - 订阅不存在 / 套餐不存在 → 404
 *      - 无 admin.subscriptions.grant 权限 → 403 { code: 4030 }
 *
 * 全离线：vi.mock db/pool + middleware/auth（与 adminRoutes.test.js 同风格）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/pool.js', () => {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return { pool, default: pool };
});

const authState = vi.hoisted(() => ({ user: null }));

vi.mock('../../src/middleware/auth.js', () => ({
  authenticateToken: vi.fn((req, _res, next) => {
    if (authState.user) {
      req.user = { ...authState.user };
      req.userId = authState.user.userId;
    }
    next();
  }),
  optionalAuth: vi.fn((req, _res, next) => next()),
}));

import express from 'express';
import request from 'supertest';
import { pool } from '../../src/db/pool.js';
import { clearPermCache } from '../../src/middleware/adminAuth.js';
import adminRouter from '../../src/routes/admin/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

const SUB_ID = 'a1000000-0000-4000-8000-000000000001';
const PLAN_A_ID = 'b1000000-0000-4000-8000-00000000000a';
const PLAN_B_ID = 'b1000000-0000-4000-8000-00000000000b';
const USER_ID = 'c1000000-0000-4000-8000-00000000000c';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

function makeSubscriptionRow(overrides = {}) {
  return {
    id: SUB_ID,
    user_id: USER_ID,
    plan_id: PLAN_A_ID,
    status: 'active',
    billing_cycle: 'monthly',
    current_period_start: new Date('2026-08-01T00:00:00Z'),
    current_period_end: new Date('2026-09-01T00:00:00Z'),
    auto_renew: true,
    created_at: new Date('2026-08-01T00:00:00Z'),
    plan_name: 'Pro',
    plan_display_name: '专业版',
    user_nickname: '林小明',
    user_phone: '13812342765',
    ...overrides,
  };
}

describe('GET /api/admin/subscriptions —— 订阅分页列表', () => {
  it('返回分页壳，行含用户摘要与套餐名（displayName 优先）', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      if (sql.includes('FROM user_subscriptions us')) {
        return { rows: [makeSubscriptionRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/subscriptions?page=1&pageSize=20');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(res.body.data.list[0]).toMatchObject({
      id: SUB_ID,
      userId: USER_ID,
      userLabel: '林小明',
      planId: PLAN_A_ID,
      planName: '专业版',
      planKey: 'Pro',
      status: 'active',
      billingCycle: 'monthly',
      autoRenew: true,
    });
  });

  it('无昵称用户回退打码手机号；status 词表归一化（trial→trialing）', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      if (sql.includes('FROM user_subscriptions us')) {
        return {
          rows: [makeSubscriptionRow({ user_nickname: '', status: 'trial' })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/subscriptions');

    expect(res.body.data.list[0].userLabel).toBe('138****2765');
    expect(res.body.data.list[0].status).toBe('trialing');
  });
});

describe('POST /api/admin/subscriptions/:id/grant —— 人工赠期/换套餐', () => {
  function mockGrantFlow({ subscription = makeSubscriptionRow(), plan = null } = {}, captured = {}) {
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key')) {
        return { rows: [{ perm_key: 'admin.subscriptions.grant' }], rowCount: 1 };
      }
      if (sql.includes('FROM user_subscriptions us') && sql.includes('WHERE us.id = $1')) {
        return subscription
          ? { rows: [subscription], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM subscription_plans') && sql.includes('WHERE id = $1')) {
        return plan
          ? { rows: [plan], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE user_subscriptions')) {
        captured.update = { sql, params };
        return {
          rows: [
            {
              ...subscription,
              plan_id: (plan && plan.id) || subscription.plan_id,
              status: 'active',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        captured.audit = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    return captured;
  }

  it('同套餐赠期：current_period_end 延长 months 个月，status 置 active，写审计', async () => {
    const captured = {};
    mockGrantFlow(
      { plan: { id: PLAN_A_ID, name: 'Pro', display_name: '专业版' } },
      captured
    );

    const res = await request(buildApp())
      .post(`/api/admin/subscriptions/${SUB_ID}/grant`)
      .send({ planId: PLAN_A_ID, months: 3, reason: '客诉补偿' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({ id: SUB_ID, planName: '专业版', status: 'active' });

    expect(captured.update.sql).toContain('current_period_end = GREATEST(current_period_end, NOW()) + make_interval(months => $3)');
    expect(captured.update.sql).toContain("status = 'active'");
    expect(captured.update.params).toEqual([SUB_ID, PLAN_A_ID, 3]);

    // 审计：action=admin.subscriptions.grant，details 含目标用户/套餐/月数/原因
    expect(captured.audit.params[1]).toBe('admin.subscriptions.grant');
    const details = JSON.parse(captured.audit.params[4]);
    expect(details).toMatchObject({
      targetUserId: USER_ID,
      planId: PLAN_A_ID,
      months: 3,
      reason: '客诉补偿',
      switchedPlan: false,
    });
  });

  it('换套餐：UPDATE 切换 plan_id，响应返回新套餐名，审计标记 switchedPlan', async () => {
    const captured = {};
    mockGrantFlow(
      { plan: { id: PLAN_B_ID, name: 'Enterprise', display_name: '企业版' } },
      captured
    );

    const res = await request(buildApp())
      .post(`/api/admin/subscriptions/${SUB_ID}/grant`)
      .send({ planId: PLAN_B_ID, months: 1, reason: '升级补偿' });

    expect(res.status).toBe(200);
    expect(res.body.data.planId).toBe(PLAN_B_ID);
    expect(res.body.data.planName).toBe('企业版');

    expect(captured.update.params).toEqual([SUB_ID, PLAN_B_ID, 1]);
    const details = JSON.parse(captured.audit.params[4]);
    expect(details.switchedPlan).toBe(true);
  });

  it('缺 reason 返回 400 { code: 4000 }，不执行更新', async () => {
    const captured = {};
    mockGrantFlow({}, captured);

    const res = await request(buildApp())
      .post(`/api/admin/subscriptions/${SUB_ID}/grant`)
      .send({ planId: PLAN_A_ID, months: 3 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
    expect(captured.update).toBeUndefined();
  });

  it('months 非法（0 / 非整数）返回 400 { code: 4000 }', async () => {
    const captured = {};
    mockGrantFlow({}, captured);

    const res = await request(buildApp())
      .post(`/api/admin/subscriptions/${SUB_ID}/grant`)
      .send({ planId: PLAN_A_ID, months: 0, reason: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);

    const res2 = await request(buildApp())
      .post(`/api/admin/subscriptions/${SUB_ID}/grant`)
      .send({ planId: PLAN_A_ID, months: 1.5, reason: 'x' });
    expect(res2.status).toBe(400);
    expect(res2.body.code).toBe(4000);
    expect(captured.update).toBeUndefined();
  });

  it('订阅不存在返回 404 { code: 40404 }', async () => {
    mockGrantFlow({ subscription: null });

    const res = await request(buildApp())
      .post(`/api/admin/subscriptions/${SUB_ID}/grant`)
      .send({ planId: PLAN_A_ID, months: 3, reason: 'x' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 40404, message: '订阅不存在' });
  });

  it('套餐不存在返回 404 { code: 40404 }', async () => {
    mockGrantFlow({ plan: null }); // subscription 命中，plan 未命中

    const res = await request(buildApp())
      .post(`/api/admin/subscriptions/${SUB_ID}/grant`)
      .send({ planId: PLAN_A_ID, months: 3, reason: 'x' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 40404, message: '套餐不存在' });
  });

  it('无 admin.subscriptions.grant 权限返回 403 { code: 4030 }', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp())
      .post(`/api/admin/subscriptions/${SUB_ID}/grant`)
      .send({ planId: PLAN_A_ID, months: 3, reason: 'x' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.subscriptions.grant' });
  });
});
