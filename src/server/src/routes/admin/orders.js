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
//   - POST /orders/:orderNo/fulfill → requirePerm('admin.orders.refund')（2026-10-05：人工补履约，
//                                      高危；**先向支付宝核实到账**再履约，详见该路由注释）
//   - GET  /orders/:orderNo/invoice → requirePerm('admin.orders.view')（2026-10-05：查开票信息）
//   - PATCH /orders/:orderNo/invoice → requirePerm('admin.orders.refund')（2026-10-05：补录抬头/税号。
//                                      履约链路从不写这两列，而收据文案却让客服来要 —— 此前只能改库）
//   - GET  /reconciliation          → requirePerm('admin.orders.reconcile')（对账查看）
//   - GET  /orders, /orders/:orderNo → requirePerm('admin.orders.view')（RB-06）
//
// 响应契约（docs/plans/archive/admin-console-v1-tickets.md §二 / src/admin-console/src/api/types.ts）：
//   成功 { code: 0, data: T }；错误 { code, message }；分页壳 { list, total, page, pageSize }
//   Order 字段与 admin-console/src/api/types.ts 的 Order 接口逐字段对齐：
//   orderNo/outTradeNo/transactionId/userId/userLabel/planLabel/channel/currency/
//   amount/refundAmount/status/createdAt/paidAt
//
// 「refunding 退款处理中」伪状态口径（前端 handlers.ts matchOrderStatus 同款）：
//   - 退款处理中 = payment_orders.status='refunded' 且 metadata 无 refund_amount
//   - 已退款     = status='refunded' 且 metadata.refund_amount 存在
//   真实退款实现（services/refund.js）里 status 与 metadata.refund_amount **同事务**写入，
//   所以正常链路不会产生「处理中」行；该筛选现在的作用是**把历史假退款（§4-A1 前
//   记账式实现改出来的 refunded）与被人工改库的行露出来**，供逐笔核账。
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { logAuditEvent } from '../../utils/audit.js';
import { requirePerm } from '../../middleware/adminAuth.js';
import { refundPaidOrder, RefundError } from '../../services/refund.js';
import { markOrderPaid } from '../../services/orderFulfillment.js';
import { queryTrade } from '../../utils/alipay.js';
import { roundToCent } from '../../services/proration.js';
import { sendNotification } from '../../ws/server.js';

const router = Router();

// ───────────────────────── 通用片段 ─────────────────────────

