/**
 * 公告软撤回单测（POST /api/admin/announcements/:id/withdraw，2026-10-05 新增，迁移 085）
 *
 * 这个端点补的是：公告**只能发、不能撤**。发错内容（写错价格、发错受众、把草稿发出去）
 * 时客户端仍会一直返回它，而表上根本没有"撤回"语义的列 —— 改库连语义都没有。
 *
 * 判据：
 *  ① 软撤回（只置 withdrawn_at）—— **绝不 DELETE**：送达/已读两张表都是
 *     `ON DELETE CASCADE`，硬删会连带毁掉"发给了谁、多少人看过"的唯一证据；
 *  ② 已撤回 → 409 并告知撤回时间（不静默重复撤）；
 *  ③ 审计要留下**撤回时的下发/点击数据**（事后复盘靠它）；
 *  ④ 权限沿用 admin.announce.send（撤回是下发的逆操作）。
 *
 * 客户端拉取侧过滤（`WHERE withdrawn_at IS NULL`）在 tests/app-announcements.test.js。
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

const ANNOUNCEMENT_ID = 'a5000000-0000-4000-8000-00000000000a';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

function mockPath({
  exists = true,
  withdrawnAt = null,
  grantedPerms = ['admin.announce.send'],
} = {}) {
  const writes = { withdrawUpdate: null, deletes: [] };
  const row = {
    id: ANNOUNCEMENT_ID,
    title: '国庆活动',
    content: '全场五折',
    audience: 'all',
    display_mode: 'once',
    sent_by: 'u-super',
    delivered_count: 128,
    click_count: 37,
    created_at: new Date('2026-10-01T02:00:00Z'),
    withdrawn_at: withdrawnAt,
  };
  pool.query.mockImplementation(async (sql, params) => {
    if (sql.includes('perm_key')) {
      const requested = params?.[1];
      return grantedPerms.includes(requested)
        ? { rows: [{ perm_key: requested }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT id, title, audience')) {
      // 撤回前的存在性/已撤回检查
      return { rows: exists ? [{ ...row }] : [], rowCount: exists ? 1 : 0 };
    }
    if (sql.includes('UPDATE admin_announcements')) {
      writes.withdrawUpdate = { sql, params };
      return { rows: [{ ...row, withdrawn_at: new Date('2026-10-05T12:00:00Z') }], rowCount: 1 };
    }
    if (sql.includes('DELETE')) {
      writes.deletes.push({ sql, params });
      return { rows: [], rowCount: 0 };
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

const withdraw = (body, id = ANNOUNCEMENT_ID) =>
  request(buildApp()).post(`/api/admin/announcements/${id}/withdraw`).send(body);

describe('公告撤回 · ★软撤回（绝不硬删）', () => {
  it('★只 UPDATE withdrawn_at，绝不 DELETE（送达/已读表是 CASCADE，硬删会毁证据）', async () => {
    const writes = mockPath();

    const res = await withdraw({ reason: '价格写错了' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(writes.withdrawUpdate).toBeTruthy();
    expect(writes.withdrawUpdate.sql).toContain('withdrawn_at = NOW()');
    expect(writes.withdrawUpdate.params).toEqual([ANNOUNCEMENT_ID]);
    // 关键：没有任何 DELETE
    expect(writes.deletes).toHaveLength(0);
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('DELETE'))).toBe(false);
    expect(res.body.data.withdrawnAt).toBeTruthy();
  });

  it('★审计留下撤回时的下发数/点击数（事后复盘靠它）', async () => {
    mockPath();
    await withdraw({ reason: '受众发错了' });

    const audit = findAuditCall('admin.announce.withdraw');
    expect(audit).toBeTruthy();
    const payload = audit[1].map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('|');
    expect(payload).toContain('国庆活动');
    expect(payload).toContain('128'); // delivered
    expect(payload).toContain('37'); // clicked
    expect(payload).toContain('受众发错了');
  });
});

describe('公告撤回 · 保护闸与校验', () => {
  it('已撤回 → 409 并告知撤回时间，且不再写库', async () => {
    const writes = mockPath({ withdrawnAt: new Date('2026-10-04T08:30:00Z') });

    const res = await withdraw({ reason: '再撤一次' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('ALREADY_WITHDRAWN');
    expect(res.body.withdrawnAt).toBeTruthy();
    expect(res.body.message).toContain('无需重复');
    expect(writes.withdrawUpdate).toBeNull();
  });

  it('公告不存在 → 404；ID 非法 → 400；缺原因 / 超长 → 400', async () => {
    mockPath({ exists: false });
    expect((await withdraw({ reason: 'x' })).status).toBe(404);

    mockPath();
    expect((await withdraw({ reason: 'x' }, 'not-a-uuid')).status).toBe(400);
    expect((await withdraw({})).status).toBe(400);
    expect((await withdraw({ reason: '   ' })).status).toBe(400);
    expect((await withdraw({ reason: 'x'.repeat(201) })).status).toBe(400);
  });

  it('权限沿用 admin.announce.send（撤回是下发的逆操作）', async () => {
    // 只有 announce.view 的人不能撤
    mockPath({ grantedPerms: ['admin.announce.view'] });
    const res = await withdraw({ reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(4030);
  });
});
