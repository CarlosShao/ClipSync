import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import pool from '../../../db/pool.js'
import { encryptField } from '../../../utils/encryption.js'
import { logAuditEvent } from '../../../utils/audit.js'
import { maskPhone, maskEmail, computeFieldHash, guardTargetUser, revokeUserSessions } from '../shared.js'

export const adminRbacHandlers = {
  'get_security_overview': async (args, userId, role) => {
    {
      const userRes = await pool.query('SELECT two_factor_enabled, is_active FROM users WHERE id = $1', [userId])
      const u = userRes.rows[0] || {}
      const dev = await pool.query(
        'SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_online)::int AS online FROM devices WHERE user_id = $1',
        [userId]
      )
      const prot = await pool.query(
        "SELECT COUNT(*)::int AS advanced FROM clipboard_items WHERE user_id = $1 AND protection_level = 'advanced'",
        [userId]
      )
      return {
        twoFactorEnabled: !!u.two_factor_enabled,
        accountActive: !!u.is_active,
        devices: { total: dev.rows[0].total, online: dev.rows[0].online },
        advancedProtectedItems: prot.rows[0].advanced,
        note: '2FA 状态、设备在线数、高级密码保护条目数。更多账号安全在应用内「设置 → 安全」中管理。'
      }
    }
  },

  'list_users': async (args, userId, role) => {
    {
      const { keyword, page = 1, page_size = 20 } = args
      const safePage = Math.max(1, parseInt(page, 10) || 1)
      const safeSize = Math.min(Math.max(1, parseInt(page_size, 10) || 20), 100)
      const offset = (safePage - 1) * safeSize
      const kw = keyword && String(keyword).trim() ? `%${String(keyword).trim()}%` : null
      let sql = `SELECT u.id, u.nickname, u.phone, u.email, u.is_active, u.created_at,
                        r.role_key, r.name AS role_name
                 FROM users u LEFT JOIN roles r ON r.id = u.role_id`
      const params = []
      if (kw) {
        params.push(kw)
        sql += ` WHERE u.phone ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.nickname ILIKE $${params.length}`
      }
      sql += ` ORDER BY u.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
      params.push(safeSize, offset)
      const result = await pool.query(sql, params)
      const totalParams = kw ? [kw] : []
      const totalSql = kw
        ? `SELECT COUNT(*) AS c FROM users WHERE phone ILIKE $1 OR email ILIKE $1 OR nickname ILIKE $1`
        : 'SELECT COUNT(*) AS c FROM users'
      const total = await pool.query(totalSql, totalParams)
      return {
        total: parseInt(total.rows[0].c, 10),
        page: safePage,
        page_size: safeSize,
        users: result.rows.map((u) => ({
          id: u.id,
          nickname: u.nickname,
          phone: maskPhone(u.phone),
          email: maskEmail(u.email),
          role: u.role_name,
          role_key: u.role_key,
          is_active: u.is_active,
          created_at: u.created_at,
        })),
      }
    }
  },

  'create_user': async (args, userId, role) => {
    {
      const { phone, email, nickname, password, role = 'user' } = args
      const cleanPhone = String(phone || '').trim()
      if (!/^1[3-9]\d{9}$/.test(cleanPhone)) {
        return { error: 'INVALID_PHONE', code: 'INVALID_PHONE', message: '手机号格式不正确' }
      }
      if (typeof password !== 'string' || password.length < 6) {
        return { error: 'INVALID_PASSWORD', code: 'INVALID_PASSWORD', message: '密码至少 6 位' }
      }
      const cleanEmail = email ? String(email).trim().toLowerCase().slice(0, 254) : null
      if (cleanEmail) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        if (!emailRegex.test(cleanEmail)) return { error: 'INVALID_EMAIL', code: 'INVALID_EMAIL' }
      }
      const cleanNickname = nickname ? String(nickname).trim().slice(0, 30) : ''
      const allowedRoles = ['user', 'admin']
      if (!allowedRoles.includes(role)) {
        const msg = role === 'super_admin'
          ? '不允许直接创建超级管理员（超管唯一）'
          : '角色仅支持 user/admin'
        return { error: 'INVALID_ROLE', code: 'INVALID_ROLE', message: msg }
      }
      const phoneHash = computeFieldHash(cleanPhone)
      const dup = await pool.query(
        'SELECT id FROM users WHERE phone = $1 OR phone_hash = $2',
        [cleanPhone, phoneHash]
      )
      if (dup.rows.length > 0) return { error: 'PHONE_EXISTS', code: 'PHONE_EXISTS' }
      if (cleanEmail) {
        const emailHash = computeFieldHash(cleanEmail)
        const dupEmail = await pool.query(
          'SELECT id FROM users WHERE email = $1 OR email_hash = $2',
          [cleanEmail, emailHash]
        )
        if (dupEmail.rows.length > 0) return { error: 'EMAIL_EXISTS', code: 'EMAIL_EXISTS' }
      }
      const roleRes = await pool.query('SELECT id FROM roles WHERE role_key = $1', [role])
      if (roleRes.rows.length === 0) return { error: 'ROLE_NOT_FOUND', code: 'ROLE_NOT_FOUND' }
      const passwordHash = await bcrypt.hash(password, 12)
      const emailHash = cleanEmail ? computeFieldHash(cleanEmail) : null
      const userRes = await pool.query(
        `INSERT INTO users (phone, phone_hash, phone_encrypted, email, email_hash, email_encrypted,
                            nickname, password_hash, role_id, tos_accepted_at, privacy_accepted_at,
                            subscription_status, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), 'free', TRUE)
         RETURNING id, nickname, phone, email, is_active, created_at`,
        [
          cleanPhone, phoneHash, encryptField(cleanPhone),
          cleanEmail, emailHash, cleanEmail ? encryptField(cleanEmail) : null,
          cleanNickname, passwordHash, roleRes.rows[0].id,
        ]
      )
      const u = userRes.rows[0]
      return {
        success: true,
        user: {
          id: u.id,
          nickname: u.nickname,
          phone: maskPhone(u.phone),
          email: maskEmail(u.email),
          role,
          is_active: u.is_active,
          created_at: u.created_at,
        },
      }
    }
  },

  'update_user_role': async (args, userId, role) => {
    {
      const { user_id, role } = args
      if (!user_id) return { error: 'USER_ID_REQUIRED', code: 'USER_ID_REQUIRED' }
      if (!['user', 'admin'].includes(role)) {
        return { error: 'INVALID_ROLE', code: 'INVALID_ROLE', message: '角色仅支持 user/admin' }
      }
      const guard = await guardTargetUser(user_id, userId)
      if (guard.notFound) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
      if (guard.forbidden) {
        return { error: guard.error, code: guard.code, message: '不能修改自身或超级管理员的角色' }
      }
      const roleRes = await pool.query('SELECT id FROM roles WHERE role_key = $1', [role])
      if (roleRes.rows.length === 0) return { error: 'ROLE_NOT_FOUND', code: 'ROLE_NOT_FOUND' }
      await pool.query('UPDATE users SET role_id = $1, updated_at = NOW() WHERE id = $2', [roleRes.rows[0].id, user_id])
      await logAuditEvent({
        userId,
        action: 'update_user_role',
        resourceType: 'user',
        resourceId: String(user_id),
        details: { target_user_id: user_id, role },
      })
      return { success: true, user_id, role }
    }
  },

  'delete_user': async (args, userId, role) => {
    {
      const { user_id } = args
      if (!user_id) return { error: 'USER_ID_REQUIRED', code: 'USER_ID_REQUIRED' }
      const guard = await guardTargetUser(user_id, userId)
      if (guard.notFound) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
      if (guard.forbidden) {
        return { error: 'SUPER_ADMIN_DELETE_FORBIDDEN', code: guard.code === 'SELF_TARGET' ? 'SELF_TARGET' : 'SUPER_ADMIN_TARGET', message: '不能删除自身或超级管理员' }
      }
      await revokeUserSessions(user_id)
      const target = await pool.query('SELECT id, nickname FROM users WHERE id = $1', [user_id])
      if (target.rows.length === 0) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
      await pool.query('DELETE FROM users WHERE id = $1', [user_id])
      await logAuditEvent({
        userId,
        action: 'delete_user',
        resourceType: 'user',
        resourceId: String(user_id),
        details: { target_user_id: user_id },
      })
      return {
        success: true,
        user_id,
        note: '已物理删除该用户，其剪贴板条目、设备、订阅等数据均被级联删除（CASCADE），不可恢复。',
      }
    }
  },

  'reset_user_password': async (args, userId, role) => {
    {
      const { user_id } = args
      if (!user_id) return { error: 'USER_ID_REQUIRED', code: 'USER_ID_REQUIRED' }
      const guard = await guardTargetUser(user_id, userId)
      if (guard.notFound) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
      if (guard.forbidden) {
        return { error: guard.error, code: guard.code, message: '不能重置自身或超级管理员的密码' }
      }
      const tempPassword = crypto.randomBytes(6).toString('base64url')
      const passwordHash = await bcrypt.hash(tempPassword, 12)
      await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, user_id])
      await logAuditEvent({
        userId,
        action: 'reset_password',
        resourceType: 'user',
        resourceId: String(user_id),
        details: { target_user_id: user_id },
      })
      return {
        success: true,
        user_id,
        temp_password: tempPassword,
        note: '临时密码仅此出现一次，请安全转达目标用户，并提示其登录后立即修改。',
      }
    }
  },

  'disable_user': async (args, userId, role) => {
    {
      const { user_id, reason } = args
      if (!user_id) return { error: 'USER_ID_REQUIRED', code: 'USER_ID_REQUIRED' }
      const guard = await guardTargetUser(user_id, userId)
      if (guard.notFound) return { error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }
      if (guard.forbidden) {
        return { error: guard.error, code: guard.code, message: '不能停用自身或超级管理员' }
      }
      const safeReason = reason ? String(reason).trim().slice(0, 500) : '禁用（AI 管理工具）'
      await pool.query(
        'UPDATE users SET is_active = FALSE, deactivated_at = NOW(), deactivation_reason = $1, updated_at = NOW() WHERE id = $2',
        [safeReason, user_id]
      )
      const revoked = await revokeUserSessions(user_id)
      await logAuditEvent({
        userId,
        action: 'disable_user',
        resourceType: 'user',
        resourceId: String(user_id),
        details: { target_user_id: user_id, reason: safeReason },
      })
      return { success: true, user_id, revoked_sessions: revoked, reason: safeReason }
    }
  },

  'get_system_config': async (args, userId, role) => {
    {
      const { category } = args
      const params = []
      let sql = 'SELECT config_key, config_value, description, category, updated_at FROM system_configs'
      if (category && String(category).trim()) {
        params.push(String(category).trim())
        sql += ` WHERE category = $${params.length}`
      }
      sql += ' ORDER BY category, config_key'
      const result = await pool.query(sql, params)
      return {
        configs: result.rows.map((r) => ({
          config_key: r.config_key,
          config_value: r.config_value, // JSONB 已由 pg 解析为对象/标量
          description: r.description,
          category: r.category,
          updated_at: r.updated_at,
        })),
        total: result.rowCount,
      }
    }
  },

  'update_system_config': async (args, userId, role) => {
    {
      const { config_key, config_value } = args
      const key = config_key ? String(config_key).trim() : ''
      const CONFIG_WHITELIST = new Set([
        'ai_max_tokens',
        'ai_default_provider',
        'max_collection_depth',
        'enable_audit_log',
        'session_timeout_minutes',
      ])
      if (!CONFIG_WHITELIST.has(key)) {
        return { error: 'CONFIG_KEY_NOT_ALLOWED', code: 'CONFIG_KEY_NOT_ALLOWED', message: `不允许修改配置项：${key}` }
      }
      if (config_value === undefined) return { error: 'CONFIG_VALUE_REQUIRED', code: 'CONFIG_VALUE_REQUIRED' }
      const result = await pool.query(
        `INSERT INTO system_configs (config_key, config_value, updated_by, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING config_key, config_value, description, category, updated_at`,
        [key, JSON.stringify(config_value), userId]
      )
      await logAuditEvent({
        userId,
        action: 'config_change',
        resourceType: 'system_config',
        resourceId: key,
        details: { config_key: key },
      })
      return {
        success: true,
        config: {
          config_key: result.rows[0].config_key,
          config_value: result.rows[0].config_value,
          updated_at: result.rows[0].updated_at,
        },
        note: 'AI 类配置项为默认值语义，不影响各用户已提交的 per-user ai_providers 设置。',
      }
    }
  },

  'toggle_feature': async (args, userId, role) => {
    {
      const { flag_key, enabled } = args
      const key = flag_key ? String(flag_key).trim() : ''
      if (!key) return { error: 'FLAG_KEY_REQUIRED', code: 'FLAG_KEY_REQUIRED' }
      if (typeof enabled !== 'boolean') return { error: 'INVALID_ENABLED', code: 'INVALID_ENABLED', message: 'enabled 必须是布尔值' }
      const result = await pool.query(
        `INSERT INTO feature_flags (flag_key, enabled, description, updated_at)
         VALUES ($1, $2, NULL, NOW())
         ON CONFLICT (flag_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
         RETURNING flag_key, enabled, updated_at`,
        [key, enabled]
      )
      await logAuditEvent({
        userId,
        action: 'feature_flag_change',
        resourceType: 'feature_flag',
        resourceId: key,
        details: { flag_key: key, enabled },
      })
      return { success: true, flag_key: key, enabled: result.rows[0].enabled }
    }
  },

  'get_audit_logs': async (args, userId, role) => {
    {
      const { action, user_id, start_time, end_time, page = 1, page_size = 50 } = args
      const safePage = Math.max(1, parseInt(page, 10) || 1)
      const safeSize = Math.min(Math.max(1, parseInt(page_size, 10) || 50), 100)
      let query = 'SELECT * FROM audit_logs WHERE 1=1'
      const params = []
      let paramCount = 0
      if (user_id) { paramCount++; query += ` AND user_id = $${paramCount}`; params.push(user_id) }
      if (action) { paramCount++; query += ` AND action = $${paramCount}`; params.push(action) }
      if (start_time) { paramCount++; query += ` AND created_at >= $${paramCount}`; params.push(start_time) }
      if (end_time) { paramCount++; query += ` AND created_at <= $${paramCount}`; params.push(end_time) }
      query += ` ORDER BY created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`
      params.push(safeSize, (safePage - 1) * safeSize)
      const result = await pool.query(query, params)
      return {
        total: result.rowCount,
        page: safePage,
        page_size: safeSize,
        logs: result.rows,
      }
    }
  },
}