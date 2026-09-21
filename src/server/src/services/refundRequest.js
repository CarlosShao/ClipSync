// =============================================
// 两段式退款：用户申请（不动钱）→ 管理员审核（才动钱）
//
// 为什么必须有这一层（产品决策 2026-09-20）：
//   支付宝 alipay.trade.refund 是**同步且不可撤销**的 —— 调用成功的那一刻钱就
//   原路退回买家了，事后无法「拒绝」。所以「审核」只能放在**调用之前**：
//     ① 用户点申请 → 本文件 createSelfRefundRequest：只落 refund_requests 一条
//        pending + **立即收回权益**，绝不碰渠道；
//     ② 管理员点通过 → approveRefundRequest：CAS 认领成 processing，然后才调
//        services/refund.js#refundPaidOrder 真打款；
//     ③ 管理员点驳回 → rejectRefundRequest：按申请时存的权益快照还原。
//
// 为什么申请时就把权益收回：
//   否则用户可以「一边等退款一边用 Pro」，审核周期越长白嫖越多。收回之后
//   用户在途期间没有任何权益可消耗。代价（老板明确认下）：审核期间用掉的天数
//   不退，因为产品没有可量化的配额，无法折算残值 —— 损失由「时限」封顶，
//   时限见 services/refundPolicy.js#getRefundSettings（后台可配，默认 7 天）。
//
// 为什么订单状态一路保持 paid：
//   payment_orders.status 的 refunded 是**对账不变量**，只能表示「款已退出去」。
//   申请阶段钱没动，所以状态不动；在途与否由 refund_requests 的部分唯一索引
//   (order_id WHERE status='pending') 说话。这样发票、看板、自动关单 sweep 等
//   所有按 status 过滤的既有代码一行都不用改，也不会出现「显示已退款但钱没退」
//   —— 那正是 §4-A1 修掉的记账式假退款事故。
//
// 为什么需要 processing 这个中间态：
//   渠道调用是外部 HTTP，不能横跨事务持行锁（并发审核会排队、锁超时还会留下
//   「钱退了库没改」）。用 `UPDATE ... WHERE status='pending'` 的 CAS 先把单子
//   抢成 processing 再打款：既不跨网络持锁，又能让人一眼看出「这条卡在渠道调用上，
//   先查支付宝再决定重试」，而不是静默地重复打款。
//
// 错误契约沿用 services/refund.js 的 RefundError{status, code, message, extra}，
// 由调用方路由翻成各自前端的响应壳。
// =============================================

import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';
import { roundToCent } from './proration.js';
import { RefundError, refundPaidOrder, locateOrder } from './refund.js';
import {
  SELF_REFUND_ORDER_COLUMNS,
  REFUND_REASON_CODES,
  evaluateSelfRefund,
  findSelfRefundAnchorOrderId,
  getRefundSettings,
} from './refundPolicy.js';

const USER_AGENT_MAX = 300;

/** 对外返回的申请单形状（列名映射集中一处，路由不再各写各的） */
function toDto(row) {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    orderNo: row.order_no,
    amount: parseFloat(row.amount),
    currency: row.currency || 'CNY',
    status: row.status,
    windowDaysAtRequest: row.window_days_at_request,
    userReason: row.user_reason ?? null,
    requestedAt: row.requested_at ? new Date(row.requested_at).toISOString() : null,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
    reviewedByName: row.reviewed_by_name ?? null,
    reviewNote: row.review_note ?? null,
  };
}

const REQUEST_COLUMNS = `id, user_id, order_id, order_no, amount, currency, status,
       window_days_at_request, user_reason, requested_at, reviewed_at, reviewed_by, review_note`;

/**
 * 重算 users 上的冗余订阅状态（配额判定读这里）。
 *
 * 为什么单独一个函数：申请收回权益、驳回还原权益、审核通过打款三条路径都会改变
 * 「这个用户还剩哪些生效订阅」，而 refundPaidOrder 是无条件把 users 写成 free 的 ——
 * 用户如果在审核期间又买了新套餐，直接沿用会让 TA 付了钱却掉回免费版。
 * 所以凡是动过订阅的路径，收尾都以「当前生效订阅」为唯一真相重算一次。
 *
 * @param {{query: Function}} client 事务内客户端（与调用方同事务，避免读到中间态）
 * @param {string} userId
 * @returns {Promise<{subscriptionStatus: string, currentSubscriptionId: string|null}>}
 */
