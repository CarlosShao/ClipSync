/**
 * Admin Console · 收回订阅权益单测（POST /api/admin/subscriptions/:id/revoke）
 *
 * 这个端点是 2026-10-05 补的：此前 grant 是**单向**的（只会前移档位 + 延长期限），
 * 误发/滥用赠期后**没有任何入口可收回**，只能改库 —— 而改库不写审计、也容易把
 * users 的订阅快照和 user_subscriptions 改得不一致。
 *
 * 最该被钉死的是**保护闸**：订阅下存在真实已付订单时必须拒收
 *（用户花钱买到的权益只能走「退款审核」原路退款），并且**一个 UPDATE 都不能发生** ——
 * 这条要是漏了，管理台上点一下就能没收用户付费权益，是资损 + 投诉 + 合规面。
 *
 * 全离线：vi.mock db/pool + middleware/auth（与 subscriptions.test.js 同风格）。
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

const SUB_ID = 'a1000000-0000-4000-8000-000000000001';
const PLAN_ID = 'b1000000-0000-4000-8000-00000000000a';
const USER_ID = 'c1000000-0000-4000-8000-00000000000c';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

function makeSubscriptionRow(overrides = {}) {
  return {
    id: SUB_ID,
    user_id: USER_ID,
    plan_id: PLAN_ID,
    status: 'active',
    billing_cycle: 'monthly',
    current_period_start: new Date('2026-08-01T00:00:00Z'),
    current_period_end: new Date('2026-09-01T00:00:00Z'),
    auto_renew: true,
    cancel_at_period_end: false,
    created_at: new Date('2026-08-01T00:00:00Z'),
    plan_name: 'Pro',
    plan_display_name: '专业版',
    user_nickname: '未付款测试用户',
    user_phone: '13800000002',
    ...overrides,
  };
}

/**
 * 放行权限 + 造数据；返回写操作调用记录，供「有没有发生写」的断言使用。
 *
 * 权限 mock **按请求的 permKey 判定** —— 本端点刻意复用 admin.subscriptions.grant
 * （不新增权限键，避免动 043 权限目录的迁移），这条 mock 同时验证了它要求的确实是该键。
 */
