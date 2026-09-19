import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { generateInvoicePDF } from '../utils/pdf-invoice.js';

const router = Router();

// =============================================
// 发票/账单查询（§4-G2 / G3 / G4 修复）
//
// ⚠️ 列名事实来源：invoices 表（migrations/004_subscription_tables.sql，
//    011a 重建后未再变更）。真实列只有
//      id, user_id, subscription_id, payment_order_id, invoice_no,
//      title, tax_no, amount, tax_amount, status, issued_at, metadata, created_at
//    —— **没有 tax，也没有 invoice_url**。
//    旧实现 SELECT 了 i.tax / i.invoice_url → PG 42703 → 两个只读接口必 500，
//    桌面端账单页把 500 当空态（BillingSubPage.vue 的 catch{}），于是
//    「付了钱却永远看不到账单」。故本文件一律按真实列取值，
//    对外响应字段名（tax / invoiceUrl）保持不变以兼容既有客户端。
//
// 履约侧写入点：services/orderFulfillment.js 的
//   INSERT INTO invoices (user_id, subscription_id, payment_order_id,
//                         invoice_no, amount, tax_amount, status)
//   —— 不写 title/tax_no（用户未填抬头），也不写任何 PDF 地址。
//
// PDF 下载（GET /:id/download）**已实现**（2026-09-19）：无 invoice_url 时
//   用 utils/pdf-invoice.js 现读现生成（pdfkit + 容器内的文泉驿正黑），
//   详见该文件顶部的字体说明与本文件 buildInvoicePdfData()。
// =============================================

/** invoices/payment_orders 主键都是 uuid：先挡掉非法 id，免得 PG 22P02 打成 500 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 金额列（numeric）→ number；空值/非法一律 null（NaN 会让 JSON 序列化成 null，但显式更好读） */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 分页参数解析：非法回默认值，limit 上限 100（避免 ?page=abc 直接把 SQL 打成 500） */
function parsePaging(query) {
  let page = parseInt(query.page, 10);
  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;
  if (page > 100000) page = 100000;
  return { page, limit, offset: (page - 1) * limit };
}

/**
 * GET /api/invoices
 * 获取用户发票/账单列表
 * 响应（契约不变，桌面端 BillingSubPage.vue / BillingModal.vue 读这些字段）：
 *   { invoices: [{ id, invoiceNo, amount, tax, status, invoiceUrl, orderNo,
 *                  paymentMethod, planName, createdAt }], pagination }
 *   tax 取自 tax_amount；invoiceUrl 取自 metadata->>'invoice_url'
 *   （履约链路当前不写该键 → 恒为 null；PDF 由 /:id/download 现生成，不依赖它）。
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { page, limit, offset } = parsePaging(req.query);
    const { status } = req.query;

    const where = ['i.user_id = $1'];
    const params = [userId];
    if (status) {
      where.push(`i.status = $${params.length + 1}`);
      params.push(status);
    }
    const whereSql = ` WHERE ${where.join(' AND ')}`;

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM invoices i${whereSql}`,
      params
    );
    const total = Number(countResult.rows[0]?.total ?? 0);

    const result = await pool.query(
      `
      SELECT
        i.id,
        i.invoice_no,
        i.amount,
        i.tax_amount,
        i.title,
        i.tax_no,
        i.status,
        i.issued_at,
        i.created_at,
        i.metadata->>'invoice_url' AS invoice_url,
        po.order_no,
        po.payment_method,
        sp.name AS plan_name
      FROM invoices i
      LEFT JOIN payment_orders po ON i.payment_order_id = po.id
      -- invoices 表**没有 plan_id 列**：套餐名只能经订阅取。
      -- 优先发票自身的 subscription_id，缺失时回退订单上的（历史/mock 单只挂订单）。
      LEFT JOIN user_subscriptions us ON us.id = COALESCE(i.subscription_id, po.subscription_id)
      LEFT JOIN subscription_plans sp ON sp.id = us.plan_id
      ${whereSql}
      ORDER BY i.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, limit, offset]
    );

    res.json({
      invoices: result.rows.map((inv) => ({
        id: inv.id,
        invoiceNo: inv.invoice_no,
        amount: toNumber(inv.amount),
        tax: toNumber(inv.tax_amount),
        title: inv.title || null,
        taxNo: inv.tax_no || null,
        status: inv.status,
        invoiceUrl: inv.invoice_url || null,
        orderNo: inv.order_no,
        paymentMethod: inv.payment_method,
        planName: inv.plan_name,
        issuedAt: inv.issued_at,
        createdAt: inv.created_at,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error('Get invoices error:', err);
    res.status(500).json({ error: 'Failed to get invoice list' });
  }
});

/**
 * 取一份「够渲染 PDF 用」的发票数据（一次查全：发票 + 订单 + 套餐 + 购买方）。
 *
 * 为什么在路由里查齐、而不是让 pdf-invoice.js 自己查库：
 * 工具函数只管渲染，不碰 DB —— 可单测、可复用（将来管理后台补开纸质发票同源）。
 *
 * 商品名口径：payment_orders.plan_id 是建单时写死的下单套餐（见 payments.js
 * INSERT），比「当前订阅的套餐」准 —— 用户后来升级过，老收据也不该跟着变。
 * 老数据 plan_id 为空时才回落 metadata.planId / 订阅的 plan_id（见下二次查询）。
 *
 * @returns {Promise<{invoice: Object, user: Object, order: Object} | null>} null = 发票不存在或不属本用户
 */
