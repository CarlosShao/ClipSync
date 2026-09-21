import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';
import { buildPagePayUrl, queryTrade, isAlipayConfigured } from '../utils/alipay.js';
import { markOrderPaid } from '../services/orderFulfillment.js';
import { computeProration, decidePlanChange, roundToCent } from '../services/proration.js';
import { refundPaidOrder, RefundError, locateOrder } from '../services/refund.js';
import {
  SELF_REFUND_WINDOW_DAYS,
  SELF_REFUND_ORDER_COLUMNS,
  REFUNDABLE_ORDERS_LIMIT,
  REFUND_REASON_CODES,
  evaluateSelfRefund,
  findSelfRefundAnchorOrderId,
  listRefundCandidateOrders,
  getRefundSettings,
} from '../services/refundPolicy.js';
import {
  createSelfRefundRequest,
  listMyRefundRequests,
  findPendingRequestsByOrderIds,
} from '../services/refundRequest.js';
import { isFlagEnabled } from '../utils/featureFlags.js';
// 注：渠道回调（webhook）相关的中间件与 handler 已迁至
// routes/paymentWebhooks.js（那里不需要 authenticateToken/csrfProtection），
// 本文件不再 import 验签与幂等中间件。


const router = Router();

/**
 * F2 修复：enable_subscription 开关的服务端强制点（收钱/退款两端各一道闸）。
 *
 * 历史：开关只影响**权益判定**（planFeature/subscriptionCheck 按 Free 处理），
 * 收钱链路（create-order / refund / 履约）完全不看它 —— 管理台关掉订阅功能后，
 * 老客户端或 curl 照样能建单收款、照样能退款，「开关」形同虚设。
 * 现在：关闭时 503 { code: 'SUBSCRIPTION_DISABLED' }（不返回 403，语义是
 * 「该功能暂时不可用」而非「你没权限」，客户端可据此重试/提示）。
 *
 * 用 isFlagEnabled 而非 requireFlag 中间件：requireFlag 的 403 形状与本文件
 * 的 { error, code } 错误壳不一致；键名写成字面量以便 featureFlags 的
 * AN-10 强制点自检扫到（否则 /api/admin/flags 的 enforced 会如实报 false）。
 */
async function subscriptionDisabled(res) {
  return res.status(503).json({
    error: 'Subscription feature is disabled by administrator',
    code: 'SUBSCRIPTION_DISABLED',
    flagDisabled: 'enable_subscription',
  });
}

/**
 * metadata 里的金额字段取值：JSON 数值/字符串都可能（历史数据、跨版本写入），
 * 非法值一律回退到 fallback —— 展示字段宁可退回实付金额，也不能出 NaN 或 0 元
 * 这种「看起来像免费」的数字（refundable-orders 的 originalAmount/creditAmount 用）。
 */
function toFiniteAmount(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? roundToCent(n) : fallback;
}

