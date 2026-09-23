import jwt from 'jsonwebtoken';
import config from '../config.js';
import { isJtiBlacklisted } from '../utils/redis-client.js';
import { pool } from '../db/pool.js';

/** 2FA 挑战令牌类型声明（登录时密码已过、动态码未过） */
export const CHALLENGE_TOKEN_TYPE = '2fa_challenge';

// twoFactorChallenge 为旧版声明，一并识别，避免存量令牌绕过
function isChallengeToken(decoded) {
  return decoded?.tokenType === CHALLENGE_TOKEN_TYPE || decoded?.twoFactorChallenge === true;
}

export async function authenticateToken(req, res, next) {
  // 测试环境跳过token验证，使用测试用户
  if (process.env.NODE_ENV === 'test') {
    req.user = {
      userId: '00000000-0000-0000-0000-000000000001', // 测试用户ID
      phone: '13900999999',
      sessionId: 'test-session-id',
      // RBAC（#210）：测试用户默认普通角色，避免误开敏感权限
      roleKey: 'user',
      roleLevel: 10,
      isAdmin: false,
    };
    req.userId = req.user.userId;
    return next();
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);

    // 挑战令牌不是登录态：只允许 require2faChallenge 保护的「完成 2FA」端点消费
    if (isChallengeToken(decoded)) {
      return res.status(401).json({ error: 'Two-factor verification required' });
    }

    // ✅ 会话吊销 / 注销后立即失效：检查 JWT 黑名单（bl:{jti}）
    // Redis 不可用时降级为“未吊销”，由下方 DB 层 user_sessions.is_active 兜底（H2 修复）
    if (decoded.jti) {
      const blacklisted = await isJtiBlacklisted(decoded.jti);
      if (blacklisted) {
        return res.status(401).json({ error: 'Token revoked' });
      }
    }

    req.user = decoded;
    req.userId = decoded.userId; // ✅ 关键：所有路由依赖此字段做用户隔离

    // 读取sessionId（用于会话管理）
    if (decoded.sessionId) {
      req.user.sessionId = decoded.sessionId;
    }

    // ✅ 账户活性 + 会话活性 双重校验（C1 修复：吊销会话须立即使 token 失效）
    // 即便 Redis 黑名单因抖动未命中，只要 user_sessions.is_active=false 就拒绝
    try {
      const userCheck = await pool.query(
        `SELECT u.is_active AS user_active, s.is_active AS session_active,
                r.role_key, r.level AS role_level, u.is_admin
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         LEFT JOIN user_sessions s ON s.id = $2
         WHERE u.id = $1`,
        [decoded.userId, decoded.jti || null]
      );
      if (userCheck.rows.length === 0) {
        return res.status(401).json({ error: 'Account not found' });
      }
      const row = userCheck.rows[0];
      if (!row.user_active) {
        return res.status(401).json({ error: 'Account deactivated' });
      }
      // token 绑定了已吊销的会话 → 立即拒绝（不依赖 Redis 黑名单）
      if (decoded.jti && row.session_active === false) {
        return res.status(401).json({ error: 'Session revoked' });
      }
      // ✅ RBAC（#210）：将角色信息注入 req.user，供 AI 角色强制链路使用
      req.user.roleKey = row.role_key || 'user';
      req.user.roleLevel = row.role_level ?? 10;
      req.user.isAdmin = Boolean(row.is_admin) || row.role_key === 'super_admin';
    } catch (err) {
      // DB 查询失败：记录告警，但放行（避免误杀正常请求）
      console.warn('[auth] user/session active check failed:', err.message);
    }

    // 角色信息兜底：若上述查询未附加（异常路径），降级为普通用户
    if (!req.user.roleKey) {
      req.user.roleKey = 'user';
      req.user.roleLevel = 10;
      req.user.isAdmin = false;
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    // 无效/伪造 token 同属认证失败，统一 401（前端 401 拦截器据此走刷新→跳登录链路；
    // 403 语义保留给「认证通过但权限不足」，此前 403 会导致管理台卡在页面无法回登录）
    return res.status(401).json({ error: 'Invalid token', detail: err.message });
  }
}

export function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    // 挑战令牌等同未认证（optionalAuth 降级为匿名，不注入身份）
    if (isChallengeToken(decoded)) {
      return next();
    }
    req.user = decoded;
    req.userId = decoded.userId;
    // RBAC（#210）：optionalAuth 不查库，给默认普通角色（下游无 roleKey 时等同）
    req.user.roleKey = req.user.roleKey || 'user';
    req.user.roleLevel = req.user.roleLevel ?? 10;
    req.user.isAdmin = Boolean(req.user.isAdmin) || req.user.roleKey === 'super_admin';
  } catch {
    // Token invalid, continue without auth
  }
  next();
}

/**
 * 只接受 2FA 挑战令牌（完成本次登录），拒绝正式 access token。
 * 用于「消费挑战」的极小端点集合：POST /api/auth/2fa/verify-login。
 * 通过后仅挂 req.twoFactorChallenge，不设置 req.user / req.userId——
 * 避免下游把它误当登录态。
 */
export function require2faChallenge(req, res, next) {
  const authHeader = req.headers['authorization'];
  const bearer = authHeader && authHeader.split(' ')[1];
  // verify-login 现由请求体传 challengeToken，两种传法都接受
  const raw = bearer || req.body?.challengeToken;

  if (!raw) {
    return res.status(401).json({ error: '2FA challenge token required' });
  }

  let decoded;
  try {
    decoded = jwt.verify(raw, config.jwt.secret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: '2FA challenge expired' });
    }
    return res.status(401).json({ error: 'Invalid 2FA challenge token' });
  }

  if (!isChallengeToken(decoded)) {
    return res.status(401).json({ error: 'Not a 2FA challenge token' });
  }

  req.twoFactorChallenge = decoded;
  next();
}
