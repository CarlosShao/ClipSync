/**
 * Admin Console 用户管理 APIs 单测（Admin Console · T-A1.5 补票）
 *
 * 覆盖（routes/admin/users.js 挂载在 /api/admin 后的完整中间件链）：
 *  - GET    /users        分页壳 { list, total, page, pageSize } + AdminUser 行映射 + 筛选（q/plan/status/registeredIn）
 *  - GET    /users/:id    详情聚合 { user, devices, recentAuditLogs } 与 404/400
 *  - PATCH  /users/:id/status   停用（吊销会话 + 审计 user.deactivate）/ 启用（user.activate）/ 校验
 *  - PATCH  /users/:id/role     授 super_admin 角色拒绝（40301）/ 正常分配写审计 role.assign
 *  - POST   /users/:id/force-logout  吊销全部会话 + 审计 admin.user.force_logout
 *  - POST   /users/:id/reset-2fa     清 two_factor 列 + 审计 admin.user.reset_2fa
 *  - DELETE /users/:id          软删（deleted_by_admin）+ 审计 user.delete；super_admin 拒删
 *
 * 全离线：vi.mock db/pool + middleware/auth（authenticateToken 按用例注入身份），
 * pool.query 以 SQL 片段特征分发 mock 结果（与 orders.test.js 同风格）。
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

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  // 默认身份：super_admin（requirePerm 对 super_admin 角色按 role_permissions 全量放行，
  // 这里统一用 perm_key 查询命中模拟）
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

// ── 夹具：USER_SELECT 输出形态的用户行 ──
const USER_ID = '11111111-1111-4111-8111-111111111111';

function makeUserRow(overrides = {}) {
  return {
    id: USER_ID,
    phone: '13812342765',
    email: 'linqing@gmail.com',
    nickname: '林清和',
    is_active: true,
    subscription_status: 'pro',
    role_id: '22222222-2222-4222-8222-222222222222',
    deactivation_reason: null,
    created_at: new Date('2025-11-02T00:00:00Z'),
    role_key: 'user',
    device_count: 4,
    last_active_at: new Date('2026-09-05T12:33:00Z'),
    last_active_platform: 'windows',
    order_count: 43,
    total_spent: '426.60',
    sub_status: 'active',
    sub_billing_cycle: 'monthly',
    sub_current_period_end: new Date('2026-10-02T00:00:00Z'),
    sub_auto_renew: true,
    sub_plan_name: 'Pro',
    ...overrides,
  };
}

/** 授予 permKey 权限（requirePerm 查询命中） */
function grantPerm(permKey = 'admin.users.view') {
  return { rows: [{ perm_key: permKey }], rowCount: 1 };
}

