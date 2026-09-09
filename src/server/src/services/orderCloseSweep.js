import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';

// ============================================
// AF-15 订单超时自动关单定时任务（orderCloseSweep）
//
// 口径（2026-09-09 拍板）：已支付订单不允许人工关单；
// 仅「超时未支付」自动关。订单页的人工「关闭」按钮已随本任务删除。
//
// 本扫描每小时一轮：创建超过 24h 仍 pending 的订单置 cancelled，
// metadata.auto_closed='timeout_unpaid' 留痕（管理台订单详情可溯源），
// 并逐单写审计日志（action=payment_auto_close）。
// ============================================

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 每小时一轮
const EXPIRE_HOURS = 24; // 创建超过 24h 未支付即超时

/**
 * 执行一轮超时关单扫描。
 * @returns {{ swept: boolean, closedCount: number }} swept=false 表示本轮因错误跳过
 */
export async function runOrderCloseSweep() {
  try {
    const { rows } = await pool.query(
      `UPDATE payment_orders
       SET status = 'cancelled',
           updated_at = NOW(),
           metadata = COALESCE(metadata, '{}'::jsonb) || '{"auto_closed": "timeout_unpaid"}'::jsonb
       WHERE status = 'pending'
         AND created_at < NOW() - ($1 || ' hours')::interval
       RETURNING id, order_no, user_id, amount`,
      [String(EXPIRE_HOURS)]
    );

    // 逐单写审计日志（失败不阻塞主流程，与 payments.js 审计风格一致）
    for (const order of rows) {
      await logAuditEvent({
        userId: order.user_id ?? null,
        action: AUDIT_ACTIONS.PAYMENT_AUTO_CLOSE,
        resourceType: 'payment_order',
        resourceId: order.id,
        details: {
          orderNo: order.order_no,
          amount: order.amount,
          reason: 'timeout_unpaid',
          autoClosed: true,
          expireHours: EXPIRE_HOURS,
        },
      }).catch((err) =>
        logger.error('[order-sweep] audit log failed', {
          error: err.message,
          orderNo: order.order_no,
        })
      );
    }

    if (rows.length > 0) {
      logger.info('[order-sweep] auto-closed expired pending orders', {
        count: rows.length,
        expireHours: EXPIRE_HOURS,
      });
    }
    return { swept: true, closedCount: rows.length };
  } catch (err) {
    logger.error('[order-sweep] sweep failed', { error: err.message });
    return { swept: false, closedCount: 0 };
  }
}

let sweepTimer = null;

/**
 * 启动订单超时关单调度器（应用启动时调用一次）。
 * 每 60min 一轮；timer.unref() 不阻止进程退出。
 * 返回周期 timer（测试/运维可 clearInterval）。
 */
export function startOrderCloseSweep() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => {
    runOrderCloseSweep();
  }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  logger.info('[order-sweep] scheduler started', {
    intervalMs: SWEEP_INTERVAL_MS,
    expireHours: EXPIRE_HOURS,
  });
  return sweepTimer;
}

/** 停止调度器（graceful shutdown 时调用），幂等。 */
export function stopOrderCloseSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    logger.info('[order-sweep] scheduler stopped');
  }
}

export default {
  runOrderCloseSweep,
  startOrderCloseSweep,
  stopOrderCloseSweep,
};
