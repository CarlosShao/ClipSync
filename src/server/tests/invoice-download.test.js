import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import pool from '../src/db/pool.js';
import { getTestApp } from './test-helpers.js';
import { invoiceFacts } from '../src/utils/pdf-invoice.js';

/**
 * 发票 PDF 下载真库测试（任务板 #36「做真发票」）
 *
 * 钉住四件事：
 *  ① 本人的票能下到**真 PDF**：200 + application/pdf + 文件头 %PDF / 文件尾 %%EOF，
 *     文件名走 Content-Disposition（invoice_<发票号>.pdf，另给 RFC 5987 filename*）。
 *  ② 越户读票 = 404（查询带 user_id），不存在的 id 也 404。
 *  ③ **错误路径必须是纯 JSON**：404 响应不得带 Content-Disposition，
 *     否则客户端会存下一个「装着 JSON 的 .pdf」损坏文件（旧 501 实现的顺序错误，
 *     见 routes/invoices.js 的 /:id/download 注释③）。
 *  ④ 有 metadata.invoice_url 时仍 302 到该地址，不自造 PDF。
 *
 * PDF 里「已退款」标注、商品名取套餐 display_name、实付取订单金额这几条
 * 属于渲染口径，用纯函数 invoiceFacts 直接断言（见最后一个 describe），
 * 不去解析 PDF 字节流（子集化 CID 字体 + Flate 压缩，解析出来的断言既脆又没意义）。
 */

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_PHONE = '+86test-dl1';
const OTHER_PHONE = '+86test-dl2';

let app;
let planId = null;
let otherUserId = null;

/**
 * 造一张完整链路的数据：订阅 → 订单 → 发票。
 * @param {object} o
 *  invoiceNo    发票号
 *  amount       订单/发票金额
 *  taxAmount    invoices.tax_amount
 *  orderStatus  'paid' | 'refunded'（refunded 时写 refunded_at）
 *  metadata     invoices.metadata（可放 invoice_url）
 *  orderPlanId  订单上的 plan_id（传 null 模拟历史脏数据 → 走 metadata.planId 回落）
 *  orphan       true = 发票与订单都不挂订阅（老 mock 单），套餐只能靠 metadata.planId
 *  userId       发票归属（默认测试用户）
 */
async function seedInvoice({
  invoiceNo,
  amount = 9.9,
  taxAmount = 0,
  orderStatus = 'paid',
  metadata = {},
  orderPlanId = undefined,
  orphan = false,
  userId = TEST_USER_ID,
} = {}) {
  const sub = await pool.query(
    `INSERT INTO user_subscriptions
       (user_id, plan_id, status, billing_cycle, start_date, end_date,
        current_period_start, current_period_end, created_at, updated_at)
     VALUES ($1, $2, 'active', 'monthly', NOW(), NOW() + INTERVAL '30 day',
             NOW(), NOW() + INTERVAL '30 day', NOW(), NOW())
     RETURNING id`,
    [userId, planId]
  );
  const subscriptionId = orphan ? null : sub.rows[0].id;

  const { rows: orderRows } = await pool.query(
    `INSERT INTO payment_orders
       (user_id, subscription_id, plan_id, order_no, amount, currency, payment_method,
        payment_channel, status, paid_at, refunded_at, transaction_id, created_at, updated_at, metadata)
     VALUES ($1, $2, $3, $4, $5, 'CNY', 'alipay', 'alipay', $6, NOW(),
             $7, '202609192200000088', NOW(), NOW(), $8)
     RETURNING id`,
    [
      userId,
      subscriptionId,
      orderPlanId === undefined ? planId : orderPlanId,
      `ORDDL${invoiceNo}`,
      amount,
      orderStatus,
      orderStatus === 'refunded' ? new Date() : null,
      JSON.stringify({ planId, billingCycle: 'monthly' }),
    ]
  );
  const orderId = orderRows[0].id;

  const { rows: invRows } = await pool.query(
    `INSERT INTO invoices (user_id, subscription_id, payment_order_id, invoice_no, amount, tax_amount, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'issued', $7)
     RETURNING id`,
    [userId, subscriptionId, orderId, invoiceNo, amount, taxAmount, JSON.stringify(metadata)]
  );
  return { invoiceId: invRows[0].id, subscriptionId, orderId };
}