export async function recomputeUserEntitlement(client, userId) {
  const { rows } = await client.query(
    `SELECT us.id, LOWER(sp.name) AS plan_key
       FROM user_subscriptions us
       LEFT JOIN subscription_plans sp ON sp.id = us.plan_id
      WHERE us.user_id = $1
        AND us.status = 'active'
        AND us.current_period_end > NOW()
      ORDER BY us.current_period_end DESC
      LIMIT 1`,
    [userId]
  );
  const hit = rows[0];
  const subscriptionStatus = hit ? hit.plan_key || 'pro' : 'free';
  const currentSubscriptionId = hit ? hit.id : null;
  await client.query(
    `UPDATE users
        SET subscription_status = $1, current_subscription_id = $2
      WHERE id = $3`,
    [subscriptionStatus, currentSubscriptionId, userId]
  );
  return { subscriptionStatus, currentSubscriptionId };
}

/**
 * 用户自助提交退款申请（**不调渠道**）。
 *
 * @param {object} p
 * @param {string} p.userId  必须是订单属主（非属主由路由侧按防探测口径处理）
 * @param {string} p.orderKey orderNo 或 orderId（形状判别复用 refund.js#locateOrder）
 * @param {string} [p.reason]
 * @returns {Promise<{ok:true, request:object, entitlement:object, reviewBusinessDays:number}>}
 * @throws {RefundError} 400/404/409/500
 */
export async function createSelfRefundRequest({ userId, orderKey, reason, ip, userAgent } = {}) {
  const key = String(orderKey ?? '').trim();
  if (!key) {
    throw new RefundError(400, 'REFUND_REQUEST_ORDER_REQUIRED', 'Missing orderId or orderNo');
  }

  const [order, settings] = await Promise.all([
    locateOrder(key, SELF_REFUND_ORDER_COLUMNS),
    getRefundSettings(),
  ]);
  // 防探测：不存在与「不是你的单」在路由侧统一成 404，这里只如实返回 null
  if (!order) throw new RefundError(404, 'ORDER_NOT_FOUND', 'Order not found', { orderNo: key });
  if (String(order.user_id) !== String(userId)) {
    throw new RefundError(404, 'ORDER_NOT_FOUND', 'Order not found', { orderNo: key });
  }

  // 在途申请先判：锚点闸也会计拒（申请已把订阅收回 → 锚点消失），但那时用户看到的是
  // 「这不是当前订阅的订单」，而真话是「你这条已经在审核中了」。理由要说对。
  const pending = await findPendingRequestsByOrderIds(userId, [String(order.id)]);
  if (pending.has(String(order.id))) {
    throw new RefundError(
      409,
      REFUND_REASON_CODES.REFUND_REQUEST_PENDING,
      'A refund request for this order is already under review',
      { orderNo: order.order_no }
    );
  }

  const anchorOrderId = await findSelfRefundAnchorOrderId(userId);
  const verdict = evaluateSelfRefund({ order, anchorOrderId, windowDays: settings.windowDays });
  // 申请阶段不发生资金动作，所以**任何**不可退理由都在这里拒掉
  // （不再有「交回 refundPaidOrder 报错」那半边，见文件头分工说明）
  if (!verdict.refundable) {
    throw new RefundError(409, verdict.reasonCode, verdict.message, verdict.extra);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 行锁复核：并发双击/两个设备同时提交，只能有一条落得下
    const locked = await client.query(
      'SELECT id, status, subscription_id, amount, currency FROM payment_orders WHERE id = $1 FOR UPDATE',
      [order.id]
    );
    const row = locked.rows[0];
    if (!row || row.status !== 'paid') {
      throw new RefundError(409, 'REFUND_STATE_CONFLICT', 'Order state changed, please refresh', {
        orderNo: order.order_no,
        status: row?.status ?? null,
      });
    }

    const snapshot = await buildEntitlementSnapshot(client, order.user_id, row.subscription_id);

    // 立即收回权益：订阅 canceled（锚点随之消失，历史单不会顺移可退）
    if (row.subscription_id) {
      await client.query(
        `UPDATE user_subscriptions
            SET status = 'canceled', canceled_at = NOW(), auto_renew = false, updated_at = NOW()
          WHERE id = $1 AND status <> 'canceled'`,
        [row.subscription_id]
      );
    }
    const entitlement = await recomputeUserEntitlement(client, order.user_id);

    const created = await client.query(
      `INSERT INTO refund_requests
         (user_id, order_id, order_no, amount, currency, status, window_days_at_request,
          user_reason, entitlement_snapshot)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)
       RETURNING ${REQUEST_COLUMNS}`,
      [
        order.user_id,
        order.id,
        order.order_no,
        roundToCent(row.amount),
        row.currency || order.currency || 'CNY',
        settings.windowDays,
        String(reason || '用户申请退款').slice(0, 200),
        JSON.stringify(snapshot),
      ]
    );
    if (created.rows.length === 0) {
      throw new RefundError(500, 'REFUND_REQUEST_CREATE_FAILED', 'Failed to create refund request');
    }

    await client.query('COMMIT');

    const dto = toDto(created.rows[0]);
    await logAuditEvent({
      userId,
      action: AUDIT_ACTIONS.REFUND_REQUEST,
      resourceType: 'refund_request',
      resourceId: dto.id,
      details: {
        orderNo: dto.orderNo,
        amount: dto.amount,
        reason: dto.userReason,
        windowDays: settings.windowDays,
        canceledSubscriptionId: row.subscription_id ?? null,
      },
      ipAddress: ip,
      userAgent: String(userAgent || '').slice(0, USER_AGENT_MAX),
    }).catch((e) => logger.error('[refundRequest] audit failed', { error: e.message }));

    logger.info('[refundRequest] created', {
      userId,
      orderNo: dto.orderNo,
      requestId: dto.id,
      entitlement,
    });

    return { ok: true, request: dto, entitlement, reviewBusinessDays: settings.reviewBusinessDays };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // 部分唯一索引 uq_refund_requests_pending_per_order 兜住并发重复提交
    if (err && err.code === '23505') {
      throw new RefundError(409, REFUND_REASON_CODES.REFUND_REQUEST_PENDING, 'A refund request for this order is already under review', {
        orderNo: order.order_no,
      });
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 权益快照：驳回时要照它还原，所以必须把「申请前那一刻」的订阅字段原样存下来。
 * users 上的冗余字段不入快照 —— 还原后统一由 recomputeUserEntitlement 重算，
 * 免得两处真相打架（也顺带避开"快照时刻用户其实已有效力更高的别的订阅"这种边角）。
 */
async function buildEntitlementSnapshot(client, userId, subscriptionId) {
  const base = { userId: String(userId), subscriptionId: subscriptionId || null };
  if (!subscriptionId) return base;

  const { rows } = await client.query(
    `SELECT status, plan_id, current_period_end
       FROM user_subscriptions WHERE id = $1`,
    [subscriptionId]
  );
  const sub = rows[0] || {};
  return {
    ...base,
    subscriptionStatus: sub.status ?? 'active',
    planId: sub.plan_id ?? null,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end).toISOString() : null,
  };
}

/** 我的申请列表（客户端「退款审核中」状态条用），只回自己的单 */
export async function listMyRefundRequests(userId, limit = 5) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 20));
  const { rows } = await pool.query(
    `SELECT ${REQUEST_COLUMNS} FROM refund_requests
      WHERE user_id = $1 ORDER BY requested_at DESC LIMIT $2`,
    [userId, safeLimit]
  );
  return rows.map(toDto);
}

