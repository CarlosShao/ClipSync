import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET /api/invoices
 * 获取用户发票/账单列表
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT 
        i.id,
        i.invoice_no,
        i.amount,
        i.tax,
        i.status,
        i.invoice_url,
        i.created_at,
        po.order_no,
        po.payment_method,
        sp.name as plan_name
      FROM invoices i
      LEFT JOIN payment_orders po ON i.order_id = po.id
      LEFT JOIN user_subscriptions us ON po.subscription_id = us.id
      LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
      WHERE i.user_id = $1
    `;
    const params = [userId];
    
    if (status) {
      query += ` AND i.status = $${params.length + 1}`;
      params.push(status);
    }
    
    query += ` ORDER BY i.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    
    // 获取总数
    let countQuery = 'SELECT COUNT(*) FROM invoices WHERE user_id = $1';
    const countParams = [userId];
    if (status) {
      countQuery += ` AND status = $2`;
      countParams.push(status);
    }
    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count);
    
    res.json({
      invoices: result.rows.map(inv => ({
        id: inv.id,
        invoiceNo: inv.invoice_no,
        amount: parseFloat(inv.amount),
        tax: parseFloat(inv.tax),
        status: inv.status,
        invoiceUrl: inv.invoice_url,
        orderNo: inv.order_no,
        paymentMethod: inv.payment_method,
        planName: inv.plan_name,
        createdAt: inv.created_at,
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error('Get invoices error:', err);
    res.status(500).json({ error: '获取发票列表失败' });
  }
});

/**
 * GET /api/invoices/:id/download
 * 下载电子发票PDF
 */
router.get('/:id/download', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    const invoiceResult = await pool.query(
      'SELECT * FROM invoices WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    
    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: '发票不存在' });
    }
    
    const invoice = invoiceResult.rows[0];
    
    // 如果有发票URL，重定向到该URL
    if (invoice.invoice_url) {
      return res.redirect(invoice.invoice_url);
    }
    
    // 否则生成PDF（Mock）
    // TODO: 实际生成PDF逻辑（需要PDF库如PDFKit）
    logger.info(`Generating invoice PDF for ${invoice.invoice_no}`);
    
    // Mock: 返回简单的PDF响应
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice_${invoice.invoice_no}.pdf"`);
    
    // 这里应该生成真实的PDF，暂时返回空响应
    res.status(501).json({ error: 'PDF生成功能尚未实现' });
  } catch (err) {
    logger.error('Download invoice error:', err);
    res.status(500).json({ error: '下载发票失败' });
  }
});

/**
 * GET /api/invoices/:id
 * 获取发票详情
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    const invoiceResult = await pool.query(`
      SELECT 
        i.*,
        po.order_no,
        po.payment_method,
        po.amount as order_amount,
        sp.name as plan_name,
        sp.price as plan_price
      FROM invoices i
      LEFT JOIN payment_orders po ON i.order_id = po.id
      LEFT JOIN user_subscriptions us ON po.subscription_id = us.id
      LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
      WHERE i.id = $1 AND i.user_id = $2
    `, [id, userId]);
    
    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: '发票不存在' });
    }
    
    const invoice = invoiceResult.rows[0];
    
    res.json({
      invoice: {
        id: invoice.id,
        invoiceNo: invoice.invoice_no,
        amount: parseFloat(invoice.amount),
        tax: parseFloat(invoice.tax),
        status: invoice.status,
        invoiceUrl: invoice.invoice_url,
        orderNo: invoice.order_no,
        paymentMethod: invoice.payment_method,
        orderAmount: parseFloat(invoice.order_amount),
        planName: invoice.plan_name,
        planPrice: parseFloat(invoice.plan_price),
        createdAt: invoice.created_at,
      },
    });
  } catch (err) {
    logger.error('Get invoice detail error:', err);
    res.status(500).json({ error: '获取发票详情失败' });
  }
});

export default router;
