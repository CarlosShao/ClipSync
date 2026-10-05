/**
 * 合并重复账号端点单测（POST /api/admin/users/merge，2026-10-05 新增）
 *
 * 分层：**执行逻辑**（搬数据、退役、事务、闸门）在 services/accountMerge.js，
 * 由 tests/accountMerge.test.js 覆盖；本文件只钉**路由这一层**的职责：
 *   - 权限、入参校验、**对两个账号都做越级防护**（不能把超管的账号并掉，也不能并给别人）；
 *   - 把服务层的失败原因**如实映射**成 HTTP 状态与可执行的话术（尤其订阅冲突那条，
 *     要明确告诉运营"先去退款/收窄"而不是一句"合并失败"）；
 *   - 审计与通知；以及"被拒绝时绝不谎报成功"。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/pool.js', () => {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return { pool, default: pool };
});

const authState = vi.hoisted(() => ({ user: null }));
const mergeMock = vi.hoisted(() => ({ mergeAccountInto: vi.fn() }));

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

vi.mock('../../src/services/accountMerge.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mergeAccountInto: mergeMock.mergeAccountInto };
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

const CANON = 'c0000000-0000-4000-8000-000000000001';
const DUP = 'd0000000-0000-4000-8000-000000000002';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  mergeMock.mergeAccountInto.mockReset();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

/** 两个账号都存在；可分别调等级 */
function mockUsers({
  canonicalLevel = 10,
  duplicateLevel = 10,
  canonicalExists = true,
  duplicateExists = true,
  grantedPerms = ['admin.users.manage'],
} = {}) {
  pool.query.mockImplementation(async (sql, params) => {
    if (sql.includes('perm_key')) {
      const requested = params?.[1];
      return grantedPerms.includes(requested)
        ? { rows: [{ perm_key: requested }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM users u')) {
      const rows = [];
      if (canonicalExists) {
        rows.push({
          id: CANON,
          nickname: '保留方',
          phone: '13800000001',
          email: null,
          merged_into: null,
          role_level: canonicalLevel,
        });
      }
      if (duplicateExists) {
        rows.push({
          id: DUP,
          nickname: '被合并方',
          phone: '13800000002',
          email: null,
          merged_into: null,
          role_level: duplicateLevel,
        });
      }
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

function findAuditCall(action) {
  return pool.query.mock.calls.find(([sql, params]) => {
    return sql.includes('INSERT INTO audit_logs') && params[1] === action;
  });
}

const merge = (body) => request(buildApp()).post('/api/admin/users/merge').send(body);

const validBody = { canonicalUserId: CANON, duplicateUserId: DUP, confirmMovedClips: 3, reason: '同人两号' };

describe('合并账号 · 入参校验', () => {
  it('缺 id / id 非法 / 同一个账号 / 缺原因 → 400（且不调用服务层）', async () => {
    mockUsers();

    expect((await merge({ ...validBody, canonicalUserId: undefined })).status).toBe(400);
    expect((await merge({ ...validBody, duplicateUserId: 'nope' })).status).toBe(400);
    expect((await merge({ ...validBody, duplicateUserId: CANON })).status).toBe(400);
    expect((await merge({ ...validBody, reason: '  ' })).status).toBe(400);
    expect((await merge({ ...validBody, reason: 'x'.repeat(201) })).status).toBe(400);
    expect(mergeMock.mergeAccountInto).not.toHaveBeenCalled();
  });

  it('账号不存在 → 404，且指明是哪一个', async () => {
    mockUsers({ duplicateExists: false });
    const res = await merge(validBody);
    expect(res.status).toBe(404);
    expect(res.body.message).toContain('被合并账号');
  });
});

describe('合并账号 · ★对两个账号都做越级防护', () => {
  it('★保留方是超管级 → 403，且不调用服务层', async () => {
    mockUsers({ canonicalLevel: 100 });
    const res = await merge(validBody);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40302);
    expect(mergeMock.mergeAccountInto).not.toHaveBeenCalled();
  });

  it('★被合并方是同级/更高级 → 403（不能借"合并"把别人的账号并掉）', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    mockUsers({ duplicateLevel: 50, grantedPerms: ['admin.users.manage'] });
    const res = await merge(validBody);
    expect(res.status).toBe(403);
    expect(mergeMock.mergeAccountInto).not.toHaveBeenCalled();
  });

  it('无 admin.users.manage 权限 → 403', async () => {
    mockUsers({ grantedPerms: ['admin.users.view'] });
    const res = await merge(validBody);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(4030);
  });
});

describe('合并账号 · 服务层失败要如实映射（不谎报成功）', () => {
  it('★条数对不上 → 409 且**回传最新条数**（运营据此刷新重试）', async () => {
    mockUsers();
    mergeMock.mergeAccountInto.mockResolvedValue({
      ok: false,
      reason: 'CLIP_COUNT_MISMATCH',
      movedClips: 9,
    });

    const res = await merge(validBody);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('CLIP_COUNT_MISMATCH');
    expect(res.body.movedClips).toBe(9);
    expect(res.body.message).toContain('9 条');
    expect(findAuditCall('admin.user.merge')).toBeUndefined();
  });

  it('★订阅冲突 → 409 且给出可执行的话术（先去退款/收窄）', async () => {
    mockUsers();
    mergeMock.mergeAccountInto.mockResolvedValue({ ok: false, reason: 'SUBSCRIPTION_CONFLICT' });

    const res = await merge(validBody);

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('退款');
    expect(res.body.message).toContain('收窄');
  });

  it('已被合并过 / 账号不存在 → 409 / 404', async () => {
    mockUsers();
    mergeMock.mergeAccountInto.mockResolvedValue({ ok: false, reason: 'ALREADY_MERGED' });
    expect((await merge(validBody)).status).toBe(409);

    mockUsers();
    mergeMock.mergeAccountInto.mockResolvedValue({ ok: false, reason: 'USER_NOT_FOUND' });
    expect((await merge(validBody)).status).toBe(404);
  });
});

describe('合并账号 · 成功路径', () => {
  it('写审计（含搬走条数/订阅/设备数）+ 通知保留方 + 返回合并统计', async () => {
    mockUsers();
    mergeMock.mergeAccountInto.mockResolvedValue({
      ok: true,
      movedClips: 12,
      movedSubscription: true,
      duplicateDeviceCount: 2,
      canonicalNickname: '保留方',
      duplicateNickname: '被合并方',
    });

    const res = await merge(validBody);

    expect(res.status).toBe(200);
    expect(res.body.data.merged).toMatchObject({
      fromUserId: DUP,
      movedClips: 12,
      movedSubscription: true,
      duplicateDeviceCount: 2,
    });
    // 文案要主动交代"设备没搬过去"，别让运营以为设备也合并了
    expect(res.body.message).toContain('设备');

    const audit = findAuditCall('admin.user.merge');
    expect(audit).toBeTruthy();
    const payload = audit[1].map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('|');
    expect(payload).toContain('movedClips');
    expect(payload).toContain('12');
    expect(payload).toContain('duplicateDeviceCount');
    expect(payload).toContain('同人两号');

    expect(
      pool.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO notification_history'))
    ).toBe(true);
  });
});
