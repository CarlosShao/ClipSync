/**
 * Admin Console 套餐管理 APIs 单测（Admin Console · T-A3）
 *
 * 覆盖（routes/admin/plans.js 挂载在 /api/admin 后的完整中间件链）：
 *  - GET   /api/admin/plans      全量列表（camelCase 映射，features 对象透传）
 *  - PATCH /api/admin/plans/:id
 *      - 部分字段更新：仅 SET body 中出现的白名单列，审计记录逐字段变更
 *      - features 合法 JSON 对象 → JSONB 写入；非法 JSON 字符串 → 400 { code: 4000 }
 *      - 空 body → 400 { code: 4000 }；套餐不存在 → 404
 *      - 无 admin.plans.manage 权限 → 403 { code: 4030 }
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

const PLAN_ID = 'd1000000-0000-4000-8000-000000000001';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

function makePlanRow(overrides = {}) {
  return {
    id: PLAN_ID,
    name: 'Pro',
    display_name: '专业版',
    description: '完整功能解锁',
    price_monthly: '9.90',
    price_yearly: '99.00',
    max_devices: 10,
    max_clipboard_items: 500,
    max_file_size_mb: 10,
    max_storage_mb: 1024,
    features: { ai_classify: true, version_history_days: 30 },
    is_active: true,
    created_at: new Date('2026-08-03T00:00:00Z'),
    ...overrides,
  };
}

describe('GET /api/admin/plans —— 套餐列表', () => {
  it('返回 { list } 且字段映射为 camelCase，features 对象透传', async () => {
    pool.query.mockImplementation(async (sql) => {
      // RB-06：GET 读侧也走 requirePerm('admin.plans.view')，先放行权限查询
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.plans.view' }], rowCount: 1 };
      if (sql.includes('FROM subscription_plans')) return { rows: [makePlanRow()], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/plans');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.list[0]).toEqual({
      id: PLAN_ID,
      name: 'Pro',
      displayName: '专业版',
      description: '完整功能解锁',
      priceMonthly: 9.9,
      priceYearly: 99,
      maxDevices: 10,
      maxClipboardItems: 500,
      maxFileSizeMb: 10,
      maxStorageMb: 1024,
      features: { ai_classify: true, version_history_days: 30 },
      isActive: true,
      createdAt: expect.any(String),
    });
  });
});

describe('PATCH /api/admin/plans/:id —— 套餐编辑', () => {
  function mockPatchFlow({ existing = makePlanRow(), updated = null } = {}, captured = {}) {
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key')) {
        return { rows: [{ perm_key: 'admin.plans.manage' }], rowCount: 1 };
      }
      if (sql.includes('FROM subscription_plans') && sql.includes('WHERE id = $1')) {
        return existing ? { rows: [existing], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE subscription_plans')) {
        captured.update = { sql, params };
        return { rows: [updated || existing], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        captured.audit = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    return captured;
  }

  it('部分字段更新：仅 SET 提交的白名单列，响应返回更新后套餐，审计含变更明细', async () => {
    const captured = {};
    mockPatchFlow({ updated: makePlanRow({ price_monthly: '19.90', is_active: false }) }, captured);

    const res = await request(buildApp())
      .patch(`/api/admin/plans/${PLAN_ID}`)
      .send({ price_monthly: 19.9, is_active: false });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({ id: PLAN_ID, priceMonthly: 19.9, isActive: false });

    // 只更新提交的两个字段，未提交字段不出现在 SET 子句
    expect(captured.update.sql).toContain('price_monthly = $2');
    expect(captured.update.sql).toContain('is_active = $3');
    expect(captured.update.sql).not.toContain('display_name');
    expect(captured.update.params).toEqual([PLAN_ID, 19.9, false]);

    // 审计：action=admin.plans.update，details 含逐字段变更值
    expect(captured.audit.params[1]).toBe('admin.plans.update');
    expect(captured.audit.params[2]).toBe('subscription_plan');
    const details = JSON.parse(captured.audit.params[4]);
    expect(details.changes).toEqual({ price_monthly: 19.9, is_active: false });
    expect(details.planName).toBe('专业版');
  });

  it('features 合法 JSON 对象按 JSONB 写入', async () => {
    const captured = {};
    mockPatchFlow({}, captured);

    const res = await request(buildApp())
      .patch(`/api/admin/plans/${PLAN_ID}`)
      .send({ features: { ai_classify: true, full_text_search: true } });

    expect(res.status).toBe(200);
    expect(captured.update.sql).toContain('features = $2::jsonb');
    expect(JSON.parse(captured.update.params[1])).toEqual({
      ai_classify: true,
      full_text_search: true,
    });
  });

  it('非法 features JSON 字符串返回 400 { code: 4000 }，不执行更新', async () => {
    const captured = {};
    mockPatchFlow({}, captured);

    const res = await request(buildApp())
      .patch(`/api/admin/plans/${PLAN_ID}`)
      .send({ features: '{not-valid-json' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
    expect(res.body.message).toContain('features');
    expect(captured.update).toBeUndefined();
  });

  it('空 body（无可更新字段）返回 400 { code: 4000 }', async () => {
    const captured = {};
    mockPatchFlow({}, captured);

    const res = await request(buildApp()).patch(`/api/admin/plans/${PLAN_ID}`).send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
    expect(captured.update).toBeUndefined();
  });

  it('非法数值字段（负数价格）返回 400 { code: 4000 }', async () => {
    const captured = {};
    mockPatchFlow({}, captured);

    const res = await request(buildApp())
      .patch(`/api/admin/plans/${PLAN_ID}`)
      .send({ price_monthly: -1 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
    expect(captured.update).toBeUndefined();
  });

  it('套餐不存在返回 404 { code: 40404 }', async () => {
    mockPatchFlow({ existing: null });

    const res = await request(buildApp())
      .patch(`/api/admin/plans/${PLAN_ID}`)
      .send({ price_monthly: 19.9 });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 40404, message: '套餐不存在' });
  });

  it('无 admin.plans.manage 权限返回 403 { code: 4030 }', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp())
      .patch(`/api/admin/plans/${PLAN_ID}`)
      .send({ price_monthly: 19.9 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.plans.manage' });
  });
});
