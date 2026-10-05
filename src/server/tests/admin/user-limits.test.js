/**
 * 单用户配额覆盖单测（POST /api/admin/users/:id/limits，2026-10-05 新增，迁移 084）
 *
 * 这个端点补的是：配额**只有一个来源**（subscription_plans，经 utils/planLimits.js 解析），
 * 而 `PATCH /admin/plans/:id` 改的是套餐行 —— 会同时影响该套餐下的**所有人**。
 * 「单独给这一个用户提配额」（客诉补偿/大客户/内部测试）此前只能改库，而改库在这个场景
 * 还多一层问题：只改数据没改口径，且完全没有审计。
 *
 * 判据集中在**写入校验**与**保护闸**上：
 *  ① 未知键一律 400（不静默存垃圾 —— 存进去也不生效，只会让人误以为设上了）；
 *  ② null = 该项不限，必须原样存下去（不能被当成"没给"而丢掉）；
 *  ③ clear 与 overrides 互斥；两者都不给也拒（不做"静默什么也没发生"的成功响应）；
 *  ④ 越级被拦时**一个写操作都不发生**；⑤ 审计记改动前后；⑥ 通知用户。
 *
 * 解析语义（覆盖如何叠加到套餐值）在 tests/planLimits-override.test.js，不在本文件。
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

const TARGET_ID = 'a4000000-0000-4000-8000-00000000000a';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

function mockPath({
  userExists = true,
  roleLevel = 10,
  existingOverrides = null,
  grantedPerms = ['admin.users.manage'],
} = {}) {
  const writes = { update: null, audits: [] };
  // mock 要模拟"写后重读"：路由在 UPDATE 之后会再 fetchUserById 一次拿最新值下发，
  // 若 mock 永远返回入参里的旧值，就会误判成"响应没更新"（真实 DB 不会这样）。
  let current = existingOverrides;
  pool.query.mockImplementation(async (sql, params) => {
    if (sql.includes('perm_key')) {
      const requested = params?.[1];
      return grantedPerms.includes(requested)
        ? { rows: [{ perm_key: requested }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('WHERE u.id::text = $1')) {
      return {
        rows: userExists
          ? [
              {
                id: TARGET_ID,
                nickname: '未付款测试用户',
                role_level: roleLevel,
                phone: '13800000002',
                email: null,
                limit_overrides: current,
              },
            ]
          : [],
        rowCount: userExists ? 1 : 0,
      };
    }
    if (sql.includes('UPDATE users SET limit_overrides')) {
      writes.update = { sql, params };
      current = params[1];
      return { rows: [{ id: TARGET_ID, nickname: '未付款测试用户', limit_overrides: current }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO audit_logs')) {
      writes.audits.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return writes;
}

function findAuditCall(action) {
  return pool.query.mock.calls.find(([sql, params]) => {
    return sql.includes('INSERT INTO audit_logs') && params[1] === action;
  });
}

const setLimits = (body, id = TARGET_ID) =>
  request(buildApp()).post(`/api/admin/users/${id}/limits`).send(body);

describe('配额覆盖 · 写入', () => {
  it('设置覆盖：落库清洗后的对象 + 审计记改动前后 + 通知用户', async () => {
    const writes = mockPath({ existingOverrides: { max_storage_mb: 1024 } });

    const res = await setLimits({
      reason: '客诉补偿',
      overrides: { max_storage_mb: 51200, max_file_size_mb: 500 },
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(writes.update.params[0]).toBe(TARGET_ID);
    expect(writes.update.params[1]).toEqual({ max_storage_mb: 51200, max_file_size_mb: 500 });
    expect(res.body.data.limitOverrides).toEqual({ max_storage_mb: 51200, max_file_size_mb: 500 });

    const audit = findAuditCall('admin.user.limits_override');
    expect(audit).toBeTruthy();
    const payload = audit[1].map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('|');
    expect(payload).toContain('客诉补偿');
    expect(payload).toContain('1024'); // before
    expect(payload).toContain('51200'); // after

    expect(
      pool.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO notification_history'))
    ).toBe(true);
  });

  it('★null = 该项不限，必须原样存下去（不能被当成"没给"）', async () => {
    const writes = mockPath();

    const res = await setLimits({ reason: '大客户', overrides: { max_storage_mb: null } });

    expect(res.status).toBe(200);
    expect(writes.update.params[1]).toEqual({ max_storage_mb: null });
  });

  it('clear:true → 落 NULL（回到套餐标准）', async () => {
    const writes = mockPath({ existingOverrides: { max_storage_mb: 51200 } });

    const res = await setLimits({ reason: '补偿期结束', clear: true });

    expect(res.status).toBe(200);
    expect(writes.update.params[1]).toBeNull();
    expect(res.body.message).toContain('清除');
  });
});

describe('配额覆盖 · ★写入校验（不静默存垃圾）', () => {
  it('★未知键 → 400（存进去也不生效，只会让人误以为设上了）', async () => {
    const writes = mockPath();
    const res = await setLimits({ reason: 'x', overrides: { max_devices: 99 } });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('max_devices');
    expect(writes.update).toBeNull();
  });

  it('空对象 → 400（要清除请用 clear:true）', async () => {
    mockPath();
    const res = await setLimits({ reason: 'x', overrides: {} });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('clear:true');
  });

  it('负数 / 非数字 → 400；计数类必须是整数', async () => {
    mockPath();
    expect((await setLimits({ reason: 'x', overrides: { max_storage_mb: -1 } })).status).toBe(400);
    expect((await setLimits({ reason: 'x', overrides: { max_storage_mb: 'many' } })).status).toBe(400);
    // max_files_per_clip / file_retention_days 对应套餐里的 integer 列
    expect((await setLimits({ reason: 'x', overrides: { max_files_per_clip: 1.5 } })).status).toBe(400);
    expect((await setLimits({ reason: 'x', overrides: { file_retention_days: 2.5 } })).status).toBe(400);
    // MB 允许小数
    expect((await setLimits({ reason: 'x', overrides: { max_file_size_mb: 0.5 } })).status).toBe(200);
  });

  it('超出上下界 → 400（不把配额写成天文数字）', async () => {
    mockPath();
    expect((await setLimits({ reason: 'x', overrides: { max_file_size_mb: 10241 } })).status).toBe(400);
    expect((await setLimits({ reason: 'x', overrides: { max_storage_mb: 1048577 } })).status).toBe(400);
    expect((await setLimits({ reason: 'x', overrides: { max_files_per_clip: 10001 } })).status).toBe(400);
    expect((await setLimits({ reason: 'x', overrides: { file_retention_days: 3651 } })).status).toBe(400);
  });

  it('clear 与 overrides 互斥；两者都不给 → 400；overrides 非对象 → 400', async () => {
    mockPath();
    expect(
      (await setLimits({ reason: 'x', clear: true, overrides: { max_storage_mb: 1 } })).status,
    ).toBe(400);
    expect((await setLimits({ reason: 'x' })).status).toBe(400);
    expect((await setLimits({ reason: 'x', overrides: [1, 2] })).status).toBe(400);
    expect((await setLimits({ reason: 'x', overrides: 'nope' })).status).toBe(400);
  });

  it('缺原因 / 原因超长 → 400；用户不存在 → 404；ID 非法 → 400', async () => {
    mockPath();
    expect((await setLimits({ overrides: { max_storage_mb: 1 } })).status).toBe(400);
    expect(
      (await setLimits({ reason: 'x'.repeat(201), overrides: { max_storage_mb: 1 } })).status,
    ).toBe(400);

    mockPath({ userExists: false });
    expect((await setLimits({ reason: 'x', overrides: { max_storage_mb: 1 } })).status).toBe(404);
    expect((await setLimits({ reason: 'x', clear: true }, 'nope')).status).toBe(400);
  });
});

describe('配额覆盖 · 权限与越级', () => {
  it('★越级防护：目标等级不低于操作者 → 403，且不写库、不发通知', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    const writes = mockPath({ roleLevel: 50 });

    const res = await setLimits({ reason: '越权尝试', overrides: { max_storage_mb: 999999 } });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40302);
    expect(writes.update).toBeNull();
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('notification_history'))).toBe(false);
  });

  it('无 admin.users.manage 权限 → 403', async () => {
    mockPath({ grantedPerms: ['admin.users.view'] });
    const res = await setLimits({ reason: 'x', overrides: { max_storage_mb: 1 } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(4030);
  });
});
