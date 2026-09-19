import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import pool from '../src/db/pool.js';
import { clearPermCache } from '../src/middleware/adminAuth.js';
import { AUDIT_ACTIONS, logAuditEvent } from '../src/utils/audit.js';

/**
 * 管理台支付/订阅面真库测试（§4-A12 + §4-A11）
 *
 * 为什么要真库：这两条缺陷都是「mock 全绿、真后端必坏」的类型 ——
 *   A12 人工赠期：管理台前端发 planId='pro'，旧后端要求 UUID → 真实后端必 400；
 *       而且 PG 不允许把 'pro' 拿去和 uuid 列比较（22P02），所以「一条 SQL 同时兜两种」
 *       的写法必须被真库验一遍才敢说能用。
 *   A11 审计筛选：旧实现 LIKE 'payment.%'，而库里真实 action 是 payment_create 等
 *       下划线值 → 生产上「支付相关」筛选永远 0 命中。只有真库能证明「修完真能查到」。
 *
 * 身份：middleware/auth 被 mock 注入临时管理员；requirePerm 打真库 RBAC
 * （super_admin 受迁移 037 唯一性触发器保护，故另建持权自定义角色）。
 */

const ADMIN_USER_ID = '00000000-0000-0000-0000-0000000000b1';
const TARGET_USER_ID = '00000000-0000-0000-0000-0000000000b2';
const TEST_ROLE_KEY = 'test_pay_audit_admin';
const NEEDED_PERMS = ['admin.subscriptions.grant', 'admin.audit.view', 'admin.orders.view'];

const authState = vi.hoisted(() => ({ user: null }));

