/**
 * Admin Console 审计日志查询 API 单测（Admin Console · T-A5）
 *
 * 覆盖（routes/admin/audit.js 挂载在 /api/admin 后的完整中间件链）：
 *  - GET /audit-logs 分页壳 { list, total, page, pageSize } + LIMIT/OFFSET 参数位置
 *  - 筛选语义契约（src/admin-console/src/mocks/handlers.test.ts 固化）：
 *      action=auth      → user.login% / user.logout%
 *      action=payment   → payment.% / admin.refund.%
 *      action=sensitive → admin.% OR IN (user.deactivate, role.assign, user.delete)
 *      action=具体串    → ILIKE %v%（includes 匹配）
 *      operator=end_user → 操作者角色 user；operator=昵称 → u.nickname 精确匹配
 *      result=failed     → status <> 'success'；非法 result → 400
 *      ip / dateFrom / dateTo / q
 *  - 行映射契约（AuditLog）：details JSONB → key=value 摘要字符串（超长截断）、
 *      敏感标记、操作者昵称/打码手机号回退、operatorRole 三值映射、createdAt 'YYYY-MM-DD HH:mm:ss'
 *
 * 全离线：vi.mock db/pool + middleware/auth（与 orders.test.js 同风格）。
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

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  // 默认身份：super_admin 且持有 admin.audit.view
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

/** 默认池 mock：requirePerm 放行 + 空结果 */
function mockPoolDefaults({ countTotal = 0, listRows = [] } = {}) {
  pool.query.mockImplementation(async (sql) => {
    if (sql.includes('perm_key')) return { rows: [{ perm_key: 'admin.audit.view' }], rowCount: 1 };
    if (sql.includes('COUNT(*)')) return { rows: [{ total: countTotal }], rowCount: 1 };
    if (sql.includes('FROM audit_logs al')) return { rows: listRows, rowCount: listRows.length };
    return { rows: [], rowCount: 0 };
  });
}

/** 夹具：AUDIT_SELECT 输出形态的审计行 */
function makeAuditRow(overrides = {}) {
  return {
    id: '0a000000-0000-4000-8000-000000000001',
    user_id: '11111111-1111-4111-8111-111111111111',
    action: 'admin.refund.execute',
    resource_type: 'payment_order',
    resource_id: '0b6f2c1e-1111-4aaa-9bbb-000000000001',
    details: { orderNo: 'CS20260905204188', amount: 9.9, reason: '用户重复支付' },
    ip_address: '116.24.66.88',
    user_agent: 'Mozilla/5.0',
    status: 'success',
    created_at: new Date('2026-08-19T12:34:56Z'),
    operator_nickname: 'Carlos',
    operator_phone: '13812342765',
    operator_role_key: 'super_admin',
    ...overrides,
  };
}

