// =============================================
// Admin Console · 订单/退款/对账 APIs（Admin Console · T-A3）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/orders', ordersRouter)          → GET /api/admin/orders
//                                                       GET /api/admin/orders/:orderNo
//                                                       POST /api/admin/orders/:orderNo/refund
//   adminRouter.use('/reconciliation', reconciliationRouter) → GET /api/admin/reconciliation
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 本文件额外细粒度权限：
//   - POST /orders/:orderNo/refund  → requirePerm('admin.orders.refund')（高危，仅退款权限）
//   - GET  /reconciliation          → requirePerm('admin.orders.reconcile')（对账查看）
//   - GET  /orders, /orders/:orderNo → 无额外权限点（admin 等级即可见）
//
// 响应契约（docs/plans/admin-console-v1-tickets.md §二 / src/admin-console/src/api/types.ts）：
//   成功 { code: 0, data: T }；错误 { code, message }；分页壳 { list, total, page, pageSize }
//   Order 字段与 admin-console/src/api/types.ts 的 Order 接口逐字段对齐：
//   orderNo/outTradeNo/transactionId/userId/userLabel/planLabel/channel/currency/
//   amount/refundAmount/status/createdAt/paidAt
//
// 「refunding 退款处理中」伪状态口径（前端 handlers.ts matchOrderStatus 同款）：
//   - 退款处理中 = payment_orders.status='refunded' 且 metadata 无 refund_amount
//     （管理员已发起退款但资金未退回 / metadata 未落退款金额）
//   - 已退款     = status='refunded' 且 metadata.refund_amount 存在
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { logAuditEvent } from '../../utils/audit.js';
import { requirePerm } from '../../middleware/adminAuth.js';

const router = Router();

// ───────────────────────── 通用片段 ─────────────────────────

// 渠道归一化表达式：优先 payment_channel，缺失回退 payment_method（历史写入方只用过 payment_method）。
// 识别不出渠道（mock/空值等）时归入 wechat —— 与前端 PaymentChannel 三值类型保持兼容。
const CHANNEL_EXPR = "lower(coalesce(nullif(po.payment_channel, ''), po.payment_method, ''))";
const CHANNEL_CASE_SQL = `
  CASE
    WHEN ${CHANNEL_EXPR} LIKE '%stripe%' THEN 'stripe'
    WHEN ${CHANNEL_EXPR} LIKE '%alipay%' THEN 'alipay'
    ELSE 'wechat'
  END`;

// 订单行查询（列表/详情/退款回读共用）。JOIN users 取用户摘要、JOIN 订阅+套餐取 planLabel。
const ORDER_SELECT = `
  SELECT
    po.id,
    po.subscription_id,
    po.order_no,
    po.out_trade_no,
    po.transaction_id,
    po.user_id,
    po.amount,
    po.currency,
    po.status,
    po.created_at,
    po.paid_at,
    ${CHANNEL_CASE_SQL} AS channel,
    po.metadata->>'refund_amount' AS refund_amount,
    u.nickname AS user_nickname,
    u.phone AS user_phone,
    sp.display_name AS plan_display_name,
    sp.name AS plan_name,
    us.billing_cycle
  FROM payment_orders po
  JOIN users u ON u.id = po.user_id
  LEFT JOIN user_subscriptions us ON us.id = po.subscription_id
  LEFT JOIN subscription_plans sp ON sp.id = COALESCE(us.plan_id, po.plan_id)`;

const VALID_ORDER_STATUSES = new Set(['pending', 'paid', 'failed', 'cancelled', 'refunded']);
const VALID_CHANNELS = new Set(['wechat', 'alipay', 'stripe']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 手机号打码：138****2765（与 routes/aiTools.js 口径一致） */
function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone);
  if (s.length < 7) return s.slice(0, 1) + '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/** timestamptz → ISO 字符串（空值透传 null） */
function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** DB 行 → 前端 Order 契约（admin-console/src/api/types.ts） */
function mapOrderRow(row) {
  const planDisplay = row.plan_display_name || row.plan_name || '';
  return {
    orderNo: row.order_no,
    outTradeNo: row.out_trade_no || '',
    transactionId: row.transaction_id || null,
    userId: row.user_id,
    // 用户摘要：优先昵称，缺失回退打码手机号（隐私：不出明文手机号）
    userLabel: (row.user_nickname || '').trim() || maskPhone(row.user_phone) || '未知用户',
    planLabel: planDisplay
      ? `${planDisplay} · ${row.billing_cycle === 'yearly' ? '年付' : '月付'}`
      : '',
    channel: row.channel,
    currency: row.currency || 'CNY',
    amount: Number(row.amount),
    // 已退款金额：来自 metadata.refund_amount；未落值（refunding 伪状态）为 null
    refundAmount: row.refund_amount != null ? Number(row.refund_amount) : null,
    status: row.status,
    createdAt: toIso(row.created_at),
    paidAt: toIso(row.paid_at),
  };
}

