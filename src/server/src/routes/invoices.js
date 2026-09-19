import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

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
// =============================================

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
 *   （当前履约链路不写该键 → 恒为 null，PDF 下载仍未实现，见 /:id/download）。
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
 * GET /api/invoices/:id/download
 * 下载电子发票 PDF —— **未实现，明确 501**（G4）。
 *
 * 两件事必须一起成立：
 *   ① 未实现就必须返回 501，绝不能给空壳/半截 PDF；
 *   ② 501 是 JSON 错误，**不得再带 `Content-Type: application/pdf` 与
 *      `Content-Disposition: attachment`** —— 旧实现先设了这两个头再
 *      res.status(501).json(...)，于是客户端收到「标着 PDF 的附件」里装着
 *      一段 JSON：浏览器/桌面端会把它存成 invoice_XXX.pdf 损坏文件，
 *      而不是按错误处理（这就是「先设头再报错」的顺序错误）。
 * 实现路径已备好：utils/pdf-invoice.js（pdfkit，目前无调用方），
 * 接上时记得一并写 metadata->>'invoice_url' 或改为直接出流。
 */
router.get('/:id/download', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const invoiceResult = await pool.query(
      `SELECT id, invoice_no, status, metadata->>'invoice_url' AS invoice_url
         FROM invoices
        WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invoiceResult.rows[0];

    // 已有真实 PDF 地址（历史数据/将来接入开票服务后）→ 302 到该地址
    if (invoice.invoice_url) {
      return res.redirect(invoice.invoice_url);
    }

    logger.info(`[invoices] PDF download requested but not implemented: ${invoice.invoice_no}`);
    return res.status(501).json({
      error: 'PDF generation not yet implemented',
      code: 'INVOICE_PDF_NOT_IMPLEMENTED',
      invoiceNo: invoice.invoice_no,
    });
  } catch (err) {
    logger.error('Download invoice error:', err);
    res.status(500).json({ error: 'Failed to download invoice' });
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
