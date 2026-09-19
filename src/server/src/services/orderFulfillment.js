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
 * 将订单标记为已支付，并完成订阅开通与发票开具。
 *
 * @param {object} params
 * @param {string} params.orderNo        商户订单号（payment_orders.order_no）
 * @param {string} [params.transactionId] 渠道交易号（支付宝 trade_no）
 * @param {string} [params.channel]      渠道标识（alipay / wechat / stripe）
 * @param {object} [params.rawPayload]   渠道原始报文摘要（留痕，勿存敏感字段）
 * @returns {Promise<{ok:boolean, changed:boolean, reason?:string, order?:object}>}
 */
export async function markOrderPaid({ orderNo, transactionId = null, channel = null, rawPayload = null }) {
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
    //  ① 升级场景：订单已关联一条 user_subscriptions（建单时写入），直接置 active
    //  ② 新订阅场景：建单时用户还没有订阅记录，需按 metadata 里的 planId/billingCycle 创建
    let activatedSubscriptionId = null;
    let planIdForUser = null;

    if (order.subscription_id) {
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
    } else if (order.metadata?.planId) {
      const cycle = order.metadata.billingCycle === 'yearly' ? 'year' : 'month';
      // 同套餐已有 active 订阅时是「续费」而非「新订」：延长周期，绝不插第二行
      // （2026-09-19 联调实测：用户重复付款曾开出两条重叠的 active 订阅）。
      const existing = await client.query(
        `SELECT id FROM user_subscriptions
          WHERE user_id = $1 AND plan_id = $2 AND status = 'active'
          ORDER BY current_period_end DESC
          LIMIT 1`,
        [order.user_id, order.metadata.planId]
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
        if (extended.rows.length > 0) {
          activatedSubscriptionId = extended.rows[0].id;
          planIdForUser = extended.rows[0].plan_id;
        }
      } else {
        const created = await client.query(
          `INSERT INTO user_subscriptions
             (user_id, plan_id, status, start_date, end_date,
              current_period_start, current_period_end, billing_cycle)
           VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '1 ${cycle}',
                   NOW(), NOW() + INTERVAL '1 ${cycle}', $3)
           RETURNING id, plan_id`,
          [order.user_id, order.metadata.planId, order.metadata.billingCycle || 'monthly']
        );
        if (created.rows.length > 0) {
          activatedSubscriptionId = created.rows[0].id;
          planIdForUser = created.rows[0].plan_id;
        }
      }

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
      order: { ...order, status: 'paid', invoiceNo, subscriptionId: activatedSubscriptionId },
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