/**
 * POST /api/payments/create-order
 * 创建支付订单；支付宝渠道返回收银台 URL 供前端 iframe 内嵌二维码。
 *
 * body: { planId? , subscriptionId?, billingCycle? = 'monthly', paymentMethod? = 'alipay' }
 *
 * 升级差价折抵（任务板 #15）：调用方**只需照常传 planId + billingCycle**，
 * 服务端自己识别「用户已持有 active 订阅」并处理三种结果 ——
 *   档位更高 → 按残值折抵后建单（200，order.amount 即实付，metadata/响应带 proration）
 *   同一套餐 → 409 ALREADY_SUBSCRIBED
 *   档位更低（或同价）→ 409 DOWNGRADE_NOT_ALLOWED
 * 无 active 订阅的用户维持全价新订（含 billingCycle='yearly'）。
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

    // F2：开关关闭时不建单（在建单/校验之前拦，绝不留下永远付不掉的 pending 单）
    if (!(await isFlagEnabled('enable_subscription'))) {
      logger.warn('[payments] create-order blocked: enable_subscription disabled', { userId });
      return subscriptionDisabled(res);
    }

    // 两种下单入口：
    //   ① planId：新订 / 升级（升级也走这个入口，服务端自行识别 active 订阅并折抵差价）
    //   ② subscriptionId：已有订阅记录（历史入口；不给 planId 时按该订阅自身套餐计价）
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

    // ── 解析目标套餐与计价 ──
    // subscription_plans 无 price/currency 列（只有 price_monthly/price_yearly），
    // 按计费周期取对应价格；币种统一 CNY（与 subscribe 路由口径一致）。
    //
    // 两种下单入口，目标套餐的确定规则：
    //   ① 只给 planId       → 目标套餐 = planId（新订 / 升级）
    //   ② 只给 subscriptionId → 目标套餐 = 该订阅所属套餐（历史行为：按该订阅自身周期计价）
    //   ③ 二者都给且不同     → 以 planId 为目标（升级单：subscriptionId 指向被取代的旧订阅）
    let targetPlan = null;
    let subscription = null;

    if (planId) {
      const planResult = await pool.query(
        `SELECT id, name, display_name, price_monthly, price_yearly
           FROM subscription_plans
          WHERE id = $1 AND is_active = true`,
        [planId]
      );
      if (planResult.rows.length === 0) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      targetPlan = planResult.rows[0];
    }

    if (subscriptionId) {
      const subscriptionResult = await pool.query(
        `SELECT us.id, us.user_id, us.plan_id, us.billing_cycle,
                us.current_period_start, us.current_period_end,
                sp.name AS plan_name,
                sp.display_name AS plan_display_name,
                sp.price_monthly AS plan_price_monthly,
                sp.price_yearly AS plan_price_yearly
         FROM user_subscriptions us
         JOIN subscription_plans sp ON us.plan_id = sp.id
         WHERE us.id = $1 AND us.user_id = $2`,
        [subscriptionId, userId]
      );

      if (subscriptionResult.rows.length === 0) {
        return res.status(404).json({ error: 'Subscription not found' });
      }
      subscription = subscriptionResult.rows[0];
      // 未显式指定 planId 时，目标套餐就是这条订阅当前的套餐
      targetPlan = targetPlan || {
        id: subscription.plan_id,
        name: subscription.plan_name,
        display_name: subscription.plan_display_name,
        price_monthly: subscription.plan_price_monthly,
        price_yearly: subscription.plan_price_yearly,
      };
    }

    // 计费周期：显式 planId 入口按请求参数；仅 subscriptionId 入口沿用该订阅自身周期
    const effectiveCycle = planId
      ? (billingCycle === 'yearly' ? 'yearly' : 'monthly')
      : (subscription?.billing_cycle === 'yearly' ? 'yearly' : 'monthly');
    const listPrice = roundToCent(
      effectiveCycle === 'yearly' ? targetPlan.price_yearly : targetPlan.price_monthly
    );
    const currency = 'CNY';

    // 套餐没配价（price_* 为 NULL，或 Free 这类 0 元套餐）：不能建 0 元订单——
    // 支付宝会直接拒单，库里留下一条永远付不掉的 pending 单；Free 也不需要下单。
    if (!(listPrice > 0)) {
      logger.warn('[payments] plan price not configured, refusing to create order', {
        userId,
        planId: targetPlan.id,
        billingCycle: effectiveCycle,
      });
      return res.status(400).json({
        error: 'Plan price is not configured for the selected billing cycle',
        code: 'PLAN_PRICE_MISSING',
      });
    }

    // ── 升级差价折抵（任务板 #15）──
    // 只认「status=active 且未到期」的订阅作为折抵依据：
    //  - 已到期（哪怕状态还没被清扫任务改成 expired）不再有钱可折，按全价新订；
    //  - 实付金额取该订阅最近一条已支付订单的金额（升级单本身是折抵后的价，
    //    按实付折抵才不会把「上次的折扣」再折一遍），无支付订单时回退套餐标价
    //    （mock/赠送/历史数据）。
    const currentResult = await pool.query(
      `SELECT us.id, us.plan_id, us.billing_cycle,
              us.current_period_start, us.current_period_end,
              sp.name AS plan_name,
              sp.price_monthly AS plan_price_monthly,
              COALESCE(
                (SELECT po.amount
                   FROM payment_orders po
                  WHERE po.subscription_id = us.id AND po.status = 'paid'
                  ORDER BY po.paid_at DESC NULLS LAST
                  LIMIT 1),
                CASE WHEN us.billing_cycle = 'yearly' THEN sp.price_yearly ELSE sp.price_monthly END
              ) AS paid_amount
         FROM user_subscriptions us
         JOIN subscription_plans sp ON sp.id = us.plan_id
        WHERE us.user_id = $1 AND us.status = 'active' AND us.current_period_end > NOW()
        ORDER BY us.current_period_end DESC
        LIMIT 1`,
      [userId]
    );
    const currentSubscription = currentResult.rows[0] || null;

    let proration = null;
    if (currentSubscription) {
      const decision = decidePlanChange({
        currentPlanId: currentSubscription.plan_id,
        targetPlanId: targetPlan.id,
        currentTierPrice: currentSubscription.plan_price_monthly,
        targetTierPrice: targetPlan.price_monthly,
      });

      if (decision.kind === 'same') {
        // 同套餐重复购买：既不折抵也不该再开一条，交给前端提示「已在该套餐」。
        // 副作用：同套餐续费也因此被拦（#13 订阅入口治理的产品口径 —— 续费入口本期不提供，
        // 到期后再订；履约侧仍保留"同套餐 active 则顺延周期"的兜底逻辑）。
        logger.info('[payments] duplicate plan purchase blocked', {
          userId,
          planId: targetPlan.id,
          subscriptionId: currentSubscription.id,
        });
        return res.status(409).json({
          error: 'You are already subscribed to this plan',
          code: 'ALREADY_SUBSCRIBED',
          subscriptionId: currentSubscription.id,
        });
      }
      if (decision.kind === 'downgrade') {
        // 降档不做差价（低档位全额重购没有统一的公平口径），引导走客服/到期后重订
        logger.info('[payments] downgrade purchase blocked', {
          userId,
          fromPlanId: currentSubscription.plan_id,
          toPlanId: targetPlan.id,
        });
        return res.status(409).json({
          error: 'Downgrade is not supported. Please wait for the current plan to expire, or contact support.',
          code: 'DOWNGRADE_NOT_ALLOWED',
        });
      }

      const base = computeProration({
        paidAmount: currentSubscription.paid_amount,
        periodStart: currentSubscription.current_period_start,
        periodEnd: currentSubscription.current_period_end,
        newPrice: listPrice,
      });
      proration = {
        originalPrice: base.originalPrice,
        creditAmount: base.creditAmount,
        finalAmount: base.finalAmount,
        remainingDays: base.remainingDays,
        cycleDays: base.cycleDays,
        oldSubscriptionId: currentSubscription.id,
        oldPlanId: currentSubscription.plan_id,
        newPlanId: targetPlan.id,
      };
    }

    // 订单实付金额：升级单用折抵后价，其余用套餐标价
    const amount = proration ? proration.finalAmount : listPrice;

    const orderNo = `ORD${Date.now()}${Math.random().toString(36).substr(2, 6)}`;
    
    // 创建订单
    const orderResult = await pool.query(`
      INSERT INTO payment_orders (user_id, subscription_id, plan_id, order_no, amount, currency, payment_method, status, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, order_no, amount, currency, status, created_at
    `, [
      userId,
      subscription?.id || null,
      targetPlan.id,
      orderNo,
      amount,
      currency,
      paymentMethod,
      'pending',
      // planId 供「新订/升级」场景在履约时创建订阅记录（见 orderFulfillment.js）；
      // proration 是升级单标记，履约据此终止旧订阅（见 services/proration.js）
      JSON.stringify({
        subscriptionId: subscription?.id || null,
        planId: targetPlan.id,
        billingCycle: effectiveCycle,
        paymentMethod,
        ...(proration ? { proration } : {}),
      })
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
        planId: targetPlan.id,
        billingCycle: effectiveCycle,
        ...(proration ? { proration } : {}),
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
        proration,
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
        subject: `ClipSync ${targetPlan.display_name || targetPlan.name || '订阅'}`,
        notifyUrl,
      });

      logger.info(`Alipay order created: ${orderNo}`);

      return res.json({
        message: 'Order created, please complete payment',
        order: {
          id: order.id,
          orderNo: order.order_no,
          amount: parseFloat(order.amount),
          // 升级折抵时给前端把「原价 / 折抵 / 实付」摊开展示，避免用户对金额产生疑问
          originalAmount: proration ? proration.originalPrice : parseFloat(order.amount),
          creditAmount: proration ? proration.creditAmount : 0,
          currency: order.currency,
          status: order.status,
          paymentParams: {
            channel: 'alipay',
            // 前端用 <iframe src={cashierUrl}> 展示二维码（qr_pay_mode=4）
            cashierUrl: payUrl,
          },
        },
        proration,
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
 * POST /api/payments/refund —— 真实退款（属主自助 + 客服通道）
 *
 * body: { orderId | orderNo, reason? }
 *  - orderId（UUID 主键）/ orderNo（业务单号）二选一，服务端按入参形状定位
 *    （形状判别只有 services/refund.js#locateOrder 一份实现，路由不再抄正则）；
 *  - 权限模型（产品决策 2026-09-19 变更，原 PD4「用户侧无退款入口」已废）：
 *      ① **订单属主本人**可自助退款 —— 客户端个人资料页「申请退款」入口，但要过
 *         三道风控闸（判定实现见 services/refundPolicy.js，与 GET /refundable-orders
 *         同源，绝不两处各写一份）：
 *           · 必须是「**当前生效订阅的最近一笔已支付订单**」→ 否则 409
 *             NOT_CURRENT_SUB_ORDER。锚点钉在 active 且未到期的订阅上：退掉即
 *             订阅 canceled、锚点消失——历史订单**永不顺移可退**（旧口径
 *             「用户最近一笔 paid」被实测打回：可以一笔笔顺着把历史全退干净）；
 *           · paid_at 距今 ≤ SELF_REFUND_WINDOW_DAYS(7) 天 → 否则 409 REFUND_WINDOW_EXPIRED；
 *           · status / 渠道（非 alipay）不在此重复报错，一律交 refundPaidOrder 裁决。
 *      ② **非属主** → 仍需 users.is_admin（管理员退款**不受**上面两道闸限制）。
 *  - 防探测：调用方既不是属主也不是管理员时，返回与「订单不存在」完全同壳的
 *    404 ORDER_NOT_FOUND —— 不在任何未授权响应里承认「这笔订单存在」。
 *
 * ⚠️ §4-A1 重构：本路由只剩「权限 + 风控 + 响应壳」，资金动作全部在
 *   services/refund.js#refundPaidOrder —— 管理与用户侧两条退款端点自此共用同一
 *   份真打款实现（旧的记账式实现在 admin/orders.js，已删除）。
 *   流程、顺序与错误码见该文件头注释；简言之：
 *   paid+alipay 校验 → alipay.trade.refund 全额 → 仅 fund_status='Y' 才
 *   事务落库（订单 refunded + 订阅 canceled + users 回 free + 审计）。
 *   退款即收回权益，所以自助退款没有「退了钱权益还在」的羊毛可薅。
 *
 * 权限模型说明（§4-A2 遗留）：管理员分支仍用 users.is_admin 布尔列；管理台端点用
 * RBAC（roles/permissions）。两套口径的收敛不在本次改动范围内。
 */
