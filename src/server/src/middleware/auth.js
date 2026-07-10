import jwt from 'jsonwebtoken';
import config from '../config.js';
import { isJtiBlacklisted } from '../utils/redis-client.js';
import { pool } from '../db/pool.js';

export async function authenticateToken(req, res, next) {
  // 测试环境跳过token验证，使用测试用户
  if (process.env.NODE_ENV === 'test') {
    req.user = {
      userId: '00000000-0000-0000-0000-000000000001', // 测试用户ID
      phone: '13900999999',
      sessionId: 'test-session-id',
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
        `SELECT u.is_active AS user_active, s.is_active AS session_active
         FROM users u
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
    } catch (err) {
      // DB 查询失败：记录告警，但放行（避免误杀正常请求）
      console.warn('[auth] user/session active check failed:', err.message);
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(403).json({ error: 'Invalid token', detail: err.message });
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
    req.user = decoded;
    req.userId = decoded.userId;
  } catch {
    // Token invalid, continue without auth
  }
  next();
}
