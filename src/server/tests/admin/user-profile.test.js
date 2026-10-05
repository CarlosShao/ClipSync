/**
 * 违规昵称/头像处置单测（PATCH /api/admin/users/:id/profile，2026-10-05 新增）
 *
 * 这个端点补的是：`routes/admin/` 里**没有任何 profile 写端点**，运营遇到违规昵称/头像
 * 只能"停用整个账号"（过重）或改库。
 *
 * 而改库在这里**确实不够**，两条都是本文件要钉住的：
 *  ① `GET /profile` 有 Redis 缓存（TTL 5 分钟），用户侧改资料会 `clearUserCache`，
 *     **改库不会** ⇒ 用户最长 5 分钟仍看到旧昵称，客服会以为"改了没生效"；
 *  ② 存储形态必须与用户侧一致（`sanitizeString` 后的形态），否则同一条数据两种写法。
 *
 * 另外钉住"管理台比用户侧更严"的部分：头像只接受 http(s) / data:image，
 * 而用户侧 `PUT /profile` 对协议完全不校验（`javascript:` 也会原样存下）。
 *
 * 全离线：vi.mock db/pool + middleware/auth + utils/cache。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/pool.js', () => {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return { pool, default: pool };
});

const authState = vi.hoisted(() => ({ user: null }));
const cacheMock = vi.hoisted(() => ({ clearUserCache: vi.fn(async () => 1) }));

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

// 只替换 clearUserCache（其余缓存函数保持原样，避免影响别的 import）
vi.mock('../../src/utils/cache.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, clearUserCache: cacheMock.clearUserCache };
});

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

const TARGET_ID = 'a3000000-0000-4000-8000-00000000000a';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  cacheMock.clearUserCache.mockClear();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

function mockPath({
  userExists = true,
  roleLevel = 10,
  nickname = '违规昵称',
  avatar = 'https://cdn.example.com/a.png',
  grantedPerms = ['admin.users.manage'],
} = {}) {
  const writes = { update: null, sessionRevoke: null };
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
          ? [{ id: TARGET_ID, nickname, role_level: roleLevel, phone: '13800000002', email: null }]
          : [],
        rowCount: userExists ? 1 : 0,
      };
    }
    if (sql.includes('UPDATE users SET') && sql.includes('nickname =')) {
      writes.update = { sql, params };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE users SET') && sql.includes('avatar_url =')) {
      writes.update = { sql, params };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE user_sessions')) {
      writes.sessionRevoke = { sql, params };
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

const moderate = (body, id = TARGET_ID) =>
  request(buildApp()).patch(`/api/admin/users/${id}/profile`).send(body);

describe('资料处置 · ★必须清 Redis 用户缓存（改库不会，用户最长 5 分钟看到旧值）', () => {
  it('★改昵称后清缓存（否则 GET /profile 仍返回旧昵称）', async () => {
    mockPath();

    const res = await moderate({ nickname: '合规昵称', reason: '昵称违规' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(cacheMock.clearUserCache).toHaveBeenCalledWith(TARGET_ID);
    expect(cacheMock.clearUserCache).toHaveBeenCalledTimes(1);
  });

  it('★存储形态与用户侧一致：走 sanitizeString（'/' 会被转义成 &#x2F;）', async () => {
    const writes = mockPath();

    await moderate({ nickname: 'a/b', reason: 'x' });

    // validateNickname 允许 '/'，而用户侧落库前也会 sanitizeString —— 两边形态必须一致
    expect(writes.update.params[1]).toBe('a&#x2F;b');
  });
});

describe('资料处置 · 头像（比用户侧更严）', () => {
  it('clearAvatar → avatar_url 置空串（列默认值）', async () => {
    const writes = mockPath();
    const res = await moderate({ clearAvatar: true, reason: '头像违规' });

    expect(res.status).toBe(200);
    expect(writes.update.sql).toContain('avatar_url = $2');
    expect(writes.update.params[1]).toBe('');
    expect(cacheMock.clearUserCache).toHaveBeenCalledWith(TARGET_ID);
  });

  it('avatarUrl 接受 http(s) 与 data:image；★拒绝 javascript: 等协议', async () => {
    mockPath();
    expect(
      (await moderate({ avatarUrl: 'https://cdn.example.com/new.png', reason: 'x' })).status,
    ).toBe(200);
    expect(
      (
        await moderate({
          avatarUrl: 'data:image/png;base64,iVBORw0KGgo=',
          reason: 'x',
        })
      ).status,
    ).toBe(200);

    const bad = await moderate({ avatarUrl: 'javascript:alert(1)', reason: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('http(s)');
    // 被拒时不得落库（用一份干净的 mock 记录，避免被前面两次成功请求的写记录干扰）
    const rejectedWrites = mockPath();
    const bad2 = await moderate({ avatarUrl: 'javascript:alert(1)', reason: 'x' });
    expect(bad2.status).toBe(400);
    expect(rejectedWrites.update).toBeNull();
  });

  it('头像超长（>2000）→ 400', async () => {
    mockPath();
    const res = await moderate({
      avatarUrl: `https://x/${'a'.repeat(2100)}`,
      reason: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('昵称与头像同时处置 → 两条 SET 一起写', async () => {
    const writes = mockPath();
    await moderate({ nickname: '新名字', clearAvatar: true, reason: 'x' });
    expect(writes.update.sql).toContain('nickname = $2');
    expect(writes.update.sql).toContain('avatar_url = $3');
    expect(writes.update.params).toEqual([TARGET_ID, '新名字', '']);
  });
});

describe('资料处置 · 校验与保护闸', () => {
  it('一项都不给 → 400；空昵称 → 400（并给出中性替代名的建议）', async () => {
    mockPath();
    expect((await moderate({ reason: 'x' })).status).toBe(400);

    const empty = await moderate({ nickname: '   ', reason: 'x' });
    expect(empty.status).toBe(400);
    expect(empty.body.message).toContain('用户4821');
  });

  it('昵称超 50 字 / 含 < > " \' & → 400', async () => {
    mockPath();
    expect((await moderate({ nickname: 'x'.repeat(51), reason: 'x' })).status).toBe(400);
    expect((await moderate({ nickname: 'a<b', reason: 'x' })).status).toBe(400);
    expect((await moderate({ nickname: 'a&b', reason: 'x' })).status).toBe(400);
  });

  it('缺原因 / 原因超长 → 400；用户不存在 → 404；ID 非法 → 400', async () => {
    mockPath();
    expect((await moderate({ nickname: 'ok' })).status).toBe(400);
    expect((await moderate({ nickname: 'ok', reason: 'x'.repeat(201) })).status).toBe(400);

    mockPath({ userExists: false });
    expect((await moderate({ nickname: 'ok', reason: 'x' })).status).toBe(404);
    expect((await moderate({ nickname: 'ok', reason: 'x' }, 'nope')).status).toBe(400);
  });

  it('★越级防护：目标等级不低于操作者 → 403，且不写库、不清缓存', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    const writes = mockPath({ roleLevel: 50 });

    const res = await moderate({ nickname: 'ok', reason: '越权尝试' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40302);
    expect(writes.update).toBeNull();
    expect(cacheMock.clearUserCache).not.toHaveBeenCalled();
  });

  it('无 admin.users.manage 权限 → 403', async () => {
    mockPath({ grantedPerms: ['admin.users.view'] });
    const res = await moderate({ nickname: 'ok', reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(4030);
  });
});

describe('资料处置 · 审计与副作用', () => {
  it('审计记改动前后昵称、是否改头像、原因', async () => {
    mockPath({ nickname: '原违规名' });
    await moderate({ nickname: '新合规名', reason: '社区规范' });

    const audit = findAuditCall('admin.user.profile_moderation');
    expect(audit).toBeTruthy();
    const payload = audit[1]
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join('|');
    expect(payload).toContain('原违规名');
    expect(payload).toContain('新合规名');
    expect(payload).toContain('avatarChanged');
    expect(payload).toContain('社区规范');
  });

  it('不吊销会话（昵称/头像可逆、不涉及凭据，为它踢人下线不成比例）', async () => {
    const writes = mockPath();
    await moderate({ nickname: 'ok', reason: 'x' });
    expect(writes.sessionRevoke).toBeNull();
  });
});
