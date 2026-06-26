/**
 * 通知偏好服务
 * Phase 9.3 - 通知偏好
 */

import pool from '../db/pool.js';

/**
 * 获取用户通知偏好
 * @param {string} userId 
 * @returns {Array}
 */
export async function getNotificationPreferences(userId) {
  const result = await pool.query(
    'SELECT * FROM notification_preferences WHERE user_id = $1 ORDER BY notification_type',
    [userId]
  );
  return result.rows;
}

/**
 * 更新用户通知偏好
 * @param {string} userId 
 * @param {string} notificationType 
 * @param {boolean} enabled 
 */
export async function updateNotificationPreference(userId, notificationType, enabled) {
  const result = await pool.query(`
    INSERT INTO notification_preferences (user_id, notification_type, enabled)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, notification_type)
    DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
    RETURNING *
  `, [userId, notificationType, enabled]);
  
  // 如果没有记录被插入/更新，先查询
  if (result.rows.length === 0) {
    // 插入默认记录
    await pool.query(`
      INSERT INTO notification_preferences (user_id, notification_type, enabled)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
    `, [userId, notificationType, enabled]);
  }
  
  const updated = await pool.query(
    'SELECT * FROM notification_preferences WHERE user_id = $1 AND notification_type = $2',
    [userId, notificationType]
  );
  return updated.rows[0];
}

/**
 * 获取用户通知历史
 * @param {string} userId 
 * @param {Object} options 
 * @returns {Array}
 */
export async function getNotificationHistory(userId, options = {}) {
  const { limit = 50, offset = 0, status } = options;
  
  let query = 'SELECT * FROM notification_history WHERE user_id = $1';
  const params = [userId];
  
  if (status) {
    query += ' AND status = $2';
    params.push(status);
  }
  
  query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
  params.push(limit, offset);
  
  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * 标记通知为已读
 * @param {string} notificationId 
 * @param {string} userId 
 */
export async function markNotificationAsRead(notificationId, userId) {
  const result = await pool.query(`
    UPDATE notification_history
    SET read_at = NOW()
    WHERE id = $1 AND user_id = $2 AND read_at IS NULL
    RETURNING *
  `, [notificationId, userId]);
  
  return result.rows[0] || null;
}

/**
 * 创建通知记录
 * @param {Object} params 
 */
export async function createNotification(params) {
  const { userId, notificationType, title, content, metadata = {} } = params;
  
  const result = await pool.query(`
    INSERT INTO notification_history (user_id, notification_type, title, content, status, sent_at, metadata)
    VALUES ($1, $2, $3, $4, 'sent', NOW(), $5)
    RETURNING *
  `, [userId, notificationType, title, content, metadata]);
  
  return result.rows[0];
}
