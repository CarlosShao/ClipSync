/**
 * Admin Console RBAC 鉴权中间件单测（Admin Console · T-A1）
 *
 * 覆盖（middleware/adminAuth.js）：
 *  - requireRole(minLevel)：等级达标放行 / 不足拒绝 / 无 req.user 拒绝 / roleLevel 缺失 fail-closed
 *  - requirePerm(permKey)：有权限放行 / 无权限 403 错误壳 / 缓存命中（第二次不再查库，
 *    断言 mock 调用次数）/ 无 req.user 不查库直接拒绝 / token 带 roleId 走快捷查询 /
 *    DB 异常 fail-closed 500 / 无权限结果同样进缓存
 *
 * 全离线：vi.mock db/pool（参照 ai-hallucination-guard.test.js 的既有 mock 风格），
 * 不触真实数据库；setup.js 中的连接预检查在 mock 生效下同样零依赖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/pool.js', () => {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return { pool, default: pool };
});

import { pool } from '../../src/db/pool.js';
import { requireRole, requirePerm, clearPermCache } from '../../src/middleware/adminAuth.js';

// res 桩：记录 status()/json() 调用结果，供错误壳断言
function mockRes() {
  return {
    statusCode: undefined,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

beforeEach(() => {
  clearPermCache(); // 权限缓存是模块级状态，逐用例清空保证隔离
  pool.query.mockClear();
});

// ======================================================================
// requireRole(minLevel)
// ======================================================================
describe('requireRole(minLevel)', () => {
  it('等级等于门槛放行：admin(50) 通过 requireRole(50)', () => {
    const req = { user: { userId: 'u1', roleKey: 'admin', roleLevel: 50 } };
    const res = mockRes();
    const next = vi.fn();

    requireRole(50)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });

  it('等级高于门槛放行：super_admin(100) 通过 requireRole(50)', () => {
    const req = { user: { userId: 'u2', roleKey: 'super_admin', roleLevel: 100 } };
    const res = mockRes();
    const next = vi.fn();

    requireRole(50)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('等级不足拒绝：user(10) 访问 requireRole(50) → 403 { code: 4030, 权限不足 }', () => {
    const req = { user: { userId: 'u3', roleKey: 'user', roleLevel: 10 } };
    const res = mockRes();
    const next = vi.fn();

    requireRole(50)(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '权限不足' });
    expect(next).not.toHaveBeenCalled();
  });

  it('无 req.user（未认证/未挂 authenticateToken）→ 403 权限不足', () => {
    const req = {};
    const res = mockRes();
    const next = vi.fn();

    requireRole(50)(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '权限不足' });
    expect(next).not.toHaveBeenCalled();
  });

  it('roleLevel 缺失/非数值时 fail-closed 拒绝', () => {
    const res = mockRes();
    const next = vi.fn();

    requireRole(50)({ user: { userId: 'u4' } }, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

// ======================================================================
// requirePerm(permKey)
// ======================================================================
describe('requirePerm(permKey)', () => {
  it('有权限放行，且按 users 表回查 role_id（userId 作为查询参数）', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ perm_key: 'admin.users.view', role_key: 'admin', level: 50 }],
      rowCount: 1,
    });
    const req = { user: { userId: 'u-admin', roleKey: 'admin', roleLevel: 50 } };
    const res = mockRes();
    const next = vi.fn();

    await requirePerm('admin.users.view')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('FROM users');
    expect(params).toEqual(['u-admin', 'admin.users.view']);
    expect(res.statusCode).toBeUndefined();
  });

  it('无权限返回 403 错误壳 { code: 4030, message: 缺少权限: <permKey> }', async () => {
    // 默认 mock 实现：rows: []（无该权限点记录）
    const req = { user: { userId: 'u-admin', roleKey: 'admin', roleLevel: 50 } };
    const res = mockRes();
    const next = vi.fn();

    await requirePerm('admin.users.delete')(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.users.delete' });
    expect(next).not.toHaveBeenCalled();
  });

  it('缓存命中：同一 userId+permKey 第二次调用不再查库（断言 mock 调用次数）', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ perm_key: 'admin.audit.view' }],
      rowCount: 1,
    });
    const mw = requirePerm('admin.audit.view');
    const buildReq = () => ({ user: { userId: 'u-cache', roleKey: 'admin', roleLevel: 50 } });

    await mw(buildReq(), mockRes(), vi.fn());
    await mw(buildReq(), mockRes(), vi.fn());
    // 第二次命中 60s TTL 内存缓存，不再触发 SQL
    expect(pool.query).toHaveBeenCalledTimes(1);

    // clearPermCache() 后缓存失效，恢复查库
    clearPermCache();
    await mw(buildReq(), mockRes(), vi.fn());
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('无权限（否定）结果同样写入缓存：第二次直接拒绝且不查库', async () => {
    const mw = requirePerm('admin.users.delete');
    const buildReq = () => ({ user: { userId: 'u-neg', roleKey: 'admin', roleLevel: 50 } });
    const res1 = mockRes();
    const res2 = mockRes();

    await mw(buildReq(), res1, vi.fn());
    await mw(buildReq(), res2, vi.fn());

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res1.statusCode).toBe(403);
    expect(res2.statusCode).toBe(403);
  });

  it('缓存按 userId 隔离：不同用户同一权限点仍会查库', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ perm_key: 'admin.audit.view' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ perm_key: 'admin.audit.view' }], rowCount: 1 });

    await requirePerm('admin.audit.view')(
      { user: { userId: 'u-a', roleLevel: 50 } }, mockRes(), vi.fn()
    );
    await requirePerm('admin.audit.view')(
      { user: { userId: 'u-b', roleLevel: 50 } }, mockRes(), vi.fn()
    );

    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('无 req.user 拒绝且不触发查库', async () => {
    const res = mockRes();
    const next = vi.fn();

    await requirePerm('admin.users.view')({}, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '权限不足' });
    expect(next).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('token 携带 roleId 时直接按 role_id 查询（跳过 users 回查）', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ perm_key: 'admin.plans.manage', role_key: 'super_admin', level: 100 }],
      rowCount: 1,
    });
    const req = {
      user: { userId: 'u5', roleId: 'role-uuid-1', roleKey: 'super_admin', roleLevel: 100 },
    };
    const res = mockRes();
    const next = vi.fn();

    await requirePerm('admin.plans.manage')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('FROM users');
    expect(params).toEqual(['role-uuid-1', 'admin.plans.manage']);
  });

  it('DB 查询异常时 fail-closed：返回 500 { code: 5000 }，绝不放行', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    const req = { user: { userId: 'u6', roleKey: 'admin', roleLevel: 50 } };
    const res = mockRes();
    const next = vi.fn();

    await requirePerm('admin.users.view')(req, res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ code: 5000, message: '权限校验失败' });
    expect(next).not.toHaveBeenCalled();
  });
});
