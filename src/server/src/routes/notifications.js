/**
 * 通知偏好路由
 * Phase 9.3 - 通知偏好
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import * as notificationService from '../services/notificationService.js';
import { logger } from '../utils/logger.js';

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
    logger.error('[Notifications] 获取偏好失败:', { error: error.message });
    res.status(500).json({ error: 'Failed to get notification preferences' });
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
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const preference = await notificationService.updateNotificationPreference(
      req.user.userId,
      notificationType,
      enabled
    );
    
    res.json(preference);
  } catch (error) {
    logger.error('[Notifications] 更新偏好失败:', { error: error.message });
    res.status(500).json({ error: 'Failed to update notification preferences' });
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
    logger.error('[Notifications] 获取历史失败:', { error: error.message });
    res.status(500).json({ error: 'Failed to get notification history' });
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
      return res.status(404).json({ error: 'Notification not found' });
    }
    
    res.json(notification);
  } catch (error) {
    logger.error('[Notifications] 标记已读失败:', { error: error.message });
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

export default router;
