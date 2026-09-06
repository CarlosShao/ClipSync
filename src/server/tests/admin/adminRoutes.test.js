/**
 * Admin Console 路由骨架集成单测（Admin Console · T-A1）
 *
 * 覆盖（routes/admin/index.js 挂载在 /api/admin 后的完整中间件链）：
 *  - 无权限用户（roleLevel=10）访问 /api/admin/* → 403 错误壳 { code: 4030 }（验收门禁项）
 *  - 管理员（roleLevel=50）GET /whoami → 200 { code: 0, data: { userId, roleKey, roleLevel, permissions } }
 *  - role_id 为空（无任何角色权限）→ permissions 为空数组
 *  - whoami 查库异常 → 500 错误壳 { code: 5000 }
 *
 * 全离线：vi.mock db/pool + middleware/auth（authenticateToken 按用例注入身份，
 * 规避真实 auth.js 在 NODE_ENV=test 下固定注入普通用户的策略）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/pool.js', () => {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return { pool, default: pool };
});

// 用例间通过该对象切换 authenticateToken 注入的身份（vi.hoisted 保证提升可见）
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
  app.use('/api/admin', adminRouter);
  return app;
}

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  authState.user = null;
});

describe('POST 挂载链：/api/admin（authenticateToken → requireRole(50) → superAdminAudit）', () => {
  it('普通用户（roleLevel=10）访问任意 /api/admin/* 返回 403 错误壳，不放行不查库', async () => {
    authState.user = { userId: 'u-user', roleKey: 'user', roleLevel: 10, isAdmin: false };

    const res = await request(buildApp()).get('/api/admin/whoami');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '权限不足' });
    expect(pool.query).not.toHaveBeenCalled(); // 门槛在进入路由处理器前拦截
  });

  it('未认证（authenticateToken 未注入 req.user）同样 403', async () => {
    const res = await request(buildApp()).get('/api/admin/whoami');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '权限不足' });
  });

  it('管理员（roleLevel=50）GET /whoami 返回 code=0 与当前角色全部权限点', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockResolvedValueOnce({
      rows: [{ perm_key: 'admin.audit.view' }, { perm_key: 'admin.users.view' }],
      rowCount: 2,
    });

    const res = await request(buildApp()).get('/api/admin/whoami');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toEqual({
      userId: 'u-admin',
      roleKey: 'admin',
      roleLevel: 50,
      permissions: ['admin.audit.view', 'admin.users.view'],
    });
    // whoami 按 users 表回查角色权限
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('FROM users');
    expect(params).toEqual(['u-admin']);
  });

  it('用户无角色（role_id 为空）时 whoami 返回空权限数组而非报错', async () => {
    authState.user = { userId: 'u-bare', roleKey: 'user', roleLevel: 10, isAdmin: false };

    const res = await request(buildApp()).get('/api/admin/whoami');

    expect(res.status).toBe(403); // 先被 requireRole(50) 拦截
    // 再以超管身份验证「角色无任何权限点」的空数组路径
    authState.user = { userId: 'u-super-bare', roleKey: 'super_admin', roleLevel: 100 };
    const res2 = await request(buildApp()).get('/api/admin/whoami');
    expect(res2.status).toBe(200);
    expect(res2.body.code).toBe(0);
    expect(res2.body.data.permissions).toEqual([]);
  });

  it('whoami 查库异常返回 500 错误壳 { code: 5000 }', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50 };
    pool.query.mockRejectedValueOnce(new Error('db down'));

    const res = await request(buildApp()).get('/api/admin/whoami');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 5000, message: '获取权限信息失败' });
  });
});
