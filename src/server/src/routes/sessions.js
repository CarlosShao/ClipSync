import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = Router();

/**
 * GET /api/sessions
 * 查看当前用户的所有活跃会话
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const sessionId = req.headers['x-session-id'] || req.body?.sessionId;

    const result = await pool.query(`
      SELECT
        id,
        device_name,
        device_type,
        platform,
        ip_address,
        user_agent,
        created_at,
        CASE WHEN id = $2 THEN true ELSE false END as is_current
      FROM user_sessions
      WHERE user_id = $1 AND is_active = true
      ORDER BY created_at DESC
    `, [userId, sessionId || null]);

    res.json({
      success: true,
      data: {
        sessions: result.rows.map(row => ({
          id: row.id,
          deviceName: row.device_name || '未知设备',
          platform: row.device_type || row.platform || 'unknown',
          ipAddress: row.ip_address || '',
          userAgent: '',
          createdAt: row.created_at,
          lastActiveAt: row.created_at,
          isCurrent: row.is_current,
        })),
      },
    });
  } catch (err) {
    logger.error('Failed to get sessions:', err);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

/**
 * DELETE /api/sessions/:sessionId
 * 撤销指定会话（强制下线）
 */
router.delete('/:sessionId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { sessionId } = req.params;

    // 检查会话是否属于当前用户
    const checkResult = await pool.query(`
      SELECT id FROM user_sessions
      WHERE id = $1 AND user_id = $2 AND is_active = true
    `, [sessionId, userId]);

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // 撤销会话（防御深度：再次验证 user_id）
    await pool.query(`
      UPDATE user_sessions
      SET is_active = false, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
    `, [sessionId, userId]);

    logger.info('Session revoked', { userId, sessionId });

    res.json({
      success: true,
      message: 'Session revoked successfully',
    });
  } catch (err) {
    logger.error('Failed to revoke session:', err);
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

/**
 * DELETE /api/sessions
 * 撤销所有会话（强制所有设备下线，除了当前会话）
 */
router.delete('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { currentSessionId } = req.body;

    // 撤销所有会话（除了当前会话）
    const result = await pool.query(`
      UPDATE user_sessions
      SET is_active = false, updated_at = NOW()
      WHERE user_id = $1
        AND is_active = true
        AND id != $2
    `, [userId, currentSessionId || null]);

    logger.info('All sessions revoked', { userId, excludedSessionId: currentSessionId });

    res.json({
      success: true,
      message: `Revoked ${result.rowCount} sessions`,
    });
  } catch (err) {
    logger.error('Failed to revoke all sessions:', err);
    res.status(500).json({ error: 'Failed to revoke all sessions' });
  }
});

export default router;
