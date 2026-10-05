/**
 * 换绑登录标识单测（POST /api/admin/users/:id/rebind，2026-10-05 新增）
 *
 * 这个端点补的是「手机号是登录标识、用户换号就登不上」这个洞。它最大的风险不是不好用，
 * 而是**改漏一列**：`phone` / `phone_hash` / `phone_encrypted` 必须一起写，
 * 少一列的直接后果就是「这个人再也登录不进来」（登录是按 `phone = $1 OR phone_hash = $2` 查的）。
 *
 * 因此本文件逐条钉死：
 *  ① 三列一起写，且 hash 必须与共享派生函数 `computeFieldHash` 的结果**完全一致**；
 *  ② email **小写归一**后再写（否则「注册写大写、登录查小写」会查不到自己）；
 *  ③ 只改一项时另一项**保持原值**（COALESCE，不能顺手清空手机号）；
 *  ④ 撞号 409 且查询必须排除自己（否则"改回原值"会被自己挡住）；
 *  ⑤ 越级防护拦下时**一个写操作都不发生**；
 *  ⑥ 审计只留**打码**值；⑦ 刻意**不**吊销会话。
 *
 * 全离线：vi.mock db/pool + middleware/auth。
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
import { computeFieldHash } from '../../src/utils/fieldHash.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

const TARGET_ID = 'f1000000-0000-4000-8000-00000000000f';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

function mockPath({
  userExists = true,
  roleLevel = 10,
  phoneDup = false,
  emailDup = false,
  grantedPerms = ['admin.users.manage'],
  oldPhone = '13800000001',
  oldEmail = 'old@example.com',
} = {}) {
  const writes = { update: null, sessionRevoke: null, dupQueries: [] };
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
                phone: oldPhone,
                email: oldEmail,
              },
            ]
          : [],
        rowCount: userExists ? 1 : 0,
      };
    }
    // 撞号检查（两条：手机号、邮箱）
    if (sql.includes('FROM users WHERE (phone =')) {
      writes.dupQueries.push({ kind: 'phone', sql, params });
      return { rows: phoneDup ? [{ id: 'other-user' }] : [], rowCount: phoneDup ? 1 : 0 };
    }
    if (sql.includes('FROM users WHERE (email =')) {
      writes.dupQueries.push({ kind: 'email', sql, params });
      return { rows: emailDup ? [{ id: 'other-user' }] : [], rowCount: emailDup ? 1 : 0 };
    }
    if (sql.includes('UPDATE users') && sql.includes('COALESCE')) {
      writes.update = { sql, params };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE user_sessions')) {
      writes.sessionRevoke = { sql, params };
      return { rows: [], rowCount: 2 };
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

const rebind = (body, id = TARGET_ID) =>
  request(buildApp()).post(`/api/admin/users/${id}/rebind`).send(body);

describe('换绑 · 三列一致（★这条要是漏了，用户就再也登不进来）', () => {
  it('★手机号：phone / phone_hash / phone_encrypted 一起写，hash 必须等于共享派生函数的结果', async () => {
    const writes = mockPath();
    const NEW_PHONE = '13900000009';

    const res = await rebind({ phone: NEW_PHONE, reason: '用户换号·工单 #4821' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);

    const sql = writes.update.sql;
    expect(sql).toContain('phone = COALESCE($2, phone)');
    expect(sql).toContain('phone_hash = COALESCE($3, phone_hash)');
    expect(sql).toContain('phone_encrypted = COALESCE($4, phone_encrypted)');

    const [, phone, phoneHash, phoneEncrypted] = writes.update.params;
    expect(phone).toBe(NEW_PHONE);
    // ★与共享派生函数逐字符一致 —— 漂一点就是"查不到自己"
    expect(phoneHash).toBe(computeFieldHash(NEW_PHONE));
    expect(phoneHash).toMatch(/^[0-9a-f]{64}$/);
    // 密文：是字符串且不是明文（encryptField 带随机 IV，不能比对定值）
    expect(typeof phoneEncrypted).toBe('string');
    expect(phoneEncrypted).not.toBe(NEW_PHONE);
    expect(phoneEncrypted.length).toBeGreaterThan(0);
  });

  it('★email 必须小写归一后再写（注册/登录都是小写口径）', async () => {
    const writes = mockPath();

    await rebind({ email: '  Foo.Bar@Example.COM  ', reason: '用户换邮箱' });

    const email = writes.update.params[4];
    const emailHash = writes.update.params[5];
    expect(email).toBe('foo.bar@example.com');
    expect(emailHash).toBe(computeFieldHash('foo.bar@example.com'));
  });

  it('只改邮箱时手机号三列传 null（COALESCE 保持原值，不能顺手清空）', async () => {
    const writes = mockPath();
    await rebind({ email: 'new@example.com', reason: '只换邮箱' });

    const [, phone, phoneHash, phoneEncrypted, email] = writes.update.params;
    expect(phone).toBeNull();
    expect(phoneHash).toBeNull();
    expect(phoneEncrypted).toBeNull();
    expect(email).toBe('new@example.com');
  });

  it('手机号与邮箱同时给 → 六列一起写，文案覆盖两项', async () => {
    const writes = mockPath();
    const res = await rebind({
      phone: '13700000007',
      email: 'both@example.com',
      reason: '换号并换邮箱',
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('手机号与邮箱');
    expect(writes.update.params[1]).toBe('13700000007');
    expect(writes.update.params[4]).toBe('both@example.com');
  });
});

describe('换绑 · 撞号与保护闸', () => {
  it('新手机号已被他人占用 → 409，且**不写库**', async () => {
    const writes = mockPath({ phoneDup: true });
    const res = await rebind({ phone: '13900000009', reason: 'x' });

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('已被其他账号使用');
    expect(writes.update).toBeNull();
    // 撞号查询必须排除自己，否则"改回原值"会被自己挡住
    expect(writes.dupQueries[0].sql).toContain('id <> $3');
    expect(writes.dupQueries[0].params[2]).toBe(TARGET_ID);
  });

  it('新邮箱已被他人占用 → 409，且不写库', async () => {
    const writes = mockPath({ emailDup: true });
    const res = await rebind({ email: 'taken@example.com', reason: 'x' });
    expect(res.status).toBe(409);
    expect(writes.update).toBeNull();
  });

  it('★越级防护：目标等级不低于操作者 → 403，且一个写操作都不发生', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    const writes = mockPath({ roleLevel: 50 });

    const res = await rebind({ phone: '13900000009', reason: '越权尝试' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40302);
    expect(writes.update).toBeNull();
    // 也不该去做撞号查询 —— 闸门在写之前
    expect(writes.dupQueries).toHaveLength(0);
  });

  it('无 admin.users.manage 权限 → 403', async () => {
    mockPath({ grantedPerms: ['admin.users.view'] });
    const res = await rebind({ phone: '13900000009', reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(4030);
  });
});

describe('换绑 · 审计与会话', () => {
  it('★审计只留打码值（不扩散明文 PII）', async () => {
    mockPath();
    const NEW_PHONE = '13900000009';
    const NEW_EMAIL = 'brand.new@example.com';
    await rebind({ phone: NEW_PHONE, email: NEW_EMAIL, reason: '换号' });

    const audit = findAuditCall('admin.user.rebind');
    expect(audit).toBeTruthy();
    const payload = audit[1]
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join('|');
    // 新值必须以打码形式出现：保留前 3 后 4
    expect(payload).toContain('139****0009');
    expect(payload).not.toContain(NEW_PHONE);
    // 邮箱打码后不应出现完整域名以外的一切？至少完整地址不能出现
    expect(payload).not.toContain(NEW_EMAIL);
    // 旧值也留痕（"从什么改成什么"要能追溯）
    expect(payload).toContain('138****0001');
    expect(payload).toContain('换号');
  });

  it('刻意**不**吊销会话（换绑不授予新访问，强行踢人会把换号变成全端下线事故）', async () => {
    const writes = mockPath();
    await rebind({ phone: '13900000009', reason: 'x' });
    expect(writes.sessionRevoke).toBeNull();
  });
});

describe('换绑 · 入参校验', () => {
  it('phone 与 email 都缺 → 400（"至少给一个"）', async () => {
    mockPath();
    const res = await rebind({ reason: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('至少提供一个');
  });

  it('手机号格式非法 → 400；邮箱格式非法 → 400', async () => {
    mockPath();
    expect((await rebind({ phone: '12345', reason: 'x' })).status).toBe(400);
    expect((await rebind({ phone: '23800000002', reason: 'x' })).status).toBe(400);
    expect((await rebind({ email: 'not-an-email', reason: 'x' })).status).toBe(400);
  });

  it('缺原因 / 原因超长 → 400', async () => {
    mockPath();
    expect((await rebind({ phone: '13900000009' })).status).toBe(400);
    expect((await rebind({ phone: '13900000009', reason: '   ' })).status).toBe(400);
    expect((await rebind({ phone: '13900000009', reason: 'x'.repeat(201) })).status).toBe(400);
  });

  it('用户不存在 → 404；ID 非法 → 400', async () => {
    mockPath({ userExists: false });
    expect((await rebind({ phone: '13900000009', reason: 'x' })).status).toBe(404);
    expect((await rebind({ phone: '13900000009', reason: 'x' }, 'nope')).status).toBe(400);
  });
});