describe('GET /api/admin/audit-logs —— 分页壳与行映射', () => {
  it('返回分页壳 { list, total, page, pageSize }，LIMIT/OFFSET 追加在筛选参数之后', async () => {
    mockPoolDefaults({ countTotal: 2431088, listRows: [makeAuditRow()] });

    const res = await request(buildApp()).get('/api/admin/audit-logs?page=2&pageSize=50');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.total).toBe(2431088);
    expect(res.body.data.page).toBe(2);
    expect(res.body.data.pageSize).toBe(50);
    expect(res.body.data.list).toHaveLength(1);

    // 无筛选参数 → LIMIT/OFFSET 即前两个参数（page=2 → offset=50）
    const [lastSql, lastParams] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(lastSql).toContain('ORDER BY al.created_at DESC');
    expect(lastParams.slice(-2)).toEqual([50, 50]);
  });

  it('行字段映射符合 AuditLog 契约：details key=value 摘要、敏感标记、角色三值、时间形态', async () => {
    mockPoolDefaults({ listRows: [makeAuditRow()] });

    const res = await request(buildApp()).get('/api/admin/audit-logs');
    const log = res.body.data.list[0];

    expect(log).toMatchObject({
      id: '0a000000-0000-4000-8000-000000000001',
      operator: 'Carlos',
      operatorRole: 'super_admin',
      userId: '11111111-1111-4111-8111-111111111111',
      action: 'admin.refund.execute',
      resourceType: 'payment_order',
      resourceId: '0b6f2c1e-1111-4aaa-9bbb-000000000001',
      ipAddress: '116.24.66.88',
      status: 'success',
      sensitive: true, // admin. 前缀 → 敏感
      createdAt: '2026-08-19 12:34:56', // YYYY-MM-DD HH:mm:ss 契约形态
    });
    // details 摘要：裸值 + 引号包裹形态（契约示例 amount=9.90, reason="用户重复支付"）
    expect(log.details).toBe('orderNo=CS20260905204188, amount=9.9, reason="用户重复支付"');
    expect(typeof log.details).toBe('string');
  });

  it('操作者昵称缺失回退打码手机号；user_id 为空显示「系统」；未知角色 operatorRole=null', async () => {
    mockPoolDefaults({
      listRows: [
        makeAuditRow({
          operator_nickname: '',
          operator_role_key: 'custom_ops',
        }),
        makeAuditRow({
          user_id: null,
          operator_nickname: null,
          operator_phone: null,
          action: 'user.login.failed',
          operator_role_key: null,
        }),
      ],
    });

    const res = await request(buildApp()).get('/api/admin/audit-logs');
    const [masked, system] = res.body.data.list;

    expect(masked.operator).toBe('138****2765'); // 打码手机号回退
    expect(masked.operatorRole).toBeNull(); // 自定义角色不在三值契约内
    expect(system.operator).toBe('系统'); // 系统级日志
    expect(system.sensitive).toBe(false); // user.login.failed 非敏感
    expect(system.status).toBe('success');
  });

  it('敏感判定：user.deactivate / role.assign / user.delete 标记敏感；failed 状态映射 failed', async () => {
    mockPoolDefaults({
      listRows: [
        makeAuditRow({ action: 'user.deactivate', status: 'failure' }),
        makeAuditRow({ action: 'role.assign' }),
        makeAuditRow({ action: 'user.delete' }),
        makeAuditRow({ action: 'payment.create' }), // 非敏感
      ],
    });

    const res = await request(buildApp()).get('/api/admin/audit-logs');
    const [deactivate, assign, del, create] = res.body.data.list;

    expect(deactivate.sensitive).toBe(true);
    expect(deactivate.status).toBe('failed'); // failure → 契约二值 failed
    expect(assign.sensitive).toBe(true);
    expect(del.sensitive).toBe(true);
    expect(create.sensitive).toBe(false);
  });
});

describe('GET /api/admin/audit-logs —— details 序列化', () => {
  it('超长摘要截断并标注原长（...[truncated:N]）', async () => {
    mockPoolDefaults({
      listRows: [makeAuditRow({ details: { blob: 'x'.repeat(600) } })],
    });

    const res = await request(buildApp()).get('/api/admin/audit-logs');
    const details = res.body.data.list[0].details;

    expect(details.startsWith('blob=')).toBe(true);
    expect(details.endsWith('...[truncated:605]')).toBe(true); // 'blob=' + 600
    expect(details.length).toBeLessThan(600);
  });

  it('null details → 空字符串；嵌套对象/数组按摘要形态展开', async () => {
    mockPoolDefaults({
      listRows: [
        makeAuditRow({ details: null, action: 'user.login' }),
        makeAuditRow({
          details: { tags: ['a', 'b'], meta: { k: 1 } },
        }),
      ],
    });

    const res = await request(buildApp()).get('/api/admin/audit-logs');
    const [empty, nested] = res.body.data.list;

    expect(empty.details).toBe('');
    expect(nested.details).toBe('tags=[a|b], meta={k=1}');
  });
});