async function cleanup() {
  await pool.query('DELETE FROM invoices WHERE user_id = ANY($1::uuid[])', [[TEST_USER_ID, otherUserId]]).catch(() => {});
  await pool
    .query('DELETE FROM payment_orders WHERE user_id = ANY($1::uuid[])', [[TEST_USER_ID, otherUserId]])
    .catch(() => {});
  await pool
    .query('DELETE FROM user_subscriptions WHERE user_id = ANY($1::uuid[])', [[TEST_USER_ID, otherUserId]])
    .catch(() => {});
}

/** 二进制响应：responseType('blob') 让 superagent 用通用 Buffer 解析器（res.body = Buffer） */
const download = (id) => request(app).get(`/api/invoices/${id}/download`).responseType('blob');

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[invoice-download] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }

  app = (await getTestApp()).app;

  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, subscription_status, created_at, updated_at)
     VALUES ($1, $2, '下载测试用户', 'test_hash', 'pro', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, TEST_PHONE]
  );
  const { rows: others } = await pool.query(
    `INSERT INTO users (phone, nickname, password_hash, created_at, updated_at)
     VALUES ($1, '无关用户', 'test_hash', NOW(), NOW())
     ON CONFLICT (phone) DO UPDATE SET nickname = EXCLUDED.nickname
     RETURNING id`,
    [OTHER_PHONE]
  );
  otherUserId = others[0].id;

  const { rows } = await pool.query(`SELECT id FROM subscription_plans WHERE name = 'Pro'`);
  planId = rows[0]?.id;
  if (!planId) throw new Error('[invoice-download] 缺少 Pro 套餐种子数据');

  await cleanup();
}, 60000);

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
});

