import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';
import { sendNotification } from '../ws/server.js';
import { getPlanLimits, getUsedStorageBytes } from '../utils/planLimits.js';
import { findSelfRefundAnchorOrderId } from '../services/refundPolicy.js';

const router = Router();

/**
 * GET /api/subscriptions/plans
 * 获取当前可用套餐列表
 */
router.get('/plans', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, display_name, description, price_monthly, price_yearly, max_devices, max_clipboard_items, max_file_size_mb, max_storage_mb, features FROM subscription_plans WHERE is_active = true ORDER BY price_monthly ASC'
    );
    
    res.json({
      plans: result.rows.map(plan => ({
        id: plan.id,
                    name: plan.name,
                    displayName: plan.display_name,
                    price: parseFloat(plan.price_monthly || 0),
                    priceYearly: parseFloat(plan.price_yearly || 0),
                    billingCycle: 'month',
                    maxDevices: plan.max_devices,
                    maxClipboardItems: plan.max_clipboard_items,
                    maxFileSizeMb: plan.max_file_size_mb,
                    maxStorageMb: plan.max_storage_mb,
                    features: plan.features,
      }))
    });
  } catch (err) {
    logger.error('Get subscription plans error:', err);
    res.status(500).json({ error: 'Failed to get subscription plans' });
  }
});

/**
 * GET /api/subscriptions/current
 * 查询当前用户订阅状态
 */
router.get('/current', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // F0.3：并行取套餐新字段与已用容量。
    //  - getPlanLimits 自带旧库缺列容错（information_schema 检测，缺 max_files_per_clip /
    //    file_retention_days 列时返回 null），不会因迁移未跑而崩；
    //  - 它只认 status='active' 的订阅，trial 用户会兜底到 Free 行 —— 这与上传配额
    //    校验（checkUploadQuota）的实际执行口径一致，故此处展示值即生效值；
    //  - plan 的 id/name 仍以下方订阅查询为准，这里只复用新字段，避免语义冲突。
    const [planLimits, usedBytes] = await Promise.all([
      getPlanLimits(userId),
      getUsedStorageBytes(userId),
    ]);

    /**
     * purchaseBacked：当前生效订阅是否有**真实已付订单**支撑。
     *
     * 客户端「申请退款」入口此前只判 `paidActive`，而它是拿**套餐目录价 > 0** 推出来的
     * （useSubscriptionAccess.ts:182）—— 于是管理台**赠期**出来的订阅也会让入口亮起来，
     * 而那种账号一分钱没付过，点开只有一堆不可退的单（2026-10-05 owner 实测反馈）。
     *
     * 判据直接复用自助退款的锚点查询（refundPolicy.findSelfRefundAnchorOrderId）：
     * 这样「入口可见」与「服务端认为存在可退锚点」永远是同一个谓词，不会各算一套。
     * 无 active 订阅 / 无已付订单 → false（锚点查询本身就返回 null）。
     */
    const refundAnchorOrderId = await findSelfRefundAnchorOrderId(userId);
    const purchaseBacked = Boolean(refundAnchorOrderId);
    // 字节转 MB：向上取整到 0.1MB 精度（ceil(x*10)/10），展示余量偏保守；
    // usedBytes 为 null（用量查询失败）时 storageUsedMb 置 null，由前端显示未知
    const storageUsedMb = usedBytes != null
      ? Math.ceil((usedBytes / (1024 * 1024)) * 10) / 10
      : null;

    // 获取用户当前订阅
    const subscriptionResult = await pool.query(`
      SELECT
        us.*,
        sp.name as plan_name,
        sp.price_monthly,
        sp.price_yearly,
        sp.max_devices,
        sp.max_clipboard_items,
        sp.max_file_size_mb,
        sp.max_storage_mb,
        sp.features
      FROM user_subscriptions us
      JOIN subscription_plans sp ON us.plan_id = sp.id
      WHERE us.user_id = $1 AND us.status IN ('active', 'trial')
      ORDER BY us.created_at DESC
      LIMIT 1
    `, [userId]);

    if (subscriptionResult.rows.length === 0) {
      // 没有活跃订阅，返回Free套餐
      const freePlan = await pool.query('SELECT * FROM subscription_plans WHERE name = $1', ['Free']);
      return res.json({
        subscription: null,
        // 没有生效订阅 ⇒ 不可能有可退锚点，入口必须收口（客户端不再只看 paidActive）
        purchaseBacked,
        plan: freePlan.rows[0] ? {
          id: freePlan.rows[0].id,
          name: freePlan.rows[0].name,
          price: parseFloat(freePlan.rows[0].price_monthly || 0),
          currency: 'CNY',
          billingCycle: 'month',
          maxDevices: freePlan.rows[0].max_devices,
          maxClipboardItems: freePlan.rows[0].max_clipboard_items,
          maxFileSizeMb: freePlan.rows[0].max_file_size_mb,
          maxStorageMb: freePlan.rows[0].max_storage_mb,
          maxFilesPerClip: planLimits.maxFilesPerClip,
          fileRetentionDays: planLimits.fileRetentionDays,
          storageUsedMb,
          features: freePlan.rows[0].features,
        } : null,
      });
    }

    const subscription = subscriptionResult.rows[0];

    res.json({
      subscription: {
        id: subscription.id,
        status: subscription.status,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        trialEnd: subscription.trial_end,
      },
      // 见上方说明：赠期/试用得到的订阅 paidActive 也为真，但一分钱没付过，不可自助退款
      purchaseBacked,
      plan: {
        id: subscription.plan_id,
        name: subscription.plan_name,
        price: parseFloat(subscription.price_monthly || 0),
        currency: 'CNY',
        billingCycle: 'month',
        maxDevices: subscription.max_devices,
        maxClipboardItems: subscription.max_clipboard_items,
        maxFileSizeMb: subscription.max_file_size_mb,
        maxStorageMb: subscription.max_storage_mb,
        maxFilesPerClip: planLimits.maxFilesPerClip,
        fileRetentionDays: planLimits.fileRetentionDays,
        storageUsedMb,
        features: subscription.features,
      }
    });
  } catch (err) {
    logger.error('Get current subscription error:', err);
    res.status(500).json({ error: 'Failed to get subscription info' });
  }
});

