/**
 * 审计日志工具
 * P1-4: 安全审计日志
 * 
 * 功能：
 * 1. 记录敏感操作（登录、数据导出、账户删除等）
 * 2. 支持结构化详情（JSONB）
 * 3. 自动清理旧日志（1年）
 */

import pool from '../db/pool.js';
import { logger } from './logger.js';

/**
 * 记录审计日志
 * @param {Object} params - 日志参数
 * @param {string} params.userId - 用户ID（可选）
 * @param {string} params.action - 操作类型
 * @param {string} params.resourceType - 资源类型（可选）
 * @param {string} params.resourceId - 资源ID（可选）
 * @param {Object} params.details - 操作详情（可选）
 * @param {string} params.ipAddress - IP地址（可选）
 * @param {string} params.userAgent - 用户代理（可选）
 * @param {string} params.status - 状态（success/failure/error）
 * @param {string} params.errorMessage - 错误信息（可选）
 */
export async function logAuditEvent(params) {
  const {
    userId,
    action,
    resourceType,
    resourceId,
    details,
    ipAddress,
    userAgent,
    status = 'success',
    errorMessage,
  } = params;

  try {
    await pool.query(
      `INSERT INTO audit_logs 
       (user_id, action, resource_type, resource_id, details, ip_address, user_agent, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId || null,
        action,
        resourceType || null,
        resourceId || null,
        details ? JSON.stringify(details) : null,
        ipAddress || null,
        userAgent || null,
        status,
        errorMessage || null,
      ]
    );
  } catch (err) {
    logger.error('Failed to log audit event', { error: err.message, action });
    // 审计日志失败不阻塞主流程
  }
}

/**
 * 获取审计日志（管理员接口）
 * @param {Object} filters - 过滤条件
 * @returns {Promise<Array>} 审计日志列表
 */
export async function getAuditLogs(filters = {}) {
  const {
    userId,
    action,
    resourceType,
    status,
    startDate,
    endDate,
    limit = 100,
    offset = 0,
  } = filters;

  let query = 'SELECT * FROM audit_logs WHERE 1=1';
  const params = [];
  let paramCount = 0;

  if (userId) {
    paramCount++;
    query += ` AND user_id = $${paramCount}`;
    params.push(userId);
  }

  if (action) {
    paramCount++;
    query += ` AND action = $${paramCount}`;
    params.push(action);
  }

  if (resourceType) {
    paramCount++;
    query += ` AND resource_type = $${paramCount}`;
    params.push(resourceType);
  }

  if (status) {
    paramCount++;
    query += ` AND status = $${paramCount}`;
    params.push(status);
  }

  if (startDate) {
    paramCount++;
    query += ` AND created_at >= $${paramCount}`;
    params.push(startDate);
  }

  if (endDate) {
    paramCount++;
    query += ` AND created_at <= $${paramCount}`;
    params.push(endDate);
  }

  query += ` ORDER BY created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
  params.push(limit, offset);

  try {
    const result = await pool.query(query, params);
    return result.rows;
  } catch (err) {
    logger.error('Failed to get audit logs', { error: err.message });
    return [];
  }
}

/**
 * 清理旧审计日志（定时任务调用）
 */
export async function cleanupOldAuditLogs() {
  try {
    await pool.query('SELECT cleanup_old_audit_logs()');
    logger.info('Old audit logs cleaned up');
  } catch (err) {
    logger.error('Failed to cleanup old audit logs', { error: err.message });
  }
}

// 操作类型常量
export const AUDIT_ACTIONS = {
  LOGIN: 'login',
  LOGOUT: 'logout',
  LOGIN_FAILED: 'login_failed',
  EXPORT_DATA: 'export_data',
  DELETE_ACCOUNT: 'delete_account',
  DEACTIVATE_ACCOUNT: 'deactivate_account',
  REACTIVATE_ACCOUNT: 'reactivate_account',
  CHANGE_PASSWORD: 'change_password',
  RESET_PASSWORD: 'reset_password',
  UPDATE_PROFILE: 'update_profile',
  CREATE_CLIPBOARD: 'create_clipboard',
  DELETE_CLIPBOARD: 'delete_clipboard',
  UPLOAD_FILE: 'upload_file',
  DELETE_FILE: 'delete_file',
  DOWNLOAD_FILE: 'download_file',
  ADMIN_LOGIN: 'admin_login',
  ADMIN_ACTION: 'admin_action',
  // 支付相关
  PAYMENT_CREATE: 'payment_create',
  PAYMENT_COMPLETE: 'payment_complete',
  PAYMENT_FAILED: 'payment_failed',
  PAYMENT_REFUND: 'payment_refund',
  SUBSCRIPTION_CREATE: 'subscription_create',
  SUBSCRIPTION_CANCEL: 'subscription_cancel',
  SUBSCRIPTION_RENEW: 'subscription_renew',
};