describe('GET /api/admin/users —— 用户分页列表', () => {
  it('返回分页壳 { list, total, page, pageSize }，行字段符合 AdminUser 契约', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return grantPerm();
      // 注意：USER_SELECT 内含 COUNT(*) 子查询，必须先按 device_count 特征识别用户行查询
      if (sql.includes('device_count')) {
        return { rows: [makeUserRow(), makeUserRow({ id: '33333333-3333-4333-8333-333333333333', nickname: '王小雨', phone: '15912348834' })], rowCount: 2 };
      }
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 3 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/users?page=2&pageSize=10');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.page).toBe(2);
    expect(res.body.data.pageSize).toBe(10);
    expect(res.body.data.list).toHaveLength(2);

    const user = res.body.data.list[0];
    expect(user).toMatchObject({
      id: USER_ID,
      // 手机号/邮箱均打码，不出明文
      phone: '138****2765',
      email: 'lin***@gmail.com',
      nickname: '林清和',
      isActive: true,
      status: 'active',
      deviceCount: 4,
      totalSpent: 426.6,
      orderCount: 43,
      roleId: '22222222-2222-4222-8222-222222222222',
      createdAt: '2025-11-02',
      riskFlag: null,
    });
    expect(user.subscription).toEqual({
      plan: 'pro',
      billingCycle: 'monthly',
      status: 'active',
      currentPeriodEnd: '2026-10-02',
      autoRenew: true,
    });
    expect(user.lastActiveAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(user.lastActiveDesc).toContain('· Windows 客户端');

    // 分页参数：LIMIT/OFFSET 追加在筛选参数之后（page=2 → offset=10）
    const [lastSql, lastParams] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(lastSql).toContain('ORDER BY u.created_at DESC');
    expect(lastParams.slice(-2)).toEqual([10, 10]);
  });

  it('status 映射：is_active=false → disabled；trial → trialing（含 trialDaysLeft）；cancelled → canceled', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return grantPerm();
      if (sql.includes('device_count')) {
        return {
          rows: [
            makeUserRow({
              is_active: false,
              deactivation_reason: '违反社区规范',
              subscription_status: 'free',
              sub_status: 'trial',
              sub_plan_name: null,
              sub_billing_cycle: null,
              sub_auto_renew: false,
              sub_current_period_end: new Date(Date.now() + 3 * 86400000),
            }),
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/users');

    const user = res.body.data.list[0];
    expect(user.isActive).toBe(false);
    expect(user.status).toBe('disabled');
    // deactivation_reason 兜底为 riskFlag 展示
    expect(user.riskFlag).toBe('违反社区规范');
    // 无订阅套餐行时回退 users.subscription_status → free
    expect(user.subscription.plan).toBe('free');
    expect(user.subscription.status).toBe('trialing');
    expect(user.subscription.billingCycle).toBeNull();
    expect(user.subscription.trialDaysLeft).toBe(3);
  });

  it('q 关键词：昵称 ILIKE + id 等值；纯数字关键词追加手机号全号/后 4 位精确匹配', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return grantPerm();
      if (sql.includes('device_count')) return { rows: [], rowCount: 0 };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await request(buildApp()).get('/api/admin/users?q=2765');
    let [sql, params] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).toContain('u.nickname ILIKE $1');
    expect(sql).toContain('u.id::text = $2');
    expect(sql).toContain('u.phone = $2');
    expect(sql).toContain('RIGHT(u.phone, 4) = $2');
    expect(params[0]).toBe('%2765%');
    expect(params[1]).toBe('2765');

    await request(buildApp()).get('/api/admin/users?q=林清和');
    [sql, params] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).not.toContain('RIGHT(u.phone');
    expect(params[0]).toBe('%林清和%');
  });

  it('plan/status/registeredIn 筛选分别落到 subscription_status / is_active / created_at', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return grantPerm();
      if (sql.includes('device_count')) return { rows: [], rowCount: 0 };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp())
      .get('/api/admin/users?plan=pro&status=disabled&registeredIn=7d');

    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).toContain('u.subscription_status = $1');
    expect(params[0]).toBe('pro');
    expect(sql).toContain('u.is_active = FALSE');
    expect(sql).toContain("INTERVAL '7 days'");
  });

  it('非法筛选参数返回 400 { code: 4000 }，不再执行列表查询', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return grantPerm();
      return { rows: [], rowCount: 0 };
    });

    const res1 = await request(buildApp()).get('/api/admin/users?plan=gold');
    const res2 = await request(buildApp()).get('/api/admin/users?status=bogus');
    const res3 = await request(buildApp()).get('/api/admin/users?registeredIn=3d');

    for (const res of [res1, res2, res3]) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(4000);
    }
    const listQueries = pool.query.mock.calls.filter(([sql]) => sql.includes('COUNT(*)'));
    expect(listQueries).toHaveLength(0);
  });

  it('无 admin.users.view 权限返回 403 { code: 4030 }', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [], rowCount: 0 }; // 权限点未授予
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/users');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.users.view' });
  });
});

