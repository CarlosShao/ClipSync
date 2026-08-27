import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import pool from '../../../db/pool.js'
import config from '../../../config.js'
import { blacklistJti, parseDurationToSeconds } from '../../../utils/redis-client.js'
import { encrypt } from '../../../utils/encryption.js'
import { logAuditEvent } from '../../../utils/audit.js'
import { isValidUUID, maskPhone } from '../shared.js'

export const sharingDevicesHandlers = {
  'show_diff_preview': async (args, userId, role) => {
        const { title, original_content, modified_content, target_id } = args
        const orig = String(original_content || '')
        const mod = String(modified_content || '')
        const origLines = orig.split('\n')
        const modLines = mod.split('\n')
        return {
          title: title || '变更对比预览',
          target_id: target_id || null,
          original_content: orig,
          modified_content: mod,
          original_lines_count: origLines.length,
          modified_lines_count: modLines.length,
          status: 'diff_rendered',
          message: '已在前端成功生成修改前后 Diff 对比卡片。'
        }
  },
  'get_devices': async (args, userId, role) => {
        const result = await pool.query(
          `SELECT id, device_name, device_type, platform, is_online, last_seen_at, created_at
           FROM devices
           WHERE user_id = $1
           ORDER BY last_seen_at DESC`,
          [userId]
        )
        return { devices: result.rows, count: result.rowCount }
  },
  'get_shared_links': async (args, userId, role) => {
        // 只返回非敏感字段：token 即访问凭证（等同 access_code），绝不回传明文
        const result = await pool.query(
          `SELECT id, title, content_preview, content_type, views, expires_at, created_at
           FROM shared_links
           WHERE user_id = $1
           ORDER BY created_at DESC`,
          [userId]
        )
        return { sharedLinks: result.rows, count: result.rowCount }
  },
  'create_shared_link': async (args, userId, role) => {
        const { content, title, expires_in_hours } = args
        if (typeof content !== 'string' || !content.trim()) {
          return { error: 'content is required' }
        }
        const token = crypto.randomBytes(10).toString('hex')
        const contentEncrypted = encrypt(String(content))
        const preview = String(content).slice(0, 200)
        const safeTitle = typeof title === 'string' ? title.slice(0, 200) : null
        let expiresAt = null
        if (typeof expires_in_hours === 'number' && expires_in_hours > 0) {
          expiresAt = new Date(Date.now() + expires_in_hours * 3600 * 1000).toISOString()
        }
        const result = await pool.query(
          `INSERT INTO shared_links (user_id, token, title, content_encrypted, content_preview, content_type, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'text', $6)
           RETURNING id, title, content_type, expires_at, created_at`,
          [userId, token, safeTitle, contentEncrypted, preview, expiresAt]
        )
        const r = result.rows[0]
        return {
          id: r.id,
          title: r.title,
          contentType: r.content_type,
          expiresAt: r.expires_at,
          createdAt: r.created_at,
          note: '共享链接已创建，访问地址请在应用「共享链接」列表中查看（链接访问凭证不会在此展示）。'
        }
  },
  'list_all_devices': async (args, userId, role) => {
        const result = await pool.query(
          `SELECT d.id, d.device_name, d.device_type, d.platform, d.is_online, d.last_seen_at, d.created_at,
                  u.id AS user_id, u.nickname, u.phone
           FROM devices d JOIN users u ON u.id = d.user_id
           ORDER BY d.last_seen_at DESC NULLS LAST`
        )
        return {
          devices: result.rows.map((d) => ({
            id: d.id,
            device_name: d.device_name,
            device_type: d.device_type,
            platform: d.platform,
            is_online: d.is_online,
            last_seen_at: d.last_seen_at,
            created_at: d.created_at,
            user: { id: d.user_id, nickname: d.nickname, phone: maskPhone(d.phone) },
          })),
          total: result.rowCount,
        }
  },
  'unpair_device': async (args, userId, role) => {
        const { device_id } = args
        if (!device_id) return { error: 'DEVICE_NOT_FOUND', code: 'DEVICE_NOT_FOUND', message: 'device_id 必填' }
        const exist = await pool.query('SELECT id FROM devices WHERE id = $1', [device_id])
        if (exist.rows.length === 0) return { error: 'DEVICE_NOT_FOUND', code: 'DEVICE_NOT_FOUND' }
        await pool.query('DELETE FROM devices WHERE id = $1', [device_id])
        await logAuditEvent({
          userId,
          action: 'unpair_device',
          resourceType: 'device',
          resourceId: String(device_id),
          details: { device_id },
        })
        return { success: true, device_id }
  },
  'delete_shared_link': async (args, userId, role) => {
        const { shared_link_id } = args
        if (!shared_link_id || !isValidUUID(shared_link_id)) {
          return { error: 'INVALID_SHARED_LINK', code: 'INVALID_SHARED_LINK', message: 'shared_link_id 必填且为合法 UUID' }
        }
        const found = await pool.query(
          'SELECT file_path FROM shared_links WHERE id = $1 AND user_id = $2',
          [shared_link_id, userId]
        )
        if (found.rows.length === 0) return { error: 'SHARED_LINK_NOT_FOUND', code: 'SHARED_LINK_NOT_FOUND' }
        for (const r of found.rows) {
          if (r.file_path) {
            try { await fs.rm(path.dirname(r.file_path), { recursive: true, force: true }) } catch { /* 忽略文件删除失败 */ }
          }
        }
        await pool.query('DELETE FROM shared_links WHERE id = $1 AND user_id = $2', [shared_link_id, userId])
        return { success: true, shared_link_id, note: '共享链接已删除，关联共享文件已一并移除。' }
  },
  'update_device': async (args, userId, role) => {
        const { device_id, device_name, platform_version, app_version } = args
        if (!device_id || !isValidUUID(device_id)) {
          return { error: 'INVALID_DEVICE', code: 'INVALID_DEVICE', message: 'device_id 必填且为合法 UUID' }
        }
        if (device_name === undefined && platform_version === undefined && app_version === undefined) {
          return { error: 'NO_FIELDS', code: 'NO_FIELDS', message: 'device_name / platform_version / app_version 至少提供一个' }
        }
        const cleanName = typeof device_name === 'string' && device_name.trim() ? device_name.trim().slice(0, 100) : null
        const cleanPv = typeof platform_version === 'string' && platform_version.trim() ? platform_version.trim().slice(0, 50) : null
        const cleanAv = typeof app_version === 'string' && app_version.trim() ? app_version.trim().slice(0, 20) : null
        const result = await pool.query(
          `UPDATE devices SET
             device_name = COALESCE($1, device_name),
             platform_version = COALESCE($2, platform_version),
             app_version = COALESCE($3, app_version),
             last_seen_at = NOW()
           WHERE id = $4 AND user_id = $5
           RETURNING id, device_name, device_type, platform, platform_version, app_version, is_online, created_at`,
          [cleanName, cleanPv, cleanAv, device_id, userId]
        )
        if (result.rowCount === 0) return { error: 'DEVICE_NOT_FOUND', code: 'DEVICE_NOT_FOUND' }
        return { device: result.rows[0] }
  },
  'unpair_own_device': async (args, userId, role) => {
        // 破坏性工具（已在 DESTRUCTIVE_CONFIRM_NEEDED 登记，经确认门控后进入此处）。仅自己设备可用。
        const { device_id } = args
        if (!device_id || !isValidUUID(device_id)) {
          return { error: 'INVALID_DEVICE', code: 'INVALID_DEVICE', message: 'device_id 必填且为合法 UUID' }
        }
        const del = await pool.query(
          'DELETE FROM devices WHERE id = $1 AND user_id = $2 RETURNING id',
          [device_id, userId]
        )
        if (del.rowCount === 0) {
          return { error: 'DEVICE_NOT_FOUND', code: 'DEVICE_NOT_FOUND', message: '未找到该设备或它不属于当前用户' }
        }
        return { success: true, device_id, note: '设备已解绑。' }
  },
  'list_my_sessions': async (args, userId, role) => {
        const { current_session_id } = args
        const result = await pool.query(
          `SELECT id, device_name, device_type, platform, ip_address, created_at
           FROM user_sessions
           WHERE user_id = $1 AND is_active = true
           ORDER BY created_at DESC`,
          [userId]
        )
        const currentId = (typeof current_session_id === 'string' && current_session_id) ? current_session_id : null
        return {
          sessions: result.rows.map((r) => ({
            id: r.id,
            deviceName: r.device_name || '未知设备',
            platform: r.device_type || r.platform || 'unknown',
            createdAt: r.created_at,
            isCurrent: currentId ? String(r.id) === String(currentId) : false,
          })),
          count: result.rowCount,
        }
  },
  'terminate_session': async (args, userId, role) => {
        // 破坏性工具（确认门控）。sessions 端点 DELETE /:sessionId 未内置「当前会话」保护，故在工具内校验。
        const { session_id, current_session_id } = args
        if (!session_id || !isValidUUID(session_id)) {
          return { error: 'INVALID_SESSION', code: 'INVALID_SESSION', message: 'session_id 必填且为合法 UUID' }
        }
        // 不能踢掉当前会话：若指定了 current_session_id 且与目标相同 → 拒绝
        if (current_session_id && String(current_session_id) === String(session_id)) {
          return { error: 'CANNOT_TERMINATE_CURRENT_SESSION', code: 'CANNOT_TERMINATE_CURRENT_SESSION', message: '不能终止当前正在使用的会话（把自己踢下线）' }
        }
        const check = await pool.query(
          'SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2 AND is_active = true',
          [session_id, userId]
        )
        if (check.rows.length === 0) return { error: 'SESSION_NOT_FOUND', code: 'SESSION_NOT_FOUND' }
        await pool.query(
          'UPDATE user_sessions SET is_active = FALSE, updated_at = NOW(), revoked_at = NOW() WHERE id = $1 AND user_id = $2',
          [session_id, userId]
        )
        const ttl = parseDurationToSeconds(config.jwt.expiresIn)
        await blacklistJti(session_id, ttl)
        return { success: true, session_id, note: '会话已强制下线，对应登录态已失效。' }
  },
}