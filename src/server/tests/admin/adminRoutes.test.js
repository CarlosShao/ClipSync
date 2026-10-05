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
import adminRouter, { ADMIN_STRICT_WRITE_PATTERNS, isAdminStrictWrite } from '../../src/routes/admin/index.js';

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

// ───────────────────────── AN-07 高危写限流名单 ─────────────────────────
// 这份名单是"哪些管理写操作要叠加更严限流"的唯一真相源。漏一条是**静默**的
//（不报错，只是那道闸没了）—— 所以必须钉住。
// 2026-10-05：收回订阅权益（revoke）当时就漏了，尽管旁边 reject 那条的注释
// 写着同样的理由「会改用户权益，同样按高危限流」。
describe('ADMIN_STRICT_WRITE_PATTERNS —— 高危写限流名单', () => {
  const hit = (path) => ADMIN_STRICT_WRITE_PATTERNS.some((re) => re.test(path));

  it('① 会改用户权益/钱的端点必须在名单里', () => {
    expect(hit('/subscriptions/a1000000-0000-4000-8000-000000000001/revoke')).toBe(true); // 收回权益
    expect(hit('/refund-reviews/a1000000-0000-4000-8000-000000000001/reject')).toBe(true); // 驳回改权益
    expect(hit('/refund-reviews/a1000000-0000-4000-8000-000000000001/approve')).toBe(true); // 真打款
    expect(hit('/orders/ORD123/refund')).toBe(true); // 退款
    expect(hit('/orders/ORD123/invoice')).toBe(true); // 补录开票信息（财务/税务凭证写入）
  });

  it('② 对外触达与账号级动作也在名单里', () => {
    expect(hit('/users/a1000000-0000-4000-8000-000000000001/notify')).toBe(true); // 定向通知=对外触达
    expect(hit('/users/a1000000-0000-4000-8000-000000000001/reset-password')).toBe(true); // 换掉登录凭据
    expect(hit('/users/a1000000-0000-4000-8000-000000000001/rebind')).toBe(true); // 换掉登录标识
    expect(hit('/users/a1000000-0000-4000-8000-000000000001/trial')).toBe(true); // 人工给出订阅权益
    expect(hit('/users/a1000000-0000-4000-8000-000000000001/profile')).toBe(true); // 改用户可见内容
    expect(hit('/users/a1000000-0000-4000-8000-000000000001/limits')).toBe(true); // 单用户放宽配额
    expect(hit('/users/merge')).toBe(true); // 退役一个账号 + 跨表搬数据（不可逆）
    expect(hit('/announcements/a1000000-0000-4000-8000-000000000001/withdraw')).toBe(true); // 对外内容补救
    expect(hit('/users/a1000000-0000-4000-8000-000000000001/force-logout')).toBe(true);
    expect(hit('/devices/a1000000-0000-4000-8000-000000000001/offline')).toBe(true);
    expect(hit('/devices/a1000000-0000-4000-8000-000000000001')).toBe(true); // 解绑（会连带删内容）
    expect(hit('/ops/actions')).toBe(true);
  });

  it('③ 只读路径不得被误伤（否则普通查询会被 10/min 卡住）', () => {
    expect(hit('/subscriptions')).toBe(false);
    expect(hit('/users')).toBe(false);
    expect(hit('/audit-logs')).toBe(false);
    // 注意：/users/:id、/devices/:id 这两条是为 DELETE 写的模式，它们同时也会匹配
    // 同路径的其它方法；但限流方法判定是 POST/DELETE/**PATCH**（见 isAdminStrictWrite），
    // 而这两个路径上不存在 PATCH 路由，且 GET 不在方法白名单里 —— 都不会被误伤。
  });

  it('④ 模式是"整段匹配"而不是前缀匹配（/users/:id 不该把 /users/:id/export 也吞掉）', () => {
    expect(hit('/users/a1000000-0000-4000-8000-000000000001/export')).toBe(false);
    expect(hit('/subscriptions/a1000000-0000-4000-8000-000000000001/stats')).toBe(false);
  });

  /**
   * ★2026-10-05：方法判定此前只认 `POST || DELETE`，于是名单里的 **PATCH 条目形同虚设**
   * —— `/users/:id/profile`（本轮加的）压根没被限流过。名单是唯一真相源，而"漏掉是静默的"，
   * 所以把方法判定一并导出并在这里钉两个方向：该限的限、读方法不能限。
   */
  it('⑤ 方法判定：PATCH 必须在内（否则名单里的 PATCH 条目等于没写）', () => {
    expect(isAdminStrictWrite('POST', '/orders/ORD123/refund')).toBe(true);
    expect(isAdminStrictWrite('DELETE', '/devices/a1000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isAdminStrictWrite('PATCH', '/users/a1000000-0000-4000-8000-000000000001/profile')).toBe(
      true
    );
    expect(isAdminStrictWrite('PATCH', '/orders/ORD123/invoice')).toBe(true);

    // 读方法一律不限流；未列入名单的写路径也不限流
    expect(isAdminStrictWrite('GET', '/users/a1000000-0000-4000-8000-000000000001/profile')).toBe(
      false
    );
    expect(isAdminStrictWrite('PATCH', '/configs/maintenance_mode')).toBe(false);
    expect(isAdminStrictWrite('PUT', '/users/merge')).toBe(false);
  });
});