router.post('/refund', authenticateToken, async (req, res) => {
  try {
    const operatorId = req.user.userId;
    const { orderId, orderNo, reason } = req.body || {};
    const key = String(orderId || orderNo || '').trim();

    if (!key) {
      return res.status(400).json({ error: 'Missing orderId or orderNo parameter' });
    }

    // 先定位订单：属主分支要求在读到 user_id 之后才能判权限
    const order = await locateOrder(key, SELF_REFUND_ORDER_COLUMNS);
    const notFound = () => res.status(404).json({ error: 'Order not found', code: 'ORDER_NOT_FOUND', orderNo: key });
    if (!order) return notFound();

    const isOwner = String(order.user_id) === String(operatorId);
    // 操作者身份一次查清：非属主要管理员权限，属主分支也要知道 TA 是不是管理员
    // （管理员本人退自己的单不该被审核门挡住 —— TA 在管理台本来就能强退任何订单，
    //  在这里再拦一道只会把人绕进自己的后台）
    const actorResult = await pool.query('SELECT is_admin FROM users WHERE id = $1', [operatorId]);
    if (actorResult.rows.length === 0) {
      logger.warn('[payments] refund denied: operator account not found', {
        operatorId,
        orderKey: key,
      });
      return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
    }
    const operatorIsAdmin = Boolean(actorResult.rows[0].is_admin);

    if (!isOwner && !operatorIsAdmin) {
      logger.warn('[payments] refund denied: neither owner nor admin', { operatorId, orderKey: key });
      // 防探测：与「订单不存在」同壳，绝不泄露「该订单存在、只是不是你的」
      return notFound();
    }

    // F2：开关关闭时不走退款（放在权限判定之后，避免向未授权调用方泄露功能状态）
    if (!(await isFlagEnabled('enable_subscription'))) {
      logger.warn('[payments] refund blocked: enable_subscription disabled', {
        operatorId,
        orderKey: key,
        selfService: isOwner,
      });
      return subscriptionDisabled(res);
    }

    // 属主分支**不再即时退款**（产品决策 2026-09-20）：支付宝的退款是同步且不可撤销
    // 的，调用成功钱就出去了，事后没有「审核不通过」可言 —— 所以审核必须前置到调用
    // 之前，属主一律改走 POST /refund-request（只落申请单 + 立即收回权益）。
    // 管理员分支保持原样：客服线下场景仍可强退任意已付订单。
    if (isOwner && !operatorIsAdmin) {
      logger.info('[payments] self-service refund redirected to review flow', {
        operatorId,
        orderKey: key,
      });
      return res.status(409).json({
        error: 'Refund requires manual review, please submit a refund request',
        code: 'REFUND_REQUEST_REQUIRED',
        orderNo: order.order_no,
      });
    }

    const result = await refundPaidOrder({
      // 用**已定位到的主键**去退，避免二次按 key 解析（形状判别的口径此时已确定）
      orderId: String(order.id),
      actorUserId: operatorId,
      reason: isOwner ? String(reason || '').trim() || '用户自助退款' : reason,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (isOwner) {
      logger.info('[payments] self-service refund completed', {
        operatorId,
        orderNo: result.order.orderNo,
        refundAmount: result.order.refundAmount,
      });
    }

    return res.json({ message: 'Refund successful', ...result });
  } catch (err) {
    if (err instanceof RefundError) {
      // 服务层错误 → 本端点既有的 { error, code, ...extra } 错误壳（契约不变）
      return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    }
    logger.error('Refund error:', err);
    res.status(500).json({ error: 'Failed to process refund' });
  }
});


/**
 * GET /api/payments/refundable-orders —— 客户端「申请退款」弹窗的候选清单
 *
 * 返回当前用户最近 REFUNDABLE_ORDERS_LIMIT(10) 条 status IN ('paid','refunded')
 * 的订单（按 paid_at 倒序），每条带 refundable + reasonCode：
 *   { orders: [ { orderId, orderNo, amount, originalAmount, creditAmount,
 *                 paidAt, status, refundable, reasonCode } ] }
 *
 * - 只查自己的单（user_id 条件），无越权面；不返回任何用户/设备隐私字段。
 * - originalAmount/creditAmount 取 metadata.proration（升级折抵单）：升级单实付是
 *   折抵后的差价，弹窗要把「原价/折抵/实付」摊开，否则用户会以为退多了。**退款金额
 *   本身永远是 amount（实付全额）**，这两个字段只用于展示。
 * - refundable 与 reasonCode 与 POST /refund 的属主分支同源（同一个
 *   evaluateSelfRefund），所以列表说可退就一定退得动、说不可退的理由就是实际拒绝理由。
 * - enable_subscription 关闭时 503 SUBSCRIPTION_DISABLED（与收款/退款端点同口径）。
 */
router.get('/refundable-orders', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!(await isFlagEnabled('enable_subscription'))) {
      logger.warn('[payments] refundable-orders blocked: enable_subscription disabled', { userId });
      return subscriptionDisabled(res);
    }

    const [orders, anchorOrderId, settings] = await Promise.all([
      listRefundCandidateOrders(userId, REFUNDABLE_ORDERS_LIMIT),
      findSelfRefundAnchorOrderId(userId),
      getRefundSettings(),
    ]);
    // 在途申请一次批量取（列表最多 10 条），避免逐条查库
    const pending = await findPendingRequestsByOrderIds(
      userId,
      orders.map((o) => String(o.id))
    );

    const now = new Date();
    res.json({
      orders: orders.map((order) => {
        const amount = roundToCent(order.amount);
        const proration = order.metadata && typeof order.metadata === 'object' ? order.metadata.proration : null;
        const originalAmount = toFiniteAmount(proration?.originalPrice, amount);
        const creditAmount = toFiniteAmount(proration?.creditAmount, 0);
        const pendingRequest = pending.get(String(order.id)) || null;
        // 有在途申请时不再走可退判定：那一条已经在审核队列里，重复申请没有意义
        const verdict = pendingRequest
          ? { refundable: false, reasonCode: REFUND_REASON_CODES.REFUND_REQUEST_PENDING }
          : evaluateSelfRefund({ order, anchorOrderId, windowDays: settings.windowDays, now });
        const paidAt = order.paid_at ? new Date(order.paid_at) : null;

        return {
          orderId: String(order.id),
          orderNo: order.order_no ?? null,
          amount,
          originalAmount,
          creditAmount,
          currency: order.currency || 'CNY',
          paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt.toISOString() : null,
          status: order.status,
          refundable: verdict.refundable,
          reasonCode: verdict.reasonCode,
          refundRequest: pendingRequest
            ? {
                id: String(pendingRequest.id),
                status: pendingRequest.status,
                requestedAt: pendingRequest.requested_at
                  ? new Date(pendingRequest.requested_at).toISOString()
                  : null,
              }
            : null,
        };
      }),
      // 时限与审核工作日都由后台配置驱动，客户端不得再写死数字
      windowDays: settings.windowDays,
      reviewBusinessDays: settings.reviewBusinessDays,
    });
  } catch (err) {
    logger.error('Get refundable orders error:', err);
    res.status(500).json({ error: 'Failed to list refundable orders' });
  }
});