describe('GET /api/invoices/:id/download —— 真 PDF', () => {
  it('本人下载 → 200 + application/pdf + 真 PDF 字节（%PDF 头 / %%EOF 尾）', async () => {
    const { invoiceId } = await seedInvoice({ invoiceNo: 'INVDL-0001', amount: 9.9, taxAmount: 0 });

    const res = await download(invoiceId);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    const body = res.body;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(body.subarray(-32).toString().includes('%%EOF')).toBe(true);
    // 空壳/截断文件也算不上「真下载」
    expect(body.length).toBeGreaterThan(5000);
  });

  it('Content-Disposition 用发票号命名，并带 RFC 5987 filename*', async () => {
    const { invoiceId } = await seedInvoice({ invoiceNo: 'INVDL-0002' });

    const res = await download(invoiceId);
    const cd = res.headers['content-disposition'] || '';

    expect(res.status).toBe(200);
    expect(cd).toMatch(/^attachment;/);
    expect(cd).toContain('filename="invoice_INVDL-0002.pdf"');
    expect(cd).toContain("filename*=UTF-8''invoice_INVDL-0002.pdf");
  });

  it('退款单：照样出 PDF（渲染口径由 invoiceFacts 保证标「已退款」，见下方纯函数用例）', async () => {
    const { invoiceId } = await seedInvoice({ invoiceNo: 'INVDL-REFUND', orderStatus: 'refunded' });

    const res = await download(invoiceId);
    expect(res.status).toBe(200);
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('订单 plan_id 丢失（历史脏数据）时按 metadata.planId 回落，不再 ::uuid 直接 500', async () => {
    const { invoiceId } = await seedInvoice({ invoiceNo: 'INVDL-0003', orphan: true });

    const res = await download(invoiceId);
    expect(res.status).toBe(200);
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('metadata.invoice_url 存在 → 302 到该地址（不自己造 PDF）', async () => {
    const { invoiceId } = await seedInvoice({
      invoiceNo: 'INVDL-0004',
      metadata: { invoice_url: 'https://invoice.example.test/INVDL-0004.pdf' },
    });

    const res = await request(app).get(`/api/invoices/${invoiceId}/download`).redirects(0);
    expect([301, 302, 307]).toContain(res.status);
    expect(res.headers.location).toBe('https://invoice.example.test/INVDL-0004.pdf');
  });
});

describe('GET /api/invoices/:id/download —— 越权与错误路径', () => {
  it('别人的发票 → 404，且响应是 JSON 而非「标着 PDF 的附件」（顺序错误的回归防线）', async () => {
    const { invoiceId } = await seedInvoice({ invoiceNo: 'INVDL-OTHER', userId: otherUserId });

    // authenticateToken 在 NODE_ENV=test 下固定注入 TEST_USER_ID，
    // 所以这张挂在 otherUserId 名下的票对当前请求者就是「无权访问」。
    const res = await request(app).get(`/api/invoices/${invoiceId}/download`);

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    // 关键：错误路径绝不能带附件头，否则浏览器存下打不开的 .pdf
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.body.error).toBeTruthy();
  });

  it('发票不存在 → 404 JSON，无 PDF 头', async () => {
    const res = await request(app).get(
      '/api/invoices/00000000-0000-4000-8000-0000000000fe/download'
    );
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('id 不是合法 uuid → 404 而不是 PG 22P02 的 500', async () => {
    const res = await request(app).get('/api/invoices/not-a-uuid/download');
    expect(res.status).toBe(404);
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('发票号里有非 ASCII 或空格也不会把 Content-Disposition 写坏（filename 段被清洗，原值走 filename*）', async () => {
    const { invoiceId } = await seedInvoice({ invoiceNo: 'INV DL/0005' });

    const res = await download(invoiceId);
    const cd = res.headers['content-disposition'] || '';
    expect(res.status).toBe(200);
    // filename= 段只允许 [A-Za-z0-9._-]，空格与斜杠必须被替换
    expect(/filename="([^"]*)"/.exec(cd)[1]).toBe('invoice_INV_DL_0005.pdf');
    expect(cd).toContain("filename*=UTF-8''");
  });
});

describe('invoiceFacts —— 收据渲染口径（纯函数，不碰 DB / pdfkit）', () => {
  const baseInvoice = {
    id: 'i1',
    invoice_no: 'INV-F1',
    status: 'issued',
    amount: '9.90',
    tax_amount: '0.57',
    title: null,
    tax_no: null,
  };
  const baseOrder = {
    order_no: 'ORD-F1',
    amount: '8.90', // 升级折抵后的真实实付，与 invoices.amount 不同
    currency: 'CNY',
    payment_method: 'alipay',
    status: 'paid',
    refunded_at: null,
    planDisplayName: '专业版',
    billingCycle: 'monthly',
  };

  it('实付金额取订单 amount（不是发票抄的那份），税费取 tax_amount', () => {
    const f = invoiceFacts(baseInvoice, baseOrder);
    expect(f.paid).toBe(8.9);
    expect(f.paidText).toBe('¥8.90');
    expect(f.tax).toBe(0.57);
  });

  it('商品名 = subscription_plans.display_name + 计费周期（调用方查好传进来）', () => {
    expect(invoiceFacts(baseInvoice, baseOrder).productName).toBe('专业版（月付）');
    expect(
      invoiceFacts(baseInvoice, { ...baseOrder, planDisplayName: '企业版', billingCycle: 'yearly' }).productName
    ).toBe('企业版（年付）');
    // 套餐名查不到时的兜底（不能出现 undefined / 空白）
    expect(
      invoiceFacts(baseInvoice, { ...baseOrder, planDisplayName: null, billingCycle: null }).productName
    ).toBe('ClipSync 订阅');
  });

  it('订单 status=refunded → refunded=true（PDF 上据此标「已退款」）', () => {
    expect(invoiceFacts(baseInvoice, { ...baseOrder, status: 'refunded' }).refunded).toBe(true);
    // invoices.status 的 CHECK 只有 issued/paid/void，退款只能以订单为准，
    // 所以 refunded_at 单独有值时也算已退款。
    expect(invoiceFacts(baseInvoice, { ...baseOrder, refunded_at: new Date() }).refunded).toBe(true);
    expect(invoiceFacts(baseInvoice, baseOrder).refunded).toBe(false);
  });

  it('状态/支付方式映射成中文，未知值原样透出而不是留空', () => {
    const f = invoiceFacts(baseInvoice, baseOrder);
    expect(f.statusText).toBe('已开具');
    expect(f.paymentMethodText).toBe('支付宝');
    expect(invoiceFacts({ ...baseInvoice, status: 'void' }, baseOrder).statusText).toBe('已作废');
    expect(invoiceFacts(baseInvoice, { ...baseOrder, payment_method: 'weird' }).paymentMethodText).toBe('weird');
  });

  it('金额列脏值不会 NaN 上纸：订单金额缺失回落发票金额，两边都没有就是 0', () => {
    const fallback = invoiceFacts(baseInvoice, { ...baseOrder, amount: null });
    expect(fallback.paid).toBe(9.9); // ← invoices.amount（履约抄自订单，正常与实付一致）

    const empty = invoiceFacts(
      { ...baseInvoice, amount: null, tax_amount: '' },
      { ...baseOrder, amount: undefined }
    );
    expect(Number.isNaN(empty.paid)).toBe(false);
    expect(empty.paid).toBe(0);
    expect(empty.paidText).toBe('¥0.00');
    expect(empty.tax).toBe(0);
  });
});