/**
 * 批量取「这些订单有没有在途申请」，给 refundable-orders 标注用。
 * 键是 order_id 字符串。一次查完，避免列表里逐条 N+1。
 */
export async function findPendingRequestsByOrderIds(userId, orderIds) {
  const ids = (orderIds || []).filter((x) => x);
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT ${REQUEST_COLUMNS} FROM refund_requests
      WHERE user_id = $1 AND status IN ('pending','processing')
        AND order_id = ANY($2::uuid[])`,
    [userId, ids]
  );
  return new Map(rows.map((r) => [String(r.order_id), r]));
}

/** 管理台列表（含用户/套餐/审核人名称，供审核页直接渲染） */
export async function listRefundRequestsForAdmin({ status = 'pending', page = 1, pageSize = 20 } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.max(1, Math.min(Number(pageSize) || 20, 100));
  const statusFilter = ['pending', 'processing', 'approved', 'rejected'].includes(status)
    ? status
    : null; // 'all' / 非法值 → 不过滤

  const where = statusFilter ? 'WHERE rr.status = $1' : '';
  const params = statusFilter ? [statusFilter] : [];

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM refund_requests rr ${where}`,
    params
  );
  const { rows } = await pool.query(
    `SELECT rr.id, rr.order_id, rr.order_no, rr.amount, rr.currency, rr.status,
            rr.window_days_at_request, rr.user_reason, rr.requested_at, rr.reviewed_at,
            rr.reviewed_by, rr.review_note,
            rr.user_id,
            u.name AS user_name, u.phone AS user_phone,
            po.paid_at, po.plan_id,
            sp.name AS plan_name,
            rv.name AS reviewed_by_name
       FROM refund_requests rr
       LEFT JOIN users u ON u.id = rr.user_id
       LEFT JOIN payment_orders po ON po.id = rr.order_id
       LEFT JOIN subscription_plans sp ON sp.id = po.plan_id
       LEFT JOIN users rv ON rv.id = rr.reviewed_by
       ${where}
      ORDER BY rr.requested_at ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeSize, (safePage - 1) * safeSize]
  );

  return {
    items: rows.map((r) => ({
      ...toDto(r),
      userId: String(r.user_id),
      userName: r.user_name ?? null,
      userPhone: r.user_phone ?? null,
      planName: r.plan_name ?? null,
      paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
    })),
    total: countRes.rows[0]?.total ?? 0,
    page: safePage,
    pageSize: safeSize,
  };
}

/**
 * 审核通过：这一刻才真打款。
 *
 * 认领（CAS）→ refundPaidOrder → 落 approved。渠道失败则把 processing 退回
 * pending，让管理员能看到「没退成，可以再试」，而不是留一条看起来已处理完的单。
 *
 * @returns {Promise<{ok:true, request:object, order:object}>}
 */
export async function approveRefundRequest({ requestId, actorUserId, ip, userAgent } = {}) {
  const id = String(requestId ?? '').trim();
  if (!id) throw new RefundError(400, 'REFUND_REQUEST_ID_REQUIRED', 'Missing refund request id');

  const claimed = await pool.query(
    `UPDATE refund_requests SET status = 'processing', updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING ${REQUEST_COLUMNS}`,
    [id]
  );
  if (claimed.rows.length === 0) {
    const existing = await pool.query(
      `SELECT ${REQUEST_COLUMNS}, order_no FROM refund_requests WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      throw new RefundError(404, 'REFUND_REQUEST_NOT_FOUND', 'Refund request not found');
    }
    throw new RefundError(409, 'REFUND_REQUEST_NOT_PENDING', 'Refund request already handled', {
      status: existing.rows[0].status,
      orderNo: existing.rows[0].order_no,
    });
  }
  const req0 = claimed.rows[0];

  let result;
  try {
    result = await refundPaidOrder({
      orderId: String(req0.order_id),
      actorUserId,
      reason: `退款审核通过（申请单 ${req0.id}）`,
      ip,
      userAgent,
    });
  } catch (err) {
    const alreadyRefunded = err instanceof RefundError && err.code === 'ALREADY_REFUNDED';
    if (alreadyRefunded) {
      // 钱已在别处退过（管理台强退/幂等重放）：目的已达成，把申请单收口成 approved，
      // 绝不能再退一次 —— refundPaidOrder 在调渠道前就抛了，这里零资金副作用。
      await pool.query(
        `UPDATE refund_requests
            SET status = 'approved', reviewed_at = NOW(), reviewed_by = $2,
                review_note = '订单此前已退款，未重复打款', updated_at = NOW()
          WHERE id = $1`,
        [id, actorUserId]
      );
    } else {
      await pool.query(
        `UPDATE refund_requests SET status = 'pending', updated_at = NOW() WHERE id = $1`,
        [id]
      ).catch((e) => logger.error('[refundRequest] release claim failed', { error: e.message }));
    }
    throw err;
  }

  const reviewed = await pool.query(
    `UPDATE refund_requests
        SET status = 'approved', reviewed_at = NOW(), reviewed_by = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING ${REQUEST_COLUMNS}`,
    [id, actorUserId]
  );

  // refundPaidOrder 无条件把 users 写成 free；若用户在审核期间又买了新套餐，
  // 这里按「当前生效订阅」重算回来，避免"付了钱却掉回免费版"。
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await recomputeUserEntitlement(client, req0.user_id);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // 钱已经退掉了，这里失败不能把整个审核接口报 500（管理员会以为没退成又点一次）
    logger.error('[refundRequest] CRITICAL: refunded but entitlement recompute failed', {
      requestId: id,
      orderNo: req0.order_no,
      userId: req0.user_id,
      error: e.message,
    });
  } finally {
    client.release();
  }

  await logAuditEvent({
    userId: actorUserId,
    action: AUDIT_ACTIONS.REFUND_APPROVE,
    resourceType: 'refund_request',
    resourceId: id,
    details: {
      orderNo: req0.order_no,
      amount: result.order.refundAmount,
      targetUserId: req0.user_id,
      out_request_no: result.channel.out_request_no,
      fund_status: result.channel.fund_status,
    },
    ipAddress: ip,
    userAgent: String(userAgent || '').slice(0, USER_AGENT_MAX),
  }).catch((e) => logger.error('[refundRequest] audit failed', { error: e.message }));

  logger.info('[refundRequest] approved and refunded', {
    requestId: id,
    orderNo: req0.order_no,
    amount: result.order.refundAmount,
    actorUserId,
  });

  return { ok: true, request: toDto(reviewed.rows[0]), order: result.order };
}

