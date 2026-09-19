import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';

/**
 * 订单履约（支付成功后的唯一落库入口）。
 *
 * 为什么单独抽一个服务：
 * 支付成功有**两条**到达路径 —— ① 渠道异步回调（notify_url）② 客户端轮询
 * `GET /api/payments/order/:orderNo/status`。两条路径都可能先到，也可能重复到达
 * （支付宝回调会重试多次），必须共用同一段**幂等**逻辑，否则会出现
 * 「回调晚到把轮询已经开好的订阅又开一遍」或「用户付了钱订阅没开」。
 *
 * 幂等策略：以 payment_orders.status 作为唯一裁判。
 *   已是 paid  → 直接返回 {changed:false}，不重复开通订阅、不重复开发票。
 *   pending   → 置 paid + 开订阅 + 开发票 + 写审计。
 *
 * 调用方不要自己 UPDATE 订单状态，一律走这里。
 */

/** 已支付终态；refunded 也视为已履约（退款是后续动作，不回头改订阅）。 */
const PAID_STATES = new Set(['paid', 'refunded']);

/**
 * 按套餐激活/新建订阅（**必须在事务内调用**，第一参数是 client 不是 pool）。
 *
 * 不变量：同一用户、同一套餐最多只有一条 active 订阅。
 * 已有 active 记录 → 顺延一个周期（续费，含升级单被重复支付的兜底）；
 * 没有 → 新建一条，周期从 NOW() 起完整一个 billingCycle。
 * （2026-09-19 联调实测：用户重复付款曾开出两条重叠的 active 订阅。）
 *
 * @returns {Promise<{id:string, plan_id:string}|null>}
 */
async function activatePlanSubscription(client, { userId, planId, billingCycle }) {
  const yearly = billingCycle === 'yearly';
  const cycle = yearly ? 'year' : 'month';

  const existing = await client.query(
    `SELECT id FROM user_subscriptions
      WHERE user_id = $1 AND plan_id = $2 AND status = 'active'
      ORDER BY current_period_end DESC
      LIMIT 1`,
    [userId, planId]
  );

  if (existing.rows.length > 0) {
    const extended = await client.query(
      `UPDATE user_subscriptions
          SET current_period_end = GREATEST(current_period_end, NOW()) + INTERVAL '1 ${cycle}',
              end_date = GREATEST(end_date, NOW()) + INTERVAL '1 ${cycle}',
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, plan_id`,
      [existing.rows[0].id]
    );
    return extended.rows[0] || null;
  }

  const created = await client.query(
    `INSERT INTO user_subscriptions
       (user_id, plan_id, status, start_date, end_date,
        current_period_start, current_period_end, billing_cycle)
     VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '1 ${cycle}',
             NOW(), NOW() + INTERVAL '1 ${cycle}', $3)
     RETURNING id, plan_id`,
    [userId, planId, yearly ? 'yearly' : 'monthly']
  );
  return created.rows[0] || null;
}

/**
 * 将订单标记为已支付，并完成订阅开通与发票开具。
 *
 * @param {object} params
 * @param {string} params.orderNo        商户订单号（payment_orders.order_no）
 * @param {string} [params.transactionId] 渠道交易号（支付宝 trade_no）
 * @param {string} [params.channel]      渠道标识（alipay / wechat / stripe）
 * @param {object} [params.rawPayload]   渠道原始报文摘要（留痕，勿存敏感字段）
 * @param {number|string} [params.expectedAmount] 渠道侧金额（回调 total_amount /
 *        查询返回金额）。提供时与订单金额比对，不符**拒绝履约**（S1：
 *        支付宝官方要求接收方校验 total_amount，防低价单被冒用类攻击）。
 * @returns {Promise<{ok:boolean, changed:boolean, reason?:string, order?:object}>}
 */
