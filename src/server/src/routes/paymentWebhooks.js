import { Router } from 'express';
import { logger } from '../utils/logger.js';
import { createStripeSignatureVerifier, verifyAlipayNotify } from '../middleware/webhook-signature.js';
import { markOrderPaid, markOrderClosed } from '../services/orderFulfillment.js';
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
 * **幂等**。
 *
 * ── 2026-10-03 审计 M1：本文件不再挂 `webhookIdempotencyMiddleware` ──
 *
 * 该中间件对支付宝是 **no-op**：它只钩 `res.json`，而本 handler 用
 * `res.send('success')` 回纯文本，所以缓存从未写入过。更糟的是它挂在 handler
 * **之前**，命中缓存就直接短路 —— 也就是**跳过验签**。另外三点：
 *   ① 不校验状态码，会把 Stripe 分支的 503/500 缓存 24h，Stripe 的后续重试
 *      全部命中同一个错误响应，事件再也不会被成功处理；
 *   ② 同一命名空间跨渠道复用（支付宝取 trade_no、Stripe 取 id、通用取
 *      x-request-id），任意人可经未配置的 Stripe 端点写入 key 干扰支付宝回调；
 *   ③ 回放用 `res.json(...)`，支付宝收到的是带引号的 `"success"`，判定失败。
 * 这四个问题里 ①③ 是设计层面的（它必须在验签之前才能"省掉一次验签"），
 * 所以**修不如删**：真正且正确的幂等裁判是履约层的 `markOrderPaid`
 * （订单行锁 + 状态判定，见 services/orderFulfillment.js），它对重复投递本身安全。
 *
 * ⚠️ 中间件的**幂等语义本身是对的**（回调无用户上下文，需全局命名空间），
 * 前提是把它放在**验签之后**。若将来确实需要传输层去重，请按此前提重写，
 * 不要直接恢复下面这个实现。
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
router.post('/alipay', async (req, res) => {
  const params = req.body || {};
  const { out_trade_no: outTradeNo, trade_no: tradeNo, trade_status: tradeStatus, app_id: appId } = params;

  // 未配置公钥时无法验签：明确失败，绝不"信任"任何未验签的报文
  if (!isAlipayNotifyConfigured()) {
    logger.error('[alipay-notify] ALIPAY_PUBLIC_KEY not configured, rejecting notify', { outTradeNo });
    return res.status(503).send('failure');
  }

  // M2（2026-10-03 审计）：身份校验必须 **fail-closed**，配置不全就直接拒收。
  //
  // 原写法是 `if (expectedAppId && appId && appId !== expectedAppId)` —— 三重前置条件，
  // 只要 env 漏配/改名（expectedAppId 为空）**或**报文里没有 app_id，整条校验就
  // **静默跳过**；而 isAlipayNotifyConfigured() 当时只查公钥，所以「有公钥、无 app_id」
  // 时 handler 会继续往下走。此时唯一剩下的防线只有金额比对 —— 攻击者完全可以拿
  // 自己的商户号，用受害者的 out_trade_no 与相同金额下单付款，取得一份**合法签名**的
  // 通知打进来，从而白拿订阅。
  const expectedAppId = String(process.env.ALIPAY_APP_ID || '').trim();
  if (!expectedAppId) {
    logger.error('[alipay-notify] ALIPAY_APP_ID not configured, cannot verify merchant identity');
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

  // 报文缺 app_id 同样拒收（不能因为"字段没有"就放行）
  if (!appId) {
    logger.warn('[alipay-notify] notify carries no app_id, rejecting', { outTradeNo });
    return res.status(401).send('failure');
  }
  if (String(appId).trim() !== expectedAppId) {
    logger.warn('[alipay-notify] app_id mismatch, rejecting', { got: appId, outTradeNo });
    return res.status(401).send('failure');
  }

  // seller_id（收款方支付宝 PID）：官方建议比对，且它是「这笔钱真的进了我的账户」
  // 的直接证据，比 app_id 更贴近资金。未配置则不校验（保持向后兼容），配了就强制。
  const expectedSellerId = String(process.env.ALIPAY_SELLER_ID || '').trim();
  if (expectedSellerId) {
    const gotSellerId = String(params.seller_id || '').trim();
    if (gotSellerId !== expectedSellerId) {
      logger.warn('[alipay-notify] seller_id mismatch, rejecting', { got: gotSellerId, outTradeNo });
      return res.status(401).send('failure');
    }
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
  } else if (tradeStatus === 'TRADE_CLOSED') {
    // M6（2026-10-03 审计）：关单通知此前只"记日志并确认收到"，本地订单仍是 pending
    // → 前端继续轮询、每次轮询继续打渠道，直到 24h 后 sweep 才关，白白消耗渠道 QPS。
    //
    // ⚠️ TRADE_CLOSED 也可能是「**全额退款后**交易关闭」，所以只能对 **pending** 生效，
    // 绝不能覆盖 paid / refunded 等终态 —— 那会抹掉资金事实（见 markOrderClosed 的 WHERE）。
    const closed = await markOrderClosed({
      orderNo: outTradeNo,
      rawPayload: { tradeStatus, tradeNo },
    });
    logger.info('[alipay-notify] TRADE_CLOSED handled', {
      outTradeNo,
      applied: closed.changed,
      reason: closed.reason,
    });
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
router.post('/stripe', async (req, res) => {
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
