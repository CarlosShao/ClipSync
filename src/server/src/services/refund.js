// =============================================
// 退款服务（§4-A1 修复：真实退款逻辑的唯一实现）
//
// 为什么抽到这里：
//   「退款」曾经有两套语义相反的实现 ——
//     ① routes/payments.js 的 POST /api/payments/refund：**真打款**
//        （alipay.trade.refund，只有渠道回 fund_status='Y' 才落库）；
//     ② routes/admin/orders.js 的 POST /api/admin/orders/:orderNo/refund：
//        **记账式假退款**（只把订单改成 refunded、不调渠道）。
//   ② 的存在等于「用户在管理台被退款、钱却没退、订单却显示已退款」——
//   正是 2026-09-19 用户侧被 501 阻断的那起事故在管理侧的复现。
//   现在两个端点都只保留**权限判定 + 响应形状**，资金动作全部走本文件。
//
// 调用方（本文件不做任何权限/风控判定，谁调都一样退得动）：
//   ① POST /api/payments/refund —— 订单**属主自助**退款（带风控闸，见
//      services/refundPolicy.js）与管理员客服通道，产品决策 2026-09-19 变更；
//   ② POST /api/admin/orders/:orderNo/refund —— 管理台 RBAC，不受自助风控闸限制。
//
// 顺序即安全性（不可调换）：
//   定位订单 → 状态/渠道/凭据校验 → 渠道 refundTrade（全额） →
//   渠道确认成功才进事务：行锁复核 → 订单 refunded + refunded_at →
//   订阅 canceled + canceled_at（退款即收回权益）→ users 冗余状态回 free → 审计。
//   渠道失败/未知 → 本地一字不动，抛 502 RefundError。
//   （渠道成功判定口径见 utils/alipay.js#refundTrade：现行接口 code=10000 即成功态，
//    幂等重放 fund_change='N' 不算失败；旧版 fund_status 非 'Y' 仍拒。）
//
// 关于「行锁」的位置：渠道打款是网络调用，若在调用前 FOR UPDATE 就会把行锁
// 横跨一次外部 HTTP（并发退款会互相排队、锁等待还可能超时后留下「钱退了库没改」）。
// 因此复核锁放在**渠道成功之后、落库之前**：先无锁读做前置校验，
// 落库时在事务里重新加锁复核 status='paid'，两个并发退款只有一个生效，
// 另一个 409 REFUND_STATE_CONFLICT（渠道侧另有 out_request_no 幂等兜底）。
//
// 错误契约：一律抛 RefundError{ status, code, message, extra }，由调用方路由
// 翻成各自的响应壳（payments 用 { error, code }，admin 用 { code:number, message }）——
// 两套前端的错误约定不同，但**资金语义完全一致**。
//
// 本期刻意不做（两处调用方都不支持部分退款）：
//   部分退款/同一订单多次退款需要 body 带 amount、out_request_no 换成
//   `${order_no}-${次序号}`（渠道要求每次不同）、metadata.refunded_items 累计，
//   只有全额退完才置 refunded。届时改本文件即可，两个端点无需重复实现。
// =============================================

import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';
import { refundTrade, isAlipayConfigured } from '../utils/alipay.js';
import { roundToCent } from './proration.js';

// orderId 是 UUID 主键、orderNo 是业务单号：按形状分流，保证两条查询都走索引
// （写成 `id::text = $1` 会让主键退化成全表扫描，且非 UUID 入参会直接抛错）
//
// 这个形状判别 + 定位查询是「哪一笔订单被退」的**唯一裁判**，属主自助退款路由
// （routes/payments.js 的 /refund、/refundable-orders）也要靠它先取到订单再判权限。
// 因此下面 export 了 UUID_ORDER_ID_RE / locateOrder：路由侧一律复用，
// **不要再抄一份正则**（两份正则一旦漂移，就会出现「路由认为是单号、服务认为是主键」
// 这种定位错位 —— 那是会退错订单的 bug，不是风格问题）。
export const UUID_ORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 退款资金动作所需的订单列（refundPaidOrder 的取数口径）。
 * 调用方需要别的列时用 locateOrder 的 columns 参数显式声明（白名单常量，
 * 绝不接受请求体里的字符串 —— 那是 SQL 注入面）。
 */
