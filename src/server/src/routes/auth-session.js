import { Router } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';
import config from '../config.js';
import { authenticateToken } from '../middleware/auth.js';
import { getRedisClient } from '../middleware/rateLimiter.js';
import { blacklistJti } from '../utils/redis-client.js';
import { logger } from '../utils/logger.js';

const router = Router();

// 获取用户会话列表
router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(
      `SELECT id, device_name, device_type, platform, ip_address, user_agent, created_at, is_active
       FROM user_sessions
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    logger.error('Get sessions error:', { error: err.message });
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

// 终止会话
router.delete('/sessions/:sessionId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { sessionId } = req.params;

    // 验证会话属于当前用户
    const sessionResult = await pool.query(
      'SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // 标记会话为非活跃
    await pool.query(
      'UPDATE user_sessions SET is_active = FALSE WHERE id = $1',
      [sessionId]
    );

    // TODO: 将 token 加入 Redis 黑名单
    try {
      const redisClient = await getRedisClient();
      await redisClient.set(`blacklist:${sessionId}`, 'true', { EX: 86400 }); // 24小时过期
    } catch (redisErr) {
      logger.warn('Redis blacklist failed:', { error: redisErr.message });
    }

    res.json({ message: 'Session terminated' });
  } catch (err) {
    logger.error('Delete session error:', { error: err.message });
    res.status(500).json({ error: 'Failed to terminate session' });
  }
});

// 登出
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const sessionId = req.user.sessionId;

    // 标记会话为非活跃
    await pool.query(
      'UPDATE user_sessions SET is_active = FALSE WHERE id = $1 AND user_id = $2',
      [sessionId, userId]
    );

    // 将 token 加入 Redis 黑名单
    // 修复：此前写入 `blacklist:{sessionId}`，而 isJtiBlacklisted 读取 `bl:{jti}`，键不一致导致黑名单从未生效；
    // 统一改用 blacklistJti 封装（key: bl:{jti}，TTL = access token 剩余有效期）
    try {
      const decoded = jwt.decode(req.headers.authorization?.split(' ')[1] || '') || {};
      const remaining = decoded?.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 86400;
      await blacklistJti(sessionId, remaining > 0 ? remaining : 3600);
    } catch (redisErr) {
      logger.warn('Redis blacklist failed:', { error: redisErr.message });
    }

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    logger.error('Logout error:', { error: err.message });
    res.status(500).json({ error: 'Failed to logout' });
  }
});

export default router;
