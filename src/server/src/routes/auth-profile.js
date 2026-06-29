import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/pool.js';
import { authenticateToken } from '../middleware/auth.js';
import { sanitizeString } from '../validation/validator.js';
import { encryptField, decryptField } from '../utils/encryption.js';
import { sendAccountDeletionEmail } from '../utils/email.js';
import { getUserCache, setUserCache, clearUserCache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';

const router = Router();

// 获取当前用户信息（带缓存）
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // 尝试从缓存获取
    const cachedUser = await getUserCache(userId);
    if (cachedUser) {
      return res.json(cachedUser);
    }

    const result = await pool.query(
      'SELECT id, phone, email, nickname, avatar_url, created_at, subscription_status FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const userData = {
      id: user.id,
      phone: user.phone,
      email: user.email,
      nickname: user.nickname,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
      subscriptionStatus: user.subscription_status
    };

    // 设置缓存
    await setUserCache(userId, userData);

    res.json(userData);
  } catch (err) {
    logger.error('Get user info error:', { error: err.message });
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// 更新用户资料
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { nickname, avatarUrl } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (nickname !== undefined) {
      updates.push(`nickname = $${paramIndex++}`);
      values.push(sanitizeString(nickname));
    }

    if (avatarUrl !== undefined) {
      updates.push(`avatar_url = $${paramIndex++}`);
      values.push(sanitizeString(avatarUrl));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(userId);

    const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`;
    await pool.query(query, values);

    // 清除用户缓存
    await clearUserCache(userId);

    res.json({ message: 'Profile updated successfully' });
  } catch (err) {
    logger.error('Update profile error:', { error: err.message });
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// 删除账户（GDPR）
router.delete('/account', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // 获取用户信息（用于发送邮件）
    const userResult = await pool.query(
      'SELECT email, nickname FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];

    // 使所有活跃会话失效
    await pool.query(
      'UPDATE user_sessions SET is_active = FALSE WHERE user_id = $1',
      [userId]
    );

    // 删除用户数据
    await pool.query('DELETE FROM clipboard_items WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM user_subscriptions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    // 发送账户删除确认邮件
    if (user?.email) {
      await sendAccountDeletionEmail(user.email, user.nickname || 'User');
    }

    res.json({ message: 'Account deleted successfully' });
  } catch (err) {
    logger.error('Delete account error:', { error: err.message });
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// 导出用户数据（GDPR）
router.get('/export-data', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // 获取用户信息
    const userResult = await pool.query(
      'SELECT id, phone, email, nickname, created_at FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // 获取剪贴板数据
    const clipboardResult = await pool.query(
      'SELECT id, content_type, content_preview, created_at, updated_at FROM clipboard_items WHERE user_id = $1',
      [userId]
    );

    // 获取会话数据
    const sessionsResult = await pool.query(
      'SELECT id, device_name, device_type, platform, created_at FROM user_sessions WHERE user_id = $1',
      [userId]
    );

    const exportData = {
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        nickname: user.nickname,
        createdAt: user.created_at
      },
      clipboardItems: clipboardResult.rows,
      sessions: sessionsResult.rows,
      exportedAt: new Date().toISOString()
    };

    res.json(exportData);
  } catch (err) {
    logger.error('Export data error:', { error: err.message });
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// 停用账户
router.put('/deactivate', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    await pool.query(
      'UPDATE users SET is_active = FALSE, deactivated_at = NOW() WHERE id = $1',
      [userId]
    );

    // 使所有会话失效
    await pool.query(
      'UPDATE user_sessions SET is_active = FALSE WHERE user_id = $1',
      [userId]
    );

    res.json({ message: 'Account deactivated successfully' });
  } catch (err) {
    logger.error('Deactivate account error:', { error: err.message });
    res.status(500).json({ error: 'Failed to deactivate account' });
  }
});

// 重新激活账户
router.put('/reactivate', async (req, res) => {
  try {
    const { email, phone } = req.body;
    const identifier = email || phone;

    if (!identifier) {
      return res.status(400).json({ error: 'Email or phone is required' });
    }

    const cleanIdentifier = identifier.toLowerCase();

    let userResult;
    if (email) {
      userResult = await pool.query('SELECT id FROM users WHERE email = $1', [cleanIdentifier]);
    } else {
      userResult = await pool.query('SELECT id FROM users WHERE phone = $1', [cleanIdentifier]);
    }

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = userResult.rows[0].id;

    await pool.query(
      'UPDATE users SET is_active = TRUE, deactivated_at = NULL WHERE id = $1',
      [userId]
    );

    res.json({ message: 'Account reactivated successfully' });
  } catch (err) {
    logger.error('Reactivate account error:', { error: err.message });
    res.status(500).json({ error: 'Failed to reactivate account' });
  }
});

// 更新用户同意状态
router.put('/consent', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { consentType, granted } = req.body;

    if (!consentType) {
      return res.status(400).json({ error: 'Consent type is required' });
    }

    // 存储同意记录
    await pool.query(
      `INSERT INTO user_consents (id, user_id, consent_type, granted, granted_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, consent_type) DO UPDATE SET granted = $4, granted_at = NOW()`,
      [uuidv4(), userId, consentType, granted]
    );

    res.json({ message: 'Consent updated successfully' });
  } catch (err) {
    logger.error('Update consent error:', { error: err.message });
    res.status(500).json({ error: 'Failed to update consent' });
  }
});

export default router;