export const REFUND_ORDER_COLUMNS = `id, user_id, subscription_id, order_no, amount, currency,
       payment_method, payment_channel, status, transaction_id`;

/** key 命中 UUID 形状 → 按主键定位，否则按业务单号定位 */
export function orderKeyColumn(key) {
  return UUID_ORDER_ID_RE.test(String(key ?? '').trim()) ? 'id' : 'order_no';
}

/**
 * 按 orderId（UUID 主键）或 orderNo（业务单号）定位一条订单。
 *
 * @param {string} key      两种键都给同一个参数即可，形状自动分流
 * @param {string} [columns] 取哪些列，必须是本文件/调用方硬编码的常量
 * @returns {Promise<object|null>} 找到返回行，找不到返回 null（不抛错，
 *          由调用方决定错误码 —— 属主自助退款要把「不存在」和「不是你的单」
 *          统一成 404 以免被探测订单是否存在）
 */
export async function locateOrder(key, columns = REFUND_ORDER_COLUMNS) {
  const trimmed = String(key ?? '').trim();
  if (!trimmed) return null;
  const { rows } = await pool.query(
    `SELECT ${columns}
       FROM payment_orders
      WHERE ${orderKeyColumn(trimmed)} = $1
      LIMIT 1`,
    [trimmed]
  );
  return rows[0] || null;
}

/**
 * 退款领域错误。`status` 是建议的 HTTP 状态码，`code` 是机器可读错误码，
 * `extra` 是要一并回给调用方的字段（channelError / orderNo / status 等）。
 */
export class RefundError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'RefundError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * 对**已支付**订单执行真实全额退款。
 *
 * @param {object} p
 * @param {string} [p.orderId]  payment_orders.id（UUID）或 order_no（按形状自动判别）
 * @param {string} [p.orderNo]  业务单号；与 orderId 等价，二者给一个即可
 * @param {string} p.actorUserId 操作者用户 id（管理员客服退款时是管理员；属主自助退款时
 *        就是订单属主本人）—— 权限与风控由**调用方路由**判定，本服务不做任何权限校验
 *        （payments 用 users.is_admin + 属主判定，admin 用 RBAC requirePerm）
 * @param {string} [p.reason]   退款原因（必填语义由调用方校验；此处兜底默认值并截 200 字）
 * @param {string} [p.ip]        审计用 IP
 * @param {string} [p.userAgent] 审计用 UA
 * @returns {Promise<{
 *   ok: true,
 *   order: { id, orderNo, amount, refundAmount, currency, status:'refunded', refundedAt },
 *   entitlement: { subscriptionId: string|null, subscriptionCanceled: boolean },
 *   channel: { name:'alipay', fund_status, trade_no, out_request_no },
 * }>}
 * @throws {RefundError} 404/400/409/502/503/500，见下方各抛点的 code
 */
