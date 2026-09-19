import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';
import { buildPagePayUrl, queryTrade, isAlipayConfigured } from '../utils/alipay.js';
import { markOrderPaid } from '../services/orderFulfillment.js';
// 注：渠道回调（webhook）相关的中间件与 handler 已迁至
// routes/paymentWebhooks.js（那里不需要 authenticateToken/csrfProtection），
// 本文件不再 import 验签与幂等中间件。


const router = Router();

/**
 * POST /api/payments/create-order
 * 创建支付订单；支付宝渠道返回收银台 URL 供前端 iframe 内嵌二维码。
 *
 * ⚠️ 关于 `mock` 渠道：
 * 它会把订单**直接置为已支付并开通订阅**（不经过任何渠道）。此前
 * `paymentMethod` 的**默认值就是 `'mock'`**，即前端不传渠道时自动白送订阅 ——
 * 生产环境等于「免费开通会员」后门。
 * 现在：默认改为 `alipay`；`mock` 仅在非生产环境（NODE_ENV !== 'production'）
 * 且显式传入时才可用，生产环境一律 403。自动化测试/联调因此不受影响。
 */
router.post('/create-order', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { subscriptionId, planId, billingCycle = 'monthly', paymentMethod = 'alipay' } = req.body;

    // 两种下单入口：
    //   ① subscriptionId：已有订阅记录（升级/续费）
    //   ② planId：全新订阅（用户还没有 user_subscriptions 记录），由履约时创建
    // 二者必须给一个，但不要都要求 —— 新用户场景下 subscriptionId 并不存在。
    if (!subscriptionId && !planId) {
      return res.status(400).json({ error: 'Missing subscriptionId or planId parameter' });
    }
    if (paymentMethod === 'mock' && !subscriptionId) {
      // mock 走的是"已有订阅直接置 active"路径，没有 subscriptionId 无法履约
      return res.status(400).json({ error: 'mock payment requires subscriptionId' });
    }

    const ALLOWED_METHODS = new Set(['alipay', 'mock']);
    if (!ALLOWED_METHODS.has(paymentMethod)) {
      return res.status(400).json({
        error: `Unsupported paymentMethod: ${paymentMethod}`,
        allowed: [...ALLOWED_METHODS],
      });
    }

    // 生产环境禁用 mock 渠道（历史后门，见上方注释）
    const isProduction = process.env.NODE_ENV === 'production';
    if (paymentMethod === 'mock' && isProduction) {
      logger.warn('[payments] mock channel attempted in production', { userId });
      return res.status(403).json({ error: 'Mock payment is not available in production' });
    }

    if (paymentMethod === 'alipay' && !isAlipayConfigured()) {
      // 未配置凭据时明确失败，绝不静默降级成 mock（那等于白送订阅）
      logger.error('[payments] alipay channel requested but not configured');
      return res.status(503).json({
        error: 'Payment channel not configured',
        code: 'ALIPAY_NOT_CONFIGURED',
      });
    }

    // 解析计价来源：订阅记录（升级）或套餐（新订）
    // subscription_plans 无 price/currency 列（只有 price_monthly/price_yearly），
    // 按计费周期取对应价格；币种统一 CNY（与 subscribe 路由口径一致）
    let subscription = null;

    if (subscriptionId) {
      const subscriptionResult = await pool.query(
        `SELECT us.*,
                sp.name AS plan_name,
                sp.display_name AS plan_display_name,
                CASE WHEN us.billing_cycle = 'yearly' THEN sp.price_yearly ELSE sp.price_monthly END AS price,
                'CNY' AS currency
         FROM user_subscriptions us
         JOIN subscription_plans sp ON us.plan_id = sp.id
         WHERE us.id = $1 AND us.user_id = $2`,
        [subscriptionId, userId]
      );

      if (subscriptionResult.rows.length === 0) {
        return res.status(404).json({ error: 'Subscription not found' });
      }
      subscription = subscriptionResult.rows[0];
    } else {
      const planResult = await pool.query(
        `SELECT id, name, display_name,
                CASE WHEN $2 = 'yearly' THEN price_yearly ELSE price_monthly END AS price,
                'CNY' AS currency
           FROM subscription_plans
          WHERE id = $1 AND is_active = true`,
        [planId, billingCycle]
      );

      if (planResult.rows.length === 0) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      const plan = planResult.rows[0];
      // 新订：此时还没有订阅记录，履约阶段（markOrderPaid）会依据 metadata.planId 创建
      subscription = {
        id: null,
        plan_name: plan.name,
        plan_display_name: plan.display_name,
        price: plan.price,
        currency: plan.currency,
      };
    }
    
    const orderNo = `ORD${Date.now()}${Math.random().toString(36).substr(2, 6)}`;
    
    // 创建订单
    const orderResult = await pool.query(`
      INSERT INTO payment_orders (user_id, subscription_id, order_no, amount, currency, payment_method, status, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, order_no, amount, currency, status, created_at
    `, [
      userId,
      subscription.id,
      orderNo,
      subscription.price,
      subscription.currency,
      paymentMethod,
      'pending',
      // planId 供「新订」场景在履约时创建订阅记录（见 orderFulfillment.js）
      JSON.stringify({ subscriptionId: subscription.id, planId: planId || null, billingCycle, paymentMethod })
    ]);
    
    const order = orderResult.rows[0];
    
    // 审计日志：记录支付订单创建
    await logAuditEvent({
      userId,
      action: AUDIT_ACTIONS.PAYMENT_CREATE,
      resourceType: 'payment_order',
      resourceId: order.id.toString(),
      details: {
        orderNo: order.order_no,
        amount: order.amount,
        currency: order.currency,
        paymentMethod,
        subscriptionId,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => logger.error('Audit log failed', { error: err.message }));
    
    // Mock支付：直接标记为已支付（仅非生产环境可达，见上方守卫）
    if (paymentMethod === 'mock') {
      // 复用统一履约入口，避免与回调路径两套逻辑漂移
      const fulfilled = await markOrderPaid({
        orderNo: order.order_no,
        transactionId: `MOCK${Date.now()}`,
        channel: 'mock',
      });

      if (!fulfilled.ok) {
        logger.error('[payments] mock fulfillment failed', { orderNo, reason: fulfilled.reason });
        return res.status(500).json({ error: 'Failed to complete mock payment' });
      }

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
        invoiceNo: fulfilled.order?.invoiceNo ?? null,
      });
    }

    // ── 支付宝渠道：生成收银台 URL（前端 iframe 内嵌二维码） ──
    if (paymentMethod === 'alipay') {
      // notify_url 必须是**公网可达**的绝对地址；由 env 提供，绝不硬编码域名
      // （此前 webhook-signature.js 里硬编码过回调路径，与实际挂载点不一致）
      const notifyUrl = String(process.env.ALIPAY_NOTIFY_URL || '').trim();
      if (!notifyUrl) {
        logger.error('[payments] ALIPAY_NOTIFY_URL not configured');
        return res.status(503).json({
          error: 'Payment notify URL not configured',
          code: 'ALIPAY_NOTIFY_URL_MISSING',
        });
      }

      const payUrl = buildPagePayUrl({
        outTradeNo: order.order_no,
        totalAmount: order.amount,
        subject: `ClipSync ${subscription.plan_display_name || subscription.plan_name || '订阅'}`,
        notifyUrl,
      });

      logger.info(`Alipay order created: ${orderNo}`);

      return res.json({
        message: 'Order created, please complete payment',
        order: {
          id: order.id,
          orderNo: order.order_no,
          amount: parseFloat(order.amount),
          currency: order.currency,
          status: order.status,
          paymentParams: {
            channel: 'alipay',
            // 前端用 <iframe src={cashierUrl}> 展示二维码（qr_pay_mode=4）
            cashierUrl: payUrl,
          },
        },
      });
    }

    // 理论上不可达（上方已校验枚举），兜底避免"静默成功"
    logger.error('[payments] unhandled paymentMethod branch', { paymentMethod, orderNo });
    return res.status(500).json({ error: 'Unhandled payment method' });
  } catch (err) {
    logger.error('Create payment order error:', err);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

/**
 * GET /api/payments/order/:orderNo/status
 * 查询订单支付状态（桌面端支付遮罩**轮询此接口**，TRAE 式交互）。
 *
 * 为什么在轮询里主动查一次支付宝：
 * 回调可能因网络/DNS/部署问题迟迟不到（支付宝重试间隔 4m/10m/10m/1h/2h/6h/15h，
 * 最长 24h）。若只依赖回调，用户扫完码会盯着遮罩等很久甚至一直等到超时。
 * 因此：订单仍为 pending 且是支付宝渠道时，顺带调 `alipay.trade.query`；
 * 查到已支付就立刻走统一履约，把结果返回给前端 —— 相当于给回调加了一条兜底路径。
 *
 * 代价说明：每次轮询都会打一次支付宝网关。前端轮询间隔应 ≥3s，
 * 且订单付清后前端即停止轮询（本接口对已支付订单不再外呼）。
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
    
    let order = orderResult.rows[0];

    // 兜底：pending 的支付宝订单，主动查一次渠道
    const isAlipayOrder =
      String(order.payment_method || '').toLowerCase() === 'alipay' ||
      String(order.payment_channel || '').toLowerCase() === 'alipay';

    if (order.status === 'pending' && isAlipayOrder && isAlipayConfigured()) {
      try {
        const trade = await queryTrade(order.order_no);
        if (trade.paid) {
          const fulfilled = await markOrderPaid({
            orderNo: order.order_no,
            transactionId: trade.tradeNo,
            channel: 'alipay',
            // S1：查询结果同样带金额，兜底路径也要校验，与回调路径同一道闸
            expectedAmount: trade.raw?.total_amount,
            rawPayload: { source: 'poll_query', tradeStatus: trade.tradeStatus },
          });
          if (fulfilled.ok) {
            // 重新读一次，拿到 paid_at / transaction_id 等最新字段
            const fresh = await pool.query('SELECT * FROM payment_orders WHERE id = $1', [order.id]);
            order = fresh.rows[0] || order;
            logger.info('[payments] order fulfilled via poll fallback', { orderNo });
          }
        }
      } catch (qErr) {
        // 查询失败不影响本次响应：仍返回数据库中的当前状态，前端继续轮询
        logger.warn('[payments] alipay trade.query failed during poll', {
          orderNo,
          error: qErr.message,
        });
      }
    }

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

// ============================================
// 支付渠道回调已迁出本文件
// ============================================
// 原先这里定义了 /webhooks/wechat-pay、/webhooks/alipay、/webhooks/stripe 三个
// handler，但它们随 payments.js 一起被挂在 /api/payments 之下，而该挂载点统一加了
// authenticateToken + csrfProtection —— 渠道服务器没有 JWT、也不带 CSRF token，
// 因此这三条路由**永远返回 401，从未被调用过**（文档里写的 /api/webhooks/* 则是 404）。
//
// 现已迁到 routes/paymentWebhooks.js，挂载于 /api/webhooks（无认证中间件，
// 靠渠道签名验签 + 幂等防护），并由 services/orderFulfillment.js 统一履约。
// 微信支付不接入（成本考虑：需已认证公众号，300 元/年认证费），故不再保留其回调实现。

/**
 * GET /api/payments/invoices/:id/download —— 已废弃，勿启用
 *
 * 此路由长期被注释，原因不明；其功能已由 routes/invoices.js 的
 * `GET /api/invoices/:id/download` 提供（挂载于 /api/invoices，index.js 已验证）。
 * 保留注释仅为说明「这里为什么空着」，不要取消注释造成两套实现。
 */

/**
 * POST /api/payments/refund
 * 申请退款 —— **已禁用（501）**，等待真实渠道退款接入（S2）。
 *
 * 原实现是假退款：只把订单标 refunded、订阅标 canceled，
 * **从不调用支付宝退款 API**——用户视角'退款成功'但钱没退，
 * 订阅反而没了。产品决策（2026-09-19）：退款=真实打款+订阅立即收回，
 * 在 alipay.trade.refund 接入前，此端点必须拒绝而非误导。
 */
router.post('/refund', authenticateToken, async (req, res) => {
  logger.warn('[payments] refund attempted but channel refund not integrated', {
    userId: req.user?.userId,
    orderId: req.body?.orderId,
  });
  return res.status(501).json({
    error: 'Refund is not available yet. Please contact support.',
    code: 'REFUND_NOT_IMPLEMENTED',
  });
});


/**
 * GET /api/payments/reconciliation
 * 财务对账（管理员功能）
 */
router.get('/reconciliation', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // 检查是否为管理员
    const userResult = await pool.query(
      'SELECT is_admin FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0 || !userResult.rows[0].is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Missing startDate or endDate parameter' });
    }
    
    // 查询订单
    const ordersResult = await pool.query(`
      SELECT 
        po.id,
        po.order_no,
        po.amount,
        po.currency,
        po.payment_method,
        po.status,
        po.paid_at,
        po.transaction_id,
        u.phone,
        u.email,
        sp.name as plan_name
      FROM payment_orders po
      JOIN users u ON po.user_id = u.id
      LEFT JOIN user_subscriptions us ON po.subscription_id = us.id
      LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
      WHERE po.paid_at BETWEEN $1 AND $2
      ORDER BY po.paid_at DESC
    `, [startDate, endDate]);
    
    // 统计
    const statsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) as total_paid_amount,
        SUM(CASE WHEN status = 'refunded' THEN amount ELSE 0 END) as total_refunded_amount,
        COUNT(CASE WHEN status = 'paid' THEN 1 END) as paid_orders,
        COUNT(CASE WHEN status = 'refunded' THEN 1 END) as refunded_orders
      FROM payment_orders
      WHERE paid_at BETWEEN $1 AND $2
    `, [startDate, endDate]);
    
    const stats = statsResult.rows[0];
    
    res.json({
      startDate,
      endDate,
      statistics: {
        totalOrders: parseInt(stats.total_orders),
        totalPaidAmount: parseFloat(stats.total_paid_amount || 0),
        totalRefundedAmount: parseFloat(stats.total_refunded_amount || 0),
        paidOrders: parseInt(stats.paid_orders),
        refundedOrders: parseInt(stats.refunded_orders),
      },
      orders: ordersResult.rows.map(order => ({
        id: order.id,
        orderNo: order.order_no,
        amount: parseFloat(order.amount),
        currency: order.currency,
        paymentMethod: order.payment_method,
        status: order.status,
        paidAt: order.paid_at,
        transactionId: order.transaction_id,
        userPhone: order.phone,
        userEmail: order.email,
        planName: order.plan_name,
      })),
    });
  } catch (err) {
    logger.error('Reconciliation error:', err);
    res.status(500).json({ error: 'Failed to generate reconciliation report' });
  }
});


export default router;
