import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();

// 支持的通知类型
const NOTIFICATION_TYPES = [
  'clipboard_sync',     // 剪贴板同步完成
  'new_device_login',   // 新设备登录
  'password_changed',    // 密码已更改
  'account_deactivated', // 账户已停用
  'account_reactivated', // 账户已重新激活
  'data_exported',      // 数据已导出
];

// 获取通知偏好
router.get('/preferences', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // 获取用户的所有通知偏好
    const result = await pool.query(
      'SELECT notification_type, enabled FROM notification_preferences WHERE user_id = $1',
      [userId]
    );

    // 构建偏好对象（默认所有通知都启用）
    const preferences = {};
    NOTIFICATION_TYPES.forEach(type => {
      preferences[type] = true; // 默认启用
    });

    // 更新为用户设置的偏好
    result.rows.forEach(row => {
      preferences[row.notification_type] = row.enabled;
    });

    res.json({
      preferences,
      availableTypes: NOTIFICATION_TYPES.map(type => ({
        type,
        description: getNotificationTypeDescription(type),
      })),
    });
  } catch (err) {
    console.error('Get notification preferences error:', err);
    res.status(500).json({ error: '获取通知偏好失败' });
  }
});

// 更新通知偏好
router.put('/preferences', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { preferences } = req.body;

    if (!preferences || typeof preferences !== 'object') {
      return res.status(400).json({ error: 'preferences 必须是对象' });
    }

    // 验证通知类型
    for (const type of Object.keys(preferences)) {
      if (!NOTIFICATION_TYPES.includes(type)) {
        return res.status(400).json({ error: `不支持的通知类型: ${type}` });
      }
      if (typeof preferences[type] !== 'boolean') {
        return res.status(400).json({ error: `通知类型 ${type} 的值必须是布尔值` });
      }
    }

    // 更新数据库
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const [type, enabled] of Object.entries(preferences)) {
        await client.query(
          `INSERT INTO notification_preferences (user_id, notification_type, enabled)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, notification_type)
           DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
          [userId, type, enabled]
        );
      }

      await client.query('COMMIT');

      // 返回更新后的偏好
      const result = await client.query(
        'SELECT notification_type, enabled FROM notification_preferences WHERE user_id = $1',
        [userId]
      );

      const updatedPreferences = {};
      NOTIFICATION_TYPES.forEach(type => {
        updatedPreferences[type] = true;
      });
      result.rows.forEach(row => {
        updatedPreferences[row.notification_type] = row.enabled;
      });

      res.json({
        message: '通知偏好已更新',
        preferences: updatedPreferences,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Update notification preferences error:', err);
    res.status(500).json({ error: '更新通知偏好失败' });
  }
});

// 获取通知历史（简化版 - 仅返回最近的操作日志）
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const limit = parseInt(req.query.limit) || 20;

    // 注意：当前没有专门的通知历史表
    // 返回最近的账户操作作为"通知历史"
    const history = [];

    // 获取最近的设备登录
    const devicesResult = await pool.query(
      `SELECT device_name, device_type, last_active_at, created_at
       FROM devices
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY last_active_at DESC
       LIMIT 5`,
      [userId]
    );

    devicesResult.rows.forEach(device => {
      history.push({
        type: 'new_device_login',
        message: `新设备登录：${device.device_name} (${device.device_type})`,
        timestamp: device.last_active_at || device.created_at,
        read: false,
      });
    });

    // 获取最近的会话
    const sessionsResult = await pool.query(
      `SELECT device_name, device_type, created_at
       FROM user_sessions
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY created_at DESC
       LIMIT 5`,
      [userId]
    );

    sessionsResult.rows.forEach(session => {
      history.push({
        type: 'session_created',
        message: `新会话创建：${session.device_name} (${session.device_type})`,
        timestamp: session.created_at,
        read: false,
      });
    });

    // 按时间排序
    history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({
      history: history.slice(0, limit),
      total: history.length,
    });
  } catch (err) {
    console.error('Get notification history error:', err);
    res.status(500).json({ error: '获取通知历史失败' });
  }
});

// 辅助函数：获取通知类型描述
function getNotificationTypeDescription(type) {
  const descriptions = {
    'clipboard_sync': '剪贴板同步完成时通知',
    'new_device_login': '新设备登录时通知',
    'password_changed': '密码已更改时通知',
    'account_deactivated': '账户已停用时通知',
    'account_reactivated': '账户已重新激活时通知',
    'data_exported': '数据已导出时通知',
  };
  return descriptions[type] || type;
}

export default router;
