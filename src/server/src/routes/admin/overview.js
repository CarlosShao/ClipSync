// =============================================
// Admin Console · 数据看板聚合 API（Admin Console · T-A1.5 补票）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/overview', overviewRouter) → GET /api/admin/overview
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 权限：GET 聚合仅要求 requireRole(50) 门槛（权限目录中无 overview 对应权限点，
//       与 orders/subscriptions 各 GET 列表口径一致）。
//
// 响应契约（src/admin-console/src/api/types.ts OverviewData + mocks/handlers.ts
// overview handler 逐字段对齐）：
//   {
//     statsAt: 'YYYY-MM-DD HH:mm',
//     kpis: { totalUsers, weekNewUsers, weekGrowthRate, monthRevenue, revenueGrowthRate,
//             refundRate, mrr, mrrYearlySharePercent, onlineDevices, devicesDelta,
//             paidUsers, conversionRate, trialingUsers },
//     orders14d: [{ date: 'YYYY-MM-DD', amount, refund }] × 14（generate_series 补零）,
//     planDistribution: [{ plan: free|pro|enterprise, count }]（固定三行）,
//     channels: [{ channel, label, percent }]（固定三行）,
//     pendingItems: []   // 真实待办（退款审核/试用到期/对账差异/异常登录）后续迭代接入
//   }
//
// 口径说明（无历史快照表的简化定义，均为可复算的即时聚合）：
//   - orders14d.amount   = 当日 paid_at 落在当天、status ∈ (paid, refunded) 的金额；
//     orders14d.refund   = 同口径订单 metadata.refund_amount 合计（退款归属支付当日）；
//   - mrr                = active 订阅 月付价 + 年付价/12 的合计；
//   - devicesDelta       = 当前在线数 − 24~48h 前活跃（last_seen_at 窗口）设备数；
//   - 渠道占比           = 近 30 天 paid/refunded 订单按渠道笔数占比（归一化 100 内可差 1）。
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// 渠道归一化（与 orders.js CHANNEL_CASE_SQL 同口径：payment_channel 优先，回退 payment_method，
// 识别不出归入 wechat，保证与前端 PaymentChannel 三值类型兼容）
const CHANNEL_EXPR = "lower(coalesce(nullif(po.payment_channel, ''), po.payment_method, ''))";
const CHANNEL_CASE_SQL = `
  CASE
    WHEN ${CHANNEL_EXPR} LIKE '%stripe%' THEN 'stripe'
    WHEN ${CHANNEL_EXPR} LIKE '%alipay%' THEN 'alipay'
    ELSE 'wechat'
  END`;

const CHANNEL_LABELS = { wechat: '微信支付', alipay: '支付宝', stripe: 'Stripe' };
const PLAN_KEYS = ['free', 'pro', 'enterprise'];

/** 保留 1 位小数（增长率/占比口径） */
function round1(n) {
  return Math.round(n * 10) / 10;
}

/** 增长率（%）：上期为 0 时，本期有量记 100%、无量记 0% */
function growthRate(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return round1(((current - previous) / previous) * 100);
}

