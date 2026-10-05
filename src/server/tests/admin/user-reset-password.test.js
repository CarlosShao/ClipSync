/**
 * 管理员代重置密码单测（POST /api/admin/users/:id/reset-password，2026-10-05 新增）
 *
 * 这个端点补的是**唯一的用户救援路径**：此前 `routes/admin/` 里没有任何 password_hash 写路径，
 * 而用户侧自助重置全都要验证码或旧密码 —— 手机+邮箱双失效＝账号永久锁死，客服只能改库。
 *
 * 三条最该钉死的判据：
 *  ① 返回的临时密码与**实际写入的哈希**必须匹配（否则客服转达的密码根本登不上）；
 *  ② 必须**吊销该用户全部活跃会话**（否则旧会话还活着，重置等于没做）；
 *  ③ 密码**绝不能进审计**（审计是长期留存的，一旦落进去就成了凭据的第二份副本）。
 *
 * 全离线：vi.mock db/pool + middleware/auth（与其它 admin 测试同风格）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';

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
import { generateTempPassword } from '../../src/services/userPasswordReset.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

const TARGET_ID = 'e1000000-0000-4000-8000-00000000000e';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

/** 放行权限 + 目标用户存在（role_level 可调，用于越级防护用例） */
function mockPath({ userExists = true, roleLevel = 10, grantedPerms = ['admin.users.manage'] } = {}) {
  const writes = { userUpdate: null, sessionRevoke: null };
  pool.query.mockImplementation(async (sql, params) => {
    if (sql.includes('perm_key')) {
      const requested = params?.[1];
      return grantedPerms.includes(requested)
        ? { rows: [{ perm_key: requested }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('WHERE u.id::text = $1')) {
      return {
        rows: userExists ? [{ id: TARGET_ID, nickname: '未付款测试用户', role_level: roleLevel }] : [],
        rowCount: userExists ? 1 : 0,
      };
    }
    if (sql.includes('UPDATE users SET password_hash')) {
      writes.userUpdate = { sql, params };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE user_sessions')) {
      writes.sessionRevoke = { sql, params };
      return { rows: [], rowCount: 3 };
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

const reset = (body, id = TARGET_ID) =>
  request(buildApp()).post(`/api/admin/users/${id}/reset-password`).send(body);

describe('代重置密码 · 核心判据', () => {
  it('★返回的临时密码必须与写入的哈希匹配（否则客服转达的密码登不上）', async () => {
    const writes = mockPath();

    const res = await reset({ reason: '用户手机丢失，无法接收验证码' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    const { temporaryPassword, sessionsRevoked } = res.body.data;

    // 格式：8 字符 base64url（不含 +/ ，便于口头转达）
    expect(temporaryPassword).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(sessionsRevoked).toBe(3);

    // 真正写进去的是 bcrypt 哈希，不是明文
    const hash = writes.userUpdate.params[0];
    expect(hash).not.toBe(temporaryPassword);
    expect(hash).toMatch(/^\$2[aby]\$/);
    // ★端到端：拿返回的密码去 compare 落库的哈希，必须为 true
    await expect(bcrypt.compare(temporaryPassword, hash)).resolves.toBe(true);
    expect(writes.userUpdate.params[1]).toBe(TARGET_ID);
  });

  it('★必须吊销该用户全部活跃会话（否则旧会话仍能用，重置等于没做）', async () => {
    const writes = mockPath();
    await reset({ reason: '账号疑似被盗' });

    expect(writes.sessionRevoke).toBeTruthy();
    expect(writes.sessionRevoke.sql).toContain('is_active = FALSE');
    expect(writes.sessionRevoke.sql).toContain('revoked_at = NOW()');
    expect(writes.sessionRevoke.params).toEqual([TARGET_ID]);
  });

  it('★密码绝不能进审计（审计长期留存，不能成为凭据的第二份副本）', async () => {
    mockPath();
    const res = await reset({ reason: '手机丢失' });
    const pw = res.body.data.temporaryPassword;

    const audit = findAuditCall('admin.user.reset_password');
    expect(audit).toBeTruthy();
    const payload = audit[1]
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join('|');
    expect(payload).not.toContain(pw);
    // 但审计要能看出「谁给谁重置了、为什么」
    expect(payload).toContain('手机丢失');
    expect(payload).toContain('sessionsRevoked');
  });
});

describe('代重置密码 · 保护闸', () => {
  it('★不得重置自己或等级不低于自己的用户（否则 admin 可一步接管 super_admin）', async () => {
    // 操作者是 admin(50)，目标是同级 admin(50) ⇒ 拒
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    const writes = mockPath({ roleLevel: 50, grantedPerms: ['admin.users.manage'] });

    const res = await reset({ reason: '越权尝试' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40302);
    // 关键：被拦下时不得改密码、也不得吊销会话
    expect(writes.userUpdate).toBeNull();
    expect(writes.sessionRevoke).toBeNull();
  });

  it('不能重置超管（目标等级 100 ≥ 操作者 50）', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    const writes = mockPath({ roleLevel: 100 });
    const res = await reset({ reason: 'x' });
    expect(res.status).toBe(403);
    expect(writes.userUpdate).toBeNull();
  });

  it('无 admin.users.manage 权限 → 403', async () => {
    mockPath({ grantedPerms: ['admin.users.read'] });
    const res = await reset({ reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(4030);
  });
});

describe('代重置密码 · 入参校验', () => {
  it('缺原因 / 原因超长 → 400（原因写审计，必填）', async () => {
    mockPath();
    expect((await reset({})).status).toBe(400);
    expect((await reset({ reason: '   ' })).status).toBe(400);
    expect((await reset({ reason: 'x'.repeat(201) })).status).toBe(400);
  });

  it('用户不存在 → 404；ID 非法 → 400', async () => {
    mockPath({ userExists: false });
    expect((await reset({ reason: 'x' })).status).toBe(404);
    expect((await reset({ reason: 'x' }, 'not-a-uuid')).status).toBe(400);
  });
});

describe('临时密码生成器', () => {
  it('每次都不一样，且长度/字符集稳定', () => {
    const a = generateTempPassword();
    const b = generateTempPassword();
    expect(a).not.toBe(b);
    expect(a).toHaveLength(8);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8}$/);
    // 满足服务端「≥8 位」的最短要求（auth.js 的注册/改密口径）
    expect(a.length).toBeGreaterThanOrEqual(8);
  });
});
