/**
 * Admin Console 角色与权限 API 单测（Admin Console · T-A5）
 *
 * 覆盖（routes/admin/roles.js 挂载在 /api/admin 后的完整中间件链）：
 *  - GET  /roles        角色数组（memberCount / permissions 集合 / Role 契约字段）
 *  - GET  /permissions  权限目录（13 项含 category / superAdminOnly，DB 为事实来源）
 *  - POST /roles        requirePerm('admin.roles.manage')：custom_ 前缀、名称/标识唯一、
 *                       级别 1-99 且 ≤ 操作者级别、审计 admin.roles.create
 *  - PATCH /roles/:id/permissions  requirePerm('admin.roles.manage')：拒改 super_admin（403）、
 *                       未知 key 400、同级拒绝 superAdminOnly（越级防护 403）、
 *                       事务全量替换、审计 admin.roles.update、响应按请求顺序回显
 *
 * 全离线：vi.mock db/pool（含事务 connect）+ middleware/auth（与 orders.test.js 同风格）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const txState = vi.hoisted(() => ({ queries: [] }));

vi.mock('../../src/db/pool.js', () => {
  const client = {
    query: vi.fn(async (sql) => {
      txState.queries.push(sql);
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: vi.fn(async () => client),
  };
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
  txState.queries = [];
  pool.query.mockClear();
  pool.query.mockReset();
  // 默认身份：super_admin（roles.manage / configs.manage 等高危权限基准身份）
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

/** requirePerm 放行（持有指定权限点） */
function grantPerm() {
  pool.query.mockImplementation(async (sql) => {
    if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.roles.manage' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

describe('GET /api/admin/roles —— 角色列表', () => {
  it('返回 Role 契约数组：memberCount 统计、permissions 按角色分组', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('GROUP BY r.id')) {
        return {
          rows: [
            { id: 'r-super', role_key: 'super_admin', name: '超级管理员', level: 100, is_system: true, description: '产品所有者', member_count: 1 },
            { id: 'r-admin', role_key: 'admin', name: '管理员', level: 50, is_system: true, description: '受信任协作者', member_count: 2 },
            { id: 'r-user', role_key: 'user', name: '普通用户', level: 10, is_system: true, description: '默认用户', member_count: 88 },
          ],
          rowCount: 3,
        };
      }
      if (sql.includes('FROM role_permissions rp')) {
        // DB 按 ORDER BY p.perm_key 返回（audit < users 字典序）
        return {
          rows: [
            { role_id: 'r-admin', perm_key: 'admin.audit.view' },
            { role_id: 'r-admin', perm_key: 'admin.users.view' },
            { role_id: 'r-super', perm_key: 'admin.users.view' },
          ],
          rowCount: 3,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/roles');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toHaveLength(3);

    const [superAdmin, admin] = res.body.data;
    expect(superAdmin).toMatchObject({
      id: 'r-super',
      roleKey: 'super_admin',
      name: '超级管理员',
      level: 100,
      memberCount: 1,
      isBuiltIn: true,
      isDefault: false,
      permissions: ['admin.users.view'],
    });
    expect(admin.isDefault).toBe(false);
    const user = res.body.data[2];
    expect(user.roleKey).toBe('user');
    expect(user.isDefault).toBe(true); // 028：新用户默认角色
    expect(user.memberCount).toBe(88);
    expect(admin.permissions).toEqual(['admin.audit.view', 'admin.users.view']); // SQL ORDER BY perm_key
  });

  it('无成员角色 memberCount=0、无权限角色 permissions=[]', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('GROUP BY r.id')) {
        return {
          rows: [
            { id: 'r-custom', role_key: 'custom_ops', name: '运营专员', level: 20, is_system: false, description: '自定义', member_count: 0 },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM role_permissions rp')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/roles');
    const role = res.body.data[0];

    expect(role.memberCount).toBe(0);
    expect(role.permissions).toEqual([]);
    expect(role.isBuiltIn).toBe(false);
  });
});

describe('GET /api/admin/permissions —— 权限目录', () => {
  it('13 项目录：含 category / name 展示元数据 / superAdminOnly 标记，按目录顺序输出', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes("category = 'admin'")) {
        // DB 事实来源：13 个 perm_key（043 12 项 + 044 补 admin.keys.view）
        return {
          rows: [
            { perm_key: 'admin.users.view', description: '查看用户列表与详情' },
            { perm_key: 'admin.users.manage', description: '停用/启用/强制下线/重置2FA' },
            { perm_key: 'admin.users.delete', description: '删除账户（高危）' },
            { perm_key: 'admin.devices.manage', description: '设备远程下线/解绑' },
            { perm_key: 'admin.subscriptions.grant', description: '人工赠期/调整套餐' },
            { perm_key: 'admin.orders.refund', description: '执行退款（高危）' },
            { perm_key: 'admin.orders.reconcile', description: '查看对账报告' },
            { perm_key: 'admin.plans.manage', description: '套餐与价格管理' },
            { perm_key: 'admin.audit.view', description: '查看审计日志' },
            { perm_key: 'admin.roles.manage', description: '角色与权限分配（高危）' },
            { perm_key: 'admin.keys.view', description: '设备密钥细节（仅超管）' },
            { perm_key: 'admin.configs.manage', description: '系统参数与功能开关' },
            { perm_key: 'admin.announce.send', description: '公告与通知下发' },
          ],
          rowCount: 13,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/permissions');

    expect(res.status).toBe(200);
    const perms = res.body.data;
    expect(perms).toHaveLength(13);

    // 目录顺序第一项与最后一项
    expect(perms[0]).toMatchObject({ permKey: 'admin.users.view', category: 'users_devices' });
    expect(perms[12]).toMatchObject({ permKey: 'admin.announce.send', category: 'operations' });

    // superAdminOnly 五项（越级防护针对的权限点）
    const superOnly = perms.filter((p) => p.superAdminOnly).map((p) => p.permKey);
    expect(superOnly.sort()).toEqual(
      ['admin.users.delete', 'admin.orders.refund', 'admin.roles.manage', 'admin.keys.view', 'admin.configs.manage'].sort()
    );

    // category 四分组均出现
    const categories = new Set(perms.map((p) => p.category));
    expect(categories).toEqual(
      new Set(['users_devices', 'subscriptions_orders', 'audit_security', 'operations'])
    );
  });
});

describe('POST /api/admin/roles —— 创建自定义角色', () => {
  it('缺 roleKey/name 返回 400 { code: 40002 }；非 custom_ 前缀返回 400 { code: 40007 }', async () => {
    grantPerm();

    const missing = await request(buildApp())
      .post('/api/admin/roles')
      .send({ roleKey: 'custom_x', name: '  ' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe(40002);

    const badPrefix = await request(buildApp())
      .post('/api/admin/roles')
      .send({ roleKey: 'support', name: '客服', level: 30 });
    expect(badPrefix.status).toBe(400);
    expect(badPrefix.body.code).toBe(40007);

    const upperPrefix = await request(buildApp())
      .post('/api/admin/roles')
      .send({ roleKey: 'Custom_Ops', name: '运营', level: 30 });
    expect(upperPrefix.status).toBe(400);
    expect(upperPrefix.body.code).toBe(40007);
  });

  it('级别非法（0 / 100 / 非整数）返回 400 { code: 40009 }', async () => {
    grantPerm();

    for (const level of [0, 100, 20.5]) {
      const res = await request(buildApp())
        .post('/api/admin/roles')
        .send({ roleKey: 'custom_ops', name: '运营专员', level });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(40009);
    }
  });

  it('越级创建：级别超过操作者角色级别返回 400，且不落库', async () => {
    grantPerm();
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };

    const res = await request(buildApp())
      .post('/api/admin/roles')
      .send({ roleKey: 'custom_high', name: '越级角色', level: 60 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40009);
    expect(res.body.message).toContain('50');
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO roles'))).toBe(false);
  });

  it('角色标识 / 名称重复返回 400 { code: 40008 }', async () => {
    grantPerm();
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.roles.manage' }], rowCount: 1 };
      if (sql.includes('role_key = $1')) return { rows: [{ id: 'r-exists' }], rowCount: 1 }; // 标识已存在
      if (sql.includes('name = $1')) return { rows: [{ id: 'r-exists' }], rowCount: 1 }; // 名称已存在
      return { rows: [], rowCount: 0 };
    });

    const dupKey = await request(buildApp())
      .post('/api/admin/roles')
      .send({ roleKey: 'custom_ops', name: '运营专员', level: 20 });
    expect(dupKey.status).toBe(400);
    expect(dupKey.body.code).toBe(40008);

    // 标识不重复、名称重复
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.roles.manage' }], rowCount: 1 };
      if (sql.includes('role_key = $1')) return { rows: [], rowCount: 0 };
      if (sql.includes('name = $1')) return { rows: [{ id: 'r-exists' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const dupName = await request(buildApp())
      .post('/api/admin/roles')
      .send({ roleKey: 'custom_other', name: '运营专员', level: 20 });
    expect(dupName.status).toBe(400);
    expect(dupName.body.code).toBe(40008);
    expect(dupName.body.message).toContain('名称');
  });

  it('合法创建：memberCount=0、permissions=[]、写审计 admin.roles.create', async () => {
    grantPerm();
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.roles.manage' }], rowCount: 1 };
      if (sql.includes('role_key = $1') || sql.includes('name = $1')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO roles')) {
        return {
          rows: [
            {
              id: 'r-new',
              role_key: 'custom_ops',
              name: '运营专员',
              level: 20,
              is_system: false,
              description: '运营支持',
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 }; // INSERT INTO audit_logs 等
    });

    const res = await request(buildApp())
      .post('/api/admin/roles')
      .send({ roleKey: 'custom_ops', name: '运营专员', level: 20, description: '运营支持' });

    expect(res.status).toBe(201);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({
      id: 'r-new',
      roleKey: 'custom_ops',
      name: '运营专员',
      level: 20,
      memberCount: 0,
      isBuiltIn: false,
      permissions: [],
    });

    // 审计：action=admin.roles.create（logAuditEvent INSERT 参数序：$1 user_id, $2 action, ...）
    const auditCall = pool.query.mock.calls.find(([sql, params]) => {
      return sql.includes('INSERT INTO audit_logs') && params[1] === 'admin.roles.create';
    });
    expect(auditCall).toBeTruthy();
    expect(auditCall[1][0]).toBe('u-super');
    expect(auditCall[1][2]).toBe('role');
    expect(auditCall[1][3]).toBe('custom_ops');
  });

  it('未持有 admin.roles.manage 返回 403 { code: 4030 }', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [], rowCount: 0 }; // admin 角色无 roles.manage（043）
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp())
      .post('/api/admin/roles')
      .send({ roleKey: 'custom_ops', name: '运营专员', level: 20 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.roles.manage' });
  });
});

describe('PATCH /api/admin/roles/:id/permissions —— 保存权限集合', () => {
  const ROLE_ID = 'r-custom';
  const PERMISSIONS = ['admin.users.view', 'admin.users.manage', 'admin.audit.view'];

  /** PATCH 成功链路池 mock：perm 校验 → 角色回读 → key 校验 → 变更前快照 → 成员数 */
  function mockPatchHappyPath({ roleRow, beforeKeys = [], permQueryResult = null } = {}) {
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key = ANY')) {
        // key 校验：默认全部命中（SQL 仅 1 个参数 $1 = permKeys）
        const requested = permQueryResult ?? params[0].map((key) => ({ perm_key: key }));
        return { rows: requested, rowCount: requested.length };
      }
      // 变更前权限快照（须先于通用 perm_key 分支：该 SQL 也含 perm_key 字样）
      if (sql.includes('rp.role_id = $1')) {
        return { rows: beforeKeys.map((perm_key) => ({ perm_key })), rowCount: beforeKeys.length };
      }
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.roles.manage' }], rowCount: 1 };
      if (sql.includes('FROM roles WHERE id = $1')) return { rows: [roleRow], rowCount: 1 };
      if (sql.includes('GROUP BY r.id')) return { rows: [{ member_count: 3 }], rowCount: 1 };
      return { rows: [], rowCount: 0 }; // 审计 INSERT
    });
  }

  it('permissions 非字符串数组返回 400 { code: 40002 }；角色不存在返回 404 { code: 40404 }', async () => {
    grantPerm();

    const badBody = await request(buildApp())
      .patch(`/api/admin/roles/${ROLE_ID}/permissions`)
      .send({ permissions: 'admin.users.view' });
    expect(badBody.status).toBe(400);
    expect(badBody.body.code).toBe(40002);

    grantPerm();
    const missing = await request(buildApp())
      .patch(`/api/admin/roles/${ROLE_ID}/permissions`)
      .send({ permissions: PERMISSIONS });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(40404);
  });

  it('super_admin 角色拒绝修改：403 { code: 40301 }，不产生任何写操作', async () => {
    grantPerm();
    mockPatchHappyPath({
      roleRow: { id: 'r-super', role_key: 'super_admin', name: '超级管理员', level: 100, is_system: true, description: '' },
    });

    const res = await request(buildApp())
      .patch('/api/admin/roles/r-super/permissions')
      .send({ permissions: [] });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40301);
    expect(txState.queries).toEqual([]); // 事务未开启
  });

  it('未知权限键返回 400 { code: 40007 }，事务不开启', async () => {
    grantPerm();
    mockPatchHappyPath({
      roleRow: { id: ROLE_ID, role_key: 'custom_ops', name: '运营专员', level: 20, is_system: false, description: '' },
      permQueryResult: [], // DB 无 admin.not.exist
    });

    const res = await request(buildApp())
      .patch(`/api/admin/roles/${ROLE_ID}/permissions`)
      .send({ permissions: ['admin.not.exist'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40007);
    expect(res.body.message).toContain('admin.not.exist');
    expect(txState.queries).toEqual([]);
  });

  it('越级防护：目标角色 level ≥ 操作者 level 时拒绝授予 superAdminOnly 权限（403）', async () => {
    grantPerm();
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    // 目标为内置 admin 角色（level 50，与操作者同级）
    mockPatchHappyPath({
      roleRow: { id: 'r-admin', role_key: 'admin', name: '管理员', level: 50, is_system: true, description: '' },
    });

    const res = await request(buildApp())
      .patch('/api/admin/roles/r-admin/permissions')
      .send({ permissions: ['admin.users.view', 'admin.users.delete'] }); // users.delete 为 superAdminOnly

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40301);
    expect(res.body.message).toContain('越级');
    expect(txState.queries).toEqual([]); // 未产生任何写操作
  });

  it('同级授予非 superAdminOnly 权限不受限（仅高危权限受越级防护）', async () => {
    grantPerm();
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    mockPatchHappyPath({
      roleRow: { id: 'r-admin', role_key: 'admin', name: '管理员', level: 50, is_system: true, description: '' },
      beforeKeys: ['admin.users.view'],
    });

    const res = await request(buildApp())
      .patch('/api/admin/roles/r-admin/permissions')
      .send({ permissions: ['admin.users.view', 'admin.devices.manage'] });

    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toEqual(['admin.users.view', 'admin.devices.manage']);
  });

  it('合法保存：事务全量替换（BEGIN→DELETE→INSERT→COMMIT）、审计 admin.roles.update、按请求顺序回显', async () => {
    grantPerm();
    mockPatchHappyPath({
      roleRow: { id: ROLE_ID, role_key: 'custom_ops', name: '运营专员', level: 20, is_system: false, description: '' },
      beforeKeys: ['admin.audit.view'],
    });

    const res = await request(buildApp())
      .patch(`/api/admin/roles/${ROLE_ID}/permissions`)
      .send({ permissions: PERMISSIONS });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    // 响应按请求顺序回显（契约往返一致）
    expect(res.body.data.permissions).toEqual(PERMISSIONS);
    expect(res.body.data.memberCount).toBe(3);

    // 事务序列
    expect(txState.queries).toEqual([
      'BEGIN',
      expect.stringContaining('DELETE FROM role_permissions'),
      expect.stringContaining('INSERT INTO role_permissions'),
      'COMMIT',
    ]);
    expect(txState.queries[1]).toContain('role_id = $1');

    // 审计：admin.roles.update，details 含 added/removed
    const auditCall = pool.query.mock.calls.find(([sql, params]) => {
      return sql.includes('INSERT INTO audit_logs') && params[1] === 'admin.roles.update';
    });
    expect(auditCall).toBeTruthy();
    expect(auditCall[1][0]).toBe('u-super');
    expect(auditCall[1][3]).toBe('custom_ops');
    const details = JSON.parse(auditCall[1][4]);
    expect(details.added.sort()).toEqual(['admin.users.manage', 'admin.users.view']);
    expect(details.removed).toEqual([]);
  });

  it('保存成功后清空权限缓存（clearPermCache 生效）', async () => {
    grantPerm();
    mockPatchHappyPath({
      roleRow: { id: ROLE_ID, role_key: 'custom_ops', name: '运营专员', level: 20, is_system: false, description: '' },
    });

    // 预热缓存：u-super + admin.roles.manage → granted
    const first = await request(buildApp())
      .patch(`/api/admin/roles/${ROLE_ID}/permissions`)
      .send({ permissions: [] });
    expect(first.status).toBe(200);

    // 二次请求：即使池 mock 返回无权限，缓存命中仍应放行（证明缓存被清理时机正确后重建）
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    // 注意：clearPermCache 在保存成功后调用 → 缓存已空，此请求应走 DB 校验被拒（403）
    const second = await request(buildApp())
      .patch(`/api/admin/roles/${ROLE_ID}/permissions`)
      .send({ permissions: [] });
    expect(second.status).toBe(403);
  });
});
