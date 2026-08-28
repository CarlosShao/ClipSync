import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import pool from '../db/pool.js';
import config from '../config.js';
import { apiLimiter, getRedisClient } from '../middleware/rateLimiter.js';
import { rotateRefreshToken, issueRefreshToken } from '../utils/refreshToken.js';
import { logger } from '../utils/logger.js';

const router = Router();

// POST /api/auth/refresh — 旋转式刷新会话
// 客户端凭 refresh token 换取新 access token + 新 refresh token；
// 旧 refresh token 在 Redis 中 GETDEL 原子消费，防并发重放。
// 匿名端点（仅凭 token 本身鉴别），apiLimiter 防暴力枚举。
router.post('/refresh', apiLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(400).json({ error: 'refreshToken required' });
    }

    const payload = await rotateRefreshToken(refreshToken);
    if (!payload || !payload.userId || !payload.sessionId) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // 会话仍需有效：已登出 / 被吊销的会话不能刷新
    const session = await pool.query(
      'SELECT id FROM user_sessions WHERE id = $1 AND is_active = TRUE',
      [payload.sessionId]
    );
    if (session.rows.length === 0) {
      return res.status(401).json({ error: 'Session revoked' });
    }

    // jti 黑名单双校验（与 middleware/auth.js 语义一致）
    const redis = await getRedisClient();
    if (redis) {
      const blacklisted = await redis.get(`bl:${payload.sessionId}`);
      if (blacklisted) {
        return res.status(401).json({ error: 'Session revoked' });
      }
    }

    const userRow = await pool.query('SELECT id, phone, email FROM users WHERE id = $1', [payload.userId]);
    if (userRow.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    const user = userRow.rows[0];

    // 新 access token：复用同一 sessionId 作为 jti，吊销链路（黑名单/会话活性）与现有一致
    const token = jwt.sign(
      { userId: user.id, phone: user.phone, email: user.email, sessionId: payload.sessionId, jti: payload.sessionId },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );
    const nextRefreshToken = await issueRefreshToken(user.id, payload.sessionId);

    res.json({ token, refreshToken: nextRefreshToken });
  } catch (err) {
    logger.error('Refresh token error:', { error: err.message });
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

export default router;
