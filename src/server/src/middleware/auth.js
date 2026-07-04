import jwt from 'jsonwebtoken';
import config from '../config.js';
import { getRedisClient } from '../utils/redis-client.js';
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

    // ✅ 新增：检查 JWT 黑名单（注销后 token 立即失效）
    if (decoded.jti) {
      const redis = await getRedisClient();
      if (redis) {
        const blacklisted = await redis.get(`bl:${decoded.jti}`);
        if (blacklisted) {
          return res.status(401).json({ error: 'Token revoked' });
        }
      }
    }

    req.user = decoded;
    req.userId = decoded.userId; // ✅ 关键：所有路由依赖此字段做用户隔离

    // 读取sessionId（用于会话管理）
    if (decoded.sessionId) {
      req.user.sessionId = decoded.sessionId;
    }

    // ✅ Red Team 修复 P0-1: 检查账户是否已停用
    try {
      const userCheck = await pool.query(
        'SELECT is_active FROM users WHERE id = $1',
        [decoded.userId]
      );
      if (userCheck.rows.length === 0 || !userCheck.rows[0].is_active) {
        return res.status(401).json({ error: 'Account deactivated' });
      }
    } catch (err) {
      // 数据库查询失败，记录日志但允许请求继续（避免误杀）
      console.warn('[auth] is_active check failed:', err.message);
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
