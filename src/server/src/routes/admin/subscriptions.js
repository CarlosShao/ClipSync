// =============================================
// Admin Console · 订阅管理 APIs（Admin Console · T-A3）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/subscriptions', subscriptionsRouter)
//     → GET  /api/admin/subscriptions           订阅分页列表（含用户摘要与套餐名）
//     → POST /api/admin/subscriptions/:id/grant 人工赠期/调整套餐（高危）
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 细粒度权限：POST /:id/grant → requirePerm('admin.subscriptions.grant')
//
// 响应契约：成功 { code: 0, data }；错误 { code, message }；分页壳 { list, total, page, pageSize }
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { logAuditEvent } from '../../utils/audit.js';
import { requirePerm } from '../../middleware/adminAuth.js';

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 订阅行查询：JOIN 套餐取名（展示名优先）、JOIN users 取用户摘要
const SUBSCRIPTION_SELECT = `
  SELECT
    us.id,
    us.user_id,
    us.plan_id,
    us.status,
    us.billing_cycle,
    us.current_period_start,
    us.current_period_end,
    us.auto_renew,
    us.created_at,
    sp.name AS plan_name,
    sp.display_name AS plan_display_name,
    u.nickname AS user_nickname,
    u.phone AS user_phone
  FROM user_subscriptions us
  JOIN subscription_plans sp ON sp.id = us.plan_id
  JOIN users u ON u.id = us.user_id`;

/** 手机号打码：138****2765（与 routes/aiTools.js 口径一致） */
function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone);
  if (s.length < 7) return s.slice(0, 1) + '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/**
 * DB 行 → 订阅列表/详情行。
 * status 归一化到前端 SubscriptionStatus 词表：'cancelled'→'canceled'、'trial'→'trialing'。
 */
function mapSubscriptionRow(row) {
  const status =
    row.status === 'cancelled' ? 'canceled' : row.status === 'trial' ? 'trialing' : row.status;
  return {
    id: row.id,
    userId: row.user_id,
    userLabel: (row.user_nickname || '').trim() || maskPhone(row.user_phone) || '未知用户',
    planId: row.plan_id,
    planName: row.plan_display_name || row.plan_name || '',
    planKey: row.plan_name || '',
    status,
    billingCycle: row.billing_cycle || null,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    autoRenew: Boolean(row.auto_renew),
    createdAt: row.created_at,
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

// ───────────────────────── 订阅列表 ─────────────────────────

/**
 * GET /api/admin/subscriptions?page=&pageSize=&q=
 * 全量订阅分页列表；q 模糊匹配昵称/手机号（用户摘要）。
 */
router.get('/', async (req, res) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query);

    // q 过滤昵称/手机号（ILIKE 模糊匹配用户摘要）
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const filterSql = q ? ` WHERE (u.nickname ILIKE $1 OR u.phone ILIKE $1)` : '';
    const baseParams = q ? [`%${q}%`] : [];

    const { rows: totalRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM user_subscriptions us
       JOIN subscription_plans sp ON sp.id = us.plan_id
       JOIN users u ON u.id = us.user_id${filterSql}`,
      baseParams
    );
    const total = totalRows[0] ? Number(totalRows[0].total) : 0;

    const { rows } = await pool.query(
      `${SUBSCRIPTION_SELECT}${filterSql} ORDER BY us.created_at DESC LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
      [...baseParams, pageSize, offset]
    );

    return res.json({ code: 0, data: { list: rows.map(mapSubscriptionRow), total, page, pageSize } });
  } catch (err) {
    logger.error('[admin/subscriptions] list failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取订阅列表失败' });
  }
});

// ───────────────────────── 页头统计 ─────────────────────────

/**
 * GET /api/admin/subscriptions/stats
 * 订阅页头统计：{ active, trialing, expiringThisMonth }。
 * expiringThisMonth = current_period_end 落在当前自然月内（含 trialing/past_due）。
 * 必须声明在 /:id/grant 之前无关（方法不同），但保持路径字面量优先。
 */