/**
 * POST /api/payments/refund-request —— 提交退款申请（两段式退款的第一段）
 *
 * 与旧的 POST /refund 的本质区别：**这里完全不碰支付宝**。落一条 pending 申请单，
 * 并立即收回该订阅的权益（订阅 canceled、users 按剩余生效订阅重算），
 * 真打款发生在管理员审核通过那一刻（routes/admin/refundReviews.js）。
 *
 * 风控闸与列表同源（services/refundPolicy.js#evaluateSelfRefund）：
 * 必须是「当前生效订阅的最近一笔已付单」+ 在后台可配的时限内 + 支付宝渠道。
 * 申请阶段不发生资金动作，所以**任何**不可退理由都在这里直接 409。
 *
 * 错误壳沿用 /refund 的 { error, code, ...extra }。
 */
router.post('/refund-request', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { orderId, orderNo, reason } = req.body || {};
    const key = String(orderId || orderNo || '').trim();

    if (!key) {
      return res.status(400).json({ error: 'Missing orderId or orderNo parameter' });
    }
    if (!(await isFlagEnabled('enable_subscription'))) {
      logger.warn('[payments] refund-request blocked: enable_subscription disabled', { userId });
      return subscriptionDisabled(res);
    }

    const result = await createSelfRefundRequest({
      userId,
      orderKey: key,
      reason,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    logger.info('[payments] refund request submitted', {
      userId,
      requestId: result.request.id,
      orderNo: result.request.orderNo,
    });
    return res.status(201).json({
      message: 'Refund request submitted for review',
      request: result.request,
      entitlement: result.entitlement,
      reviewBusinessDays: result.reviewBusinessDays,
    });
  } catch (err) {
    if (err instanceof RefundError) {
      return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    }
    logger.error('Refund request error:', err);
    res.status(500).json({ error: 'Failed to submit refund request' });
  }
});

/**
 * GET /api/payments/refund-requests/mine —— 我的退款申请（最近 5 条）
 *
 * 个人资料页要在不开弹窗的情况下也能显示「退款审核中」，所以单独给一条轻量列表。
 * 只查自己的（user_id 条件），无越权面。
 */
router.get('/refund-requests/mine', authenticateToken, async (req, res) => {
  try {
    const requests = await listMyRefundRequests(req.user.userId, 5);
    res.json({ requests });
  } catch (err) {
    logger.error('Get refund requests error:', err);
    res.status(500).json({ error: 'Failed to list refund requests' });
  }
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
