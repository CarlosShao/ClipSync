import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET /api/subscriptions/plans
 * 获取当前可用套餐列表
 */
router.get('/plans', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, price, currency, billing_cycle, max_devices, max_clipboard_items, max_file_size_mb, max_storage_mb, features FROM subscription_plans WHERE is_active = true ORDER BY price ASC'
    );
    
    res.json({
      plans: result.rows.map(plan => ({
        id: plan.id,
        name: plan.name,
        price: parseFloat(plan.price),
        currency: plan.currency,
        billingCycle: plan.billing_cycle,
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
    
    // 获取用户当前订阅
    const subscriptionResult = await pool.query(`
      SELECT 
        us.*,
        sp.name as plan_name,
        sp.price,
        sp.currency,
        sp.billing_cycle,
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
          price: parseFloat(freePlan.rows[0].price),
          currency: freePlan.rows[0].currency,
          billingCycle: freePlan.rows[0].billing_cycle,
          maxDevices: freePlan.rows[0].max_devices,
          maxClipboardItems: freePlan.rows[0].max_clipboard_items,
          maxFileSizeMb: freePlan.rows[0].max_file_size_mb,
          maxStorageMb: freePlan.rows[0].max_storage_mb,
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
        price: parseFloat(subscription.price),
        currency: subscription.currency,
        billingCycle: subscription.billing_cycle,
        maxDevices: subscription.max_devices,
        maxClipboardItems: subscription.max_clipboard_items,
        maxFileSizeMb: subscription.max_file_size_mb,
        maxStorageMb: subscription.max_storage_mb,
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
    const price = billingCycle === 'yearly' ? plan.price * 10 : plan.price; // 年付优惠2个月
    
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
      
      // 创建支付订单
      const orderNo = `ORD${Date.now()}${Math.random().toString(36).substr(2, 6)}`;
      const orderResult = await pool.query(`
        INSERT INTO payment_orders (user_id, order_no, amount, currency, payment_method, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, order_no
      `, [
        userId,
        orderNo,
        price,
        plan.currency,
        'mock', // 暂时使用mock支付
        'pending',
        JSON.stringify({ planId, billingCycle, action: 'upgrade' })
      ]);
      
      // 暂时直接激活订阅（Mock支付成功）
      await pool.query(`
        UPDATE user_subscriptions 
        SET status = $1, updated_at = NOW()
        WHERE id = $2
      `, ['cancelled', current.id]);
      
      const newSubscriptionResult = await pool.query(`
        INSERT INTO user_subscriptions (user_id, plan_id, status, current_period_start, current_period_end)
        VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '1 ${billingCycle === 'yearly' ? 'year' : 'month'}')
        RETURNING id
      `, [userId, planId, 'active']);
      
      // 更新用户订阅状态
      await pool.query(
        'UPDATE users SET subscription_status = $1, current_subscription_id = $2 WHERE id = $3',
        [plan.name.toLowerCase(), newSubscriptionResult.rows[0].id, userId]
      );
      
      // 更新订单状态为已支付
      await pool.query(
        'UPDATE payment_orders SET status = $1, paid_at = NOW() WHERE order_no = $2',
        ['paid', orderNo]
      );
      
      logger.info(`User ${userId} subscribed to plan ${plan.name}`);
      
      return res.json({
        message: 'Subscription successful',
        subscriptionId: newSubscriptionResult.rows[0].id,
        orderNo: orderNo,
      });
    } else {
      // 新订阅（可能是试用期）
      const hasEverSubscribed = await pool.query(
        'SELECT id FROM user_subscriptions WHERE user_id = $1',
        [userId]
      );
      
      const isTrial = hasEverSubscribed.rows.length === 0; // 新用户给7天试用
      const trialEnd = isTrial ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null;
      
      const subscriptionResult = await pool.query(`
        INSERT INTO user_subscriptions (user_id, plan_id, status, current_period_start, current_period_end, trial_end)
        VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '1 ${billingCycle === 'yearly' ? 'year' : 'month'}', $4)
        RETURNING id
      `, [
        userId,
        planId,
        isTrial ? 'trial' : 'active',
        trialEnd
      ]);
      
      // 更新用户订阅状态
      await pool.query(
        'UPDATE users SET subscription_status = $1, current_subscription_id = $2 WHERE id = $3',
        [isTrial ? 'trial' : plan.name.toLowerCase(), subscriptionResult.rows[0].id, userId]
      );
      
      logger.info(`User ${userId} started new subscription to plan ${plan.name}, trial: ${isTrial}`);
      
      return res.json({
        message: isTrial ? 'Trial period started, auto-renewal in 7 days' : 'Subscription successful',
        subscriptionId: subscriptionResult.rows[0].id,
        isTrial,
        trialEnd,
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
