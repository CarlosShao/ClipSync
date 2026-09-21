// =============================================
// 属主自助退款的风控闸（唯一实现）
//
// 背景（产品决策 2026-09-19 变更）：客户端个人资料页开放「申请退款」入口 ⇒
// 订单**属主本人**可以不打客服直接退款。资金动作仍是 services/refund.js 的
// refundPaidOrder（真打款、渠道确认才落库、退款即收回权益），本文件只回答
// 一个问题：「这一单，现在允许由属主自助退吗？不允许的话理由是什么？」
//
// 为什么单独抽一个模块，而不是把判定写在路由里：
//   这个判定有**两个调用方**，而且它们必须给出完全一致的答案 ——
//     ① POST /api/payments/refund —— 强制拦截（属主分支）；
//     ② GET  /api/payments/refundable-orders —— 给客户端弹窗预先标注 refundable/reasonCode。
//   一旦两处各写一份，最典型的漂移就是「列表说可退、点了却 409」或反过来
//   「列表说不可退、接口其实退得掉」（后者是可被用户拿来做薅羊毛试探的口子）。
//   判定是纯函数（evaluateSelfRefund），只有「锚定单」要查库
//   （findSelfRefundAnchorOrderId），因此边界可以用单测钉死。
//
// 判定顺序（自上而下，第一个不满足的就是返回的理由）：
//   1. status：refunded → ALREADY_REFUNDED；非 paid → ORDER_NOT_REFUNDABLE
//      （与 refundPaidOrder 同码，不新造第二套语义）；
//   2. channel：非 alipay → CHANNEL_UNSUPPORTED（mock/stripe 历史单只能线下退，
//      与「付进来的路径」不对称的在线退款绝不给自助通道）；
//   3. **锚定单**：不是「当前生效订阅的最近一笔已支付订单」→ NOT_CURRENT_SUB_ORDER。
//      ⚠️ 这条 2026-09-19 被用户实测打回过一次：旧口径「用户最近一笔 paid 订单」
//      在退掉锚定单后会**顺移**到上一笔 —— 等于把历史订单依次退干净（用了三个月
//      的钱全退回来，白嫖整个周期）。新口径把锚定单钉死在「当前 active 且未到期」
//      的订阅上：退款成功 → 该订阅 canceled → 锚点消失 → 其余任何已付/已退订单
//      永不顺移可退。无 active 订阅（到期回落/已退过）时 anchor 为 null，全拒。
//      这是**自助专属**限制（管理台仍可强退）；
//   4. 支付时间窗口：paid_at 距今 > SELF_REFUND_WINDOW_DAYS → REFUND_WINDOW_EXPIRED。
//      paid_at 缺失/非法按「超窗」处理（fail closed，宁可拒绝）。
//
// 与 refundPaidOrder 的分工（2026-09-20 两段式退款后）：
//   用户点「申请退款」时**不发生资金动作**（services/refundRequest.js 只落申请单 +
//   收回权益），所以本文件产出的**任何** !refundable 码都由申请端点直接拒掉，
//   不再存在「交回 refundPaidOrder 统一报错」那半边。refundPaidOrder 只在管理员
//   审核通过时被调用，它自己的 status/channel 校验照旧保留 —— 那是资金动作前的
//   最后一道复核，与这里的入口闸是双保险，不是重复实现。
// =============================================

import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';

/** 自助退款窗口（天）的**兜底默认值**：system_configs 读不到/非法时用它 */
export const SELF_REFUND_WINDOW_DAYS = 7;

/** 审核承诺工作日数默认值（只进客户端文案，不参与任何资金判定） */
export const DEFAULT_REVIEW_BUSINESS_DAYS = 3;

/** system_configs 里的两个可配置键（不登记进 admin/configs.js 的 CONFIG_CATALOG） */
export const REFUND_CONFIG_KEYS = {
  windowDays: 'refund_self_window_days',
  reviewBusinessDays: 'refund_review_business_days',
};

/** 只有支付宝能原路在线退回，故只有它开放自助退款 */
export const SELF_REFUND_CHANNEL = 'alipay';

/** 列表接口最多回溯的订单条数（只用于「申请退款」弹窗，够看清最近几笔即可） */
export const REFUNDABLE_ORDERS_LIMIT = 10;

/**
 * 本模块取数口径：硬编码列清单，绝不把调用方拼进来的字符串当 SQL。
 * order_no/currency 是给 refundable-orders 的响应用的（弹窗要显示单号），
 * POST /refund 的定位查询也用这一份，两条端点因此不可能读到不同的列。
 */