describe('GET /api/admin/users/:id —— 用户详情聚合', () => {
  function mockDetailFlow(userRow, devices, audits) {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return grantPerm();
      if (sql.includes('device_count')) {
        return { rows: userRow ? [userRow] : [], rowCount: userRow ? 1 : 0 };
      }
      if (sql.includes('FROM devices WHERE user_id')) return { rows: devices, rowCount: devices.length };
      if (sql.includes('FROM audit_logs al')) return { rows: audits, rowCount: audits.length };
      return { rows: [], rowCount: 0 };
    });
  }

  it('返回 { user, devices, recentAuditLogs } 聚合，字段符合 UserDetail 契约', async () => {
    mockDetailFlow(
      makeUserRow(),
      [
        {
          id: 'aaaa1111-1111-4111-8111-aaaaaaaaaaa1',
          device_name: 'DESKTOP-7A2',
          platform: 'windows',
          platform_version: '11',
          is_online: true,
          last_seen_at: new Date('2026-09-05T12:33:00Z'),
        },
        {
          id: 'aaaa1111-1111-4111-8111-aaaaaaaaaaa2',
          device_name: 'Xiaomi 14',
          platform: 'android',
          platform_version: '15',
          is_online: false,
          last_seen_at: null,
        },
      ],
      [
        {
          id: 'bbbb1111-1111-4111-8111-bbbbbbbbbb01',
          user_id: USER_ID,
          action: 'user.login',
          resource_type: 'session',
          resource_id: 'cccc1111-1111-4111-8111-cccccccccccc',
          details: { ip: '116.24.1.1' },
          ip_address: '116.24.1.1',
          user_agent: 'ClipSync/1.4.2',
          status: 'success',
          created_at: new Date('2026-09-05T12:30:00Z'),
          operator_nickname: '林清和',
          operator_phone: '13812342765',
          operator_role_key: 'user',
        },
        {
          id: 'bbbb1111-1111-4111-8111-bbbbbbbbbb02',
          user_id: 'u-super',
          action: 'user.deactivate',
          resource_type: 'user',
          resource_id: USER_ID,
          details: { reason: '违反社区规范' },
          ip_address: '10.0.0.1',
          user_agent: null,
          status: 'success',
          created_at: new Date('2026-09-04T08:00:00Z'),
          operator_nickname: 'Carlos',
          operator_phone: null,
          operator_role_key: 'super_admin',
        },
      ]
    );

    const res = await request(buildApp()).get(`/api/admin/users/${USER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.user.nickname).toBe('林清和');

    expect(res.body.data.devices).toHaveLength(2);
    expect(res.body.data.devices[0]).toEqual({
      id: 'aaaa1111-1111-4111-8111-aaaaaaaaaaa1',
      name: 'DESKTOP-7A2',
      platform: 'windows',
      os: '11',
      status: 'online',
      lastActiveAt: '2026-09-05 12:33',
    });
    expect(res.body.data.devices[1].status).toBe('offline');
    expect(res.body.data.devices[1].lastActiveAt).toBeNull();

    expect(res.body.data.recentAuditLogs).toHaveLength(2);
    const [ownLogin, adminOp] = res.body.data.recentAuditLogs;
    expect(ownLogin).toMatchObject({
      operator: '林清和',
      operatorRole: 'user',
      action: 'user.login',
      status: 'success',
      sensitive: false,
      ipAddress: '116.24.1.1',
      details: 'ip=116.24.1.1',
      createdAt: '2026-09-05 12:30:00',
    });
    expect(adminOp).toMatchObject({
      operator: 'Carlos',
      operatorRole: 'super_admin',
      action: 'user.deactivate',
      sensitive: true,
      details: 'reason="违反社区规范"',
    });
  });

  it('用户不存在返回 404 { code: 40404 }；非法 ID 返回 400 { code: 4000 }', async () => {
    mockDetailFlow(null, [], []);

    const res = await request(buildApp()).get(`/api/admin/users/${USER_ID}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 40404, message: '用户不存在' });

    const res2 = await request(buildApp()).get('/api/admin/users/not-a-uuid');
    expect(res2.status).toBe(400);
    expect(res2.body.code).toBe(4000);
  });
});

