import pool from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * 订阅权限检查中间件
 * 检查用户订阅状态，将订阅信息附加到req对象
 */
async function subscriptionCheck(req, res, next) {
  // 测试环境跳过订阅检查
  if (process.env.NODE_ENV === 'test') {
    return next();
  }
  try {
    const userId = req.user.userId;
    
    // 获取用户订阅状态（含管理员标记）
    const userResult = await pool.query(
      'SELECT subscription_status, current_subscription_id, is_admin FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // 管理员：直接赋予无限额度
    if (user.is_admin) {
      req.user.subscriptionStatus = 'admin';
      req.user.plan = {
        name: 'Admin',
        maxDevices: 9999,
        maxClipboardItems: 99999,
        maxFileSizeMb: 500,
        maxStorageMb: 100000,
        features: JSON.stringify(['all']),
        isUnlimited: true,
      };
      return next();
    }
    req.user.subscriptionStatus = user.subscription_status || 'free';
    req.user.currentSubscriptionId = user.current_subscription_id;
    
    // 如果是Free套餐，直接继续
    if (req.user.subscriptionStatus === 'free') {
      req.user.plan = await getPlanByName('Free');
      return next();
    }
    
    // 获取当前订阅详情
    if (req.user.currentSubscriptionId) {
      const subscriptionResult = await pool.query(`
        SELECT us.*, sp.name as plan_name, sp.max_devices, sp.max_clipboard_items, 
               sp.max_file_size_mb, sp.max_storage_mb, sp.features
        FROM user_subscriptions us
        JOIN subscription_plans sp ON us.plan_id = sp.id
        WHERE us.id = $1 AND us.user_id = $2
      `, [req.user.currentSubscriptionId, userId]);
      
      if (subscriptionResult.rows.length > 0) {
        const subscription = subscriptionResult.rows[0];
        
        // 检查订阅是否过期
        const now = new Date();
        if (subscription.current_period_end && new Date(subscription.current_period_end) < now) {
          // 订阅已过期，降级到Free
          await downgradeToFree(userId);
          req.user.subscriptionStatus = 'free';
          req.user.plan = await getPlanByName('Free');
          req.user.subscriptionExpired = true;
        } else {
          // 订阅有效
          req.user.plan = {
            name: subscription.plan_name,
            maxDevices: subscription.max_devices,
            maxClipboardItems: subscription.max_clipboard_items,
            maxFileSizeMb: subscription.max_file_size_mb,
            maxStorageMb: subscription.max_storage_mb,
            features: subscription.features,
          };
          req.user.subscriptionExpiresAt = subscription.current_period_end;
        }
      } else {
        // 订阅不存在，降级到Free
        await downgradeToFree(userId);
        req.user.subscriptionStatus = 'free';
        req.user.plan = await getPlanByName('Free');
      }
    } else {
      req.user.plan = await getPlanByName('Free');
    }
    
    next();
  } catch (err) {
    logger.error('Subscription check error:', err);
    res.status(500).json({ error: 'Subscription check failed' });
  }
}

/**
 * 功能分级中间件工厂
 * 根据功能名称检查用户是否有权限使用
 */
function requireFeature(featureName) {
  return async (req, res, next) => {
    try {
      const plan = req.user.plan;
      
      if (!plan) {
        return res.status(403).json({ error: 'Unable to retrieve subscription info' });
      }
      
      const features = typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features;
      
      if (!features || features[featureName] !== true) {
        return res.status(403).json({
          error: 'This feature requires a higher subscription tier',
          feature: featureName,
          currentPlan: plan.name || 'Free',
          upgradeUrl: '/subscribe',
        });
      }
      
      next();
    } catch (err) {
      logger.error('Feature check error:', err);
      res.status(500).json({ error: 'Feature check failed' });
    }
  };
}

/**
 * 设备数量限制中间件
 * 只拦截 POST（创建设备）请求，不拦截 GET（列表）请求
 */
async function checkDeviceLimit(req, res, next) {
  // 只对创建设备的 POST 请求做限制
  if (req.method !== 'POST') {
    return next();
  }

  try {
    const userId = req.user.userId;
    const plan = req.user.plan;

    // 管理员绕过所有限制
    if (plan && plan.isUnlimited) return next();

    if (!plan) return next();
    
    // 获取用户当前设备数量
    const deviceCountResult = await pool.query(
      'SELECT COUNT(*) as count FROM devices WHERE user_id = $1',
      [userId]
    );
    
    const currentDeviceCount = parseInt(deviceCountResult.rows[0].count);
    
    if (currentDeviceCount >= plan.maxDevices) {
      return res.status(403).json({
        error: `Device limit reached (${plan.maxDevices} devices)`,
        currentCount: currentDeviceCount,
        maxDevices: plan.maxDevices,
        upgradeUrl: '/subscribe',
      });
    }
    
    next();
  } catch (err) {
    logger.error('Device limit check error:', err);
    res.status(500).json({ error: 'Device limit check failed' });
  }
}

/**
 * 剪贴板条数限制中间件
 */
async function checkClipboardLimit(req, res, next) {
  try {
    const userId = req.user.userId;
    const plan = req.user.plan;

    // 管理员绕过所有限制
    if (plan && plan.isUnlimited) return next();
    if (!plan) return next();
    
    // 获取用户当前剪贴板条数
    const clipboardCountResult = await pool.query(
      'SELECT COUNT(*) as count FROM clipboard_items WHERE user_id = $1',
      [userId]
    );
    
    const currentClipboardCount = parseInt(clipboardCountResult.rows[0].count);
    
    if (currentClipboardCount >= plan.maxClipboardItems) {
      return res.status(403).json({
        error: `Clipboard item limit reached (${plan.maxClipboardItems} items)`,
        currentCount: currentClipboardCount,
        maxItems: plan.maxClipboardItems,
        upgradeUrl: '/subscribe',
      });
    }
    
    next();
  } catch (err) {
    logger.error('Clipboard limit check error:', err);
    res.status(500).json({ error: 'Clipboard limit check failed' });
  }
}

/**
 * 文件大小限制中间件
 */
function checkFileSizeLimit(maxSizeMb) {
  return async (req, res, next) => {
    try {
      const plan = req.user.plan;
      
      if (!plan) return next();
      
      if (maxSizeMb > plan.maxFileSizeMb) {
        return res.status(403).json({
          error: `File size exceeds plan limit (max ${plan.maxFileSizeMb}MB)`,
          fileSize: maxSizeMb,
          maxFileSize: plan.maxFileSizeMb,
          upgradeUrl: '/subscribe',
        });
      }
      
      next();
    } catch (err) {
      logger.error('File size limit check error:', err);
      res.status(500).json({ error: 'File size limit check failed' });
    }
  };
}

/**
 * 试用期管理：检查是否新用户（给7天Pro试用）
 */
async function checkTrialEligibility(req, res, next) {
  try {
    const userId = req.user.userId;
    
    // 检查用户是否曾经有过订阅
    const subscriptionHistory = await pool.query(
      'SELECT id FROM user_subscriptions WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    
    req.user.isTrialEligible = subscriptionHistory.rows.length === 0;
    
    next();
  } catch (err) {
    logger.error('Trial eligibility check error:', err);
    req.user.isTrialEligible = false;
    next();
  }
}

/**
 * 降级到Free套餐
 */
async function downgradeToFree(userId) {
  try {
    await pool.query(
      'UPDATE users SET subscription_status = $1, current_subscription_id = $2 WHERE id = $3',
      ['free', null, userId]
    );
    
    logger.info(`User ${userId} downgraded to Free plan`);
  } catch (err) {
    logger.error('Downgrade to free error:', err);
  }
}

/**
 * 获取套餐信息（按名称）
 */
async function getPlanByName(planName) {
  const result = await pool.query('SELECT * FROM subscription_plans WHERE name = $1 AND is_active = true', [planName]);
  
  if (result.rows.length === 0) {
    // 返回默认Free套餐
    return {
      name: 'Free',
      maxDevices: 2,
      maxClipboardItems: 50,
      maxFileSizeMb: 1,
      maxStorageMb: 100,
      features: {
        ai_classify: true,
        offline_queue: true,
        e2e_encryption: true,
        push_notification: false,
        full_text_search: false,
        version_history_days: 3,
      },
    };
  }
  
  const plan = result.rows[0];
  return {
    name: plan.name,
    maxDevices: plan.max_devices,
    maxClipboardItems: plan.max_clipboard_items,
    maxFileSizeMb: plan.max_file_size_mb,
    maxStorageMb: plan.max_storage_mb,
    features: typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features,
  };
}

export {
  subscriptionCheck,
  requireFeature,
  checkDeviceLimit,
  checkClipboardLimit,
  checkFileSizeLimit,
  checkTrialEligibility,
  downgradeToFree,
  getPlanByName,
};