/**
 * 驳回：钱没退，所以权益必须按快照还原。
 *
 * 一个刻意的例外：如果用户在申请之后又买了新套餐（现在有别的有效订阅），
 * 就不还原旧订阅 —— 否则又会造出「同一用户两条 active 订阅」那种脏数据
 * （生产上刚清过一条）。此时 users 的冗余状态由 recompute 按新订阅算。
 */
export async function rejectRefundRequest({ requestId, actorUserId, reason, ip, userAgent } = {}) {
  const id = String(requestId ?? '').trim();
  const note = String(reason || '').trim();
  if (!id) throw new RefundError(400, 'REFUND_REQUEST_ID_REQUIRED', 'Missing refund request id');
  if (!note) {
    throw new RefundError(400, 'REFUND_REJECT_REASON_REQUIRED', 'Reject reason is required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT ${REQUEST_COLUMNS}, user_id, entitlement_snapshot
         FROM refund_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const rr = rows[0];
    if (!rr) throw new RefundError(404, 'REFUND_REQUEST_NOT_FOUND', 'Refund request not found');
    if (rr.status !== 'pending') {
      throw new RefundError(409, 'REFUND_REQUEST_NOT_PENDING', 'Refund request already handled', {
        status: rr.status,
        orderNo: rr.order_no,
      });
    }

    const snap = rr.entitlement_snapshot && typeof rr.entitlement_snapshot === 'object'
      ? rr.entitlement_snapshot
      : {};
    let restored = false;
    if (snap.subscriptionId) {
      const others = await client.query(
        `SELECT COUNT(*)::int AS n FROM user_subscriptions
          WHERE user_id = $1 AND id <> $2 AND status = 'active' AND current_period_end > NOW()`,
        [rr.user_id, snap.subscriptionId]
      );
      const periodEnd = snap.currentPeriodEnd ? new Date(snap.currentPeriodEnd) : null;
      const stillValid = periodEnd && periodEnd.getTime() > Date.now();
      if (others.rows[0].n === 0 && stillValid) {
        await client.query(
          `UPDATE user_subscriptions
              SET status = 'active', canceled_at = NULL, updated_at = NOW()
            WHERE id = $1 AND status = 'canceled'`,
          [snap.subscriptionId]
        );
        restored = true;
      }
    }
    const entitlement = await recomputeUserEntitlement(client, rr.user_id);

    const updated = await client.query(
      `UPDATE refund_requests
          SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $2,
              review_note = $3, updated_at = NOW()
        WHERE id = $1
        RETURNING ${REQUEST_COLUMNS}`,
      [id, actorUserId, note.slice(0, 200)]
    );

    await client.query('COMMIT');

    await logAuditEvent({
      userId: actorUserId,
      action: AUDIT_ACTIONS.REFUND_REJECT,
      resourceType: 'refund_request',
      resourceId: id,
      details: {
        orderNo: rr.order_no,
        targetUserId: rr.user_id,
        reason: note.slice(0, 200),
        entitlementRestored: restored,
      },
      ipAddress: ip,
      userAgent: String(userAgent || '').slice(0, USER_AGENT_MAX),
    }).catch((e) => logger.error('[refundRequest] audit failed', { error: e.message }));

    logger.info('[refundRequest] rejected', {
      requestId: id,
      orderNo: rr.order_no,
      actorUserId,
      entitlementRestored: restored,
      entitlement,
    });

    return { ok: true, request: toDto(updated.rows[0]), entitlement, entitlementRestored: restored };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export default {
  createSelfRefundRequest,
  approveRefundRequest,
  rejectRefundRequest,
  listMyRefundRequests,
  listRefundRequestsForAdmin,
  findPendingRequestsByOrderIds,
  recomputeUserEntitlement,
};