export const SELF_REFUND_ORDER_COLUMNS = `id, order_no, user_id, status, payment_channel,
       payment_method, paid_at, amount, currency, metadata`;

/** refundable-orders 的 reasonCode 取值（响应契约，客户端按此出文案） */
export const REFUND_REASON_CODES = Object.freeze({
  ALREADY_REFUNDED: 'ALREADY_REFUNDED',
  REFUND_WINDOW_EXPIRED: 'REFUND_WINDOW_EXPIRED',
  NOT_CURRENT_SUB_ORDER: 'NOT_CURRENT_SUB_ORDER',
  CHANNEL_UNSUPPORTED: 'CHANNEL_UNSUPPORTED',
  // 已有在途申请：列表与申请端点共用同一个码，客户端据此显示「退款审核中」
  REFUND_REQUEST_PENDING: 'REFUND_REQUEST_PENDING',
  // 防御性取值：理论上列表只会取 paid/refunded，其它状态沿用 refundPaidOrder 的错误码
  ORDER_NOT_REFUNDABLE: 'ORDER_NOT_REFUNDABLE',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SETTINGS_TTL_MS = 5000;

let settingsCache = null;
let settingsCachedAt = 0;

function toPositiveInt(raw, fallback) {
  const n = Number(typeof raw === 'string' ? raw.trim() : raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * 读退款相关配置（带 5s 进程内 TTL）。
 *
 * 为什么读库失败要回退默认值而不是抛错：这两个数只决定「放行还是拒绝」与文案，
 * 默认值是**更保守**的那一侧（7 天窗口照样存在），配置表抖动不该让退款入口整片 500。
 *
 * @returns {Promise<{windowDays: number, reviewBusinessDays: number}>}
 */
export async function getRefundSettings() {
  const now = Date.now();
  if (settingsCache && now - settingsCachedAt < SETTINGS_TTL_MS) return settingsCache;

  let rows = [];
  try {
    ({ rows } = await pool.query(
      'SELECT config_key, config_value FROM system_configs WHERE config_key = ANY($1)',
      [[REFUND_CONFIG_KEYS.windowDays, REFUND_CONFIG_KEYS.reviewBusinessDays]]
    ));
  } catch (err) {
    logger.warn('[refundPolicy] read refund configs failed, using defaults', { error: err.message });
  }
  const byKey = new Map(rows.map((r) => [r.config_key, r.config_value]));
  settingsCache = {
    windowDays: toPositiveInt(byKey.get(REFUND_CONFIG_KEYS.windowDays), SELF_REFUND_WINDOW_DAYS),
    reviewBusinessDays: toPositiveInt(
      byKey.get(REFUND_CONFIG_KEYS.reviewBusinessDays),
      DEFAULT_REVIEW_BUSINESS_DAYS
    ),
  };
  settingsCachedAt = now;
  return settingsCache;
}

/** 只给测试用：清掉 TTL 缓存，避免用例之间互相读到上一个配置值 */
export function clearRefundSettingsCache() {
  settingsCache = null;
  settingsCachedAt = 0;
}

/** 渠道归一口径（与 refundPaidOrder 完全一致：payment_channel 优先，回退 payment_method） */
export function normalizeOrderChannel(order) {
  return String(order?.payment_channel || order?.payment_method || '').toLowerCase();
}

function deny(reasonCode, message, extra = {}) {
  return { refundable: false, reasonCode, message, extra };
}

/**
 * 判定一条订单能否由属主自助退款（纯函数，不查库）。
 *
 * @param {object} p
 * @param {object} p.order 含 status/payment_channel/payment_method/paid_at/id 的订单行
 *        （列口径见 SELF_REFUND_ORDER_COLUMNS）
 * @param {string|null} p.anchorOrderId 「当前生效订阅的最近一笔已支付订单」id
 *        （findSelfRefundAnchorOrderId 的结果；null = 无可退锚点，一律拒）
 * @param {number} [p.windowDays] 时限（天）；省略时用 SELF_REFUND_WINDOW_DAYS 兜底值。
 *        生产传 getRefundSettings() 的结果——时限已挪到后台可配置，判定函数本身不查库。
 * @param {Date} [p.now] 判定基准时间（单测注入，生产用当前时间）
 * @returns {{refundable: boolean, reasonCode: string|null, message: string, extra: object}}
 */
export function evaluateSelfRefund({ order, anchorOrderId, windowDays, now = new Date() } = {}) {
  if (!order) {
    return deny(REFUND_REASON_CODES.ORDER_NOT_FOUND, 'Order not found');
  }

  const status = String(order.status || '').toLowerCase();
  if (status === 'refunded') {
    return deny(REFUND_REASON_CODES.ALREADY_REFUNDED, 'Order already refunded');
  }
  if (status !== 'paid') {
    return deny(REFUND_REASON_CODES.ORDER_NOT_REFUNDABLE, 'Order is not paid, cannot refund', {
      status: order.status ?? null,
    });
  }

  const channel = normalizeOrderChannel(order);
  if (channel !== SELF_REFUND_CHANNEL) {
    return deny(
      REFUND_REASON_CODES.CHANNEL_UNSUPPORTED,
      `Channel ${channel || 'unknown'} cannot be refunded online, please refund out-of-band`,
      { channel: channel || 'unknown' }
    );
  }

  // 只允许退「当前生效订阅的最近一笔已支付订单」：
  // 锚点之外的单（历史订阅的单 / 同订阅更早的续费单 / 已退过之后顺移来的旧单）一律拒。
  if (!anchorOrderId || String(anchorOrderId) !== String(order.id)) {
    return deny(
      REFUND_REASON_CODES.NOT_CURRENT_SUB_ORDER,
      'Only the latest paid order of your current active subscription can be refunded by yourself; contact support for other orders',
      { anchorOrderId: anchorOrderId ?? null }
    );
  }

  const paidAt = order.paid_at ? new Date(order.paid_at) : null;
  const paidAtValid = Boolean(paidAt) && !Number.isNaN(paidAt.getTime());
  // paid_at 缺失/非法 → age=Infinity → 判超窗（fail closed，不放过任何一笔说不清时间的单）
  const ageMs = paidAtValid ? new Date(now).getTime() - paidAt.getTime() : Infinity;
  const days = toPositiveInt(windowDays, SELF_REFUND_WINDOW_DAYS);
  if (ageMs > days * MS_PER_DAY) {
    return deny(
      REFUND_REASON_CODES.REFUND_WINDOW_EXPIRED,
      `Self-service refund is only available within ${days} days after payment, please contact support`,
      { paidAt: paidAtValid ? paidAt.toISOString() : null, windowDays: days }
    );
  }

  return { refundable: true, reasonCode: null, message: 'Refundable', extra: {} };
}

/**
 * 「锚定单」：当前生效订阅（active 且未到期）的最近一笔已支付订单 id。
 * 无 active 订阅 / 该订阅没有任何已支付订单 → null（自助退款全部拒绝）。
 *
 * 防顺移的关键就在「active 且未到期」这个前置：退款成功后服务层会把订阅
 * canceled —— 锚点随即消失，同一用户的其余历史订单**不会**因为退掉一笔而
 * 依次变成可退（旧口径「用户最近一笔 paid 订单」正是栽在这里，见文件头注释）。
 *
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
export async function findSelfRefundAnchorOrderId(userId) {
  if (!userId) return null;
  const { rows } = await pool.query(
    `SELECT po.id
       FROM payment_orders po
       JOIN user_subscriptions us ON us.id = po.subscription_id
      WHERE po.user_id = $1
        AND po.status = 'paid'
        AND us.status = 'active'
        AND us.current_period_end > NOW()
      ORDER BY us.current_period_end DESC, po.paid_at DESC NULLS LAST, po.created_at DESC
      LIMIT 1`,
    [userId]
  );
  return rows[0]?.id ?? null;
}

/**
 * 列表接口的回溯查询：最近 N 条 paid / refunded 订单（按支付时间倒序）。
 * 只返回当前用户自己的单（user_id 条件），越权无从谈起。
 *
 * @param {string} userId
 * @param {number} [limit]
 * @returns {Promise<Array<object>>}
 */
export async function listRefundCandidateOrders(userId, limit = REFUNDABLE_ORDERS_LIMIT) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || REFUNDABLE_ORDERS_LIMIT, 50));
  const { rows } = await pool.query(
    `SELECT ${SELF_REFUND_ORDER_COLUMNS}
       FROM payment_orders
      WHERE user_id = $1 AND status IN ('paid', 'refunded')
      ORDER BY paid_at DESC NULLS LAST
      LIMIT $2`,
    [userId, safeLimit]
  );
  return rows;
}

export default {
  SELF_REFUND_WINDOW_DAYS,
  DEFAULT_REVIEW_BUSINESS_DAYS,
  REFUND_CONFIG_KEYS,
  SELF_REFUND_CHANNEL,
  REFUNDABLE_ORDERS_LIMIT,
  REFUND_REASON_CODES,
  getRefundSettings,
  clearRefundSettingsCache,
  evaluateSelfRefund,
  findSelfRefundAnchorOrderId,
  listRefundCandidateOrders,
};