/** 'YYYY-MM-DD HH:mm'（statsAt 快照时间，与 reconciliation generatedAt 同形态） */
function formatStatsAt() {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

/**
 * GET /api/admin/overview
 * 看板聚合：KPI + 近 14 天订单（含退款叠加）+ 套餐分布 + 渠道占比 + 待处理事项。
 */
router.get('/', async (req, res) => {
  try {
    // ── 1. 注册用户 KPI（本周/上周新增）──
    const { rows: userRows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total_users,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS week_new_users,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '14 days'
                          AND created_at < NOW() - INTERVAL '7 days')::int AS prev_week_new_users
      FROM users`);

    // ── 2. 营收 KPI（本月成交 / 上月成交 / 近 30 天退款率）──
    const { rows: revenueRows } = await pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE paid_at >= date_trunc('month', NOW())), 0)::float8 AS month_revenue,
        COALESCE(SUM(amount) FILTER (WHERE paid_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
                                      AND paid_at < date_trunc('month', NOW())), 0)::float8 AS prev_month_revenue,
        COALESCE(SUM(amount) FILTER (WHERE paid_at >= NOW() - INTERVAL '30 days'), 0)::float8 AS paid_30d,
        COALESCE(SUM(COALESCE(NULLIF(metadata->>'refund_amount', ''), '0')::numeric)
                 FILTER (WHERE paid_at >= NOW() - INTERVAL '30 days'), 0)::float8 AS refund_30d
      FROM payment_orders
      WHERE status IN ('paid', 'refunded') AND paid_at IS NOT NULL`);

    // ── 3. MRR（active 订阅：月付价 + 年付价/12）──
    const { rows: mrrRows } = await pool.query(`
      SELECT
        COALESCE(SUM(CASE us.billing_cycle WHEN 'yearly' THEN sp.price_yearly / 12.0
                                           ELSE sp.price_monthly END), 0)::float8 AS mrr_total,
        COALESCE(SUM(CASE WHEN us.billing_cycle = 'yearly' THEN sp.price_yearly / 12.0
                          ELSE 0 END), 0)::float8 AS mrr_yearly_part
      FROM user_subscriptions us
      JOIN subscription_plans sp ON sp.id = us.plan_id
      WHERE us.status = 'active'`);

    // ── 4. 设备（在线数 / 24~48h 前活跃数）──
    const { rows: deviceRows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_online)::int AS online_devices,
        COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '48 hours'
                          AND last_seen_at < NOW() - INTERVAL '24 hours')::int AS online_prev_day
      FROM devices`);

    // ── 5. 付费用户 / 试用中用户 ──
    const { rows: paidRows } = await pool.query(`
      SELECT
        (SELECT COUNT(DISTINCT user_id)::int FROM payment_orders
          WHERE status IN ('paid', 'refunded')) AS paid_users,
        (SELECT COUNT(*)::int FROM user_subscriptions
          WHERE status IN ('trial', 'trialing')) AS trialing_users`);

    // ── 6. 近 14 天每日订单（generate_series 补零；退款归属支付当日）──
    const { rows: dailyRows } = await pool.query(`
      SELECT
        to_char(gs.day, 'YYYY-MM-DD') AS date,
        COALESCE(SUM(po.amount) FILTER (WHERE po.status IN ('paid', 'refunded')), 0)::float8 AS amount,
        COALESCE(SUM(COALESCE(NULLIF(po.metadata->>'refund_amount', ''), '0')::numeric), 0)::float8 AS refund
      FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') AS gs(day)
      LEFT JOIN payment_orders po
        ON po.paid_at >= gs.day AND po.paid_at < gs.day + INTERVAL '1 day'
      GROUP BY gs.day
      ORDER BY gs.day`);

    // ── 7. 套餐分布（当前订阅套餐名优先，回退 users.subscription_status；固定三行）──
    const { rows: planRows } = await pool.query(`
      SELECT
        CASE
          WHEN lower(COALESCE(sp.name, '')) IN ('pro', 'enterprise') THEN lower(sp.name)
          WHEN u.subscription_status IN ('pro', 'enterprise') THEN u.subscription_status
          ELSE 'free'
        END AS plan,
        COUNT(*)::int AS count
      FROM users u
      LEFT JOIN user_subscriptions us ON us.id = u.current_subscription_id
      LEFT JOIN subscription_plans sp ON sp.id = us.plan_id
      GROUP BY 1`);

    // ── 8. 渠道占比（近 30 天 paid/refunded 订单笔数）──
    const { rows: channelRows } = await pool.query(`
      SELECT
        ${CHANNEL_CASE_SQL} AS channel,
        COUNT(*)::int AS cnt
      FROM payment_orders po
      WHERE po.status IN ('paid', 'refunded')
        AND po.paid_at >= NOW() - INTERVAL '30 days'
      GROUP BY 1`);

    // ── 组装 ──
    const users = userRows[0] || {};
    const revenue = revenueRows[0] || {};
    const mrr = mrrRows[0] || {};
    const devices = deviceRows[0] || {};
    const paid = paidRows[0] || {};

    const totalUsers = Number(users.total_users) || 0;
    const paidUsers = Number(paid.paid_users) || 0;
    const monthRevenue = Math.round(Number(revenue.month_revenue) * 100) / 100;
    const prevMonthRevenue = Number(revenue.prev_month_revenue) || 0;
    const paid30d = Number(revenue.paid_30d) || 0;
    const refund30d = Number(revenue.refund_30d) || 0;
    const mrrTotal = Math.round(Number(mrr.mrr_total) * 100) / 100;
    const mrrYearlyPart = Number(mrr.mrr_yearly_part) || 0;

    const planCountMap = new Map(planRows.map((r) => [r.plan, Number(r.count)]));

    const channelTotal = channelRows.reduce((sum, r) => sum + Number(r.cnt), 0);
    const channelMap = new Map(channelRows.map((r) => [r.channel, Number(r.cnt)]));

    const data = {
      statsAt: formatStatsAt(),
      kpis: {
        totalUsers,
        weekNewUsers: Number(users.week_new_users) || 0,
        weekGrowthRate: growthRate(Number(users.week_new_users) || 0, Number(users.prev_week_new_users) || 0),
        monthRevenue,
        revenueGrowthRate: growthRate(monthRevenue, prevMonthRevenue),
        // 退款率：近 30 天退款额 / 成交额
        refundRate: paid30d > 0 ? round1((refund30d / paid30d) * 100) : 0,
        mrr: mrrTotal,
        mrrYearlySharePercent:
          mrrTotal > 0 ? Math.round((mrrYearlyPart / mrrTotal) * 100) : 0,
        onlineDevices: Number(devices.online_devices) || 0,
        // 无历史快照表：以「24~48h 前活跃设备数」为基线的简化 delta
        devicesDelta:
          (Number(devices.online_devices) || 0) - (Number(devices.online_prev_day) || 0),
        paidUsers,
        conversionRate: totalUsers > 0 ? round1((paidUsers / totalUsers) * 100) : 0,
        trialingUsers: Number(paid.trialing_users) || 0,
      },
      orders14d: dailyRows.map((r) => ({
        date: r.date,
        amount: Math.round(Number(r.amount) * 100) / 100,
        refund: Math.round(Number(r.refund) * 100) / 100,
      })),
      planDistribution: PLAN_KEYS.map((plan) => ({ plan, count: planCountMap.get(plan) || 0 })),
      channels: Object.entries(CHANNEL_LABELS).map(([channel, label]) => ({
        channel,
        label,
        percent: channelTotal > 0 ? Math.round(((channelMap.get(channel) || 0) / channelTotal) * 100) : 0,
      })),
      // 待处理事项（退款审核 / 试用到期 / 对账差异 / 异常登录）依赖后续工单的对账与风控数据，先返回空数组
      pendingItems: [],
    };

    return res.json({ code: 0, data });
  } catch (err) {
    logger.error('[admin/overview] failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取看板数据失败' });
  }
});

export default router;