export async function refundPaidOrder({ orderId, orderNo, actorUserId, reason, ip, userAgent } = {}) {
  const key = String(orderId ?? orderNo ?? '').trim();
  if (!key) {
    throw new RefundError(400, 'MISSING_ORDER_KEY', 'Missing orderId or orderNo parameter');
  }
  const refundReason = String(reason || '管理员退款').slice(0, 200);

  const order = await locateOrder(key);
  if (!order) {
    throw new RefundError(404, 'ORDER_NOT_FOUND', 'Order not found', { orderNo: key });
  }

  if (order.status === 'refunded') {
    throw new RefundError(409, 'ALREADY_REFUNDED', 'Order already refunded', {
      orderNo: order.order_no,
    });
  }
  if (order.status !== 'paid') {
    throw new RefundError(400, 'ORDER_NOT_REFUNDABLE', 'Order is not paid, cannot refund', {
      orderNo: order.order_no,
      status: order.status,
    });
  }
  const channel = String(order.payment_channel || order.payment_method || '').toLowerCase();
  if (channel !== 'alipay') {
    throw new RefundError(
      400,
      'REFUND_CHANNEL_UNSUPPORTED',
      `Channel ${channel || 'unknown'} cannot be refunded online, please refund out-of-band`,
      { orderNo: order.order_no, channel: channel || 'unknown' }
    );
  }
  if (!isAlipayConfigured()) {
    logger.error('[refund] requested but alipay channel not configured', { orderNo: order.order_no });
    throw new RefundError(503, 'ALIPAY_NOT_CONFIGURED', 'Payment channel not configured', {
      orderNo: order.order_no,
    });
  }

  // 一期只全额退款；幂等键固定用订单号（换请求号即可支持多次/部分退款）
  const refundAmount = roundToCent(order.amount);

  const auditFailure = async (summary) => {
    await logAuditEvent({
      userId: actorUserId,
      action: AUDIT_ACTIONS.PAYMENT_REFUND,
      resourceType: 'payment_order',
      resourceId: String(order.id),
      details: {
        orderNo: order.order_no,
        amount: refundAmount,
        reason: refundReason,
        targetUserId: order.user_id,
        ...summary,
      },
      status: 'failure',
      errorMessage: summary.message,
      ipAddress: ip,
      userAgent,
    }).catch((e) => logger.error('[refund] audit failed', { error: e.message }));
  };

  let refund;
  try {
    refund = await refundTrade({
      outTradeNo: order.order_no,
      refundAmount,
      outRequestNo: order.order_no,
    });
  } catch (err) {
    // 渠道业务失败（code !== 10000）/ 验签失败 / 网络异常：订单保持 paid，钱没动
    logger.error('[refund] alipay refund call failed', {
      orderNo: order.order_no,
      actorUserId,
      code: err.code,
      subCode: err.subCode,
      error: err.message,
    });
    await auditFailure({
      stage: 'channel_call',
      code: err.code || null,
      subCode: err.subCode || null,
      message: err.message,
    });
    throw new RefundError(502, 'REFUND_CHANNEL_FAILED', 'Refund failed at payment channel', {
      orderNo: order.order_no,
      channelError: { code: err.code || null, subCode: err.subCode || null, message: err.message },
    });
  }

  if (!refund.ok) {
    // 仅旧版渠道会走到这里（fund_status='C' 失败 / 'D' 未知）：同样不得改本地状态
    logger.error('[refund] alipay refund not confirmed', {
      orderNo: order.order_no,
      fundStatus: refund.fundStatus,
      actorUserId,
    });
    await auditFailure({
      stage: 'channel_status',
      code: refund.code,
      message: `fund_status=${refund.fundStatus}`,
    });
    throw new RefundError(
      502,
      'REFUND_NOT_CONFIRMED',
      'Refund not confirmed by payment channel',
      {
        orderNo: order.order_no,
        channelError: { code: refund.code, fund_status: refund.fundStatus },
      }
    );
  }

  const refundedAt = new Date();
  const refundMeta = {
    // refund_amount 与 admin-console 的订单退款口径对齐（有值=已退款，无值=处理中）
    refund_amount: refundAmount,
    refund_reason: refundReason,
    refund_by: actorUserId ?? null,
    refunded_at: refundedAt.toISOString(),
    alipay_refund: {
      fund_status: refund.fundStatus,
      code: refund.code,
      trade_no: refund.tradeNo,
      out_request_no: refund.requestId,
      refund_amount: refund.refundAmount,
    },
  };

  const client = await pool.connect();
  let canceledSubscriptionId = null;
  try {
    await client.query('BEGIN');

    // 行级锁 + 复核：渠道打款有耗时，期间并发进来的另一次退款只能有一个生效
    const locked = await client.query(
      'SELECT id, status, subscription_id FROM payment_orders WHERE id = $1 FOR UPDATE',
      [order.id]
    );
    const row = locked.rows[0];
    if (!row || row.status !== 'paid') {
      await client.query('ROLLBACK');
      logger.warn('[refund] skipped: order state changed concurrently', {
        orderNo: order.order_no,
        status: row?.status,
      });
      throw new RefundError(
        409,
        'REFUND_STATE_CONFLICT',
        'Order state changed, refund not applied locally. Please re-check the order.',
        { orderNo: order.order_no }
      );
    }

    await client.query(
      `UPDATE payment_orders
          SET status = 'refunded',
              refunded_at = $2,
              metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [order.id, refundedAt, JSON.stringify(refundMeta)]
    );

    const targetSubscriptionId = row.subscription_id || order.subscription_id;
    if (targetSubscriptionId) {
      const canceled = await client.query(
        `UPDATE user_subscriptions
            SET status = 'canceled',
                canceled_at = $2,
                auto_renew = false,
                updated_at = NOW()
          WHERE id = $1 AND status <> 'canceled'
          RETURNING id`,
        [targetSubscriptionId, refundedAt]
      );
      canceledSubscriptionId = canceled.rows[0]?.id || null;
    }

    // 退款即收回权益：users 上的冗余订阅状态同步回 free（配额判定读这里）
    await client.query(
      `UPDATE users
          SET subscription_status = 'free', current_subscription_id = NULL
        WHERE id = $1`,
      [order.user_id]
    );

    await client.query('COMMIT');
  } catch (dbErr) {
    await client.query('ROLLBACK').catch(() => {});
    // ⚠️ 走到这里说明**钱已经退出去了但本地状态没落**，必须人工补账
    if (dbErr instanceof RefundError) throw dbErr;
    logger.error('[refund] CRITICAL: refund succeeded at channel but local update failed', {
      orderNo: order.order_no,
      refundAmount,
      alipayTradeNo: refund.tradeNo,
      error: dbErr.message,
    });
    await auditFailure({
      stage: 'local_update',
      message: `refund paid at channel but DB update failed: ${dbErr.message}`,
      out_request_no: refund.requestId,
    });
    throw new RefundError(
      500,
      'REFUND_LOCAL_UPDATE_FAILED',
      'Refund succeeded at payment channel but failed to update local records. Please contact support.',
      {
        orderNo: order.order_no,
        channelRefund: { fund_status: refund.fundStatus, out_request_no: refund.requestId },
      }
    );
  } finally {
    client.release();
  }

  logger.info('[refund] completed', {
    orderNo: order.order_no,
    refundAmount,
    actorUserId,
    canceledSubscriptionId,
  });

  await logAuditEvent({
    userId: actorUserId,
    action: AUDIT_ACTIONS.PAYMENT_REFUND,
    resourceType: 'payment_order',
    resourceId: String(order.id),
    details: {
      orderNo: order.order_no,
      amount: refundAmount,
      reason: refundReason,
      targetUserId: order.user_id,
      canceledSubscriptionId,
      out_request_no: refund.requestId,
      fund_status: refund.fundStatus,
    },
    ipAddress: ip,
    userAgent,
  }).catch((e) => logger.error('[refund] audit failed', { error: e.message }));

  return {
    ok: true,
    order: {
      id: order.id,
      orderNo: order.order_no,
      amount: parseFloat(order.amount),
      refundAmount,
      currency: order.currency,
      status: 'refunded',
      refundedAt: refundedAt.toISOString(),
    },
    entitlement: {
      subscriptionId: canceledSubscriptionId,
      subscriptionCanceled: Boolean(canceledSubscriptionId),
    },
    channel: {
      name: 'alipay',
      fund_status: refund.fundStatus,
      trade_no: refund.tradeNo,
      out_request_no: refund.requestId,
    },
  };
}

export default { refundPaidOrder, RefundError };
