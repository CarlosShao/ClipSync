import { Router } from 'express';
import { logger } from '../utils/logger.js';
import { webhookIdempotencyMiddleware } from '../middleware/idempotency.js';
import { createStripeSignatureVerifier, verifyAlipayNotify } from '../middleware/webhook-signature.js';
import { markOrderPaid } from '../services/orderFulfillment.js';
import { isAlipayNotifyConfigured } from '../utils/alipay.js';

/**
 * 支付渠道回调（notify / webhook）路由。
 *
 * ⚠️ 为什么单独一个路由文件，而不是塞进 `routes/payments.js`：
 *
 * 这些端点必须挂在**没有 authenticateToken、没有 csrfProtection** 的位置。
 * 原因：调用方是支付宝/Stripe 的服务器，它们
 *   ① 没有本站用户的 JWT（挂 authenticateToken 必然 401）
 *   ② 也不会带 CSRF token（挂 csrfProtection 必然 403）
 *
 * 此前这些 handler 定义在 payments.js 里，而 payments.js 整体被挂在
 * `/api/payments` 之下并统一加了 `authenticateToken + csrfProtection`
 * （见 index.js）。后果实测：
 *   - 文档写的 `POST /api/webhooks/alipay` → **404**（路由根本不存在）
 *   - 真实地址 `POST /api/payments/webhooks/alipay` → **401 Access token required**
 * 即「支付回调完全不可达」，且因为没法触发，问题一直没被发现。
 *
 * 安全上不靠鉴权，靠**渠道签名验签**（见 webhook-signature.js）+
 * **幂等**（同一通知重复投递不会重复开通订阅）。
 */

const router = Router();

/**
 * POST /api/webhooks/alipay
 * 支付宝异步通知（application/x-www-form-urlencoded）
 *
 * 支付宝要求：处理成功必须返回**纯文本 `success`**（不能带引号/JSON），
 * 否则支付宝会按 25m/2h/... 的策略持续重试，最长 24h。
 * 返回 `failure` 或非 200 会触发重试。
 */
router.post('/alipay', webhookIdempotencyMiddleware(), async (req, res) => {
  const params = req.body || {};
  const { out_trade_no: outTradeNo, trade_no: tradeNo, trade_status: tradeStatus, app_id: appId } = params;

  // 未配置公钥时无法验签：明确失败，绝不"信任"任何未验签的报文
  if (!isAlipayNotifyConfigured()) {
    logger.error('[alipay-notify] ALIPAY_PUBLIC_KEY not configured, rejecting notify', { outTradeNo });
    return res.status(503).send('failure');
  }

  const verified = verifyAlipayNotify(params);
  if (!verified) {
    logger.warn('[alipay-notify] signature verification FAILED', {
      outTradeNo,
      tradeStatus,
      // 只记订单号与状态，绝不打完整报文（可能含买家信息）
    });
    return res.status(401).send('failure');
  }

  // app_id 必须与本商户一致，防止他人用自己商户号的合法签名打过来
  const expectedAppId = process.env.ALIPAY_APP_ID || '';
  if (expectedAppId && appId && appId !== expectedAppId) {
    logger.warn('[alipay-notify] app_id mismatch, rejecting', { got: appId });
    return res.status(401).send('failure');
  }

  logger.info('[alipay-notify] verified', { outTradeNo, tradeStatus, tradeNo });

  // 只处理成功态；其余（WAIT_BUYER_PAY / TRADE_CLOSED）如实记日志并确认收到
  if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
    const result = await markOrderPaid({
      orderNo: outTradeNo,
      transactionId: tradeNo,
      channel: 'alipay',
      // S1：官方要求接收方校验金额——报文 total_amount 必须等于订单金额
      expectedAmount: params.total_amount,
      rawPayload: { tradeStatus, tradeNo },
    });

    if (!result.ok) {
      // 订单不存在/已取消等异常：记错误但仍返回 success？
      // 否 —— 返回 failure 让支付宝重试，给人工排查留出窗口（例如回调早于订单落库的极端竞态）。
      // 但 'already_paid' 属正常幂等，直接确认。
      if (result.reason === 'already_paid') {
        return res.send('success');
      }
      logger.error('[alipay-notify] fulfillment failed, will let alipay retry', {
        outTradeNo,
        reason: result.reason,
      });
      return res.status(500).send('failure');
    }
  } else {
    logger.info('[alipay-notify] non-success status ignored', { outTradeNo, tradeStatus });
  }

  // 支付宝只认小写纯文本 success
  return res.send('success');
});

/**
 * POST /api/webhooks/stripe
 * Stripe 事件回调（JSON，用 stripe-signature 头验签）
 */
router.post('/stripe', webhookIdempotencyMiddleware(), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!endpointSecret) {
    logger.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured');
    return res.status(503).json({ error: 'Not configured' });
  }

  const verify = createStripeSignatureVerifier(endpointSecret);
  await new Promise((resolve) => {
    verify(req, res, () => resolve());
  });
  // verify 内部已在失败时响应，这里检查是否已被处理
  if (res.headersSent) return undefined;

  const event = req.stripeEvent || req.body;
  if (!event || !event.type) {
    logger.error('[stripe-webhook] invalid event object');
    return res.status(400).json({ error: 'Invalid event' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object || {};
      const orderNo = session.client_reference_id;
      if (orderNo) {
        await markOrderPaid({
          orderNo,
          transactionId: session.payment_intent,
          channel: 'stripe',
        });
      } else {
        logger.warn('[stripe-webhook] session without client_reference_id, skipped');
      }
    } else if (event.type === 'invoice.payment_failed') {
      logger.warn('[stripe-webhook] invoice payment failed', { id: event.data?.object?.id });
    } else {
      logger.info('[stripe-webhook] unhandled event type', { type: event.type });
    }
    return res.json({ received: true });
  } catch (err) {
    logger.error('[stripe-webhook] handler failed', { error: err.message });
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
});

export default router;
