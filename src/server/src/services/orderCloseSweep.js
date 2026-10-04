import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';
import { isAlipayConfigured, queryTrade, closeTrade } from '../utils/alipay.js';

// ============================================
// AF-15 订单超时自动关单定时任务（orderCloseSweep）
//
// 口径（2026-09-09 拍板）：已支付订单不允许人工关单；
// 仅「超时未支付」自动关。订单页的人工「关闭」按钮已随本任务删除。
//
// 本扫描每小时一轮：创建超过 24h 仍 pending 的订单置 cancelled，
// metadata.auto_closed='timeout_unpaid' 留痕（管理台订单详情可溯源），
// 并逐单写审计日志（action=payment_auto_close）。
//
// ── 2026-09-29 审计 H2 修复：关单前必须先在渠道侧关掉 ──
//
// 原实现是一条 `UPDATE ... SET status='cancelled'` 批量把超时 pending 全关，
// 但**支付宝侧的交易并不因此关闭**，于是出现：
//   用户第 25 小时付款成功 → 回调 `markOrderPaid` 判 `order_cancelled` → 回 failure
//   → 钱进了商户账户、订阅永远不开，而所有退款入口都拒收 cancelled 单
//   → 系统内没有任何一条路径能把钱退回去，只能人工登支付宝后台退款并对账。
//
// 现在逐单处理，顺序是「先查渠道 → 再关渠道 → 最后才关本地」：
//   · 渠道已付款      → **绝不关单**，留给回调/轮询兜底去履约，并打 CRITICAL 日志待对账
//   · 查单失败        → 本轮跳过，下轮重试（绝不冒险关单）
//   · 渠道关单失败    → 本轮跳过，下轮重试
//   · 渠道确认已关闭  → 才允许本地置 cancelled
//
// 与之配套的不变量：`utils/alipay.js` 的 `PAYMENT_TIMEOUT_EXPRESS`（渠道侧可支付窗口）
// 必须**明显短于**这里的 EXPIRE_HOURS，否则渠道窗口可能晚于本地关单窗口而重新打开这个洞。
// ============================================

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 每小时一轮
const EXPIRE_HOURS = 24; // 创建超过 24h 未支付即超时
const SWEEP_BATCH_LIMIT = 100; // 单轮处理上限，避免大量历史单把一轮拖成长时间占用

/**
 * 执行一轮超时关单扫描。
 * @returns {{ swept: boolean, closedCount: number, skippedPaid: number, deferredByChannel: number }}
 *   swept=false 表示本轮因错误跳过；skippedPaid>0 表示发现「渠道已付款但本地仍 pending」的
 *   异常单（已被保护性跳过，需对账）；deferredByChannel 表示因渠道查单/关单失败而推迟到下一轮。
 */
export async function runOrderCloseSweep() {
  try {
    // 先「选候选」而不是直接批量 UPDATE —— 见文件头说明
    const { rows } = await pool.query(
      `SELECT id, order_no, user_id, amount, payment_method, payment_channel
         FROM payment_orders
        WHERE status = 'pending'
          AND created_at < NOW() - ($1 || ' hours')::interval
        ORDER BY created_at ASC
        LIMIT $2`,
      [String(EXPIRE_HOURS), SWEEP_BATCH_LIMIT]
    );

    let closedCount = 0;
    let skippedPaid = 0;
    let deferredByChannel = 0;

    for (const order of rows) {
      const channel = String(order.payment_channel || order.payment_method || '').toLowerCase();

      if (channel === 'alipay' && isAlipayConfigured()) {
        // ① 先查渠道：已付款的单绝不关，留给回调/轮询去履约
        let paid = false;
        try {
          const trade = await queryTrade(order.order_no);
          paid = trade.paid;
        } catch (err) {
          if (err.subCode !== 'ACQ.TRADE_NOT_EXIST') {
            // 查单本身失败（网络/限流/未知错误）→ 本轮跳过，下轮再试
            logger.error('[order-sweep] trade.query failed; deferring order to next round', {
              orderNo: order.order_no,
              subCode: err.subCode || null,
              error: err.message,
            });
            deferredByChannel++;
            continue;
          }
          // 渠道没有这笔交易 → 视为未付，继续走关单
        }

        if (paid) {
          skippedPaid++;
          logger.error(
            '[order-sweep] CRITICAL: channel reports PAID on an expired pending order; NOT closing it ' +
              '(notify/polling will fulfil it). Needs reconciliation.',
            { orderNo: order.order_no, amount: order.amount }
          );

          // ⚠️ 必须在**数据上**留痕，不能只打日志（2026-10-03 管理台复查发现的遗留）：
          // 否则管理台无从发现这类单 —— 更糟的是它们会被「待支付订单超 24 小时」那条待办
          // 捞进去、标题写"待支付"，运营看到会当成"用户忘了付"，而真相是**钱已经收了**。
          // 打上标记后 overview 的待办可以据此单列一类高优先级「异常到账」。
          await pool
            .query(
              `UPDATE payment_orders
                  SET metadata = COALESCE(metadata, '{}'::jsonb)
                                 || jsonb_build_object(
                                      'channel_reports_paid', true,
                                      'channel_paid_detected_at', NOW()::text
                                    ),
                      updated_at = NOW()
                WHERE id = $1 AND status = 'pending'`,
              [order.id]
            )
            .catch((err) =>
              logger.error('[order-sweep] failed to mark channel_reports_paid', {
                orderNo: order.order_no,
                error: err.message,
              })
            );
          continue;
        }

        // ② 渠道侧确认未付 → 关掉渠道交易，只有成功才允许本地关单
        try {
          await closeTrade(order.order_no);
        } catch (err) {
          logger.error('[order-sweep] trade.close failed; deferring order to next round', {
            orderNo: order.order_no,
            subCode: err.subCode || null,
            error: err.message,
          });
          deferredByChannel++;
          continue;
        }
      }

      // ③ 本地关单（status 守卫：并发下回调可能刚把它改成 paid）
      const upd = await pool.query(
        `UPDATE payment_orders
            SET status = 'cancelled',
                updated_at = NOW(),
                metadata = COALESCE(metadata, '{}'::jsonb) || '{"auto_closed": "timeout_unpaid"}'::jsonb
          WHERE id = $1 AND status = 'pending'`,
        [order.id]
      );
      if (upd.rowCount === 0) continue;
      closedCount++;

      // 逐单写审计日志（失败不阻塞主流程，与 payments.js 审计风格一致）
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
          channelClosed: channel === 'alipay',
        },
      }).catch((err) =>
        logger.error('[order-sweep] audit log failed', {
          error: err.message,
          orderNo: order.order_no,
        })
      );
    }

    if (closedCount > 0 || skippedPaid > 0 || deferredByChannel > 0) {
      logger.info('[order-sweep] sweep round done', {
        candidates: rows.length,
        closedCount,
        skippedPaid,
        deferredByChannel,
        expireHours: EXPIRE_HOURS,
      });
    }

    return { swept: true, closedCount, skippedPaid, deferredByChannel };
  } catch (err) {
    logger.error('[order-sweep] sweep failed', { error: err.message });
    return { swept: false, closedCount: 0, skippedPaid: 0, deferredByChannel: 0 };
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