// 渠道归一化表达式：优先 payment_channel，缺失回退 payment_method（历史写入方只用过 payment_method）。
// §4-A4：识别不出渠道（mock/空值等）归入 'unknown' —— 项目**根本没有微信渠道**，
// 把认不出的单算成 wechat 会让对账/看板/占比三处一起虚高（宁可显式未知，不可造假）。
const CHANNEL_EXPR = "lower(coalesce(nullif(po.payment_channel, ''), po.payment_method, ''))";
const CHANNEL_CASE_SQL = `
  CASE
    WHEN ${CHANNEL_EXPR} LIKE '%stripe%' THEN 'stripe'
    WHEN ${CHANNEL_EXPR} LIKE '%alipay%' THEN 'alipay'
    WHEN ${CHANNEL_EXPR} LIKE '%wechat%' THEN 'wechat'
    ELSE 'unknown'
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
    -- 关单/异常到账留痕（M6 / H2）：只取这三个**派生值**下发给管理台。
    -- metadata 里还存着回调报文原文（closed_by_channel 那次的 raw payload），整包下发等于
    -- 把渠道原始报文透给前端，故一律走 ->> 取标量，不下发 metadata 本身。
    po.metadata->>'auto_closed' AS auto_closed,
    (po.metadata->>'closed_by_channel') = 'true' AS closed_by_channel,
    (po.metadata->>'channel_reports_paid') = 'true' AS channel_reports_paid,
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
// 'unknown' = §4-A4 的未识别渠道桶（前端筛选器暂无该项，允许直接带参访问便于排障）
const VALID_CHANNELS = new Set(['wechat', 'alipay', 'stripe', 'unknown']);
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
    // 关闭溯源：'timeout_unpaid' = orderCloseSweep 超时关单；closed_by_channel = 渠道
    // （TRADE_CLOSED 通知）关单。两者都为假时管理台不得再说成「超时未支付」。
    autoClosed: row.auto_closed != null ? String(row.auto_closed) : null,
    closedByChannel: row.closed_by_channel === true,
    // 异常到账：渠道报告已付款、本地订单却仍 pending（orderCloseSweep 查单发现，未关单）
    channelReportsPaid: row.channel_reports_paid === true,
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
router.get('/', requirePerm('admin.orders.view'), async (req, res) => {
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
router.get('/:orderNo', requirePerm('admin.orders.view'), async (req, res) => {
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
 * 服务层 RefundError → 管理台错误壳 { code:number, message:string }。
 * message 一律中文（管理台拦截器直接 toast message），`refundCode` 给前端做分支。
 * 数字码沿用本文件既有口径：4000 参数错 / 40005 状态不可退 / 40404 不存在 /
 * 5000 服务端错，新增 40006（渠道不支持）/ 40901（已退过）/ 40902（并发态变）/
 * 5020 渠道退款失败 / 5030 渠道未配置。
 *
 * export 给 routes/admin/refundReviews.js 复用：审核通过走的是同一个 refundPaidOrder，
 * 错误码与中文文案必须一处维护，否则同一个渠道错误在订单页和管理页会说两套话。
 */
export function refundErrorToAdmin(err) {
  const map = {
    MISSING_ORDER_KEY: [4000, '订单号不能为空'],
    ORDER_NOT_FOUND: [40404, '订单不存在'],
    ALREADY_REFUNDED: [40901, '该订单已退款，不能重复退款'],
    // 放宽后（isRefundableStatus）：已支付，或「渠道已确认收款」的 cancelled/pending 残留单也能退，
    // 文案不能再写"仅已支付订单"——那会把可退的单说成不可退，运营直接放弃处理。
    ORDER_NOT_REFUNDABLE: [40005, '该订单状态不可退款（仅已支付订单，或渠道已确认收款的订单可退）'],
    REFUND_CHANNEL_UNSUPPORTED: [40006, '该订单的支付渠道不支持在线退款，请线下退款后人工核账'],
    ALIPAY_NOT_CONFIGURED: [5030, '支付渠道凭据未配置，无法在线退款'],
    REFUND_CHANNEL_FAILED: [5020, '渠道退款失败，订单保持已支付（资金未退回）'],
    REFUND_NOT_CONFIRMED: [5020, '渠道未确认退款成功，订单保持已支付（资金未退回）'],
    REFUND_STATE_CONFLICT: [40902, '订单状态已变化，本次退款未落库，请刷新后复核'],
    REFUND_LOCAL_UPDATE_FAILED: [5000, '渠道已退款但本地状态更新失败，请立即人工核账'],
  };
  const [code, message] = map[err.code] || [5000, '退款执行失败'];
  return { code, message };
}

/**
 * POST /api/admin/orders/:orderNo/refund  body { amount?, reason }
 * 执行退款 —— **真实渠道退款**（§4-A1 修复）。
 *
 * 这里以前是一段「记账式退款」：只把订单改成 refunded、不调支付渠道，
 * 结果是「订单显示已退款 + 审计写成功 + 用户钱没退 + 权益可能还在」。
 * 现改为与 POST /api/payments/refund 同一实现（services/refund.js）：
 *   ① 权限：沿用本路由的 RBAC requirePerm('admin.orders.refund')
 *      （/api/payments/refund 用的是 users.is_admin，两套口径并存属 §4-A2，本次不收敛）；
 *   ② 资金：alipay.trade.refund 全额打款，仅 fund_status='Y' 才落库；
 *   ③ 权益：退款即收回 —— 关联订阅立即 canceled + canceled_at、users 冗余状态回 free，
 *      **不再**有「年付且全额才取消订阅」的旧口径（那是假退款时代的简化，PD3 已作废）；
 *   ④ 审计：服务写 payment_refund（资金流水口径），本路由另写
 *      admin.orders.refund（管理动作口径，审计页/筛选依赖该值，保留）。
 *
 * 请求契约变化（admin-console 需知）：
 *   - `amount` **可选**，给了就必须等于订单全额（容差到分），否则
 *     400 { code: 4000, error_code: 'PARTIAL_REFUND_NOT_SUPPORTED' } —— 本期两处
 *     都不支持部分退款；
 *   - 渠道非支付宝的订单不再「标记退款」，直接 400/40006；
 *   - 成功响应体不变（`data` 仍是 Order，status='refunded'、refundAmount=全额）。
 */
router.post('/:orderNo/refund', requirePerm('admin.orders.refund'), async (req, res) => {
  try {
    const { orderNo } = req.params;
    const body = req.body || {};
    const { amount } = body;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

    if (!orderNo || typeof orderNo !== 'string') {
      return res.status(400).json({ code: 4000, message: '订单号不合法' });
    }
    if (!reason) {
      return res.status(400).json({ code: 4000, message: '退款原因必填（写入审计日志）' });
    }

    // 定位订单（只读，不改状态）—— 用于「部分退款」闸与失败时的审计 details
    const { rows } = await pool.query(`${ORDER_SELECT} WHERE po.order_no = $1`, [orderNo]);
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '订单不存在' });
    }
    const found = rows[0];

    // 本期不支持部分退款：amount 缺省=全额放行，给了别的数就明确拒绝
    // （旧记账实现允许任意 ≤ 订单额的数字，那正是「假部分退款」的来源）
    if (amount !== undefined && amount !== null && amount !== '') {
      const requested = Number(amount);
      const full = roundToCent(found.amount);
      if (!Number.isFinite(requested) || roundToCent(requested) !== full) {
        logger.warn('[admin/orders] partial refund rejected', {
          orderNo,
          requested: amount,
          full,
          operator: req.user?.userId,
        });
        return res.status(400).json({
          code: 4000,
          error_code: 'PARTIAL_REFUND_NOT_SUPPORTED',
          message: '本期仅支持全额退款（部分退款请走线下渠道并人工核账）',
          orderAmount: full,
        });
      }
    }

    let result;
    try {
      result = await refundPaidOrder({
        orderNo,
        actorUserId: req.user?.userId,
        reason,
        ip: req.ip,
        userAgent: req.headers ? req.headers['user-agent'] : undefined,
      });
    } catch (err) {
      if (err instanceof RefundError) {
        const { code, message } = refundErrorToAdmin(err);
        return res.status(err.status).json({ code, message, refundCode: err.code, ...err.extra });
      }
      throw err;
    }

    // 管理动作审计（资金审计已由服务写 payment_refund；两者并存，各司其职）
    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.orders.refund',
      resourceType: 'payment_order',
      resourceId: String(result.order.id),
      details: {
        orderNo: result.order.orderNo,
        amount: result.order.refundAmount,
        reason,
        targetUserId: found.user_id,
        channel: 'alipay',
        fund_status: result.channel.fund_status,
        out_request_no: result.channel.out_request_no,
        subscriptionCanceled: result.entitlement.subscriptionCanceled,
        canceledSubscriptionId: result.entitlement.subscriptionId,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/orders] refund executed', {
      orderNo: result.order.orderNo,
      amount: result.order.refundAmount,
      operator: req.user?.userId,
    });

    // 回读订单 → Order 契约（与列表/详情同一映射，避免两套字段口径）
    const { rows: afterRows } = await pool.query(`${ORDER_SELECT} WHERE po.order_no = $1`, [
      result.order.orderNo,
    ]);
    if (afterRows.length === 0) {
      return res.status(500).json({ code: 5000, message: '退款已完成但订单回读失败，请刷新后复核' });
    }

    return res.json({ code: 0, data: mapOrderRow(afterRows[0]) });
  } catch (err) {
    logger.error('[admin/orders] refund failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '退款执行失败' });
  }
});

// ───────────────────────── 开票信息（补录） ─────────────────────────

/**
 * 开票信息行查询。
 *
 * 为什么要这个端点：`invoices` 有 `title` / `tax_no` 两列，但**履约链路从不写它们**
 *（`services/orderFulfillment.js` 建票只写 user/subscription/order/invoice_no/amount/
 * tax_amount/status）。而发票 PDF（`utils/pdf-invoice.js`）在抬头/税号为空时**整行不显** ——
 * 也就是说：收据上写着「如需增值税发票请联系客服提供开票信息」，客服**没有任何工具**能录入，
 * 只能改库。合规面上这是"被文案指引却没有落点"的空洞。
 *
 * 落点选择：挂在订单下（`/orders/:orderNo/invoice`）而不是新建 admin 发票页 ——
 * 发票本就是某笔订单的履约产物，客服的工作流是"看着这笔订单补开票信息"，
 * 而且 `orders.js` 已经有订单定位（ORDER_SELECT）与既有约定。
 */
function mapInvoiceRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    title: row.title || null,
    taxNo: row.tax_no || null,
    amount: row.amount != null ? Number(row.amount) : null,
    taxAmount: row.tax_amount != null ? Number(row.tax_amount) : null,
    status: row.status,
    issuedAt: row.issued_at ? new Date(row.issued_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

const INVOICE_SELECT = `
  SELECT id, invoice_no, title, tax_no, amount, tax_amount, status, issued_at, created_at
    FROM invoices
   WHERE payment_order_id = $1
   ORDER BY created_at DESC
   LIMIT 1`;

/**
 * GET /api/admin/orders/:orderNo/invoice
 * 查这笔订单的开票信息（含抬头/税号），供补录弹窗回填。
 * 无发票时返回 `{ hasInvoice: false }`（**200 而非 404**）—— "这笔单还没开票"是正常状态，
 * 不是错误，前端据此提示"先完成履约"而不是弹一个错误。
 */
router.get('/:orderNo/invoice', requirePerm('admin.orders.view'), async (req, res) => {
  try {
    const { orderNo } = req.params;
    if (!orderNo || typeof orderNo !== 'string') {
      return res.status(400).json({ code: 4000, message: '订单号不合法' });
    }
    const { rows } = await pool.query(`${ORDER_SELECT} WHERE po.order_no = $1`, [orderNo]);
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '订单不存在' });
    }
    const found = rows[0];
    const { rows: invoiceRows } = await pool.query(INVOICE_SELECT, [found.id]);
    const invoice = mapInvoiceRow(invoiceRows[0]);
    return res.json({
      code: 0,
      data: { hasInvoice: Boolean(invoice), orderNo, invoice },
    });
  } catch (err) {
    logger.error('[admin/orders] get invoice failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取开票信息失败' });
  }
});

/**
 * PATCH /api/admin/orders/:orderNo/invoice  body { title?, taxNo?, reason }
 * 补录开票信息（抬头 / 税号）—— 2026-10-05 新增。
 *
 * 口径：
 *   - `title` 与 `taxNo` **至少给一项**；给了就校验（抬头 ≤200 且非空；税号 5–50 位字母数字，
 *     不接受空格/中日韩字符 —— 税号要印在税务凭证上，不能是随手粘的文本）；
 *   - 发票状态为 `void`（已作废）时拒绝：在作废凭证上改抬头/税号没有意义，也会误导人；
 *   - 无发票 → 404（先完成履约才有票）；
 *   - 原因必填；审计 `admin.invoice.update` 记**改动前后**与发票号（税号不是密钥，
 *     它本来就印在票面上，留痕对事后核对有价值）；
 *   - 通知用户：他是这条信息的提供方，改完应当知道可以重新下载了；
 *   - 权限用 `admin.orders.refund`：这是**财务/税务凭证**上的写入，与退款同属资金级
 *     订单写操作；也避免为细分语义去动 043 权限目录的迁移（生产落后分支很远）。
 *     已进高危限流名单（名单方法判定已修，见 admin/index.js 的 isAdminStrictWrite）。
 */
router.patch('/:orderNo/invoice', requirePerm('admin.orders.refund'), async (req, res) => {
  try {
    const { orderNo } = req.params;
    if (!orderNo || typeof orderNo !== 'string') {
      return res.status(400).json({ code: 4000, message: '订单号不合法' });
    }
    const body = req.body || {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({ code: 4000, message: '补录开票信息必须填写原因（写入审计日志）' });
    }
    if (reason.length > 200) {
      return res.status(400).json({ code: 4000, message: '原因不能超过 200 字' });
    }

    const hasTitle = body.title !== undefined && body.title !== null;
    const hasTaxNo = body.taxNo !== undefined && body.taxNo !== null;
    if (!hasTitle && !hasTaxNo) {
      return res.status(400).json({ code: 4000, message: '发票抬头与税号至少提供一项' });
    }

    let cleanTitle = null; // null = 不改
    if (hasTitle) {
      const title = String(body.title).trim();
      if (!title) {
        return res.status(400).json({ code: 4000, message: '发票抬头不能为空（不修改请别传该字段）' });
      }
      if (title.length > 200) {
        return res.status(400).json({ code: 4000, message: '发票抬头不能超过 200 字' });
      }
      cleanTitle = title;
    }

    let cleanTaxNo = null;
    if (hasTaxNo) {
      const taxNo = String(body.taxNo).trim();
      if (!/^[A-Za-z0-9]{5,50}$/.test(taxNo)) {
        return res.status(400).json({
          code: 4000,
          message: '纳税人识别号应为 5–50 位字母或数字（不含空格等其它字符）',
        });
      }
      cleanTaxNo = taxNo;
    }

    const { rows } = await pool.query(`${ORDER_SELECT} WHERE po.order_no = $1`, [orderNo]);
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '订单不存在' });
    }
    const found = rows[0];

    const { rows: invoiceRows } = await pool.query(INVOICE_SELECT, [found.id]);
    if (invoiceRows.length === 0) {
      return res.status(404).json({
        code: 40404,
        message: '该订单还没有发票（履约完成后才会开票），暂时无法补录开票信息',
      });
    }
    const before = invoiceRows[0];
    if (before.status === 'void') {
      return res.status(409).json({
        code: 40906,
        reason: 'INVOICE_VOID',
        message: '该发票已作废，不能再修改抬头/税号；请按正常流程重新开票',
      });
    }

    const sets = [];
    const params = [before.id];
    if (cleanTitle !== null) {
      params.push(cleanTitle);
      sets.push(`title = $${params.length}`);
    }
    if (cleanTaxNo !== null) {
      params.push(cleanTaxNo);
      sets.push(`tax_no = $${params.length}`);
    }

    const { rows: updatedRows } = await pool.query(
      `UPDATE invoices SET ${sets.join(', ')}
        WHERE id = $1
        RETURNING id, invoice_no, title, tax_no, amount, tax_amount, status, issued_at, created_at`,
      params
    );
    const updated = updatedRows[0];

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.invoice.update',
      resourceType: 'invoice',
      resourceId: String(before.id),
      details: {
        orderNo,
        invoiceNo: before.invoice_no,
        targetUserId: found.user_id,
        reason,
        titleFrom: before.title || null,
        titleTo: cleanTitle,
        taxNoFrom: before.tax_no || null,
        taxNoTo: cleanTaxNo,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    try {
      await sendNotification(found.user_id, {
        notificationType: 'subscription_notice',
        title: '你的发票信息已更新',
        body: `订单 ${orderNo} 的发票抬头/税号已按你提供的信息更新，可到「发票」页重新下载。`,
        data: { orderNo, invoiceNo: before.invoice_no },
      });
    } catch (notifyErr) {
      logger.warn('[admin/orders] invoice update notify failed (ignored)', {
        invoiceId: before.id,
        error: notifyErr?.message,
      });
    }

    logger.info('[admin/orders] invoice info updated', {
      invoiceNo: before.invoice_no,
      orderNo,
      operator: req.user?.userId,
    });

    return res.json({
      code: 0,
      data: { orderNo, invoice: mapInvoiceRow(updated) },
      message: '开票信息已补录，用户重新下载发票即可看到抬头/税号',
    });
  } catch (err) {
    logger.error('[admin/orders] invoice update failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '补录开票信息失败' });
  }
});

// ───────────────────────── 人工补履约 ─────────────────────────

/**
 * POST /api/admin/orders/:orderNo/fulfill  body { reason }
 * 人工补履约（2026-10-05 新增）—— 渠道回调丢失时「钱到了、货没到」的唯一人工出口。
 *
 * 为什么之前只能改库：履约函数 `markOrderPaid` 只有两个调用来源 —— 渠道回调
 *（paymentWebhooks.js）与**用户自己**查单兜底（payments.js，且限定 `user_id = 自己`）。
 * admin 侧零落点，于是「用户付了钱、回调没到、他也不再去点开客户端」这种情况只能干等，
 * 或者改库复刻整段事务（订阅 + 发票 + users 快照，漏一步就不一致）。
 *
 * ⚠️ 本端点最重要的设计：**必须先向渠道核实到账，再履约**。
 *   - `queryTrade(orderNo)` 取渠道 `trade_status`；不是 TRADE_SUCCESS / TRADE_FINISHED 一律拒
 *     —— 绝不允许「管理员点一下就把货开了」（那就是凭空发货）；
 *   - 把渠道回的 `total_amount` 作为 `expectedAmount` 交给 markOrderPaid，
 *     **金额闸照旧生效**（不符会拒并落 `metadata.amount_mismatch`，进看板第 6 类待办）；
 *   - 渠道没回金额 → 也拒（fail-closed：无从核对就不发）；
 *   - 渠道调用失败（未配置/网络）→ 503（核实不了就不动）。
 *
 * 其余口径**不另立一套**，与 markOrderPaid 保持一致：
 *   - 已履约（paid）→ 409；
 *   - cancelled / failed → 409，**不**补履约（服务里就写着「已取消/失败的订单不接受支付，
 *     需人工介入退款」）—— 这种残留单应当走退款把钱退回去，而不是把货给出去；
 *   - refunded → 409（钱已退回，再发货等于白送）；
 *   - 非支付宝渠道（mock / 历史单）→ 409（无法向渠道核实，禁止履约）。
 *
 * 权限复用 admin.orders.refund：同属「资金级订单写操作」，能决定这笔钱去向的人本就该能
 * 决定发不发货；也避免为细分语义去动 043 权限目录的迁移（生产落后分支很远，不值得冒险）。
 */
router.post('/:orderNo/fulfill', requirePerm('admin.orders.refund'), async (req, res) => {
  try {
    const { orderNo } = req.params;
    const body = req.body || {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

    if (!orderNo || typeof orderNo !== 'string') {
      return res.status(400).json({ code: 4000, message: '订单号不合法' });
    }
    if (!reason) {
      return res.status(400).json({ code: 4000, message: '补履约原因必填（写入审计日志）' });
    }
    if (reason.length > 200) {
      return res.status(400).json({ code: 4000, message: '原因不能超过 200 字' });
    }

    const { rows } = await pool.query(`${ORDER_SELECT} WHERE po.order_no = $1`, [orderNo]);
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '订单不存在' });
    }
    const found = rows[0];

    if (found.status === 'paid') {
      return res
        .status(409)
        .json({ code: 40904, reason: 'ALREADY_PAID', message: '该订单已履约，无需补履约' });
    }
    if (found.status === 'refunded') {
      return res.status(409).json({
        code: 40904,
        reason: 'ALREADY_REFUNDED',
        message: '该订单已退款，不能再补履约（钱已退回，再发货等于白送）',
      });
    }
    if (found.status === 'cancelled' || found.status === 'failed') {
      return res.status(409).json({
        code: 40904,
        reason: 'ORDER_NOT_PAYABLE',
        message: `该订单已${found.status === 'cancelled' ? '关闭' : '失败'}：按既有口径不接受补履约，若渠道确有到账请用「退款」把钱原路退回`,
      });
    }
    if (found.channel !== 'alipay') {
      return res.status(409).json({
        code: 40904,
        reason: 'CHANNEL_UNVERIFIABLE',
        message: `该订单渠道为 ${found.channel}，无法向渠道核实到账，禁止补履约`,
      });
    }

    // ★先向渠道核实 —— 不是"管理员说有就有"
    let trade;
    try {
      trade = await queryTrade(orderNo);
    } catch (err) {
      logger.error('[admin/orders] fulfill: channel query failed', { orderNo, error: err.message });
      return res.status(503).json({
        code: 5030,
        reason: 'CHANNEL_QUERY_FAILED',
        message: '无法向支付宝核实该订单（未配置或网络异常），已拒绝履约',
      });
    }

    const tradeStatus = trade.tradeStatus || null;
    if (!trade.paid) {
      return res.status(409).json({
        code: 40904,
        reason: 'CHANNEL_NOT_PAID',
        channelTradeStatus: tradeStatus,
        message: `支付宝返回该订单未支付（trade_status=${tradeStatus ?? '未知'}），拒绝履约`,
      });
    }
    const channelAmount =
      trade.raw && trade.raw.total_amount != null ? String(trade.raw.total_amount) : '';
    if (!channelAmount) {
      return res.status(409).json({
        code: 40904,
        reason: 'CHANNEL_AMOUNT_MISSING',
        message: '支付宝未回传订单金额，无从核对，已拒绝履约（fail-closed）',
      });
    }

    const result = await markOrderPaid({
      orderNo,
      transactionId: trade.tradeNo || null,
      channel: 'alipay',
      expectedAmount: channelAmount,
      rawPayload: {
        source: 'admin_manual_fulfill',
        tradeStatus,
        tradeNo: trade.tradeNo || null,
        operator: req.user?.userId ?? null,
      },
    });

    if (!result.ok) {
      // 如实回传失败原因，不吞：金额不符/状态竞态都是要人工看的
      const failureMap = {
        order_cancelled: [409, 40904, '该订单已关闭，不接受补履约（请走退款）'],
        order_failed: [409, 40904, '该订单为失败态，不接受补履约'],
        amount_mismatch: [
          409,
          40905,
          `渠道金额(${channelAmount})与订单金额不一致，已拒绝履约并留痕，请人工核账`,
        ],
        order_not_found: [404, 40404, '订单不存在'],
      };
      const [status, code, message] = failureMap[result.reason] || [
        409,
        40904,
        `补履约被拒绝（${result.reason}）`,
      ];
      return res.status(status).json({ code, reason: result.reason, message });
    }

    // 并发竞态：我们读到的是 pending，但 markOrderPaid 执行时已被渠道回调履约完成。
    // 目标状态**已达成**，所以按成功回（与 webhook 把 already_paid 当 success 同一口径）；
    // 但文案必须说清"这不是本次操作做的"，并且**不写** manual_fulfill 审计 ——
    // 否则审计里会出现一条"管理员补了履约"，而实际上货是回调开的。
    if (result.reason === 'already_paid') {
      const { rows: racedRows } = await pool.query(`${ORDER_SELECT} WHERE po.order_no = $1`, [
        orderNo,
      ]);
      return res.json({
        code: 0,
        data: racedRows[0] ? mapOrderRow(racedRows[0]) : null,
        message: '该订单已在本次操作期间由渠道回调完成履约，无需重复操作',
      });
    }

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.order.manual_fulfill',
      resourceType: 'payment_order',
      resourceId: String(result.order?.id ?? found.id),
      details: {
        orderNo,
        targetUserId: found.user_id,
        amount: found.amount,
        // 留痕：这次履约是**凭渠道核实结果**做的，把核实到的东西一并记下
        channelTradeStatus: tradeStatus,
        channelAmount,
        transactionId: trade.tradeNo || null,
        reason,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/orders] manual fulfill executed', {
      orderNo,
      tradeStatus,
      channelAmount,
      operator: req.user?.userId,
    });

    const { rows: afterRows } = await pool.query(`${ORDER_SELECT} WHERE po.order_no = $1`, [orderNo]);
    return res.json({
      code: 0,
      data: afterRows[0] ? mapOrderRow(afterRows[0]) : null,
      message: `已按渠道核实结果补履约（支付宝 ${tradeStatus}，金额 ${channelAmount}）`,
    });
  } catch (err) {
    logger.error('[admin/orders] fulfill failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '补履约失败' });
  }
});

// ───────────────────────── 对账报告 ─────────────────────────

const reconciliationRouter = Router();

/**
 * GET /api/admin/reconciliation
 * 对账报告（按渠道汇总近 30 天成交笔数/金额与退款额）。
 * 返回 { generatedAt, rows: [{ channel, label, paidCount, paidAmount, refundAmount }] }，
 * rows 固定微信支付/支付宝/Stripe 三行（无数据的渠道补 0）。
 *
 * §4-A4 连带：未识别渠道（mock / payment_channel 为空的历史单）不再被算进「微信支付」，
 * 改为单独一行 `channel:'unknown'`（label 由服务端给出，前端表格读 label 渲染）。
 * **仅在该桶真的有钱/有退款时才追加这一行** —— 当前生产全量支付宝，前端看到的仍是三行；
 * 等真出现未识别渠道时它必须可见，否则「合计」会静默少钱（对账最怕少）。
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

    const toRow = (channel, label, r) => ({
      channel,
      label,
      paidCount: r ? Number(r.paid_count) : 0,
      paidAmount: r ? Number(r.paid_amount) : 0,
      refundAmount: r ? Number(r.refund_amount) : 0,
    });

    const unknown = byChannel.get('unknown');
    const data = {
      generatedAt,
      rows: Object.entries(CHANNEL_LABELS).map(([channel, label]) =>
        toRow(channel, label, byChannel.get(channel))
      ),
    };
    if (unknown && (Number(unknown.paid_count) > 0 || Number(unknown.paid_amount) > 0)) {
      data.rows.push(toRow('unknown', '未识别渠道（mock/历史单）', unknown));
    }

    return res.json({ code: 0, data });
  } catch (err) {
    logger.error('[admin/orders] reconciliation failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '生成对账报告失败' });
  }
});

export default router;
export { reconciliationRouter };
