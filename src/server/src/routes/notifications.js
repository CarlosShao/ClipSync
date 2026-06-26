/**
 * 通知偏好路由
 * Phase 9.3 - 通知偏好
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import * as notificationService from '../services/notificationService.js';

const router = Router();

/**
 * GET /api/notifications/preferences
 * 获取用户通知偏好
 */
router.get('/preferences', authenticateToken, async (req, res) => {
  try {
    const preferences = await notificationService.getNotificationPreferences(req.user.userId);
    res.json(preferences);
  } catch (error) {
    console.error('[Notifications] 获取偏好失败:', error);
    res.status(500).json({ error: '获取通知偏好失败' });
  }
});

/**
 * PUT /api/notifications/preferences
 * 更新用户通知偏好
 */
router.put('/preferences', authenticateToken, async (req, res) => {
  try {
    const { notificationType, enabled } = req.body;
    
    if (!notificationType || enabled === undefined) {
      return res.status(400).json({ error: '缺少必需参数' });
    }
    
    const preference = await notificationService.updateNotificationPreference(
      req.user.userId,
      notificationType,
      enabled
    );
    
    res.json(preference);
  } catch (error) {
    console.error('[Notifications] 更新偏好失败:', error);
    res.status(500).json({ error: '更新通知偏好失败' });
  }
});

/**
 * GET /api/notifications/history
 * 获取用户通知历史
 */
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const { limit = 50, offset = 0, status } = req.query;
    
    const history = await notificationService.getNotificationHistory(
      req.user.userId,
      { limit: parseInt(limit), offset: parseInt(offset), status }
    );
    
    res.json(history);
  } catch (error) {
    console.error('[Notifications] 获取历史失败:', error);
    res.status(500).json({ error: '获取通知历史失败' });
  }
});

/**
 * PUT /api/notifications/history/:id/read
 * 标记通知为已读
 */
router.put('/history/:id/read', authenticateToken, async (req, res) => {
  try {
    const notification = await notificationService.markNotificationAsRead(
      req.params.id,
      req.user.userId
    );
    
    if (!notification) {
      return res.status(404).json({ error: '通知不存在' });
    }
    
    res.json(notification);
  } catch (error) {
    console.error('[Notifications] 标记已读失败:', error);
    res.status(500).json({ error: '标记通知已读失败' });
  }
});

export default router;