describe('GET /api/admin/audit-logs —— 筛选语义契约（handlers.test.ts 固化）', () => {
  it('action=auth：命中 user.login% / user.logout% 前缀', async () => {
    mockPoolDefaults();

    const res = await request(buildApp()).get('/api/admin/audit-logs?action=auth');
    expect(res.status).toBe(200);

    const [listSql] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(listSql).toContain("al.action LIKE 'user.login%'");
    expect(listSql).toContain("al.action LIKE 'user.logout%'");
  });

  it('action=payment：命中 payment.% / admin.refund.% 前缀', async () => {
    mockPoolDefaults();

    await request(buildApp()).get('/api/admin/audit-logs?action=payment');
    const [listSql] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(listSql).toContain("al.action LIKE 'payment.%'");
    expect(listSql).toContain("al.action LIKE 'admin.refund.%'");
  });

  it('action=sensitive：admin.% 前缀 OR 三个精确动作', async () => {
    mockPoolDefaults();

    await request(buildApp()).get('/api/admin/audit-logs?action=sensitive');
    const [listSql] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(listSql).toContain("al.action LIKE 'admin.%'");
    expect(listSql).toContain("'user.deactivate', 'role.assign', 'user.delete'");
  });

  it('action=具体动作串：ILIKE includes 匹配（参数化）', async () => {
    mockPoolDefaults();

    await request(buildApp()).get('/api/admin/audit-logs?action=user.login');
    const [listSql, params] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(listSql).toContain('al.action ILIKE $1');
    expect(params[0]).toBe('%user.login%');
  });

  it('operator=end_user：操作者角色为 user；operator=昵称：u.nickname 精确匹配', async () => {
    mockPoolDefaults();

    await request(buildApp()).get('/api/admin/audit-logs?operator=end_user');
    let [sql, params] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).toContain("r.role_key = 'user'");
    expect(params).toEqual([10, 0]); // 无参数化筛选条件，仅剩分页参数（pageSize=10, offset=0）

    pool.query.mockClear();
    mockPoolDefaults();
    await request(buildApp()).get('/api/admin/audit-logs?operator=Carlos');
    [sql, params] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).toContain('u.nickname = $1');
    expect(params[0]).toBe('Carlos');
  });

  it('result=success/failed 口径；非法 result 返回 400 { code: 4000 }', async () => {
    mockPoolDefaults();

    await request(buildApp()).get('/api/admin/audit-logs?result=failed');
    let [sql] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).toContain("al.status <> 'success'"); // failed 含 failure/error 等非 success

    pool.query.mockClear();
    mockPoolDefaults();
    await request(buildApp()).get('/api/admin/audit-logs?result=success');
    [sql] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).toContain("al.status = 'success'");

    pool.query.mockClear();
    mockPoolDefaults();
    const res = await request(buildApp()).get('/api/admin/audit-logs?result=bogus');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
    expect(pool.query).not.toHaveBeenCalled(); // 参数校验前置，不查库
  });

  it('ip 包含匹配（ILIKE %v%）', async () => {
    mockPoolDefaults();

    await request(buildApp()).get('/api/admin/audit-logs?ip=116.24');
    const [sql, params] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).toContain('al.ip_address::text ILIKE $1');
    expect(params[0]).toBe('%116.24%');
  });

  it('日期范围：dateFrom 含当日、dateTo 排他次日零点；非法日期 400', async () => {
    mockPoolDefaults();

    await request(buildApp()).get('/api/admin/audit-logs?dateFrom=2026-08-19&dateTo=2026-08-20');
    const [sql, params] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).toContain('al.created_at >= ($1)::date');
    expect(sql).toContain("al.created_at < ($2)::date + INTERVAL '1 day'");
    expect(params[0]).toBe('2026-08-19');
    expect(params[1]).toBe('2026-08-20');

    pool.query.mockClear();
    mockPoolDefaults();
    const res = await request(buildApp()).get('/api/admin/audit-logs?dateFrom=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(4000);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('q 关键字：action / resource_id / details 三字段 ILIKE', async () => {
    mockPoolDefaults();

    await request(buildApp()).get('/api/admin/audit-logs?q=refund');
    const [sql, params] = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(sql).toContain('al.action ILIKE $1');
    expect(sql).toContain('al.resource_id::text ILIKE $1');
    expect(sql).toContain('al.details::text ILIKE $1');
    expect(params[0]).toBe('%refund%');
  });

  it('组合筛选：COUNT 与列表共用同一 WHERE（参数一致）', async () => {
    mockPoolDefaults();

    await request(buildApp()).get(
      '/api/admin/audit-logs?action=payment&operator=end_user&result=failed&ip=116.24&dateFrom=2026-08-19&dateTo=2026-08-20&page=3&pageSize=20'
    );
    const [countSql, countParams] = pool.query.mock.calls.find(([s]) => s.includes('COUNT(*)'));
    const [listSql, listParams] = pool.query.mock.calls[pool.query.mock.calls.length - 1];

    // COUNT 子查询与列表查询携带相同筛选条件
    expect(countSql).toContain("al.action LIKE 'payment.%'");
    expect(countSql).toContain("r.role_key = 'user'");
    expect(countParams).toEqual(listParams.slice(0, countParams.length));
    // 分页参数追加在筛选之后（page=3, pageSize=20 → offset=40）
    expect(listParams.slice(-2)).toEqual([20, 40]);
  });

  it('未持有 admin.audit.view 权限返回 403 { code: 4030 }，不查审计表', async () => {
    authState.user = { userId: 'u-admin', roleKey: 'admin', roleLevel: 50, isAdmin: true };
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('perm_key')) return { rows: [], rowCount: 0 }; // 权限点未授予
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/api/admin/audit-logs');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 4030, message: '缺少权限: admin.audit.view' });
  });
});