/**
 * POST /api/subscriptions/subscribe —— 已停用（2026-10-03 审计 M4）
 *
 * ⚠️ 这条端点此前仍在「收钱链路」上，但它**绕过 create-order 的全部闸门**：
 *   · 不查 enable_subscription 开关（本文件此前完全没有 isFlagEnabled 引用）
 *   · 不校验渠道凭据是否配置
 *   · 不做档位判定与升级差价折抵（create-order 会拦的降档/同套餐，这里不拦）
 *   · 不检查 price > 0
 * 而且它只返回 orderNo + amount、**不给收银台 URL**，create-order 也不接受已存在的
 * 订单号 —— 所以它建出来的订单**永远付不掉**：只会污染订单表/审计/看板，
 * 24h 后被 orderCloseSweep 关掉。
 *
 * 现在没有任何客户端调用它（桌面端走 /api/payments/create-order；移动端与管理台均无调用），
 * 故直接停用。下单请一律走 POST /api/payments/create-order（返回 cashierUrl）。
 *
 * 为什么是「停用」而不是「继续修补」：这条端点历史上被修过两次安全洞
 * （直接 INSERT paid 订单白送会员、给新用户白送 7 天试用），根因都是它同时承担
 * 「下单」与「开卡」两种语义。语义拆分后（/start-trial 专门发放权益）保留一个
 * 无人调用、又绕过全部闸门的第三通道，只会再次成为漏洞温床。
 */
router.post('/subscribe', authenticateToken, (req, res) => {
  logger.warn('[subscriptions] /subscribe 已停用，调用方应改用 /api/payments/create-order', {
    userId: req.user?.userId,
  });
  return res.status(410).json({
    error: 'This endpoint has been retired; use POST /api/payments/create-order',
    code: 'ENDPOINT_RETIRED',
    useInstead: '/api/payments/create-order',
  });
});

/**
 * POST /api/subscriptions/start-trial
 * 开始 7 天免费试用（官网承诺：「所有付费方案含 7 天 Pro 免费试用，随时取消」）。
 *
 * 为什么与 /subscribe 分开：
 *   /subscribe 现在是「纯下单」入口（返回 202 + 待支付订单），不再发放任何权益。
 *   试用是**发放权益**的动作，语义完全不同，混在一个端点里正是此前漏洞的温床
 *   （同一条 SQL 路径既能下单又能开卡，很难判断哪条分支该收钱）。
 *
 * 防滥用设计：
 *   1. **每用户终身一次** —— 以「是否存在过任何 user_subscriptions 记录」判定，
 *      已取消/已过期的记录同样计入（否则可反复取消再试用）。
 *   2. 试用只发放**指定套餐**，到期由 expiry 任务降级为 Free（历史数据保留）。
 *   3. 显式审计 action=subscription.trial_start，便于事后排查批量套取。
 *   4. 仅允许 Free 以外的套餐（给 Free 开试用没有意义）。
 */