describe('PATCH /api/admin/users/:id/status —— 停用/启用', () => {
  function mockStatusFlow(userRow, captured) {
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key')) return grantPerm('admin.users.manage');
      if (sql.includes('device_count')) {
        return { rows: userRow ? [userRow] : [], rowCount: userRow ? 1 : 0 };
      }
      if (sql.includes('UPDATE users')) {
        captured.updateUser = { sql, params };
        // 模拟 DB 更新生效（写操作后回读同一行）
        if (userRow) userRow.is_active = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE user_sessions')) {
        captured.revokeSessions = { sql, params };
        return { rows: [], rowCount: 4 };
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        captured.audit = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  it('停用成功：is_active=false + 落停用原因 + 吊销全部会话 + 审计 user.deactivate', async () => {
    const captured = {};
    const row = makeUserRow();
    mockStatusFlow(row, captured);

    const res = await request(buildApp())
      .patch(`/api/admin/users/${USER_ID}/status`)
      .send({ status: 'disabled', reason: '违反社区规范 #3' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.message).toBe('账号已停用');
    expect(res.body.data.status).toBe('disabled');
    expect(res.body.data.isActive).toBe(false);

    expect(captured.updateUser.sql).toContain('is_active = $2');
    expect(captured.updateUser.sql).toContain('deactivation_reason = $3');
    expect(captured.updateUser.params).toEqual([USER_ID, false, '违反社区规范 #3']);

    expect(captured.revokeSessions).toBeTruthy();
    expect(captured.revokeSessions.sql).toContain('is_active = FALSE, revoked_at = NOW()');
    expect(captured.revokeSessions.params).toEqual([USER_ID]);

    expect(captured.audit).toBeTruthy();
    expect(captured.audit.params[1]).toBe('user.deactivate');
    expect(captured.audit.params[2]).toBe('user');
    const details = JSON.parse(captured.audit.params[4]);
    expect(details).toMatchObject({ targetUserId: USER_ID, reason: '违反社区规范 #3' });
  });

  it('启用成功：is_active=true + 清停用标记 + 不吊销会话 + 审计 user.activate', async () => {
    const captured = {};
    const row = makeUserRow({ is_active: false });
    mockStatusFlow(row, captured);

    const res = await request(buildApp())
      .patch(`/api/admin/users/${USER_ID}/status`)
      .send({ status: 'active' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('账号已启用');
    expect(res.body.data.status).toBe('active');
    expect(captured.updateUser.sql).toContain('deactivation_reason = NULL');
    expect(captured.updateUser.params).toEqual([USER_ID, true]);
    expect(captured.revokeSessions).toBeUndefined();
    expect(captured.audit.params[1]).toBe('user.activate');
  });

  it('停用缺原因返回 400 { code: 4000 }，不产生任何写操作', async () => {
    const captured = {};
    mockStatusFlow(makeUserRow(), captured);

    const res = await request(buildApp())
      .patch(`/api/admin/users/${USER_ID}/status`)
      .send({ status: 'disabled', reason: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
    expect(captured.updateUser).toBeUndefined();
    expect(captured.revokeSessions).toBeUndefined();
  });

  it('status 取值不合法返回 400；用户不存在返回 404 { code: 40404 }', async () => {
    const captured = {};
    mockStatusFlow(makeUserRow(), captured);

    const res = await request(buildApp())
      .patch(`/api/admin/users/${USER_ID}/status`)
      .send({ status: 'frozen' });
    expect(res.status).toBe(400);

    const captured2 = {};
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return grantPerm('admin.users.manage');
      if (sql.includes('device_count')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const res2 = await request(buildApp())
      .patch(`/api/admin/users/${USER_ID}/status`)
      .send({ status: 'disabled', reason: 'x' });
    expect(res2.status).toBe(404);
    expect(res2.body).toEqual({ code: 40404, message: '用户不存在' });
  });

  it('无 admin.users.manage 权限返回 403 { code: 4030 }', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp())
      .patch(`/api/admin/users/${USER_ID}/status`)
      .send({ status: 'disabled', reason: 'x' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.users.manage' });
  });
});

describe('PATCH /api/admin/users/:id/role —— 角色分配', () => {
  const ADMIN_ROLE_ID = '44444444-4444-4444-8444-444444444444';
  const SUPER_ROLE_ID = '55555555-5555-5555-8555-555555555555';

  function mockRoleFlow(userRow, roleRow, captured) {
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key')) return grantPerm('admin.roles.manage');
      if (sql.includes('device_count')) {
        return { rows: userRow ? [userRow] : [], rowCount: userRow ? 1 : 0 };
      }
      if (sql.includes('FROM roles WHERE id::text')) {
        return { rows: roleRow ? [roleRow] : [], rowCount: roleRow ? 1 : 0 };
      }
      if (sql.includes('UPDATE users')) {
        captured.updateUser = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        captured.audit = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  it('授予 super_admin 角色被拒绝（403 { code: 40301 }），不执行更新', async () => {
    const captured = {};
    mockRoleFlow(
      makeUserRow(),
      { id: SUPER_ROLE_ID, role_key: 'super_admin', name: '超级管理员', level: 100 },
      captured
    );

    const res = await request(buildApp())
      .patch(`/api/admin/users/${USER_ID}/role`)
      .send({ roleId: SUPER_ROLE_ID, reason: '提权' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40301);
    expect(captured.updateUser).toBeUndefined();
  });

  it('分配 admin 角色成功：更新 role_id + 审计 role.assign', async () => {
    const captured = {};
    mockRoleFlow(
      makeUserRow(),
      { id: ADMIN_ROLE_ID, role_key: 'admin', name: '管理员', level: 50 },
      captured
    );

    const res = await request(buildApp())
      .patch(`/api/admin/users/${USER_ID}/role`)
      .send({ roleId: ADMIN_ROLE_ID, reason: '晋升运营管理员' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(captured.updateUser.sql).toContain('SET role_id = $2');
    expect(captured.updateUser.params).toEqual([USER_ID, ADMIN_ROLE_ID]);

    expect(captured.audit.params[1]).toBe('role.assign');
    expect(captured.audit.params[2]).toBe('user');
    const details = JSON.parse(captured.audit.params[4]);
    expect(details).toMatchObject({
      targetUserId: USER_ID,
      roleId: ADMIN_ROLE_ID,
      roleKey: 'admin',
      reason: '晋升运营管理员',
    });
  });

  it('角色不存在返回 404 { code: 40404 }', async () => {
    const captured = {};
    mockRoleFlow(makeUserRow(), null, captured);

    const res = await request(buildApp())
      .patch(`/api/admin/users/${USER_ID}/role`)
      .send({ roleId: ADMIN_ROLE_ID });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 40404, message: '角色不存在' });
  });

  it('roleId 非法返回 400 { code: 4000 }', async () => {
    const captured = {};
    mockRoleFlow(makeUserRow(), null, captured);

    const res = await request(buildApp())
      .patch(`/api/admin/users/${USER_ID}/role`)
      .send({ roleId: 'role_admin' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
  });
});

describe('POST /api/admin/users/:id/force-logout —— 强制下线', () => {
  it('吊销该用户全部活跃会话并写审计 admin.user.force_logout', async () => {
    const captured = {};
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key')) return grantPerm('admin.users.manage');
      if (sql.includes('device_count')) return { rows: [makeUserRow()], rowCount: 1 };
      if (sql.includes('UPDATE user_sessions')) {
        captured.revoke = { sql, params };
        return { rows: [], rowCount: 3 };
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        captured.audit = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).post(`/api/admin/users/${USER_ID}/force-logout`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: USER_ID, revokedSessions: 3 });
    expect(captured.revoke.sql).toContain('WHERE user_id = $1 AND is_active = TRUE');

    expect(captured.audit.params[1]).toBe('admin.user.force_logout');
    const details = JSON.parse(captured.audit.params[4]);
    expect(details).toMatchObject({ targetUserId: USER_ID, sessionsRevoked: 3 });
  });

  it('用户不存在返回 404 { code: 40404 }', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return grantPerm('admin.users.manage');
      if (sql.includes('device_count')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).post(`/api/admin/users/${USER_ID}/force-logout`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 40404, message: '用户不存在' });
  });
});

describe('POST /api/admin/users/:id/reset-2fa —— 重置两步验证', () => {
  it('清空 users 表 2FA 列并写审计 admin.user.reset_2fa', async () => {
    const captured = {};
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key')) return grantPerm('admin.users.manage');
      if (sql.includes('device_count')) return { rows: [makeUserRow()], rowCount: 1 };
      if (sql.includes('UPDATE users')) {
        captured.update = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        captured.audit = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).post(`/api/admin/users/${USER_ID}/reset-2fa`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: USER_ID, twoFactorEnabled: false });
    // 021_two_factor.sql：2FA 落 users 表列（无独立 two_factor 表）
    expect(captured.update.sql).toContain('two_factor_enabled = FALSE');
    expect(captured.update.sql).toContain('two_factor_secret = NULL');
    expect(captured.update.sql).toContain('two_factor_backup_codes = NULL');
    expect(captured.update.params).toEqual([USER_ID]);

    expect(captured.audit.params[1]).toBe('admin.user.reset_2fa');
    expect(captured.audit.params[2]).toBe('user');
  });
});

describe('DELETE /api/admin/users/:id —— 删除账户（软删）', () => {
  function mockDeleteFlow(userRow, captured) {
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key')) return grantPerm('admin.users.delete');
      if (sql.includes('device_count')) {
        return { rows: userRow ? [userRow] : [], rowCount: userRow ? 1 : 0 };
      }
      if (sql.includes('UPDATE users')) {
        captured.update = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        captured.audit = { sql, params };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  it('软删成功：is_active=false + deactivation_reason=deleted_by_admin + 审计 user.delete', async () => {
    const captured = {};
    mockDeleteFlow(makeUserRow(), captured);

    const res = await request(buildApp()).delete(`/api/admin/users/${USER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: USER_ID, deleted: true });

    expect(captured.update.sql).toContain('is_active = FALSE');
    expect(captured.update.sql).toContain("deactivation_reason = 'deleted_by_admin'");
    expect(captured.update.params).toEqual([USER_ID]);

    expect(captured.audit.params[1]).toBe('user.delete');
    expect(captured.audit.params[2]).toBe('user');
    const details = JSON.parse(captured.audit.params[4]);
    expect(details).toMatchObject({ targetUserId: USER_ID, reason: 'deleted_by_admin' });
  });

  it('super_admin 账户拒绝删除（403 { code: 40301 }）', async () => {
    const captured = {};
    mockDeleteFlow(makeUserRow({ role_key: 'super_admin' }), captured);

    const res = await request(buildApp()).delete(`/api/admin/users/${USER_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40301);
    expect(captured.update).toBeUndefined();
  });

  it('无 admin.users.delete 权限返回 403 { code: 4030 }', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).delete(`/api/admin/users/${USER_ID}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.users.delete' });
  });
});
