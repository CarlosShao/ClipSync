import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent, AUDIT_ACTIONS } from '../utils/audit.js';
import { sendNotification } from '../ws/server.js';
import { getPlanLimits, getUsedStorageBytes } from '../utils/planLimits.js';

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
 * POST /api/subscriptions/subscribe
 * 创建/升级订阅
 */
router.post('/subscribe', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { planId, billingCycle = 'monthly' } = req.body;
    
    if (!planId) {
      return res.status(400).json({ error: 'Missing planId parameter' });
    }
    
    // 验证套餐是否存在
    const planResult = await pool.query('SELECT * FROM subscription_plans WHERE id = $1 AND is_active = true', [planId]);
    if (planResult.rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    const plan = planResult.rows[0];
    const price = billingCycle === 'yearly' ? (plan.price_yearly || plan.price_monthly * 10) : plan.price_monthly;
    
    // 检查是否已有活跃订阅
    const existingSubscription = await pool.query(
      'SELECT * FROM user_subscriptions WHERE user_id = $1 AND status IN ($2, $3) ORDER BY created_at DESC LIMIT 1',
      [userId, 'active', 'trial']
    );
    
    if (existingSubscription.rows.length > 0) {
      // 已有订阅，升级/降级
      const current = existingSubscription.rows[0];

      if (current.plan_id === planId) {
        return res.status(400).json({ error: 'You are already on this plan' });
      }

      // 创建**待支付**订单，并让调用方去走真实支付渠道。
      //
      // ⚠️ 此前的实现是一条严重的免费开卡漏洞（2026-09-16 修复）：
      //   它直接 INSERT 一条 payment_method='mock'、status='paid' 的订单，
      //   紧接着把新订阅置为 'active' —— **用户一分钱没付就拿到了付费套餐**。
      //   而该端点只要求登录（无支付校验），任何登录用户 POST 一次即可升级。
      //   前端虽已改成"渠道接入中"占位不再调用，但**后端接口仍是敞开的**，
      //   直接 curl 即可白拿会员。
      //
      // 现在：只建 pending 订单，订阅状态不动；由 /api/payments/create-order
      // 发起支付，支付成功后经支付宝回调 → orderFulfillment 统一开通。
      const orderNo = `ORD${Date.now()}${Math.random().toString(36).substr(2, 6)}`;
      const orderResult = await pool.query(`
        INSERT INTO payment_orders (user_id, subscription_id, order_no, amount, currency, payment_method, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, order_no
      `, [
        userId,
        current.id,          // 支付成功后由履约逻辑把这条订阅置为 active
        orderNo,
        price,
        'CNY',               // subscription_plans 无 currency 列，统一 CNY
        'alipay',            // 真实渠道；不再是 mock
        'pending',
        JSON.stringify({ planId, billingCycle, action: 'upgrade', fromPlanId: current.plan_id }),
      ]);

      logger.info(`Upgrade order created for user ${userId} to plan ${plan.name}`, { orderNo });

      await logAuditEvent({
        userId,
        action: AUDIT_ACTIONS.PAYMENT_CREATE,
        resourceType: 'payment_order',
        resourceId: orderResult.rows[0].id,
        details: { orderNo, planId, planName: plan.name, billingCycle, price, action: 'upgrade' },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      // 明确告知「需要支付」，绝不返回成功升级
      return res.status(202).json({
        message: 'Order created, payment required',
        paymentRequired: true,
        subscriptionId: current.id,
        orderNo,
        amount: price,
        currency: 'CNY',
      });
    } else {
      // 新订阅：一律先建待支付订单。
      //
      // 原实现对「从未订阅过」的用户直接写 status='trial' 白送 7 天试用
      // （同样不校验任何支付）。7 天试用是产品决策，但**不应由这个端点悄悄发放** ——
      // 它既无频次限制也无风控，可被反复注册新号套取。
      // 这里改为统一走支付；试用能力将来应作为独立、可审计的发放接口实现。
      const orderNo = `ORD${Date.now()}${Math.random().toString(36).substr(2, 6)}`;
      const orderResult = await pool.query(`
        INSERT INTO payment_orders (user_id, order_no, amount, currency, payment_method, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, order_no
      `, [
        userId,
        orderNo,
        price,
        'CNY',
        'alipay',
        'pending',
        JSON.stringify({ planId, billingCycle, action: 'new' }),
      ]);

      logger.info(`New subscription order created for user ${userId}, plan ${plan.name}`, { orderNo });

      await logAuditEvent({
        userId,
        action: AUDIT_ACTIONS.PAYMENT_CREATE,
        resourceType: 'payment_order',
        resourceId: orderResult.rows[0].id,
        details: { orderNo, planId, planName: plan.name, billingCycle, price, action: 'new' },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      return res.status(202).json({
        message: 'Order created, payment required',
        paymentRequired: true,
        orderNo,
        amount: price,
        currency: 'CNY',
        // 新订阅尚无 user_subscriptions 记录，订阅将在支付成功后创建
        subscriptionId: null,
      });
    }
  } catch (err) {
    logger.error('Subscribe error:', err);
    res.status(500).json({ error: 'Subscription failed' });
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