router.get('/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active')::int AS active,
         COUNT(*) FILTER (WHERE status = 'trialing')::int AS trialing,
         COUNT(*) FILTER (
           WHERE current_period_end IS NOT NULL
             AND current_period_end < date_trunc('month', NOW()) + INTERVAL '1 month'
             AND current_period_end >= date_trunc('month', NOW())
         )::int AS expiring_this_month
       FROM user_subscriptions`
    );
    const row = rows[0] ?? {};
    return res.json({
      code: 0,
      data: {
        active: Number(row.active ?? 0),
        trialing: Number(row.trialing ?? 0),
        expiringThisMonth: Number(row.expiring_this_month ?? 0),
      },
    });
  } catch (err) {
    logger.error('[admin/subscriptions] stats failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '获取订阅统计失败' });
  }
});

// ───────────────────────── 人工赠期/调整套餐 ─────────────────────────

/**
 * POST /api/admin/subscriptions/:id/grant  body { planId, months, reason }
 * 人工赠期/调整套餐（requirePerm('admin.subscriptions.grant')）：
 *  - 若 planId 与当前套餐不同 → 切换 plan_id；
 *  - current_period_end 自「当前期末与 NOW() 的较大者」起延长 months 个月
 *    （GREATEST 防止对已过期订阅追加时长被 NOW() 之前的旧期末吞掉）；
 *  - status 置 'active'（赠期即恢复权益）；
 *  - 写审计日志（action=admin.subscriptions.grant，details 含目标用户/套餐/月数/原因）。
 */
router.post('/:id/grant', requirePerm('admin.subscriptions.grant'), async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const { planId, months, reason } = body;
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';

    if (!id || typeof id !== 'string' || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '订阅 ID 不合法' });
    }
    if (!planId || typeof planId !== 'string' || !UUID_RE.test(planId)) {
      return res.status(400).json({ code: 4000, message: 'planId 必填且须为合法 UUID' });
    }
    if (!Number.isInteger(months) || months < 1 || months > 120) {
      return res.status(400).json({ code: 4000, message: 'months 必须为 1-120 的整数' });
    }
    if (!trimmedReason) {
      return res.status(400).json({ code: 4000, message: '赠期原因必填（写入审计日志）' });
    }

    const { rows: subRows } = await pool.query(`${SUBSCRIPTION_SELECT} WHERE us.id = $1`, [id]);
    if (subRows.length === 0) {
      return res.status(404).json({ code: 40404, message: '订阅不存在' });
    }
    const subscription = subRows[0];

    const { rows: planRows } = await pool.query(
      'SELECT id, name, display_name FROM subscription_plans WHERE id = $1',
      [planId]
    );
    if (planRows.length === 0) {
      return res.status(404).json({ code: 40404, message: '套餐不存在' });
    }
    const plan = planRows[0];

    const { rows: updatedRows } = await pool.query(
      `UPDATE user_subscriptions
       SET plan_id = $2,
           status = 'active',
           current_period_end = GREATEST(current_period_end, NOW()) + make_interval(months => $3),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, planId, months]
    );
    const updated = updatedRows[0];

    // 同步 users 订阅快照（与 subscribe 路由口径一致：subscription_status = 套餐名小写，
    // current_subscription_id 指向被调整的订阅）——否则订阅检查中间件读到旧状态
    await pool.query(
      `UPDATE users
       SET subscription_status = $2, current_subscription_id = $1, updated_at = NOW()
       WHERE id = $3`,
      [updated.id, (plan.name || '').toLowerCase() || 'active', subscription.user_id]
    );

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.subscriptions.grant',
      resourceType: 'user_subscription',
      resourceId: id,
      details: {
        targetUserId: subscription.user_id,
        planId,
        planName: plan.display_name || plan.name,
        months,
        reason: trimmedReason,
        switchedPlan: subscription.plan_id !== planId,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/subscriptions] grant executed', {
      subscriptionId: id,
      planId,
      months,
      operator: req.user?.userId,
    });

    return res.json({
      code: 0,
      data: mapSubscriptionRow({
        ...subscription,
        ...updated,
        plan_name: plan.name,
        plan_display_name: plan.display_name,
      }),
    });
  } catch (err) {
    logger.error('[admin/subscriptions] grant failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '赠期执行失败' });
  }
});

export default router;
