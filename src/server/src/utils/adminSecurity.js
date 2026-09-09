// =============================================
// AN-12 管理员安全策略强制点：force_2fa_for_admin 开关
//
// 语义：开启后，管理角色（roles.level >= 50，admin / super_admin）
//       在登录时若未绑定两步验证 → 登录被拦截（403 + forceTwoFactorSetup 标识），
//       引导先在客户端绑定 2FA 再登录。
//
// 调用点（登录成功、签发会话之前）：
//   - routes/auth.js       POST /login（密码登录，管理台/桌面端共用）
//   - routes/auth-verify.js POST /verify-code（验证码登录）
//
// 响应契约：403 { error: '<引导文案>', forceTwoFactorSetup: true }
// （与 auth-password.js 的 deactivated / pendingReview 拦截同一形态，
//   前端按 errBody.error toast 展示）
// =============================================

import { pool } from '../db/pool.js';
import { isFlagEnabled } from './featureFlags.js';
import { logger } from './logger.js';

/** 管理角色最低等级阈值（028_roles.sql：user=10 / admin=50 / super_admin=100） */
const ADMIN_LEVEL_THRESHOLD = 50;

/** 开关开启时返回给前端的引导文案 */
export const FORCE_2FA_MESSAGE = '该管理员账号已强制要求两步验证，请先在 ClipSync 客户端绑定 2FA 后重新登录';

/**
 * AN-12：判断该用户是否被「强制管理员 2FA」策略拦截。
 * @param {{ id: string, two_factor_enabled?: boolean|null }} user users 行（需含 id）
 * @returns {Promise<boolean>} true = 应拦截登录（引导绑定 2FA）
 */
export async function shouldForceTwoFactorForAdmin(user) {
  // 已绑定 2FA：直接放行（不查开关，省一次读）
  if (user?.two_factor_enabled) return false;

  const enabled = await isFlagEnabled('force_2fa_for_admin', false);
  if (!enabled) return false;

  try {
    const { rows } = await pool.query(
      `SELECT r.level
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [user.id]
    );
    const level = Number(rows[0]?.level);
    // 无角色/查询为空按普通用户处理（fail-open：仅拦管理角色，不影响普通用户登录）
    return Number.isFinite(level) && level >= ADMIN_LEVEL_THRESHOLD;
  } catch (err) {
    // 查库失败不阻塞登录（fail-open），仅告警
    logger.warn('[adminSecurity] force_2fa role lookup failed, allow login', {
      userId: user?.id,
      error: err.message,
    });
    return false;
  }
}