/** 分页参数解析（容错：非法回默认值，page=1 / pageSize=10，上限 200） */
function parsePaging(query) {
  let page = parseInt(query.page, 10);
  let pageSize = parseInt(query.pageSize, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 10;
  if (pageSize > 200) pageSize = 200;
  if (page > 100000) page = 100000;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * 组装列表 WHERE（含 refunding 伪状态口径）。
 * @returns {{ whereSql: string, params: any[] }} 与 ORDER_SELECT/COUNT 的 po 别名配套
 */
function buildOrderFilters(query, params) {
  const where = [];

  const { status, channel, dateFrom, dateTo, q } = query;

  if (status && status !== 'all') {
    if (status === 'refunding') {
      // 伪状态：已置 refunded 但退款金额未落（资金未退回）
      where.push(`po.status = 'refunded' AND po.metadata->>'refund_amount' IS NULL`);
    } else if (status === 'refunded') {
      where.push(`po.status = 'refunded' AND po.metadata->>'refund_amount' IS NOT NULL`);
    } else if (VALID_ORDER_STATUSES.has(status)) {
      params.push(status);
      where.push(`po.status = $${params.length}`);
    } else {
      return null; // 非法状态值 → 由调用方 400
    }
  }

  if (channel && channel !== 'all') {
    if (!VALID_CHANNELS.has(channel)) return null;
    params.push(channel);
    where.push(`${CHANNEL_CASE_SQL} = $${params.length}`);
  }

  if (dateFrom) {
    if (!DATE_RE.test(dateFrom)) return null;
    params.push(dateFrom);
    where.push(`po.created_at >= ($${params.length})::date`);
  }

  if (dateTo) {
    if (!DATE_RE.test(dateTo)) return null;
    params.push(dateTo);
    where.push(`po.created_at < ($${params.length})::date + INTERVAL '1 day'`);
  }

  if (q && String(q).trim()) {
    const keyword = `%${String(q).trim()}%`;
    params.push(keyword);
    const idx = params.length;
    where.push(
      `(po.order_no ILIKE $${idx} OR po.out_trade_no ILIKE $${idx} OR po.transaction_id ILIKE $${idx})`
    );
  }

  return { whereSql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

// ───────────────────────── 订单列表 ─────────────────────────

/**
 * GET /api/admin/orders?status=&channel=&dateFrom=&dateTo=&q=&page=&pageSize=
 * 订单分页列表（状态 Tabs + 渠道/时间筛选 + 关键字搜订单号/商户单号/第三方流水号）。
 */
router.get('/', async (req, res) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query);
    const params = [];
    const filters = buildOrderFilters(req.query, params);
    if (!filters) {
      return res.status(400).json({ code: 4000, message: '筛选参数不合法' });
    }

    const { rows: totalRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM payment_orders po${filters.whereSql}`,
      filters.params
    );
    const total = totalRows[0] ? Number(totalRows[0].total) : 0;

    const { rows } = await pool.query(
      `${ORDER_SELECT}${filters.whereSql} ORDER BY po.created_at DESC LIMIT $${filters.params.length + 1} OFFSET $${filters.params.length + 2}`,
      [...filters.params, pageSize, offset]
    );

    return res.json({ code: 0, data: { list: rows.map(mapOrderRow), total, page, pageSize } });
  } catch (err) {
    logger.error('[admin/orders] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取订单列表失败' });
  }
});

// ───────────────────────── 订单详情 ─────────────────────────

/**
 * GET /api/admin/orders/:orderNo
 * 订单全字段详情（详情弹窗）。
 */
router.get('/:orderNo', async (req, res) => {
  try {
    const { orderNo } = req.params;
    if (!orderNo || typeof orderNo !== 'string') {
      return res.status(400).json({ code: 4000, message: '订单号不合法' });
    }

    const { rows } = await pool.query(`${ORDER_SELECT} WHERE po.order_no = $1`, [orderNo]);
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '订单不存在' });
    }

    return res.json({ code: 0, data: mapOrderRow(rows[0]) });
  } catch (err) {
    logger.error('[admin/orders] detail failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取订单详情失败' });
  }
});

// ───────────────────────── 退款（高危） ─────────────────────────

/**
 * POST /api/admin/orders/:orderNo/refund  body { amount, reason }
 * 执行退款（requirePerm('admin.orders.refund')，原因必填并写入审计日志）。
 *
 * 简化口径（与用户端 payments.js /refund 思路一致）：
 *  1. 订单 status='paid' 才可退；退款后 status='refunded'，退款信息落 metadata
 *     （refund_amount / refund_reason / refund_by / refunded_at），不依赖独立退款流水表；
 *     不支持同一订单多次部分退款叠加（再次退款会被「非 paid」拦截）。
 *  2. 订阅联动（期末逻辑简化）：若订单对应订阅为年付且本次为全额退款，
 *     直接将 user_subscriptions.status 置 'canceled' —— 退款即终止权益，
 *     不适用普通退订的 cancel_at_period_end（期末生效）路径；月付/部分退款不动订阅。
 */
router.post('/:orderNo/refund', requirePerm('admin.orders.refund'), async (req, res) => {
  try {
    const { orderNo } = req.params;
    const body = req.body || {};
    const { amount } = body;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

    if (!reason) {
      return res.status(400).json({ code: 4000, message: '退款原因必填（写入审计日志）' });
    }

    const { rows } = await pool.query(`${ORDER_SELECT} WHERE po.order_no = $1`, [orderNo]);
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '订单不存在' });
    }
    const order = rows[0];

    if (order.status !== 'paid') {
      return res.status(400).json({ code: 40005, message: '仅已支付订单可退款' });
    }

    const orderAmount = Number(order.amount);
    // amount 缺省视为全额退款（与前端退款弹窗「默认全额」一致）
    const refundAmount = amount === undefined || amount === null ? orderAmount : Number(amount);
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      return res.status(400).json({ code: 4000, message: '退款金额不合法' });
    }
    if (refundAmount > orderAmount) {
      return res.status(400).json({ code: 4000, message: '退款金额不能超过订单金额' });
    }

    const refundMeta = {
      refund_amount: refundAmount,
      refund_reason: reason,
      refund_by: req.user?.userId ?? null,
      refunded_at: new Date().toISOString(),
    };

    await pool.query(
      `UPDATE payment_orders
       SET status = 'refunded',
           metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, JSON.stringify(refundMeta)]
    );

    // 年付全额退款 → 取消对应订阅（详见函数头注释的期末逻辑简化说明）
    if (
      order.subscription_id &&
      order.billing_cycle === 'yearly' &&
      refundAmount >= orderAmount
    ) {
      await pool.query(
        `UPDATE user_subscriptions
         SET status = 'canceled', updated_at = NOW()
         WHERE id = $1 AND status IN ('active', 'trial')`,
        [order.subscription_id]
      );
    }

    // 审计：details 含订单号/金额/原因，供审计页检索
    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.orders.refund',
      resourceType: 'payment_order',
      resourceId: String(order.id),
      details: {
        orderNo: order.order_no,
        amount: refundAmount,
        reason,
        targetUserId: order.user_id,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/orders] refund executed', {
      orderNo: order.order_no,
      amount: refundAmount,
      operator: req.user?.userId,
    });

    return res.json({
      code: 0,
      data: mapOrderRow({ ...order, status: 'refunded', refund_amount: String(refundAmount) }),
    });
  } catch (err) {
    logger.error('[admin/orders] refund failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '退款执行失败' });
  }
});

