/**
 * 人工开通/重置试用单测（POST /api/admin/users/:id/trial，2026-10-05 新增）
 *
 * 这个端点补的是：用户侧 `POST /api/subscriptions/trial` 有**终身一次**闸
 *（库里只要有任一 user_subscriptions 行就拒，连 cancelled/expired 都算），
 * 而它**没有例外通道** —— 客服想补一次试用只能改库，而改库要同时写
 * user_subscriptions（含 trial_end）与 users 的两个快照列，必错。
 *
 * 因此判据集中在三件事上：
 *  ① **刻意绕过**那条闸必须留痕（审计里 bypassedLifetimeGate=true），
 *     否则事后分不清"客服补的"与"用户自助的"；
 *  ② 但**不能叠出第二条生效中的订阅** —— 已有付费/试用进行中就该拒（409 且不 INSERT）；
 *  ③ 写入必须与用户侧 trial 同口径（status='trial'、区间由 SQL 算、users 快照同步）。
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

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

const TARGET_ID = 'a2000000-0000-4000-8000-00000000000a';
const PLAN_ID = 'b2000000-0000-4000-8000-00000000000b';
const SUB_ID = 'c2000000-0000-4000-8000-00000000000c';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

function mockPath({
  userExists = true,
  roleLevel = 10,
  liveSub = null,
  plan = { id: PLAN_ID, name: 'pro', display_name: '专业版' },
  planMissing = false,
  grantedPerms = ['admin.subscriptions.grant'],
} = {}) {
  const writes = { insert: null, usersUpdate: null, audits: [] };
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
                subscription_status: 'free',
              },
            ]
          : [],
        rowCount: userExists ? 1 : 0,
      };
    }
    // 生效中订阅检查
    if (sql.includes('FROM user_subscriptions') && sql.includes('status IN')) {
      return { rows: liveSub ? [liveSub] : [], rowCount: liveSub ? 1 : 0 };
    }
    if (sql.includes('FROM subscription_plans')) {
      return { rows: planMissing ? [] : [plan], rowCount: planMissing ? 0 : 1 };
    }
    if (sql.includes('INSERT INTO user_subscriptions')) {
      writes.insert = { sql, params };
      return {
        rows: [{ id: SUB_ID, trial_end: new Date('2026-10-12T00:00:00Z'), current_period_end: new Date('2026-10-12T00:00:00Z') }],
        rowCount: 1,
      };
    }
    if (sql.includes('UPDATE users')) {
      writes.usersUpdate = { sql, params };
      return { rows: [], rowCount: 1 };
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

function findNotification() {
  return pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO notification_history'));
}

const trial = (body, id = TARGET_ID) =>
  request(buildApp()).post(`/api/admin/users/${id}/trial`).send(body);

describe('人工试用 · 写入口径（与用户侧 trial 一致）', () => {
  it('默认 7 天：status=trial、trial_end 由 SQL 算、users 快照同步指向新订阅', async () => {
    const writes = mockPath();

    const res = await trial({ reason: '试用期内服务故障，补一次' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.message).toContain('7 天试用');

    const ins = writes.insert;
    expect(ins.sql).toContain("'trial'");
    expect(ins.sql).toContain('trial_end');
    // 区间由 SQL 计算（避免 JS/DB 时区偏移），参数里给的是校验过的整数天数
    expect(ins.sql).toContain('make_interval');
    expect(ins.params).toEqual([TARGET_ID, PLAN_ID, 'monthly', 7]);

    // users 快照必须同步，否则订阅检查中间件读到旧状态
    expect(writes.usersUpdate.params).toEqual([TARGET_ID, SUB_ID]);
    expect(writes.usersUpdate.sql).toContain("subscription_status = 'trial'");
    expect(writes.usersUpdate.sql).toContain('current_subscription_id');

    // 通知用户（静默开通也得有迹可循）
    expect(findNotification()).toBeTruthy();
  });

  it('★审计必须留痕「绕过了终身一次闸」（否则事后分不清谁补的）', async () => {
    mockPath();
    await trial({ reason: '客服补发' });

    const audit = findAuditCall('admin.subscriptions.trial');
    expect(audit).toBeTruthy();
    const payload = audit[1]
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join('|');
    expect(payload).toContain('bypassedLifetimeGate');
    expect(payload).toContain('true');
    expect(payload).toContain('客服补发');
    expect(payload).toContain('days');
  });

  it('days 可指定（1–30），年付/月付按参数落库', async () => {
    const writes = mockPath();
    await trial({ reason: 'x', days: 30, billingCycle: 'yearly' });
    expect(writes.insert.params[3]).toBe(30);
    expect(writes.insert.params[2]).toBe('yearly');
  });
});

describe('人工试用 · ★不能叠出第二条生效中的订阅', () => {
  it('★已有生效中订阅（付费或试用进行中）→ 409，且**不 INSERT、不动 users 快照**', async () => {
    const writes = mockPath({
      liveSub: { id: 'old-sub', status: 'active', current_period_end: new Date('2027-01-01T00:00:00Z') },
    });

    const res = await trial({ reason: '想再给一次' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('ALREADY_SUBSCRIBED');
    expect(res.body.message).toContain('赠期');
    expect(writes.insert).toBeNull();
    expect(writes.usersUpdate).toBeNull();
    expect(findAuditCall('admin.subscriptions.trial')).toBeUndefined();
  });

  it('试用进行中同样拒绝（status=trialing）', async () => {
    mockPath({
      liveSub: { id: 't', status: 'trialing', current_period_end: new Date('2027-01-01T00:00:00Z') },
    });
    const res = await trial({ reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.existingStatus).toBe('trialing');
  });
});

describe('人工试用 · 套餐解析与校验', () => {
  it('默认取名为 pro 的套餐（走名称分支，不是 UUID 分支）', async () => {
    mockPath();
    await trial({ reason: 'x' });
    const planQuery = pool.query.mock.calls.find(([sql]) => sql.includes('FROM subscription_plans'));
    expect(planQuery[0]).toContain('lower(name) = lower($1)');
    expect(planQuery[1]).toEqual(['pro']);
  });

  it('给 UUID 时走 id 分支（§4-A12：两条分支必须分流，不能写成 id=$1 OR name=$1）', async () => {
    mockPath();
    await trial({ reason: 'x', planId: PLAN_ID });
    const planQuery = pool.query.mock.calls.find(([sql]) => sql.includes('FROM subscription_plans'));
    expect(planQuery[0]).toContain('WHERE id = $1');
    expect(planQuery[0]).not.toContain('OR');
    expect(planQuery[1]).toEqual([PLAN_ID]);
  });

  it('Free 套餐 / 套餐不存在 → 拒绝', async () => {
    mockPath({ plan: { id: PLAN_ID, name: 'free', display_name: '免费版' } });
    const freeRes = await trial({ reason: 'x' });
    expect(freeRes.status).toBe(400);
    expect(freeRes.body.message).toContain('免费版');

    mockPath({ planMissing: true });
    expect((await trial({ reason: 'x' })).status).toBe(404);
  });

  it('days 非整数 / 0 / 31 → 400；边界 1 与 30 通过', async () => {
    mockPath();
    expect((await trial({ reason: 'x', days: 0 })).status).toBe(400);
    expect((await trial({ reason: 'x', days: 31 })).status).toBe(400);
    expect((await trial({ reason: 'x', days: 1.5 })).status).toBe(400);
    expect((await trial({ reason: 'x', days: '七天' })).status).toBe(400);
    expect((await trial({ reason: 'x', days: 1 })).status).toBe(200);
    expect((await trial({ reason: 'x', days: 30 })).status).toBe(200);
  });

  it('缺原因 / 原因超长 → 400；用户不存在 → 404；ID 非法 → 400', async () => {
    mockPath();
    expect((await trial({})).status).toBe(400);
    expect((await trial({ reason: '  ' })).status).toBe(400);
    expect((await trial({ reason: 'x'.repeat(201) })).status).toBe(400);

    mockPath({ userExists: false });
    expect((await trial({ reason: 'x' })).status).toBe(404);
    expect((await trial({ reason: 'x' }, 'nope')).status).toBe(400);
  });
});

describe('人工试用 · 权限与越级', () => {
  it('★越级防护：目标等级不低于操作者 → 403，且不写库', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    const writes = mockPath({ roleLevel: 50 });

    const res = await trial({ reason: '越权尝试' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40302);
    expect(writes.insert).toBeNull();
  });

  it('无 admin.subscriptions.grant 权限 → 403', async () => {
    mockPath({ grantedPerms: ['admin.users.manage'] });
    const res = await trial({ reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(4030);
  });
});