function mockPath({ paidOrders = 0, subOverrides = {}, grantedPerms = ['admin.subscriptions.grant'] } = {}) {
  const writes = { subscriptionUpdates: [], usersUpdates: [] };
  pool.query.mockImplementation(async (sql, params) => {
    if (sql.includes('perm_key')) {
      const requested = params?.[1];
      return grantedPerms.includes(requested)
        ? { rows: [{ perm_key: requested }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM user_subscriptions us')) {
      return { rows: [makeSubscriptionRow(subOverrides)], rowCount: 1 };
    }
    if (sql.includes('FROM payment_orders')) {
      return { rows: [{ n: paidOrders }], rowCount: 1 };
    }
    if (sql.includes('UPDATE user_subscriptions')) {
      writes.subscriptionUpdates.push({ sql, params });
      return { rows: [{ ...makeSubscriptionRow(subOverrides), status: 'canceled' }], rowCount: 1 };
    }
    if (sql.includes('UPDATE users')) {
      writes.usersUpdates.push({ sql, params });
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

function revoke(body, id = SUB_ID) {
  return request(buildApp()).post(`/api/admin/subscriptions/${id}/revoke`).send(body);
}

describe('revoke · 保护闸（★本轮最重要的判据）', () => {
  it('★有真实已付订单 → 409 HAS_PAID_ORDER，且**一个写操作都不能发生**', async () => {
    const writes = mockPath({ paidOrders: 2 });

    const res = await revoke({ reason: '误发赠期，尝试收回' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('HAS_PAID_ORDER');
    expect(res.body.paidOrders).toBe(2);
    // 提示必须把人引导到退款，而不是让人以为是权限/参数问题
    expect(res.body.message).toContain('退款');
    // 核心反例：绝不能"先撤了再说"——订阅行与用户快照都必须原封不动
    expect(writes.subscriptionUpdates).toHaveLength(0);
    expect(writes.usersUpdates).toHaveLength(0);
  });

  it('已退款订单（status=refunded）不算已付 → 放行（退回的钱不该再拦着收回）', async () => {
    // 服务端 SQL 只数 status='paid'；这里通过「计数为 0」表达"订单存在但已退款"的等价结果
    const writes = mockPath({ paidOrders: 0 });
    const res = await revoke({ reason: '退款后收回权益' });

    expect(res.status).toBe(200);
    expect(writes.subscriptionUpdates).toHaveLength(1);
  });
});

describe('revoke · 立即生效（immediate，默认）', () => {
  it('订阅置 canceled + canceled_at，用户快照回落 free，并写审计', async () => {
    const writes = mockPath();

    const res = await revoke({ reason: '误发赠期一个月' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.revokedMode).toBe('immediate');

    const sub = writes.subscriptionUpdates[0];
    expect(sub.sql).toContain("status = 'canceled'");
    expect(sub.sql).toContain('canceled_at = NOW()');
    expect(sub.params).toEqual([SUB_ID]);

    // 快照回落：必须带 current_subscription_id 条件，否则会把用户另一条生效订阅的档位改错
    const usr = writes.usersUpdates[0];
    expect(usr.sql).toContain("subscription_status = 'free'");
    expect(usr.sql).toContain('current_subscription_id = $2');
    expect(usr.params).toEqual([USER_ID, SUB_ID]);

    const audit = findAuditCall('admin.subscriptions.revoke');
    expect(audit).toBeTruthy();
    expect(audit[1][0]).toBe('u-super');
  });

  it('审计里留下「撤销时确实没有已付订单」的自证字段', async () => {
    mockPath();
    await revoke({ reason: '误发' });

    const audit = findAuditCall('admin.subscriptions.revoke');
    expect(audit).toBeTruthy();
    // 不猜 param 下标：把整串入参摊平成一个字符串再断言关键字段
    const payload = audit[1]
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join('|');
    expect(payload).toContain('"paidOrders":0');
    expect(payload).toContain('"mode":"immediate"');
    expect(payload).toContain('"reason":"误发"');
  });

  it('会告知用户（写 notification_history），且**不把内部原因**透给用户', async () => {
    mockPath();
    await revoke({ reason: '该用户涉嫌滥用赠期' });

    const notify = pool.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO notification_history')
    );
    expect(notify).toBeTruthy();
    const flat = JSON.stringify(notify[1]);
    expect(flat).not.toContain('滥用');
  });
});

describe('revoke · 期末生效（period_end）', () => {
  it('只设 cancel_at_period_end，**不动**用户快照（权益留到期）', async () => {
    const writes = mockPath();

    const res = await revoke({ reason: '到期后不再续', mode: 'period_end' });

    expect(res.status).toBe(200);
    expect(res.body.data.revokedMode).toBe('period_end');
    const sql = writes.subscriptionUpdates[0].sql;
    expect(sql).toContain('cancel_at_period_end = true');
    expect(sql).not.toContain("status = 'canceled'");
    // 期末生效期间他还是付费用户，快照不能回落
    expect(writes.usersUpdates).toHaveLength(0);
  });
});

describe('revoke · 入参与状态校验', () => {
  it('缺 reason → 400（原因必填，写审计）', async () => {
    mockPath();
    const res = await revoke({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
    expect(res.body.message).toContain('原因');
  });

  it('reason 纯空白 → 400', async () => {
    mockPath();
    const res = await revoke({ reason: '   ' });
    expect(res.status).toBe(400);
  });

  it('reason 超过 200 字 → 400', async () => {
    mockPath();
    const res = await revoke({ reason: 'x'.repeat(201) });
    expect(res.status).toBe(400);
  });

  it('mode 非法 → 400', async () => {
    mockPath();
    const res = await revoke({ reason: 'ok', mode: 'whenever' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('mode');
  });

  it('订阅 ID 非法 → 400（不查库）', async () => {
    mockPath();
    const res = await revoke({ reason: 'ok' }, 'not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('订阅不存在 → 404', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.subscriptions.grant' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const res = await revoke({ reason: 'ok' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40404);
  });

  it('已经是 canceled → 409，不重复处理', async () => {
    mockPath({ subOverrides: { status: 'canceled' } });
    const res = await revoke({ reason: 'ok' });
    expect(res.status).toBe(409);
  });

  it('无 admin.subscriptions.grant 权限 → 403（收回与赠出同一权限键）', async () => {
    mockPath({ grantedPerms: [] });
    const res = await revoke({ reason: 'ok' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(4030);
  });
});

/**
 * mode=`shorten_to_paid_end`（2026-10-05 新增）：只把「多给的那段」收回来。
 *
 * 场景：订阅**既有真实已付订单、又被误赠一段** —— 保护闸会拒 immediate，而整条收回
 * 又会连带收掉用户付过钱的时段。这类混合场景此前只能改库。
 *
 * 判据集中在**不越界**上：绝不能把到期日收到付费终点之前，也不该在没有付费依据时动手。
 */
describe('revoke · mode=shorten_to_paid_end（收窄到付费终点）', () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** 造"20 天前开始、40 天后到期、1 笔已付订单"的订阅；paid_end 由 db 侧算 */
  function mockShorten({
    paidCount = 1,
    billingCycle = 'monthly',
    startOffsetDays = -20,
    endOffsetDays = 40,
    paidEndOffsetDays = 10,
    subOverrides = {},
  } = {}) {
    const start = new Date(Date.now() + startOffsetDays * DAY);
    const end = new Date(Date.now() + endOffsetDays * DAY);
    const paidEnd = new Date(Date.now() + paidEndOffsetDays * DAY);
    const writes = { subscriptionUpdates: [], usersUpdates: [] };

    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('perm_key')) {
        const requested = params?.[1];
        return requested === 'admin.subscriptions.grant'
          ? { rows: [{ perm_key: requested }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM user_subscriptions us')) {
        return {
          rows: [
            makeSubscriptionRow({
              billing_cycle: billingCycle,
              current_period_start: start,
              current_period_end: end,
              ...subOverrides,
            }),
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM payment_orders')) {
        return { rows: [{ n: paidCount }], rowCount: 1 };
      }
      if (sql.includes('make_interval')) {
        return { rows: [{ paid_end: paidEnd }], rowCount: 1 };
      }
      if (sql.includes('UPDATE user_subscriptions')) {
        writes.subscriptionUpdates.push({ sql, params });
        return { rows: [{ ...makeSubscriptionRow(), current_period_end: paidEnd }], rowCount: 1 };
      }
      if (sql.includes('UPDATE users')) {
        writes.usersUpdates.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    return { writes, paidEnd, start, end };
  }

  it('★正常收窄：只改 current_period_end（+auto_renew），**status 不变、用户快照不动**', async () => {
    const { writes, paidEnd } = mockShorten();

    const res = await revoke({ reason: '误赠一个月，收窄回付费终点', mode: 'shorten_to_paid_end' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.shortenedTo).toBe(paidEnd.toISOString());
    expect(res.body.data.paidOrders).toBe(1);

    const upd = writes.subscriptionUpdates[0];
    expect(upd.sql).toContain('current_period_end = $2');
    expect(upd.sql).toContain('auto_renew = false');
    // ★不能顺手把 status 改成 canceled —— 用户付过钱的那段还在
    expect(upd.sql).not.toContain("status = 'canceled'");
    expect(upd.params[0]).toBe(SUB_ID);
    expect(new Date(upd.params[1]).toISOString()).toBe(paidEnd.toISOString());

    // 仍是付费用户 ⇒ 用户档位快照不能动
    expect(writes.usersUpdates).toHaveLength(0);

    // 审计用**独立 action**，别和"收回"混在一起（事后审计要能分清是哪种操作）
    const audit = findAuditCall('admin.subscriptions.shorten');
    expect(audit).toBeTruthy();
    const payload = audit[1]
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join('|');
    expect(payload).toContain('toPeriodEnd');
    expect(payload).toContain('paidOrders');

    // 到期日被提前，必须告知用户；文案不带内部原因
    const notify = pool.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO notification_history')
    );
    expect(notify).toBeTruthy();
    expect(JSON.stringify(notify[1])).not.toContain('误赠');
  });

  it('★年付订阅按年折算（billing_cycle 传下去）', async () => {
    const { writes } = mockShorten({ billingCycle: 'yearly' });
    await revoke({ reason: 'x', mode: 'shorten_to_paid_end' });
    // make_interval 那条 SQL 的第三个参数是周期白名单
    const shortenQuery = pool.query.mock.calls.find(([sql]) => sql.includes('make_interval'));
    expect(shortenQuery[1][2]).toBe('yearly');
    expect(writes.subscriptionUpdates).toHaveLength(1);
  });

  it('★无已付订单 → 409 NO_PAID_ORDER，且不写库（该用 immediate）', async () => {
    const { writes } = mockShorten({ paidCount: 0 });

    const res = await revoke({ reason: 'x', mode: 'shorten_to_paid_end' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('NO_PAID_ORDER');
    expect(res.body.message).toContain('立即收回');
    expect(writes.subscriptionUpdates).toHaveLength(0);
  });

  it('★付费终点已过去（只剩赠送时段）→ 409 PAID_PERIOD_ALREADY_OVER，且不写库', async () => {
    const { writes } = mockShorten({ paidEndOffsetDays: -3 });

    const res = await revoke({ reason: 'x', mode: 'shorten_to_paid_end' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('PAID_PERIOD_ALREADY_OVER');
    expect(res.body.message).toContain('立即收回');
    expect(writes.subscriptionUpdates).toHaveLength(0);
  });

  it('★付费终点不早于当前到期日（本来就没多给）→ 409 NOTHING_TO_SHORTEN，且不写库', async () => {
    const { writes } = mockShorten({ paidEndOffsetDays: 45 }); // 比 endOffsetDays(40) 还晚

    const res = await revoke({ reason: 'x', mode: 'shorten_to_paid_end' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('NOTHING_TO_SHORTEN');
    // 回传算出来的付费终点，让运营看得见依据
    expect(res.body.paidEnd).toBeTruthy();
    expect(writes.subscriptionUpdates).toHaveLength(0);
  });

  it('★新模式没有削弱保护闸：有已付订单时 immediate 依旧 409 HAS_PAID_ORDER', async () => {
    // 同一个 mock（有 1 笔已付订单），换个 mode 就必须被保护闸拦住
    mockShorten({ paidCount: 2 });
    const res = await revoke({ reason: 'x', mode: 'immediate' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('HAS_PAID_ORDER');
  });
});
