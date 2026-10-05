/**
 * 补录开票信息单测（GET / PATCH /api/admin/orders/:orderNo/invoice，2026-10-05 新增）
 *
 * 这个端点补的是：`invoices` 有 `title` / `tax_no` 两列，但**履约链路从不写它们**
 *（orderFulfillment 建票只写 user/subscription/order/invoice_no/amount/tax_amount/status），
 * 而发票 PDF 在抬头/税号为空时**整行不显** —— 收据文案写着「如需增值税发票请联系客服提供
 * 开票信息」，客服却**没有任何工具**能录入，只能改库。合规面上这是被文案指引却没有落点的空洞。
 *
 * 判据：
 *  ① 两项至少给一项；抬头非空且 ≤200；税号 5–50 位字母数字（要印在税务凭证上，不能是随手粘的文本）；
 *  ② 发票**已作废**时拒绝（在作废凭证上改抬头/税号没有意义）；
 *  ③ 没有发票 → 404（先完成履约才有票）；查询侧无票则是 `hasInvoice:false` 的 200（正常状态不是错误）；
 *  ④ 审计记**改动前后**（含发票号）；通知用户；
 *  ⑤ 越权/无权限不写库。
 *
 * 全离线：pool + ws/server 都被 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/pool.js', () => {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return { pool, default: pool };
});

const authState = vi.hoisted(() => ({ user: null }));
const wsMock = vi.hoisted(() => ({ sendNotification: vi.fn(async () => ({ ok: true })) }));

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

vi.mock('../../src/ws/server.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendNotification: wsMock.sendNotification };
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

const ORDER_NO = 'CS20261005000001';
const ORDER_ID = 'o1000000-0000-4000-8000-000000000001';
const USER_ID = 'u1000000-0000-4000-8000-000000000001';
const INVOICE_ID = 'i1000000-0000-4000-8000-000000000001';

beforeEach(() => {
  clearPermCache();
  pool.query.mockClear();
  pool.query.mockReset();
  wsMock.sendNotification.mockClear();
  authState.user = { userId: 'u-super', roleKey: 'super_admin', roleLevel: 100, isAdmin: true };
});

function mockPath({
  orderExists = true,
  invoice = {
    id: 'i1000000-0000-4000-8000-000000000001',
    invoice_no: 'INV-2026-0001',
    title: null,
    tax_no: null,
    amount: 19.89,
    tax_amount: 0,
    status: 'issued',
    issued_at: new Date('2026-10-05T00:00:00Z'),
    created_at: new Date('2026-10-05T00:00:00Z'),
  },
  grantedPerms = ['admin.orders.view', 'admin.orders.refund'],
} = {}) {
  const writes = { update: null };
  pool.query.mockImplementation(async (sql, params) => {
    if (sql.includes('perm_key')) {
      const requested = params?.[1];
      return grantedPerms.includes(requested)
        ? { rows: [{ perm_key: requested }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM payment_orders po') && sql.includes('WHERE po.order_no = $1')) {
      return {
        rows: orderExists
          ? [{ id: ORDER_ID, order_no: ORDER_NO, user_id: USER_ID, amount: 19.89, status: 'paid' }]
          : [],
        rowCount: orderExists ? 1 : 0,
      };
    }
    if (sql.includes('FROM invoices')) {
      return { rows: invoice ? [{ ...invoice }] : [], rowCount: invoice ? 1 : 0 };
    }
    if (sql.includes('UPDATE invoices')) {
      writes.update = { sql, params };
      return {
        rows: [{ ...(invoice || {}), id: 'i1', invoice_no: 'INV-2026-0001', title: '新抬头', tax_no: '91310000MA1K3XYZ12' }],
        rowCount: 1,
      };
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

const getInvoice = (orderNo = ORDER_NO) =>
  request(buildApp()).get(`/api/admin/orders/${orderNo}/invoice`);
const patchInvoice = (body, orderNo = ORDER_NO) =>
  request(buildApp()).patch(`/api/admin/orders/${orderNo}/invoice`).send(body);

describe('开票信息 · 查询', () => {
  it('有票 → hasInvoice:true 并回填抬头/税号；无票 → 200 + hasInvoice:false（正常状态不是错误）', async () => {
    mockPath();
    const withInvoice = await getInvoice();
    expect(withInvoice.status).toBe(200);
    expect(withInvoice.body.data.hasInvoice).toBe(true);
    expect(withInvoice.body.data.invoice.invoiceNo).toBe('INV-2026-0001');

    mockPath({ invoice: null });
    const without = await getInvoice();
    expect(without.status).toBe(200);
    expect(without.body.data.hasInvoice).toBe(false);
    expect(without.body.data.invoice).toBeNull();
  });

  it('订单不存在 → 404', async () => {
    mockPath({ orderExists: false });
    expect((await getInvoice()).status).toBe(404);
  });
});

describe('开票信息 · ★补录', () => {
  it('★抬头 + 税号一起写，审计记改动前后，并通知用户重新下载', async () => {
    const writes = mockPath({ invoice: { id: 'i1', invoice_no: 'INV-1', title: null, tax_no: null, amount: 19.89, tax_amount: 0, status: 'issued', issued_at: null, created_at: null } });

    const res = await patchInvoice({
      title: '某某科技有限公司',
      taxNo: '91310000MA1K3XYZ12',
      reason: '客服工单 #4821：用户索要增值税发票',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.invoice.title).toBe('新抬头');
    expect(writes.update.sql).toContain('title = $2');
    expect(writes.update.sql).toContain('tax_no = $3');
    expect(writes.update.params).toEqual(['i1', '某某科技有限公司', '91310000MA1K3XYZ12']);

    const audit = findAuditCall('admin.invoice.update');
    expect(audit).toBeTruthy();
    const payload = audit[1].map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('|');
    expect(payload).toContain('titleFrom');
    expect(payload).toContain('taxNoTo');
    expect(payload).toContain('INV-1');
    expect(payload).toContain('工单 #4821');

    expect(wsMock.sendNotification).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ notificationType: 'subscription_notice' })
    );
  });

  it('只给抬头 / 只给税号 都可（另一列不动）', async () => {
    // 断言用 params 而不是 SQL 文本：SQL 的 RETURNING 里也有 title/tax_no，按文本判会误判
    const onlyTitle = mockPath();
    await patchInvoice({ title: '只改抬头', reason: 'x' });
    expect(onlyTitle.update.params).toEqual([INVOICE_ID, '只改抬头']);

    const onlyTax = mockPath();
    await patchInvoice({ taxNo: '91310000MA1K3XYZ12', reason: 'x' });
    expect(onlyTax.update.params).toEqual([INVOICE_ID, '91310000MA1K3XYZ12']);
  });
});

describe('开票信息 · 校验与保护闸', () => {
  it('两项都不给 → 400；抬头为空 → 400；抬头超 200 → 400', async () => {
    mockPath();
    expect((await patchInvoice({ reason: 'x' })).status).toBe(400);
    expect((await patchInvoice({ title: '   ', reason: 'x' })).status).toBe(400);
    expect((await patchInvoice({ title: 'x'.repeat(201), reason: 'x' })).status).toBe(400);
  });

  it('★税号格式：太短 / 带空格 / 含中日韩字符 → 400（要印在税务凭证上）', async () => {
    mockPath();
    expect((await patchInvoice({ taxNo: '123', reason: 'x' })).status).toBe(400);
    expect((await patchInvoice({ taxNo: '9131 0000MA1K', reason: 'x' })).status).toBe(400);
    expect((await patchInvoice({ taxNo: '纳税人识别号', reason: 'x' })).status).toBe(400);
    // 合法：18 位统一社会信用代码
    expect((await patchInvoice({ taxNo: '91310000MA1K3XYZ12', reason: 'x' })).status).toBe(200);
  });

  it('缺原因 / 原因超长 → 400', async () => {
    mockPath();
    expect((await patchInvoice({ title: '抬头' })).status).toBe(400);
    expect((await patchInvoice({ title: '抬头', reason: 'x'.repeat(201) })).status).toBe(400);
  });

  it('★发票已作废 → 409 且不写库', async () => {
    const writes = mockPath({
      invoice: { id: 'i1', invoice_no: 'INV-1', title: null, tax_no: null, amount: 1, tax_amount: 0, status: 'void', issued_at: null, created_at: null },
    });

    const res = await patchInvoice({ title: '抬头', reason: 'x' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('INVOICE_VOID');
    expect(writes.update).toBeNull();
  });

  it('★没有发票 → 404（先完成履约才有票），且不写库', async () => {
    const writes = mockPath({ invoice: null });

    const res = await patchInvoice({ title: '抬头', reason: 'x' });

    expect(res.status).toBe(404);
    expect(res.body.message).toContain('还没有发票');
    expect(writes.update).toBeNull();
  });

  it('订单不存在 → 404；无 admin.orders.refund 权限 → 403 且不写库', async () => {
    mockPath({ orderExists: false });
    expect((await patchInvoice({ title: '抬头', reason: 'x' })).status).toBe(404);

    const writes = mockPath({ grantedPerms: ['admin.orders.view'] });
    // ★requirePerm 按 (userId, permKey) 缓存，而本用例前面那次请求已把 admin.orders.refund
    //   判定为"通过"缓存住了 —— 换权限场景必须显式清缓存，否则第二次仍会放行（这条我自己踩过）
    clearPermCache();
    const res = await patchInvoice({ title: '抬头', reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(4030);
    expect(writes.update).toBeNull();
  });
});