async function buildInvoicePdfData(invoiceId, userId) {
  const { rows } = await pool.query(
    `
    SELECT
      i.id, i.invoice_no, i.title, i.tax_no, i.amount, i.tax_amount,
      i.status, i.issued_at, i.created_at,
      i.metadata->>'invoice_url' AS invoice_url,
      po.order_no,
      po.amount AS order_amount,
      po.currency,
      po.payment_method,
      po.status AS order_status,
      po.paid_at,
      po.refunded_at,
      po.metadata AS order_metadata,
      us.billing_cycle,
      sp.display_name AS plan_display_name,
      u.id AS user_id, u.nickname, u.phone, u.email
    FROM invoices i
    LEFT JOIN payment_orders po ON i.payment_order_id = po.id
    LEFT JOIN user_subscriptions us ON us.id = COALESCE(i.subscription_id, po.subscription_id)
    LEFT JOIN subscription_plans sp ON sp.id = COALESCE(po.plan_id, us.plan_id)
    LEFT JOIN users u ON u.id = i.user_id
    WHERE i.id = $1 AND i.user_id = $2
    `,
    [invoiceId, userId]
  );

  const row = rows[0];
  if (!row) return null;

  // plan_id 两处都空（历史/mock 单）→ 按 metadata.planId 再查一次。
  // 不把这个值直接 ::uuid 塞进上面的 JOIN：metadata 里可能是脏字符串，
  // 一脏就 22P02 让整个下载 500，不值当。
  let planDisplayName = row.plan_display_name || null;
  if (!planDisplayName) {
    const metaPlanId = row.order_metadata?.planId;
    if (typeof metaPlanId === 'string' && /^[0-9a-f-]{36}$/i.test(metaPlanId)) {
      const planRes = await pool.query(
        'SELECT display_name FROM subscription_plans WHERE id = $1',
        [metaPlanId]
      );
      planDisplayName = planRes.rows[0]?.display_name || null;
    }
  }

  return {
    invoice: {
      id: row.id,
      invoice_no: row.invoice_no,
      title: row.title,
      tax_no: row.tax_no,
      amount: row.amount,
      tax_amount: row.tax_amount,
      status: row.status,
      issued_at: row.issued_at,
      created_at: row.created_at,
      invoice_url: row.invoice_url,
    },
    user: {
      id: row.user_id,
      nickname: row.nickname,
      phone: row.phone,
      email: row.email,
    },
    order: {
      order_no: row.order_no,
      amount: row.order_amount,
      currency: row.currency,
      payment_method: row.payment_method,
      status: row.order_status,
      paid_at: row.paid_at,
      refunded_at: row.refunded_at,
      metadata: row.order_metadata,
      billingCycle: row.billing_cycle || row.order_metadata?.billingCycle || null,
      planDisplayName,
    },
  };
}

/**
 * 附件下载头：文件名只用发票号（服务端生成、字符集可控），
 * 但仍把非 ASCII 剔掉再拼 filename=，filename* 走 RFC 5987 UTF-8 编码。
 */
