import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import pool from '../src/db/pool.js';
import { getTestApp } from './test-helpers.js';

/**
 * 账单/发票只读接口真库测试（§4-G2 / G3 / G4）
 *
 * 修前：routes/invoices.js 的 SELECT 里写了 **不存在的列** i.tax 与 i.invoice_url
 * （invoices 真实列只有 tax_amount / metadata，见 004_subscription_tables.sql）
 *  → PG 42703 → 列表与详情两个接口**必然 500**；桌面端 BillingSubPage.vue 用
 *    catch{} 吞掉错误，于是「付了钱却永远显示暂无账单」。
 * 下载接口旧实现先 setHeader('Content-Type','application/pdf') 再
 * res.status(501).json(...) → 客户端拿到一个「标着 PDF 附件的 JSON」，
 * 存成 invoice_XXX.pdf 就是打不开的坏文件（G4 的顺序错误）。
 *
 * 本文件用真库把这三条钉住：能查到、字段对得上、501 是纯 JSON。
 */

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_PHONE = '+86test-invoice1';

let app;
let planId = null;

async function seedInvoice({ invoiceNo, amount = 9.9, taxAmount = 0, metadata = {} } = {}) {
  const sub = await pool.query(
    `INSERT INTO user_subscriptions
       (user_id, plan_id, status, billing_cycle, start_date, end_date,
        current_period_start, current_period_end, created_at, updated_at)
     VALUES ($1, $2, 'active', 'monthly', NOW(), NOW() + INTERVAL '30 day',
             NOW(), NOW() + INTERVAL '30 day', NOW(), NOW())
     RETURNING id`,
    [TEST_USER_ID, planId]
  );
  const subscriptionId = sub.rows[0].id;

  const { rows: orderRows } = await pool.query(
    `INSERT INTO payment_orders
       (user_id, subscription_id, plan_id, order_no, amount, currency, payment_method,
        payment_channel, status, paid_at, transaction_id, created_at, updated_at, metadata)
     VALUES ($1, $2, $3, $4, $5, 'CNY', 'alipay', 'alipay', 'paid', NOW(), '202609192200000099', NOW(), NOW(), '{}')
     RETURNING id`,
    [TEST_USER_ID, subscriptionId, planId, `ORDINV${invoiceNo}`, amount]
  );
  const orderId = orderRows[0].id;

  const { rows: invRows } = await pool.query(
    `INSERT INTO invoices (user_id, subscription_id, payment_order_id, invoice_no, amount, tax_amount, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'issued', $7)
     RETURNING id`,
    [TEST_USER_ID, subscriptionId, orderId, invoiceNo, amount, taxAmount, JSON.stringify(metadata)]
  );
  return { invoiceId: invRows[0].id, subscriptionId, orderId };
}