export async function markOrderPaid({ orderNo, transactionId = null, channel = null, rawPayload = null, expectedAmount = null }) {
  if (!orderNo) {
    return { ok: false, changed: false, reason: 'missing_order_no' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 行级锁：并发回调/轮询同时到达时，只有一个事务能拿到这一行
    const { rows } = await client.query(
      `SELECT id, user_id, subscription_id, amount, status, metadata
         FROM payment_orders
        WHERE order_no = $1
        FOR UPDATE`,
      [orderNo]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      logger.warn('[fulfillment] order not found', { orderNo, channel });
      return { ok: false, changed: false, reason: 'order_not_found' };
    }

    const order = rows[0];

    // 幂等：已履约则直接返回，不重复开订阅/开发票
    if (PAID_STATES.has(order.status)) {
      await client.query('COMMIT');
      logger.info('[fulfillment] already paid, skipped', { orderNo, status: order.status });
      return { ok: true, changed: false, reason: 'already_paid', order };
    }

    // 已取消/失败的订单不接受支付（例如超时自动关单后才到账，需人工介入退款）
    if (order.status === 'cancelled' || order.status === 'failed') {
      await client.query('ROLLBACK');
      logger.error('[fulfillment] payment arrived for non-payable order', {
        orderNo,
        status: order.status,
        channel,
      });
      return { ok: false, changed: false, reason: `order_${order.status}`, order };
    }

    // S1：渠道金额与订单金额必须一致（分级容差 0.005 元覆盖浮点表示误差）。
    // 不符时不履约、返回 failure 让渠道重试并留错误日志，转人工排查。
    if (expectedAmount != null && expectedAmount !== '') {
      const channelAmt = Number(expectedAmount);
      const orderAmt = Number(order.amount);
      if (!Number.isFinite(channelAmt) || !Number.isFinite(orderAmt) || Math.abs(channelAmt - orderAmt) > 0.005) {
        await client.query('ROLLBACK');
        logger.error('[fulfillment] amount mismatch, refusing fulfillment', {
          orderNo,
          orderAmount: order.amount,
          channelAmount: expectedAmount,
          channel,
        });
        return { ok: false, changed: false, reason: 'amount_mismatch', order };
      }
    }

    await client.query(
      `UPDATE payment_orders
          SET status = 'paid',
              paid_at = NOW(),
              updated_at = NOW(),
              transaction_id = COALESCE($2, transaction_id),
              payment_channel = COALESCE($3, payment_channel),
              metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE($4::jsonb, '{}'::jsonb)
        WHERE id = $1`,
      [
        order.id,
        transactionId,
        channel,
        rawPayload ? JSON.stringify({ fulfillment: rawPayload }) : null,
      ]
    );

    // 开通订阅
    //  ① 升级单：订单目标是**更高档位的新套餐**（下单侧已按残值折抵，见 services/proration.js）。
    //     处理 = 为新套餐新建 active 订阅（周期从 NOW() 起完整一个 billingCycle）
    //          + 把旧订阅立即终止。
    //     为什么旧订阅要立即终止：残值已经把旧订阅剩余天数的钱折进本单了，
    //     旧周期若继续挂着等于「一次折抵、两段权益」。
    //     为什么写 canceled 而不是 superseded：user_subscriptions 的 status CHECK 约束
    //     （迁移 048）不含 superseded，为「被升级取代」这一种来源去放宽约束不划算；
    //     canceled 已是终止态、与退订/退款同口径，下游读侧一律按 status='active' 过滤，
    //     取代来源另外记在 metadata.proration.oldSubscriptionId 与审计日志里，可追溯。
    //  ② 续费/直接激活：订单已挂 user_subscriptions（建单时写入），置 active
    //  ③ 新订阅：建单时用户还没有订阅记录，按 metadata.planId/billingCycle 创建
    let activatedSubscriptionId = null;
    let planIdForUser = null;
    let supersededSubscriptionId = null;

    const targetPlanId = order.metadata?.planId || null;
    const declaredOldSubscriptionId = order.metadata?.proration?.oldSubscriptionId || null;

    // 订单所挂订阅的套餐：用于识别 /subscriptions/subscribe 那种
    // 「subscription_id 指向旧订阅 + metadata.planId 指向新套餐」的升级单
    let linkedPlanId = null;
    if (order.subscription_id) {
      const linked = await client.query(
        'SELECT plan_id FROM user_subscriptions WHERE id = $1',
        [order.subscription_id]
      );
      linkedPlanId = linked.rows[0]?.plan_id || null;
    }

    const isUpgradeOrder = Boolean(
      targetPlanId && (declaredOldSubscriptionId || (linkedPlanId && linkedPlanId !== targetPlanId))
    );

    if (isUpgradeOrder) {
      // 旧订阅：优先取下单时锁定的那条（metadata），退化用订单所挂订阅
      supersededSubscriptionId = declaredOldSubscriptionId || order.subscription_id;
      if (supersededSubscriptionId) {
        await client.query(
          `UPDATE user_subscriptions
              SET status = 'canceled',
                  canceled_at = NOW(),
                  auto_renew = false,
                  updated_at = NOW()
            WHERE id = $1
              AND status IN ('active', 'trial', 'past_due')`,
          [supersededSubscriptionId]
        );
      }

      const activated = await activatePlanSubscription(client, {
        userId: order.user_id,
        planId: targetPlanId,
        billingCycle: order.metadata.billingCycle,
      });
      activatedSubscriptionId = activated?.id || null;
      planIdForUser = activated?.plan_id || null;

      if (activatedSubscriptionId) {
        await client.query('UPDATE payment_orders SET subscription_id = $1 WHERE id = $2', [
          activatedSubscriptionId,
          order.id,
        ]);
      }
    } else if (order.subscription_id) {
      const subRes = await client.query(
        `UPDATE user_subscriptions
            SET status = 'active', updated_at = NOW()
          WHERE id = $1
      RETURNING id, user_id, plan_id`,
        [order.subscription_id]
      );
      if (subRes.rows.length > 0) {
        activatedSubscriptionId = subRes.rows[0].id;
        planIdForUser = subRes.rows[0].plan_id;
      }
    } else if (targetPlanId) {
      const activated = await activatePlanSubscription(client, {
        userId: order.user_id,
        planId: targetPlanId,
        billingCycle: order.metadata.billingCycle,
      });
      activatedSubscriptionId = activated?.id || null;
      planIdForUser = activated?.plan_id || null;

      if (activatedSubscriptionId) {
        // 回填订单的 subscription_id，便于后续对账/退款定位
        await client.query('UPDATE payment_orders SET subscription_id = $1 WHERE id = $2', [
          activatedSubscriptionId,
          order.id,
        ]);
      }
    }

    // 同步 users 上的冗余订阅状态（桌面端配额判定读这里）
    if (activatedSubscriptionId && planIdForUser) {
      const planRes = await client.query('SELECT name FROM subscription_plans WHERE id = $1', [
        planIdForUser,
      ]);
      if (planRes.rows.length > 0) {
        await client.query(
          `UPDATE users
              SET subscription_status = $1, current_subscription_id = $2
            WHERE id = $3`,
          [planRes.rows[0].name.toLowerCase(), activatedSubscriptionId, order.user_id]
        );
      }
    }

    // 开发票（invoice_no 唯一，冲突说明已开过，忽略）
    let invoiceNo = null;
    try {
      const invRes = await client.query(
        `INSERT INTO invoices (user_id, subscription_id, payment_order_id, invoice_no, amount, tax_amount, status)
         VALUES ($1, $2, $3, $4, $5, 0, 'issued')
         ON CONFLICT (invoice_no) DO NOTHING
         RETURNING invoice_no`,
        [
          order.user_id,
          order.subscription_id,
          order.id,
          `INV${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          order.amount,
        ]
      );
      invoiceNo = invRes.rows[0]?.invoice_no ?? null;
    } catch (invErr) {
      // 发票失败不能回滚支付本身（钱已到账，订阅必须开通）
      logger.error('[fulfillment] invoice creation failed (payment kept)', {
        orderNo,
        error: invErr.message,
      });
    }

    await client.query('COMMIT');

    logger.info('[fulfillment] order paid & fulfilled', {
      orderNo,
      channel,
      transactionId,
      subscriptionId: activatedSubscriptionId,
      supersededSubscriptionId,
      invoiceNo,
    });

    // 审计在事务外做（失败不影响履约，与既有审计风格一致）
    await logAuditEvent({
      userId: order.user_id,
      action: AUDIT_ACTIONS.PAYMENT_COMPLETE,
      resourceType: 'payment_order',
      resourceId: String(order.id),
      details: { orderNo, amount: order.amount, channel, transactionId, invoiceNo },
    }).catch((err) => logger.error('[fulfillment] audit failed', { orderNo, error: err.message }));

    return {
      ok: true,
      changed: true,
      order: {
        ...order,
        status: 'paid',
        invoiceNo,
        subscriptionId: activatedSubscriptionId,
        supersededSubscriptionId,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('[fulfillment] markOrderPaid failed', { orderNo, error: err.message });
    return { ok: false, changed: false, reason: 'internal_error' };
  } finally {
    client.release();
  }
}

export default { markOrderPaid };