vi.mock('../src/middleware/auth.js', () => ({
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
import adminRouter from '../src/routes/admin/index.js';

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

let adminRoleId = null;
const planIds = {}; // { Free, Pro, Enterprise }

async function ensureTempRole() {
  const { rows } = await pool.query(
    `INSERT INTO roles (role_key, name, level, is_system, is_assignable, description)
     VALUES ($1, '支付审计测试角色', 60, false, true, 'tests/admin-payment-surfaces.test.js 临时角色')
     ON CONFLICT (role_key) DO UPDATE SET level = EXCLUDED.level
     RETURNING id`,
    [TEST_ROLE_KEY]
  );
  const roleId = rows[0].id;
  const { rows: perms } = await pool.query(
    `SELECT id, perm_key FROM permissions WHERE perm_key = ANY($1)`,
    [NEEDED_PERMS]
  );
  if (perms.length !== NEEDED_PERMS.length) {
    throw new Error(`[admin-payment-surfaces] 权限点缺种子：${NEEDED_PERMS.join(',')}`);
  }
  for (const p of perms) {
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [roleId, p.id]
    );
  }
  return roleId;
}

/** 目标用户 + 一条挂在 Free 上的 active 订阅（赠期前的起点） */
async function seedSubscription() {
  const { rows } = await pool.query(
    `INSERT INTO user_subscriptions
       (user_id, plan_id, status, billing_cycle, start_date, end_date,
        current_period_start, current_period_end, created_at, updated_at)
     VALUES ($1, $2, 'active', 'monthly', NOW(), NOW() + INTERVAL '20 day',
             NOW(), NOW() + INTERVAL '20 day', NOW(), NOW())
     RETURNING id, current_period_end`,
    [TARGET_USER_ID, planIds.Free]
  );
  await pool.query('UPDATE users SET subscription_status = $1, current_subscription_id = $2, updated_at = NOW() WHERE id = $3',
    ['free', rows[0].id, TARGET_USER_ID]);
  return { subscriptionId: rows[0].id, periodEnd: new Date(rows[0].current_period_end) };
}

async function readSubscription(subscriptionId) {
  const { rows } = await pool.query('SELECT * FROM user_subscriptions WHERE id = $1', [subscriptionId]);
  return rows[0];
}

function grant(subscriptionId, body) {
  return request(buildAdminApp()).post(`/api/admin/subscriptions/${subscriptionId}/grant`).send(body);
}

async function cleanup() {
  // 只按 user_id 删（audit_logs 上有索引）。
  // ⚠️ 不要用 `details::text LIKE '%…%'` 之类的表达式做清理条件：clipsync_test 的
  // audit_logs 有若干超大 details 行（AI 会话快照），整表扫一次要 30s+，会把用例拖超时。
  // 同理，查询侧也不用 ?q= 关键字筛选，改用 ?userId= 精确定位本用例自己写的行。
  await pool
    .query(`DELETE FROM audit_logs WHERE user_id = ANY($1)`, [[ADMIN_USER_ID, TARGET_USER_ID]])
    .catch(() => {});
  await pool
    .query(
      `UPDATE users SET subscription_status = 'free', current_subscription_id = NULL WHERE id = $1`,
      [TARGET_USER_ID]
    )
    .catch(() => {});
  await pool.query(`DELETE FROM user_subscriptions WHERE user_id = $1`, [TARGET_USER_ID]).catch(() => {});
}

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[admin-payment-surfaces] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }

  adminRoleId = await ensureTempRole();

  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, role_id, is_admin, subscription_status, created_at, updated_at)
     VALUES ($1, '+86apsadmin01', '赠期测试管理员', 'test_hash', $2, true, 'free', NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET role_id = EXCLUDED.role_id, is_admin = true`,
    [ADMIN_USER_ID, adminRoleId]
  );
  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, subscription_status, created_at, updated_at)
     VALUES ($1, '+86apstarget1', '赠期测试用户', 'test_hash', 'free', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [TARGET_USER_ID]
  );

  const { rows } = await pool.query(
    `SELECT id, name FROM subscription_plans WHERE name = ANY($1)`,
    [['Free', 'Pro', 'Enterprise']]
  );
  for (const r of rows) planIds[r.name] = r.id;
  if (!planIds.Free || !planIds.Pro || !planIds.Enterprise) {
    throw new Error('[admin-payment-surfaces] 缺少 Free/Pro/Enterprise 套餐种子');
  }

  clearPermCache();
  await cleanup();
}, 60000);

beforeEach(async () => {
  await cleanup();
  clearPermCache();
  authState.user = { userId: ADMIN_USER_ID, roleKey: TEST_ROLE_KEY, roleLevel: 60, isAdmin: true };
});

afterAll(async () => {
  await cleanup().catch(() => {});
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[ADMIN_USER_ID, TARGET_USER_ID]]).catch(() => {});
  await pool.query(`DELETE FROM roles WHERE role_key = $1`, [TEST_ROLE_KEY]).catch(() => {});
  await pool.end().catch(() => {});
});

// ───────────────────────── A12：人工赠期 planId 兼容 ─────────────────────────

describe('POST /api/admin/subscriptions/:id/grant —— planId 兼容套餐名（§4-A12）', () => {
  it('管理台真实入参 planId="enterprise"（小写名）→ 200，套餐切换、期末顺延', async () => {
    const { subscriptionId, periodEnd } = await seedSubscription();

    const res = await grant(subscriptionId, { planId: 'enterprise', months: 1, reason: '客服补偿 · 工单 #4821' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.planId).toBe(planIds.Enterprise);
    expect(res.body.data.planKey).toBe('Enterprise');

    const sub = await readSubscription(subscriptionId);
    expect(sub.plan_id).toBe(planIds.Enterprise);
    expect(sub.status).toBe('active');
    // 顺延 1 个月（起点的 current_period_end 在未来 → 从它往后加，不被 NOW() 吞掉）
    const deltaMonths =
      (new Date(sub.current_period_end).getFullYear() - periodEnd.getFullYear()) * 12 +
      (new Date(sub.current_period_end).getMonth() - periodEnd.getMonth());
    expect(deltaMonths).toBe(1);
    expect(new Date(sub.current_period_end).getDate()).toBe(periodEnd.getDate());

    const { rows: u } = await pool.query('SELECT subscription_status, current_subscription_id FROM users WHERE id = $1', [TARGET_USER_ID]);
    expect(u[0].subscription_status).toBe('enterprise');
    expect(u[0].current_subscription_id).toBe(subscriptionId);
  });

  it('planId="Pro"（首字母大写，与 DB name 完全一致）同样命中', async () => {
    const { subscriptionId } = await seedSubscription();
    const res = await grant(subscriptionId, { planId: 'Pro', months: 2, reason: '续费补偿' });
    expect(res.status).toBe(200);
    expect((await readSubscription(subscriptionId)).plan_id).toBe(planIds.Pro);
  });

  it('planId 传 UUID 仍然可用（不破坏既有调用方）', async () => {
    const { subscriptionId } = await seedSubscription();
    const res = await grant(subscriptionId, { planId: planIds.Enterprise, months: 1, reason: '按 UUID 赠期' });
    expect(res.status).toBe(200);
    expect((await readSubscription(subscriptionId)).plan_id).toBe(planIds.Enterprise);
  });

  it('审计同时记录解析后的 UUID 与原始入参（pro → Enterprise UUID 可追溯）', async () => {
    const { subscriptionId } = await seedSubscription();
    const res = await grant(subscriptionId, { planId: 'enterprise', months: 3, reason: '大客补偿' });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT details FROM audit_logs
        WHERE action = 'admin.subscriptions.grant' AND resource_id = $1`,
      [subscriptionId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({
      planId: planIds.Enterprise,
      planIdInput: 'enterprise',
      months: 3,
      reason: '大客补偿',
      targetUserId: TARGET_USER_ID,
      switchedPlan: true,
    });
  });

  it('未知套餐名 → 404（不是 500：非法 uuid 字符串绝不能进 uuid 比较）', async () => {
    const { subscriptionId } = await seedSubscription();
    const res = await grant(subscriptionId, { planId: 'enetprise', months: 1, reason: '拼错了' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 40404, message: '套餐不存在' });
    expect((await readSubscription(subscriptionId)).plan_id).toBe(planIds.Free);
  });

  it('Free 之外的名字也不会误伤：大小写不敏感但整名匹配（"pro " 带空格可去空白）', async () => {
    const { subscriptionId } = await seedSubscription();
    const res = await grant(subscriptionId, { planId: '  pro  ', months: 1, reason: '带空白' });
    expect(res.status).toBe(200);
    expect((await readSubscription(subscriptionId)).plan_id).toBe(planIds.Pro);
  });

  it('months 边界：1 与 36 放行，0 / 37 / 非整数 400（前端 UI 限 1-12，服务端刻意放宽到 36）', async () => {
    const a = await seedSubscription();
    expect((await grant(a.subscriptionId, { planId: 'pro', months: 1, reason: 'r' })).status).toBe(200);
    expect((await grant(a.subscriptionId, { planId: 'pro', months: 36, reason: 'r' })).status).toBe(200);

    for (const bad of [0, 37, 1.5, '3', null]) {
      const res = await grant(a.subscriptionId, { planId: 'pro', months: bad, reason: 'r' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(4000);
    }
  });

  it('缺 reason / 订阅不存在 → 400 / 404', async () => {
    const a = await seedSubscription();
    expect((await grant(a.subscriptionId, { planId: 'pro', months: 1 })).status).toBe(400);
    const res = await grant('00000000-0000-4000-8000-0000000000ff', { planId: 'pro', months: 1, reason: 'r' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 40404, message: '订阅不存在' });
  });

  it('无 admin.subscriptions.grant 权限 → 403（真库 RBAC 判定）', async () => {
    const { rows } = await pool.query(`SELECT id FROM roles WHERE role_key = 'user'`);
    await pool.query('UPDATE users SET role_id = $1 WHERE id = $2', [rows[0].id, ADMIN_USER_ID]);
    clearPermCache();
    const a = await seedSubscription();

    const res = await grant(a.subscriptionId, { planId: 'pro', months: 1, reason: '越权' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.subscriptions.grant' });
    expect((await readSubscription(a.subscriptionId)).plan_id).toBe(planIds.Free);

    await pool.query('UPDATE users SET role_id = $1 WHERE id = $2', [adminRoleId, ADMIN_USER_ID]);
    clearPermCache();
  });
});

// ───────────────────────── A11：审计「支付相关」筛选 ─────────────────────────

describe('GET /api/admin/audit-logs?action=payment —— 真实 action 值必须命中（§4-A11）', () => {
  const PAYMENT_ACTIONS = [
    AUDIT_ACTIONS.PAYMENT_CREATE,
    AUDIT_ACTIONS.PAYMENT_COMPLETE,
    AUDIT_ACTIONS.PAYMENT_AUTO_CLOSE,
    AUDIT_ACTIONS.PAYMENT_REFUND,
    'admin.orders.refund',
    'admin.subscriptions.grant',
  ];
  const NON_PAYMENT_ACTIONS = ['login', 'logout', 'upload_file', 'admin.flag.update'];

  let marker = '';

  async function seedAuditRows(actions) {
    const table = [];
    for (const action of actions) {
      const { rows } = await pool.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details, status)
         VALUES ($1, $2, 'payment_order', $3, $4, 'success')
         RETURNING id`,
        [
          ADMIN_USER_ID,
          action,
          `aps-${action}-${Date.now()}`,
          JSON.stringify({ case: marker, note: '审计筛选真库回归' }),
        ]
      );
      table.push({ id: rows[0].id, action });
    }
    return table;
  }

  /**
   * 只筛「本用例自己写的行」：?userId= 走 audit_logs.user_id 索引 + ?action=payment
   * 走精确 IN 清单（不用 ?q= —— 那要对含超大 details 的整表做 ILIKE，30s+ 超时）。
   */
  async function queryGroup(action) {
    const res = await request(buildAdminApp()).get(
      `/api/admin/audit-logs?action=${action}&userId=${ADMIN_USER_ID}&pageSize=200`
    );
    expect(res.status).toBe(200);
    return res.body.data;
  }

  beforeEach(async () => {
    marker = `aps-case-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  });

  it('支付/订阅/管理台退款 6 类动作全部命中（旧 LIKE payment.% 这里是 0 条）', async () => {
    await seedAuditRows(PAYMENT_ACTIONS);
    await seedAuditRows(NON_PAYMENT_ACTIONS);

    const data = await queryGroup('payment');
    const found = data.list.map((r) => r.action).sort();
    expect(data.total).toBe(PAYMENT_ACTIONS.length);
    expect(found).toEqual([...PAYMENT_ACTIONS].sort());

    // 非支付类不得混进来（admin.flag.update 属 admin.* 但不是支付）
    for (const noise of NON_PAYMENT_ACTIONS) expect(found).not.toContain(noise);
  });

  it('支付相关行仍同时被 sensitive 组识别（admin.* 前缀口径未破）', async () => {
    await seedAuditRows(['admin.orders.refund']);
    const data = await queryGroup('sensitive');
    expect(data.total).toBe(1);
    expect(data.list[0].sensitive).toBe(true);
  });

  it('action=auth 命中真实登录行 login / logout（同 A11 病因的第二处）', async () => {
    await seedAuditRows(['login', 'logout', 'upload_file']);
    const data = await queryGroup('auth');
    expect(data.total).toBe(2);
    expect(data.list.map((r) => r.action).sort()).toEqual(['login', 'logout']);
  });

  it('payment_refund 行由真实退款服务写入 → 可被支付筛选查到（A1↔A11 闭环）', async () => {
    // 直接经 utils/audit 常量写，确保「服务写的值」与「筛选清单」同源
    await logAuditEvent({
      userId: ADMIN_USER_ID,
      action: AUDIT_ACTIONS.PAYMENT_REFUND,
      resourceType: 'payment_order',
      resourceId: `闭环-${marker}`,
      details: { case: marker, orderNo: 'ORDCLOSE000001' },
    });

    const data = await queryGroup('payment');
    expect(data.total).toBe(1);
    expect(data.list[0].action).toBe('payment_refund');
  });
});