function setPdfDownloadHeaders(res, invoiceNo) {
  const raw = String(invoiceNo || 'invoice').slice(0, 64);
  const ascii = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '') || 'invoice';
  const name = `invoice_${ascii}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(`invoice_${raw}.pdf`)}`
  );
  // 收据是「按当下数据现生成」的（退款状态会变），不许缓存
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * GET /api/invoices/:id/download
 * 下载电子发票 PDF —— **已实现**（G4 的替代）。
 *
 * 三条硬约束（顺序错了就会产出损坏文件，历史教训见下）：
 *  ① 只能下自己的票：查询一律带 `AND i.user_id = $2`，查不到就 404，
 *     绝不区分「不存在 / 是别人的」两种措辞（不泄露他人发票号是否存在）。
 *  ② 有 metadata.invoice_url（将来接第三方开票服务）→ 302 到该地址，不自造 PDF。
 *  ③ **先拿全 PDF Buffer，再设响应头**：
 *     Content-Type / Content-Disposition 必须在 generateInvoicePDF() 成功之后
 *     才出现（见 setPdfDownloadHeaders 的唯一调用点）。这样生成中途任何异常
 *     （缺中文字体、pdfkit 抛错、查询失败）都还能走 res.json()，客户端拿到的是
 *     干净的 JSON 错误；反之先设头再报错，浏览器会存下一个「装着 JSON 的 .pdf」
 *     损坏文件（旧实现 501 就是这么写的）。catch 里的 headersSent 守卫是
 *     最后一道保险：头一旦发出就再不能改状态码，只能断掉，不拼半个 PDF。
 */
router.get('/:id/download', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    // 非法 id（如 /api/invoices/abc/download）当「不存在」处理，
    // 不让 PG 的 22P02 把它升级成 500。
    if (!UUID_RE.test(String(id || ''))) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const data = await buildInvoicePdfData(id, userId);
    if (!data) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const { invoice } = data;

    // 已有真实 PDF 地址（历史数据/将来接入开票服务后）→ 302 到该地址
    if (invoice.invoice_url) {
      return res.redirect(invoice.invoice_url);
    }

    // 关键顺序：Buffer 完整生成了才允许出现 PDF 头
    const pdf = await generateInvoicePDF(invoice, data.user, data.order);

    setPdfDownloadHeaders(res, invoice.invoice_no);
    res.setHeader('Content-Length', pdf.length);
    return res.status(200).end(pdf);
  } catch (err) {
    logger.error('Download invoice error:', err);
    // 头已发出（只可能是 302 之后）→ 无法再回 JSON，直接断开让客户端报错
    if (res.headersSent) return res.destroy();
    return res.status(500).json({ error: 'Failed to generate invoice PDF' });
  }
});

/**
 * GET /api/invoices/:id
 * 获取发票详情（响应键名与列表一致，另加 orderAmount / planPrice）
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const invoiceResult = await pool.query(
      `
      SELECT
        i.id,
        i.invoice_no,
        i.amount,
        i.tax_amount,
        i.title,
        i.tax_no,
        i.status,
        i.issued_at,
        i.created_at,
        i.metadata->>'invoice_url' AS invoice_url,
        po.order_no,
        po.payment_method,
        po.amount AS order_amount,
        sp.name AS plan_name,
        sp.price AS plan_price
      FROM invoices i
      LEFT JOIN payment_orders po ON i.payment_order_id = po.id
      LEFT JOIN user_subscriptions us ON us.id = COALESCE(i.subscription_id, po.subscription_id)
      LEFT JOIN subscription_plans sp ON sp.id = us.plan_id
      WHERE i.id = $1 AND i.user_id = $2
      `,
      [id, userId]
    );

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invoiceResult.rows[0];

    res.json({
      invoice: {
        id: invoice.id,
        invoiceNo: invoice.invoice_no,
        amount: toNumber(invoice.amount),
        tax: toNumber(invoice.tax_amount),
        title: invoice.title || null,
        taxNo: invoice.tax_no || null,
        status: invoice.status,
        invoiceUrl: invoice.invoice_url || null,
        orderNo: invoice.order_no,
        paymentMethod: invoice.payment_method,
        orderAmount: toNumber(invoice.order_amount),
        planName: invoice.plan_name,
        planPrice: toNumber(invoice.plan_price),
        issuedAt: invoice.issued_at,
        createdAt: invoice.created_at,
      },
    });
  } catch (err) {
    logger.error('Get invoice detail error:', err);
    res.status(500).json({ error: 'Failed to get invoice details' });
  }
});

export default router;
