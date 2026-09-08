import pool from '../db/pool.js';
import { isFlagEnabled } from '../utils/featureFlags.js';
import { logger } from '../utils/logger.js';
import { getPlanByName } from './subscriptionCheck.js';

/**
 * 套餐功能墙中间件（MA-05 · 方案一 B「按 subscription_plans.features 真锁」）
 *
 * 用法：router.post('/xxx', requirePlanFeature('team_management'), handler)
 * 行为：读用户当前 active 订阅套餐的 features JSONB，键值 !== true 时返回
 *      403 { error: '该功能为付费套餐功能', planFeature: '<key>', code: 40303 }。
 *      admin/super_admin（users.is_admin 或 roles.role_key='super_admin'）直通；
 *      enable_subscription 开关关闭时全员按 Free 套餐 features 判定（与 subscriptionCheck 口径一致）。
 *
 * ── 真实 features 数据形态（2026-09-07 clipsync_dev 实测）──────────────────
 * 顶层扁平布尔键（version_history_days 为数字天数，本中间件只认布尔 true）：
 *   Free       : ai_classify/offline_queue/e2e_encryption=true；full_text_search/push_notification=false；version_history_days=3
 *   Pro        : 同 Free，但 full_text_search/push_notification=true；version_history_days=30
 *   Enterprise : 另含 team_management=true、audit_logs=true；version_history_days=365
 * 注意：工单假设的 hasOcr/hasAICategories/hasPrioritySync/hasTeamSharing 四个键在真实数据中
 * 【不存在】，挂墙一律使用上表真实键；移动端 subscription_plan.dart 读取的 has_ocr 等字段
 * 服务端从未下发，恒为默认值 false。
 *
 * ── 四个营销键的服务端现状（供后续功能立项时使用）──────────────────────────
 * 1. hasOcr —— A：服务端无独立 OCR REST 端点（OCR 仅有以下执行点），feature.ocr 键名已定，
 *    但套餐 features 无对应键，故【未挂墙，待功能立项时挂墙】：
 *    - 图片上传后台 OCR：src/server/src/routes/clipboard.js:666（runOcrForClip 异步写 ocr_text）
 *    - AI 工具手动 OCR：src/server/src/routes/aiTools.js:2361（ocr_clip_image → ocrClipById）
 *    立项时：先在管理台为各套餐 features 增加 "ocr": true/false，再把
 *    requirePlanFeature('ocr') 挂到上述两处。现在直接挂会因键缺失把全部套餐（含付费）锁死。
 * 2. hasPrioritySync —— C：服务端无「优先同步」实现（sync.js 仅 push/pull/status，无队列/优先级概念），
 *    仅移动端订阅页营销展示位。无服务端执行点可挂，功能墙暂仅客户端 UI 层。
 * 3. hasAICategories —— A：已映射真实键 ai_classify，挂墙于 POST /api/ai/suggest
 *    （AI 收藏/分类/清理建议，aiChat.js）。当前三档套餐 ai_classify 均为 true（挂墙零行为变化），
 *    管理台将某套餐改为 false 即服务端生效。
 * 4. hasTeamSharing —— A：已映射真实键 team_management，挂墙于分享链接创建
 *    （POST /api/shared-links、POST /api/shared-links/upload-file）。仅 Enterprise 为 true，
 *    Free/Pro 创建分享将被 403；已有链接的查看/删除/公开访问不受影响。
 */

function normalizeFeatures(features) {
  if (!features) return {};
  if (typeof features === 'string') {
    try {
      features = JSON.parse(features);
    } catch {
      return {};
    }
  }
  return features && typeof features === 'object' && !Array.isArray(features) ? features : {};
}

/**
 * 解析用户当前生效套餐的 features。
 * 返回 { bypass: true }（管理员直通）或 { features }（普通用户判定用）。
 */
async function loadPlanFeatures(userId) {
  const userResult = await pool.query(
    `SELECT u.is_admin, u.subscription_status, u.current_subscription_id, r.role_key
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [userId]
  );

  // 用户不存在（正常请求不会走到这）：按空 features 处理 → 拒绝
  if (userResult.rows.length === 0) {
    return { features: {} };
  }

  const user = userResult.rows[0];

  // admin / super_admin：不限（与 subscriptionCheck 的管理员口径一致）
  if (user.is_admin || user.role_key === 'super_admin') {
    return { bypass: true };
  }

  // enable_subscription 开关关闭：全员临时按 Free 配额执行，不改库不碰订单
  if (!(await isFlagEnabled('enable_subscription'))) {
    return { features: normalizeFeatures((await getPlanByName('Free')).features) };
  }

  // Free / 无订阅记录 → Free
  const status = user.subscription_status || 'free';
  if (status === 'free' || !user.current_subscription_id) {
    return { features: normalizeFeatures((await getPlanByName('Free')).features) };
  }

  // 有效订阅：取其套餐 features；订阅不存在或已过期降级按 Free（只读，不写库）
  const subResult = await pool.query(
    `SELECT sp.features, us.current_period_end
     FROM user_subscriptions us
     JOIN subscription_plans sp ON us.plan_id = sp.id
     WHERE us.id = $1 AND us.user_id = $2`,
    [user.current_subscription_id, userId]
  );

  const now = new Date();
  if (
    subResult.rows.length > 0 &&
    (!subResult.rows[0].current_period_end || new Date(subResult.rows[0].current_period_end) >= now)
  ) {
    return { features: normalizeFeatures(subResult.rows[0].features) };
  }

  return { features: normalizeFeatures((await getPlanByName('Free')).features) };
}

/**
 * 套餐功能墙中间件工厂
 * @param {string} featureKey subscription_plans.features JSONB 布尔键（如 'ai_classify' / 'team_management'）
 */
function requirePlanFeature(featureKey) {
  return async (req, res, next) => {
    // 测试环境跳过（与 subscriptionCheck 口径一致）
    if (process.env.NODE_ENV === 'test') {
      return next();
    }
    try {
      const userId = req.user && req.user.userId;
      if (!userId) {
        return res.status(401).json({ error: 'Access token required' });
      }

      const result = await loadPlanFeatures(userId);
      if (result.bypass) {
        return next();
      }

      if (result.features[featureKey] !== true) {
        logger.info('[PlanFeature] feature denied', { userId, featureKey });
        return res.status(403).json({
          error: '该功能为付费套餐功能',
          planFeature: featureKey,
          code: 40303,
        });
      }

      return next();
    } catch (err) {
      logger.error('[PlanFeature] check failed:', err);
      res.status(500).json({ error: 'Plan feature check failed' });
    }
  };
}

export { requirePlanFeature };
