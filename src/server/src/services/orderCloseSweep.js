import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';
import {
  isAlipayConfigured,
  isAlipayNotifyConfigured,
  queryTrade,
  closeTrade,
} from '../utils/alipay.js';

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
//
// ── 2026-10-04 审计 Q3 修复：渠道能力缺失时必须 fail-closed ──
//
// 原判定是 `channel === 'alipay' && isAlipayConfigured()`：只要**签不了名**（缺 appId/
// 应用私钥）就走不到渠道分支，于是这批单会被「本地直接 cancelled」——而它们恰恰可能是
// 用户真付过的单。`isAlipayConfigured()` 要求的是能 SIGN trade.query/trade.close 的凭据，
// 比「我们是支付宝商户」的判定（`isAlipayNotifyConfigured()`：回调验签只需公钥）更严。
// 因此配置回退（公钥还在、私钥丢了）时旧代码会静默降级成最危险的行为。
// 现在：只要「我方是支付宝商户」成立（公钥在）却「签不了名」（私钥/APP_ID 缺），
// 就**绝不本地关单**，保持 pending 并打标记留给人工，配置补齐后下一轮自然恢复。
// ============================================

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 每小时一轮
const EXPIRE_HOURS = 24; // 创建超过 24h 未支付即超时
const SWEEP_BATCH_LIMIT = 100; // 单轮处理上限，避免大量历史单把一轮拖成长时间占用

/**
 * 执行一轮超时关单扫描。
 * @returns {{ swept: boolean, closedCount: number, skippedPaid: number, deferredByChannel: number, deferredUnverifiable: number }}
 *   swept=false 表示本轮因错误跳过；skippedPaid>0 表示发现「渠道已付款但本地仍 pending」的
 *   异常单（已被保护性跳过，需对账）；deferredByChannel 表示因渠道查单/关单失败而推迟到下一轮；
 *   deferredUnverifiable 表示「是支付宝商户但签不了名」，无法确认渠道状态而保护性跳过（需人工）。
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
    let deferredUnverifiable = 0; // 是支付宝商户却签不了名：无法查/关渠道，保护性跳过

    for (const order of rows) {
      const channel = String(order.payment_channel || order.payment_method || '').toLowerCase();
      const isAlipay = channel === 'alipay';
      const alipayCanSign = isAlipay && isAlipayConfigured();

      // ── fail-closed（2026-10-04 审计 Q3）：我方是支付宝商户（回调验签公钥已配置），
      // 却**签不了名**（缺 appId/应用私钥）── queryTrade/closeTrade 都必须 RSA 签名，
      // 于是「渠道侧到底付没付」根本无从确认。绝不能因此回落成「本地直接关单」：
      // 那正是本扫描要防的事故 —— 可能关掉一笔用户**真付过钱**的单
      // （与 2026-09-29 H2 同口径：未确认渠道状态前一律不许本地置 cancelled）。
      // 保持 pending，打固定标记 CRITICAL 日志 + metadata 留痕，等人处理；
      // 配置补齐后下一轮自然恢复（原逻辑：非支付宝或完全未配置时行为不变）。
      if (isAlipay && !alipayCanSign && isAlipayNotifyConfigured()) {
        deferredUnverifiable++;
        logger.error(
          '[order-sweep] CRITICAL: alipay notify is configured but SIGNING credentials are missing; ' +
            'cannot trade.query/trade.close, NOT closing this order locally. Needs human review.',
          { orderNo: order.order_no, amount: order.amount }
        );

        // 与 channel_reports_paid 同理：必须在**数据上**留痕，否则管理台无从发现这类单。
        await pool
          .query(
            `UPDATE payment_orders
                SET metadata = COALESCE(metadata, '{}'::jsonb)
                               || jsonb_build_object(
                                    'channel_unverifiable', true,
                                    'channel_unverifiable_at', NOW()::text
                                  ),
                    updated_at = NOW()
              WHERE id = $1 AND status = 'pending'`,
            [order.id]
          )
          .catch((err) =>
            logger.error('[order-sweep] failed to mark channel_unverifiable', {
              orderNo: order.order_no,
              error: err.message,
            })
          );
        continue;
      }

      if (alipayCanSign) {
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

    if (closedCount > 0 || skippedPaid > 0 || deferredByChannel > 0 || deferredUnverifiable > 0) {
      logger.info('[order-sweep] sweep round done', {
        candidates: rows.length,
        closedCount,
        skippedPaid,
        deferredByChannel,
        deferredUnverifiable,
        expireHours: EXPIRE_HOURS,
      });
    }

    return { swept: true, closedCount, skippedPaid, deferredByChannel, deferredUnverifiable };
  } catch (err) {
    logger.error('[order-sweep] sweep failed', { error: err.message });
    return {
      swept: false,
      closedCount: 0,
      skippedPaid: 0,
      deferredByChannel: 0,
      deferredUnverifiable: 0,
    };
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
