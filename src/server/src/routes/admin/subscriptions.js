// =============================================
// Admin Console · 订阅管理 APIs（Admin Console · T-A3）
//
// 挂载（routes/admin/index.js）：
//   adminRouter.use('/subscriptions', subscriptionsRouter)
//     → GET  /api/admin/subscriptions           订阅分页列表（含用户摘要与套餐名）
//     → POST /api/admin/subscriptions/:id/grant 人工赠期/调整套餐（高危）
//     → POST /api/admin/subscriptions/:id/revoke 收回人工授予的权益（高危；有已付订单一律拒）
//
// 上游链（index.js 顶层已装配）：authenticateToken → requireRole(50) → superAdminAudit
// 细粒度权限：POST /:id/grant 与 /:id/revoke → requirePerm('admin.subscriptions.grant')
//   （revoke 刻意复用 grant 的权限键：两者是同一类"人工调整高危操作"，且新增权限键要动
//    043 权限目录的迁移，而生产落后分支很远，不值得为语义细分冒迁移风险。
//    收回与赠出是对称的 —— 能赠的人本就该能撤。）
//
// 响应契约：成功 { code: 0, data }；错误 { code, message }；分页壳 { list, total, page, pageSize }
// =============================================

import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { logAuditEvent } from '../../utils/audit.js';
import { requirePerm } from '../../middleware/adminAuth.js';
import { sendNotification } from '../../ws/server.js';

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
router.get('/', requirePerm('admin.subscriptions.view'), async (req, res) => {
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
router.get('/stats', requirePerm('admin.subscriptions.view'), async (req, res) => {
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
 *  - planId 兼容两种写法（§4-A12）：套餐 UUID 主键 **或** 套餐名（'pro'/'Enterprise'，
 *    大小写不敏感）—— 管理台前端发的是后者，旧实现只收 UUID，人工赠期必 400；
 *  - 若解析出的套餐与当前不同 → 切换 plan_id；
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
    if (!planId || typeof planId !== 'string' || !planId.trim()) {
      return res.status(400).json({ code: 4000, message: 'planId 必填（套餐 UUID 或套餐名）' });
    }
    // 月数上限：前端 GrantSubscriptionModal 的 InputNumber 是 1-12，
    // 服务端**刻意放宽到 1-36** —— 客服/续约补偿一次给 24~36 个月是合理运维动作，
    // 不该被 UI 控件的保守上限卡住；同时保留硬上限，避免误输入成 1200 个月。
    if (!Number.isInteger(months) || months < 1 || months > 36) {
      return res.status(400).json({ code: 4000, message: 'months 必须为 1-36 的整数' });
    }
    if (!trimmedReason) {
      return res.status(400).json({ code: 4000, message: '赠期原因必填（写入审计日志）' });
    }

    const { rows: subRows } = await pool.query(`${SUBSCRIPTION_SELECT} WHERE us.id = $1`, [id]);
    if (subRows.length === 0) {
      return res.status(404).json({ code: 40404, message: '订阅不存在' });
    }
    const subscription = subRows[0];

    // §4-A12：UUID 与套餐名两条查询分支**必须分流**，不能写成 `id = $1 OR name = $1` ——
    // PostgreSQL 会把非 UUID 字符串（'pro'）直接以 22P02 invalid input syntax 抛错，
    // 整个 OR 条件根本走不到 name 那一侧。
    const planIsUuid = UUID_RE.test(planId.trim());
    const { rows: planRows } = await pool.query(
      planIsUuid
        ? 'SELECT id, name, display_name FROM subscription_plans WHERE id = $1 AND is_active = true'
        : 'SELECT id, name, display_name FROM subscription_plans WHERE lower(name) = lower($1) AND is_active = true',
      [planId.trim()]
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
      [id, plan.id, months]
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
        planId: plan.id,
        // 原始入参一并留痕：管理台常按套餐名（'pro'）发指令，事后核对要看当时给的是什么
        planIdInput: planId.trim(),
        planName: plan.display_name || plan.name,
        months,
        reason: trimmedReason,
        switchedPlan: subscription.plan_id !== plan.id,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    logger.info('[admin/subscriptions] grant executed', {
      subscriptionId: id,
      planId: plan.id,
      planIdInput: planId.trim(),
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

/**
 * POST /api/admin/subscriptions/:id/revoke  body { reason, mode? = 'immediate' }
 * 收回「人工给出去」的订阅权益（赠期 / mock / 补偿）—— 2026-10-05 新增。
 *
 * 为什么需要它：grant 是**单向**的（只把 plan_id 往前挪 + period_end 往后延），
 * 误发或滥用赠期后**没有任何入口可收回** —— 此前只能改库，而改库既不写审计，
 * 也很容易把 users 的订阅快照和 user_subscriptions 改得不一致。
 *
 * ⚠️ 本端点最重要的设计是**保护闸**：订阅下只要存在**真实已付订单**（status='paid'）
 * 就一律拒收（409 / REVOKE_PAID_SUBSCRIPTION_USE_REFUND）。用户付过钱买到的权益只能走
 * 「退款审核」（/refund-review：先调渠道原路退款、再取消订阅）—— 否则在这里点一下
 * 就等于**没收用户花钱买的东西**，是资损 + 投诉 + 合规面。
 * 本端点只处理与钱无关的那部分（管理台赠期、mock、人工补偿）。
 *
 * mode：
 *   immediate（默认）立即生效：status='canceled' + canceled_at，用户快照回落 free
 *                        （与 orderFulfillment 升级取代旧订阅同一口径）
 *   period_end         期末生效：cancel_at_period_end=true，权益保留到到期
 *                        （与用户自助 POST /api/subscriptions/cancel 同一口径）
 */
router.post('/:id/revoke', requirePerm('admin.subscriptions.grant'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || !UUID_RE.test(id)) {
      return res.status(400).json({ code: 4000, message: '订阅 ID 不合法' });
    }

    const body = req.body || {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const mode = body.mode === undefined || body.mode === null ? 'immediate' : body.mode;

    if (!reason) {
      return res.status(400).json({ code: 4000, message: '撤销原因必填（写入审计日志）' });
    }
    if (reason.length > 200) {
      return res.status(400).json({ code: 4000, message: '撤销原因不能超过 200 字' });
    }
    if (mode !== 'immediate' && mode !== 'period_end') {
      return res
        .status(400)
        .json({ code: 4000, message: 'mode 取值不合法（immediate / period_end）' });
    }

    const { rows } = await pool.query(`${SUBSCRIPTION_SELECT} WHERE us.id = $1`, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ code: 40404, message: '订阅不存在' });
    }
    const subscription = rows[0];
    const previousStatus = String(subscription.status || '');

    if (previousStatus === 'canceled' || previousStatus === 'expired') {
      return res.status(409).json({ code: 40904, message: '该订阅已终止，无需撤销' });
    }

    // ★保护闸：有真实已付订单一律拒（引导走退款审核）
    const paid = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payment_orders WHERE subscription_id = $1 AND status = 'paid'`,
      [id]
    );
    const paidOrders = paid.rows[0].n;
    if (paidOrders > 0) {
      logger.warn('[admin/subscriptions] revoke blocked: subscription has paid order(s)', {
        subscriptionId: id,
        paidOrders,
        operator: req.user?.userId,
      });
      return res.status(409).json({
        code: 40905,
        reason: 'HAS_PAID_ORDER',
        paidOrders,
        message: `该订阅有 ${paidOrders} 笔已支付订单，不能在这里撤销；请用「退款审核」原路退款（退款会一并取消订阅）`,
      });
    }

    let updated;
    if (mode === 'immediate') {
      const r = await pool.query(
        `UPDATE user_subscriptions
            SET status = 'canceled',
                canceled_at = NOW(),
                cancel_at_period_end = false,
                auto_renew = false,
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [id]
      );
      updated = r.rows[0];

      // users 快照回落：**只在该订阅正是当前指向的那条时**回落，
      // 否则会把用户另一条生效订阅的档位改错（同用户可能存在多条订阅行）
      await pool.query(
        `UPDATE users
            SET subscription_status = 'free',
                current_subscription_id = NULL,
                updated_at = NOW()
          WHERE id = $1 AND current_subscription_id = $2`,
        [subscription.user_id, id]
      );
    } else {
      const r = await pool.query(
        `UPDATE user_subscriptions
            SET cancel_at_period_end = true,
                auto_renew = false,
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [id]
      );
      updated = r.rows[0];
    }

    await logAuditEvent({
      userId: req.user?.userId,
      action: 'admin.subscriptions.revoke',
      resourceType: 'user_subscription',
      resourceId: id,
      details: {
        targetUserId: subscription.user_id,
        planId: subscription.plan_id,
        planName: subscription.plan_display_name || subscription.plan_name,
        mode,
        reason,
        previousStatus,
        currentPeriodEnd: subscription.current_period_end,
        // 留痕：撤销时该订阅**确实**没有已付订单（保护闸已过），事后可自证没没收付费权益
        paidOrders: 0,
      },
      ipAddress: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : undefined,
    });

    // 告知用户（静默收回权益比收回本身更糟）。注意**不把内部原因**塞给用户 ——
    // reason 是给审计看的（"误发""滥用"），对用户只给中性文案。失败只 warn，不影响撤销。
    try {
      const endText = subscription.current_period_end
        ? new Date(subscription.current_period_end).toLocaleDateString()
        : '';
      await sendNotification(subscription.user_id, {
        notificationType: 'subscription_revoked',
        title: mode === 'immediate' ? '订阅权益已收回' : '订阅将于到期后结束',
        body:
          mode === 'immediate'
            ? '管理员已收回该订阅的权益，账号已回落免费版。如有疑问请联系客服。'
            : `该订阅将于 ${endText} 到期后结束，期间权益不受影响。`,
        data: { subscriptionId: id, mode },
      });
    } catch (notifyErr) {
      logger.warn('[admin/subscriptions] revoke notify failed (ignored)', {
        subscriptionId: id,
        error: notifyErr?.message,
      });
    }

    logger.info('[admin/subscriptions] revoke executed', {
      subscriptionId: id,
      mode,
      previousStatus,
      operator: req.user?.userId,
    });

    return res.json({
      code: 0,
      data: {
        ...mapSubscriptionRow({ ...subscription, ...updated }),
        revokedMode: mode,
        revokedAt: new Date().toISOString(),
      },
      message: mode === 'immediate' ? '订阅已立即终止，用户已回落免费版' : '订阅已设为期末终止',
    });
  } catch (err) {
    logger.error('[admin/subscriptions] revoke failed', { error: err.message });
    return res.status(500).json({ code: 5000, message: '撤销订阅失败' });
  }
});

export default router;
