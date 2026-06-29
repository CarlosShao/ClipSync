import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { webhookSignatureVerifier, createWeChatSignatureVerifier, createAlipaySignatureVerifier, createStripeSignatureVerifier } from '../middleware/webhook-signature.js';
import { webhookIdempotencyMiddleware } from '../middleware/idempotency.js';


const router = Router();

/**
 * POST /api/payments/create-order
 * 创建支付订单
 */
router.post('/create-order', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { subscriptionId, paymentMethod = 'mock' } = req.body;
    
    if (!subscriptionId) {
      return res.status(400).json({ error: 'Missing subscriptionId parameter' });
    }
    
    // 验证订阅是否存在
    const subscriptionResult = await pool.query(
      'SELECT us.*, sp.price, sp.currency FROM user_subscriptions us JOIN subscription_plans sp ON us.plan_id = sp.id WHERE us.id = $1 AND us.user_id = $2',
      [subscriptionId, userId]
    );
    
    if (subscriptionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    
    const subscription = subscriptionResult.rows[0];
    
    // 生成订单号
    const orderNo = `ORD${Date.now()}${Math.random().toString(36).substr(2, 6)}`;
    
    // 创建订单
    const orderResult = await pool.query(`
      INSERT INTO payment_orders (user_id, subscription_id, order_no, amount, currency, payment_method, status, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, order_no, amount, currency, status, created_at
    `, [
      userId,
      subscriptionId,
      orderNo,
      subscription.price,
      subscription.currency,
      paymentMethod,
      'pending',
      JSON.stringify({ subscriptionId, paymentMethod })
    ]);
    
    const order = orderResult.rows[0];
    
    // Mock支付：直接标记为已支付
    if (paymentMethod === 'mock') {
      await pool.query(`
        UPDATE payment_orders 
        SET status = $1, paid_at = NOW(), transaction_id = $2, updated_at = NOW()
        WHERE id = $3
      `, ['paid', `MOCK${Date.now()}`, order.id]);
      
      // 创建发票
      const invoiceNo = `INV${Date.now()}${Math.random().toString(36).substr(2, 4)}`;
      await pool.query(`
        INSERT INTO invoices (user_id, order_id, invoice_no, amount, tax, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [userId, order.id, invoiceNo, order.amount, 0, 'issued']);
      
      logger.info(`Mock payment successful for order ${orderNo}`);
      
      return res.json({
        message: 'Order created, mock payment completed',
        order: {
          id: order.id,
          orderNo: order.order_no,
          amount: parseFloat(order.amount),
          currency: order.currency,
          status: 'paid',
          paidAt: new Date().toISOString(),
        },
        invoiceNo,
      });
    }
    
    // 真实支付渠道（需要外部依赖，暂时返回mock数据）
    logger.info(`Payment order created: ${orderNo}, method: ${paymentMethod}`);
    
    res.json({
      message: 'Order created, please complete payment',
      order: {
        id: order.id,
        orderNo: order.order_no,
        amount: parseFloat(order.amount),
        currency: order.currency,
        status: order.status,
        paymentParams: {
          // 这里应该返回真实支付渠道的支付参数
          // 例如微信支付的prepay_id，支付宝的form表单等
          mock: true,
          redirectUrl: `/payment/mock?orderNo=${orderNo}`,
        },
      },
    });
  } catch (err) {
    logger.error('Create payment order error:', err);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

/**
 * GET /api/payments/order/:orderNo/status
 * 查询订单支付状态
 */
router.get('/order/:orderNo/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { orderNo } = req.params;
    
    const orderResult = await pool.query(
      'SELECT * FROM payment_orders WHERE order_no = $1 AND user_id = $2',
      [orderNo, userId]
    );
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderResult.rows[0];
    
    res.json({
      order: {
        id: order.id,
        orderNo: order.order_no,
        amount: parseFloat(order.amount),
        currency: order.currency,
        paymentMethod: order.payment_method,
        status: order.status,
        paidAt: order.paid_at,
        transactionId: order.transaction_id,
        createdAt: order.created_at,
      },
    });
  } catch (err) {
    logger.error('Get order status error:', err);
    res.status(500).json({ error: 'Failed to query order status' });
  }
});

/**
 * POST /api/webhooks/wechat-pay
 * 微信支付回调通知处理（Mock）
 */
router.post('/webhooks/wechat-pay', webhookSignatureVerifier, webhookIdempotencyMiddleware(), async (req, res) => {
  try {
    logger.info('WeChat Pay webhook received', { orderNo: req.body.orderNo });
    
    // 签名验证已由 webhookSignatureVerifier 中间件完成
    const { orderNo, transactionId, status } = req.body;
    
    if (status === 'SUCCESS') {
      await pool.query(`
        UPDATE payment_orders 
        SET status = $1, paid_at = NOW(), transaction_id = $2, updated_at = NOW()
        WHERE order_no = $3
      `, ['paid', transactionId, orderNo]);
      
      // 更新订阅状态
      const orderResult = await pool.query(
        'SELECT subscription_id FROM payment_orders WHERE order_no = $1',
        [orderNo]
      );
      
      if (orderResult.rows.length > 0) {
        await pool.query(`
          UPDATE user_subscriptions 
          SET status = $1, updated_at = NOW()
          WHERE id = $2
        `, ['active', orderResult.rows[0].subscription_id]);
      }
      
      logger.info(`WeChat Pay payment successful for order ${orderNo}`);
    }
    
    // 微信支付要求返回特定格式
    res.json({ code: 'SUCCESS', message: 'Success' });
  } catch (err) {
    logger.error('WeChat Pay webhook error:', err);
    res.status(500).json({ code: 'FAIL', message: 'Failed' });
  }
});

/**
 * POST /api/webhooks/alipay
 * 支付宝异步通知处理（Mock）
 */
router.post('/webhooks/alipay', webhookSignatureVerifier, webhookIdempotencyMiddleware(), async (req, res) => {
  try {
    logger.info('Alipay webhook received', { outTradeNo: req.body.out_trade_no });
    
    // 签名验证已由 webhookSignatureVerifier 中间件完成
    const { out_trade_no, trade_no, trade_status } = req.body;
    
    if (trade_status === 'TRADE_SUCCESS') {
      await pool.query(`
        UPDATE payment_orders 
        SET status = $1, paid_at = NOW(), transaction_id = $2, updated_at = NOW()
        WHERE order_no = $3
      `, ['paid', trade_no, out_trade_no]);
      
      // 更新订阅状态
      const orderResult = await pool.query(
        'SELECT subscription_id FROM payment_orders WHERE order_no = $1',
        [out_trade_no]
      );
      
      if (orderResult.rows.length > 0) {
        await pool.query(`
          UPDATE user_subscriptions 
          SET status = $1, updated_at = NOW()
          WHERE id = $2
        `, ['active', orderResult.rows[0].subscription_id]);
      }
      
      logger.info(`Alipay payment successful for order ${out_trade_no}`);
    }
    
    // 支付宝要求返回"success"
    res.send('success');
  } catch (err) {
    logger.error('Alipay webhook error:', err);
    res.status(500).send('failure');
  }
});

/**
 * POST /api/webhooks/stripe
 * Stripe Webhook 事件处理
 */
router.post('/webhooks/stripe', webhookSignatureVerifier, webhookIdempotencyMiddleware(), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || 'mock_secret';
    
    logger.info('Stripe webhook received', { hasSignature: !!sig });
    
    // 使用验证后的事件（由webhookSignatureVerifier中间件附加）
    const event = req.stripeEvent || req.body;
    
    if (!event || !event.type) {
      logger.error('Stripe webhook: Invalid event object');
      return res.status(400).json({ error: 'Invalid event' });
    }
    
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        const orderNo = session.client_reference_id;
        
        await pool.query(`
          UPDATE payment_orders 
          SET status = $1, paid_at = NOW(), transaction_id = $2, updated_at = NOW()
          WHERE order_no = $3
        `, ['paid', session.payment_intent, orderNo]);
        
        // 更新订阅状态
        const orderResult = await pool.query(
          'SELECT subscription_id FROM payment_orders WHERE order_no = $1',
          [orderNo]
        );
        
        if (orderResult.rows.length > 0) {
          await pool.query(`
            UPDATE user_subscriptions 
            SET status = $1, updated_at = NOW()
            WHERE id = $2
          `, ['active', orderResult.rows[0].subscription_id]);
        }
        
        logger.info(`Stripe payment successful for order ${orderNo}`);
        break;
        
      case 'invoice.payment_failed':
        logger.warn('Stripe payment failed', { event: event.data.object });
        break;
        
      default:
        logger.info(`Unhandled Stripe event type: ${event.type}`);
    }
    
    res.json({ received: true });
  } catch (err) {
    logger.error('Stripe webhook error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

export default router;

/**
 * GET /api/invoices/:id/download
 * 下载电子发票 PDF
 */
router.get('/invoices/:id/download', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const invoiceId = req.params.id;
    
    // 查询发票
    const invoiceResult = await pool.query(
      'SELECT * FROM invoices WHERE id = $1 AND user_id = $2',
      [invoiceId, userId]
    );
    
    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    
    const invoice = invoiceResult.rows[0];
    
    // 查询订单
    const orderResult = await pool.query(
      'SELECT * FROM payment_orders WHERE id = $1 AND user_id = $2',
      [invoice.order_id, userId]
    );
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderResult.rows[0];
    
    // 查询用户
    const userResult = await pool.query(
      'SELECT id, phone, email, nickname FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    // 生成 PDF
    const { generateInvoicePDF } = await import('../utils/pdf-invoice.js');
    const pdfBuffer = await generateInvoicePDF(invoice, user, order);
    
    // 返回 PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_no}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    
    res.send(pdfBuffer);
    
    logger.info(`Invoice PDF downloaded: ${invoice.invoice_no}, user: ${userId}`);
  } catch (err) {
    logger.error('Download invoice PDF error:', err);
    res.status(500).json({ error: 'Failed to download invoice' });
  }
});