async function cleanup() {
  await pool.query('DELETE FROM invoices WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM payment_orders WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
  await pool.query('DELETE FROM user_subscriptions WHERE user_id = $1', [TEST_USER_ID]).catch(() => {});
}

beforeAll(async () => {
  const dbName = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (dbName !== 'clipsync_test') {
    throw new Error(`[invoices-read] 仅允许在 clipsync_test 库运行，当前是 ${dbName}`);
  }

  app = (await getTestApp()).app;

  await pool.query(
    `INSERT INTO users (id, phone, nickname, password_hash, subscription_status, created_at, updated_at)
     VALUES ($1, $2, '账单测试用户', 'test_hash', 'free', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, TEST_PHONE]
  );
  const { rows } = await pool.query(`SELECT id FROM subscription_plans WHERE name = 'Pro'`);
  planId = rows[0]?.id;
  if (!planId) throw new Error('[invoices-read] 缺少 Pro 套餐种子数据');

  await cleanup();
}, 60000);

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
});

describe('GET /api/invoices —— 账单列表（G2）', () => {
  it('不再 500：返回真实列映射（tax 取 tax_amount，invoiceUrl 取 metadata）', async () => {
    const { invoiceId } = await seedInvoice({ invoiceNo: 'INV-G2-0001', amount: 9.9, taxAmount: 0.57 });

    const res = await request(app).get('/api/invoices');

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0]).toMatchObject({
      id: invoiceId,
      invoiceNo: 'INV-G2-0001',
      amount: 9.9,
      tax: 0.57,
      status: 'issued',
      invoiceUrl: null,
      orderNo: 'ORDINVINV-G2-0001',
      paymentMethod: 'alipay',
      planName: 'Pro',
    });
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it('metadata.invoice_url 有值时透出（将来接开票服务不用改接口）', async () => {
    await seedInvoice({
      invoiceNo: 'INV-G2-0002',
      metadata: { invoice_url: 'https://invoice.example.test/INV-G2-0002.pdf' },
    });

    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(200);
    expect(res.body.invoices[0].invoiceUrl).toBe('https://invoice.example.test/INV-G2-0002.pdf');
  });

  it('status 筛选 + 分页参数非法不再 500', async () => {
    await seedInvoice({ invoiceNo: 'INV-G2-0003' });

    expect((await request(app).get('/api/invoices?status=issued')).status).toBe(200);
    expect((await request(app).get('/api/invoices?status=void')).body.invoices).toHaveLength(0);
    expect((await request(app).get('/api/invoices?page=abc&limit=99999')).status).toBe(200);
    const bad = await request(app).get('/api/invoices?page=abc&limit=99999');
    expect(bad.body.pagination).toMatchObject({ page: 1, limit: 100 });
  });
});

describe('GET /api/invoices/:id —— 账单详情（G3）', () => {
  it('返回全字段（含 orderAmount / planName / planPrice），不再因不存在的列 500', async () => {
    const { invoiceId } = await seedInvoice({ invoiceNo: 'INV-G3-0001', amount: 9.9, taxAmount: 0 });

    const res = await request(app).get(`/api/invoices/${invoiceId}`);

    expect(res.status).toBe(200);
    expect(res.body.invoice).toMatchObject({
      id: invoiceId,
      invoiceNo: 'INV-G3-0001',
      amount: 9.9,
      tax: 0,
      status: 'issued',
      invoiceUrl: null,
      orderNo: 'ORDINVINV-G3-0001',
      orderAmount: 9.9,
      planName: 'Pro',
    });
    // 没有真实 PDF，就必须明确 null，不能给一个下载了打不开的路径
    expect(res.body.invoice.invoiceUrl).toBeNull();
  });

  it('别人的发票 → 404（详情按 (id,user_id) 取数，不得越户读票）', async () => {
    const { invoiceId } = await seedInvoice({ invoiceNo: 'INV-G3-0002' });
    const { rows: others } = await pool.query(
      `INSERT INTO users (phone, nickname, password_hash, created_at, updated_at)
       VALUES ('+86test-invoice2', '无关用户', 'test_hash', NOW(), NOW())
       ON CONFLICT (phone) DO UPDATE SET nickname = EXCLUDED.nickname
       RETURNING id`
    );
    const otherId = others[0].id;
    try {
      await pool.query('UPDATE invoices SET user_id = $1 WHERE invoice_no = $2', [otherId, 'INV-G3-0002']);
      const res = await request(app).get(`/api/invoices/${invoiceId}`);
      expect(res.status).toBe(404);
    } finally {
      await pool.query('UPDATE invoices SET user_id = $1 WHERE invoice_no = $2', [TEST_USER_ID, 'INV-G3-0002']);
      await pool.query('DELETE FROM users WHERE id = $1', [otherId]).catch(() => {});
    }
  });
});

describe('GET /api/invoices/:id/download —— 明确 501，不得伪装成 PDF（G4）', () => {
  it('501 + JSON 错误壳；响应头不带 PDF 的 Content-Type / Content-Disposition', async () => {
    const { invoiceId } = await seedInvoice({ invoiceNo: 'INV-G4-0001' });

    const res = await request(app).get(`/api/invoices/${invoiceId}/download`);

    expect(res.status).toBe(501);
    expect(res.body.code).toBe('INVOICE_PDF_NOT_IMPLEMENTED');
    expect(res.headers['content-type']).toMatch(/application\/json/);
    // 关键：501 时绝不能带文件头，否则客户端存下一个打不开的 .pdf
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('metadata.invoice_url 存在时 302 到该地址', async () => {
    const { invoiceId } = await seedInvoice({
      invoiceNo: 'INV-G4-0002',
      metadata: { invoice_url: 'https://invoice.example.test/ok.pdf' },
    });

    // .redirects(0)：不跟随到外部 https 地址（跟随会发真实网络请求，CI 里必挂）
    const res = await request(app).get(`/api/invoices/${invoiceId}/download`).redirects(0);
    expect([301, 302, 307]).toContain(res.status);
    expect(res.headers.location).toBe('https://invoice.example.test/ok.pdf');
  });

  it('发票不存在 → 404', async () => {
    const res = await request(app).get(
      '/api/invoices/00000000-0000-4000-8000-0000000000fe/download'
    );
    expect(res.status).toBe(404);
  });
});