router.post('/start-trial', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { planId, billingCycle = 'monthly' } = req.body;

    if (!planId) {
      return res.status(400).json({ error: 'Missing planId parameter' });
    }

    const planResult = await pool.query(
      'SELECT * FROM subscription_plans WHERE id = $1 AND is_active = true',
      [planId]
    );
    if (planResult.rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    const plan = planResult.rows[0];

    if (plan.name.toLowerCase() === 'free') {
      return res.status(400).json({ error: 'Free plan does not need a trial' });
    }

    // 终身一次：含 cancelled / expired（防「取消后再试用」循环套取）
    const everSubscribed = await pool.query(
      'SELECT id FROM user_subscriptions WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    if (everSubscribed.rows.length > 0) {
      return res.status(409).json({
        error: 'Trial already used',
        code: 'TRIAL_ALREADY_USED',
      });
    }

    const TRIAL_DAYS = 7;
    // 区间用 SQL 计算（避免 JS/DB 时区不一致导致 trial_end 偏移）
    const trial = await pool.query(
      `INSERT INTO user_subscriptions
         (user_id, plan_id, status, start_date, end_date,
          current_period_start, current_period_end, billing_cycle, trial_end)
       VALUES ($1, $2, 'trial', NOW(), NOW() + INTERVAL '${TRIAL_DAYS} days',
               NOW(), NOW() + INTERVAL '${TRIAL_DAYS} days', $3,
               NOW() + INTERVAL '${TRIAL_DAYS} days')
       RETURNING id, trial_end`,
      [userId, planId, billingCycle]
    );

    await pool.query(
      'UPDATE users SET subscription_status = $1, current_subscription_id = $2 WHERE id = $3',
      ['trial', trial.rows[0].id, userId]
    );

    logger.info(`[trial] started for user ${userId}`, { planId, planName: plan.name, days: TRIAL_DAYS });

    await logAuditEvent({
      userId,
      action: AUDIT_ACTIONS.SUBSCRIPTION_CREATE,
      resourceType: 'subscription',
      resourceId: trial.rows[0].id,
      details: { planId, planName: plan.name, billingCycle, trialDays: TRIAL_DAYS, kind: 'trial' },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.status(201).json({
      message: 'Trial started',
      isTrial: true,
      subscriptionId: trial.rows[0].id,
      trialEnd: trial.rows[0].trial_end,
      trialDays: TRIAL_DAYS,
    });
  } catch (err) {
    logger.error('Start trial error:', err);
    res.status(500).json({ error: 'Failed to start trial' });
  }
});

/**
 * POST /api/subscriptions/cancel
 * 取消订阅（期末生效）
 */
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // 查找活跃订阅
    const subscriptionResult = await pool.query(
      'SELECT * FROM user_subscriptions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
      [userId, 'active']
    );
    
    if (subscriptionResult.rows.length === 0) {
      return res.status(400).json({ error: 'No active subscription' });
    }
    
    const subscription = subscriptionResult.rows[0];
    
    // 设置为期末取消
    await pool.query(
      'UPDATE user_subscriptions SET cancel_at_period_end = $1, updated_at = NOW() WHERE id = $2',
      [true, subscription.id]
    );
    
    logger.info(`User ${userId} cancelled subscription ${subscription.id}, will end at period end`);

    // 推送订阅取消通知
    try {
      await sendNotification(userId, {
        notificationType: 'subscription_cancelled',
        title: 'Subscription cancelled',
        body: `Your subscription will end on ${new Date(subscription.current_period_end).toLocaleDateString()}.`,
        data: { currentPeriodEnd: subscription.current_period_end },
      });
    } catch (notifErr) {
      logger.error('[Subscription] 订阅取消通知失败（已忽略）:', { error: notifErr?.message, userId });
    }

    // 审计日志：记录订阅取消
    await logAuditEvent({
      userId,
      action: AUDIT_ACTIONS.SUBSCRIPTION_CANCEL,
      resourceType: 'subscription',
      resourceId: subscription.id,
      details: { currentPeriodEnd: subscription.current_period_end },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({
      message: 'Subscription marked for cancellation, effective at the end of the current billing period',
      currentPeriodEnd: subscription.current_period_end,
    });
  } catch (err) {
    logger.error('Cancel subscription error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

/**
 * POST /api/subscriptions/resume
 * 恢复已取消的订阅
 */
router.post('/resume', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // 查找已取消但未到期的订阅
    const subscriptionResult = await pool.query(
      'SELECT * FROM user_subscriptions WHERE user_id = $1 AND status = $2 AND cancel_at_period_end = $3 ORDER BY created_at DESC LIMIT 1',
      [userId, 'active', true]
    );
    
    if (subscriptionResult.rows.length === 0) {
      return res.status(400).json({ error: 'No cancellable subscription to restore' });
    }
    
    const subscription = subscriptionResult.rows[0];
    
    // 恢复订阅
    await pool.query(
      'UPDATE user_subscriptions SET cancel_at_period_end = $1, updated_at = NOW() WHERE id = $2',
      [false, subscription.id]
    );
    
    logger.info(`User ${userId} resumed subscription ${subscription.id}`);

    // 推送订阅恢复通知
    try {
      await sendNotification(userId, {
        notificationType: 'subscription_resumed',
        title: 'Subscription resumed',
        body: 'Your subscription will continue renewing as before.',
        data: {},
      });
    } catch (notifErr) {
      logger.error('[Subscription] 订阅恢复通知失败（已忽略）:', { error: notifErr?.message, userId });
    }

    // 审计日志：记录订阅恢复
    await logAuditEvent({
      userId,
      action: AUDIT_ACTIONS.SUBSCRIPTION_RESUME,
      resourceType: 'subscription',
      resourceId: subscription.id,
      details: { currentPeriodEnd: subscription.current_period_end },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({
      message: 'Subscription restored',
      subscriptionId: subscription.id,
    });
  } catch (err) {
    logger.error('Resume subscription error:', err);
    res.status(500).json({ error: 'Failed to restore subscription' });
  }
});

export default router;