// ───────────────────────── 对账报告 ─────────────────────────

const reconciliationRouter = Router();

/**
 * GET /api/admin/reconciliation
 * 对账报告（按渠道汇总近 30 天成交笔数/金额与退款额）。
 * 返回 { generatedAt, rows: [{ channel, label, paidCount, paidAmount, refundAmount }] }，
 * rows 固定微信支付/支付宝/Stripe 三行（无数据的渠道补 0）。
 */
reconciliationRouter.get('/', requirePerm('admin.orders.reconcile'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        ${CHANNEL_CASE_SQL} AS channel,
        COUNT(*)::int AS paid_count,
        COALESCE(SUM(po.amount), 0)::float8 AS paid_amount,
        COALESCE(SUM(NULLIF(po.metadata->>'refund_amount', '')::numeric), 0)::float8 AS refund_amount
      FROM payment_orders po
      WHERE po.status IN ('paid', 'refunded')
        AND po.paid_at >= NOW() - INTERVAL '30 days'
      GROUP BY 1
    `);

    const byChannel = new Map(rows.map((r) => [r.channel, r]));
    const CHANNEL_LABELS = { wechat: '微信支付', alipay: '支付宝', stripe: 'Stripe' };

    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const generatedAt =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const data = {
      generatedAt,
      rows: Object.entries(CHANNEL_LABELS).map(([channel, label]) => {
        const r = byChannel.get(channel);
        return {
          channel,
          label,
          paidCount: r ? Number(r.paid_count) : 0,
          paidAmount: r ? Number(r.paid_amount) : 0,
          refundAmount: r ? Number(r.refund_amount) : 0,
        };
      }),
    };

    return res.json({ code: 0, data });
  } catch (err) {
    logger.error('[admin/orders] reconciliation failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '生成对账报告失败' });
  }
});

export default router;
export { reconciliationRouter };
