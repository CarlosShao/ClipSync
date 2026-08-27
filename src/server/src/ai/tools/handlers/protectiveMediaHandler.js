// ============ aiTools 分域拆分：域 C handler（protectiveMedia 保护/媒体） ============
// 纯重构（自 routes/aiTools.js executeToolInner 各 case 逐字迁移），禁止改写业务逻辑。
import path from 'path'
import fs from 'fs/promises'
import { v4 as uuidv4 } from 'uuid'
import pool from '../../../db/pool.js'
import { isValidUUID } from '../../../validation/validator.js'
import { setupAdvancedProtection, unlockWithPassword } from '../../../utils/protectionCrypto.js'
import { IMAGE_DIR, FILE_DIR, UPLOAD_FILE_ALLOWED_EXT } from '../shared.js'

export const protectiveMediaHandlers = {
  'get_protected_clips': async (args, userId, role) => {
        const result = await pool.query(
          `SELECT id, content_type, protection_level, content_size, created_at
           FROM clipboard_items WHERE user_id = $1 AND protection_level <> 'none'
           ORDER BY created_at DESC`,
          [userId]
        )
        return { protectedItems: result.rows, count: result.rowCount }
  },

  'set_item_protection': async (args, userId, role) => {
        const { item_id, level, password, content } = args
        if (!item_id || !isValidUUID(item_id)) return { error: 'INVALID_ITEM', code: 'INVALID_ITEM' }
        if (!['pin', 'advanced'].includes(level)) return { error: 'INVALID_LEVEL', code: 'INVALID_LEVEL', message: 'level 仅支持 pin / advanced' }
        const chk = await pool.query(
          'SELECT id, content_type FROM clipboard_items WHERE id = $1 AND user_id = $2',
          [item_id, userId]
        )
        if (chk.rows.length === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        if (level === 'pin') {
          await pool.query(
            `UPDATE clipboard_items SET protection_level = 'pin', updated_at = NOW() WHERE id = $1 AND user_id = $2`,
            [item_id, userId]
          )
          return { success: true, level: 'pin', note: '已设置 PIN 保护（仅控制客户端展示，不影响服务端可解密性）。' }
        }
        // advanced：高级密码保护（复用 protection.js 的 setupAdvancedProtection）
        if (!password || String(password).length < 4) {
          return { error: 'INVALID_PASSWORD', code: 'INVALID_PASSWORD', message: 'advanced 保护需要 ≥4 位的密码' }
        }
        if (typeof content !== 'string' || !content) {
          return { error: 'CONTENT_REQUIRED', code: 'CONTENT_REQUIRED', message: 'advanced 保护需要提供被保护内容的明文 content' }
        }
        const data = setupAdvancedProtection(content, String(password))
        // B2：advanced 保护条目同步清空明文预览与 OCR 文本（与 protection.js /setup 同款），
        // 防止 search/list/AI 工具从 content_preview / ocr_text 读到受保护原文。
        await pool.query(
          `UPDATE clipboard_items
           SET protection_level = 'advanced', content_encrypted = $1, wrapped_dek_password = $2,
               wrapped_dek_recovery = $3, protection_salt = $4, protection_iv = $5,
               content_preview = '', ocr_text = NULL, updated_at = NOW()
           WHERE id = $6 AND user_id = $7`,
          [data.encryptedContent, data.wrappedDEKPassword, data.wrappedDEKRecovery, data.salt, data.iv, item_id, userId]
        )
        await pool.query(
          `INSERT INTO recovery_keys (user_id, item_id, recovery_key_hash) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, item_id) DO UPDATE SET recovery_key_hash = EXCLUDED.recovery_key_hash`,
          [userId, item_id, data.recoveryKeyHash]
        )
        return {
          success: true,
          level: 'advanced',
          recoveryKey: data.recoveryKey,
          note: '已设置高级密码保护。请务必保存返回的 recoveryKey（仅此一次出现）。',
        }
  },

  'remove_item_protection': async (args, userId, role) => {
        const { item_id, password } = args
        if (!item_id || !isValidUUID(item_id)) return { error: 'INVALID_ITEM', code: 'INVALID_ITEM' }
        const item = await pool.query(
          `SELECT id, content_encrypted, protection_level, wrapped_dek_password, protection_salt
           FROM clipboard_items WHERE id = $1 AND user_id = $2`,
          [item_id, userId]
        )
        if (item.rows.length === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        const it = item.rows[0]
        if (it.protection_level === 'none') return { error: 'NOT_PROTECTED', code: 'NOT_PROTECTED', message: '该条目未受保护' }
        // advanced 条目：若提供密码则先验证明文（复用 protection.js 逻辑），不移除则仍可解除保护
        if (it.protection_level === 'advanced' && password) {
          const plain = unlockWithPassword(it.content_encrypted, it.wrapped_dek_password, String(password), it.protection_salt)
          if (!plain) return { error: 'INVALID_PASSWORD', code: 'INVALID_PASSWORD', message: '密码不正确，无法校验高级保护' }
        }
        await pool.query(
          `UPDATE clipboard_items
           SET protection_level = 'none', wrapped_dek_password = NULL, wrapped_dek_recovery = NULL,
               protection_salt = NULL, protection_iv = NULL, updated_at = NOW()
           WHERE id = $1 AND user_id = $2`,
          [item_id, userId]
        )
        await pool.query('DELETE FROM recovery_keys WHERE user_id = $1 AND item_id = $2', [userId, item_id])
        return { success: true, item_id, note: '已移除该条目的密码保护。' }
  },

  'get_protection_status': async (args, userId, role) => {
        const { item_id } = args
        if (!item_id || !isValidUUID(item_id)) return { error: 'INVALID_ITEM', code: 'INVALID_ITEM' }
        const result = await pool.query(
          'SELECT protection_level FROM clipboard_items WHERE id = $1 AND user_id = $2',
          [item_id, userId]
        )
        if (result.rowCount === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        const rec = await pool.query(
          'SELECT id FROM recovery_keys WHERE user_id = $1 AND item_id = $2',
          [userId, item_id]
        )
        return { item_id, level: result.rows[0].protection_level || 'none', hasRecoveryKey: rec.rows.length > 0 }
  },

  'upload_image': async (args, userId, role) => {
        // base64 输入写盘，复用 storage 目录（uploads/images）与 uuid 命名
        const { base64, mime_type, filename, expires_at } = args
        if (typeof base64 !== 'string' || !base64) return { error: 'BASE64_REQUIRED', code: 'BASE64_REQUIRED' }
        const buf = Buffer.from(base64, 'base64')
        if (buf.length === 0) return { error: 'INVALID_BASE64', code: 'INVALID_BASE64' }
        if (buf.length > 15 * 1024 * 1024) return { error: 'FILE_TOO_LARGE', code: 'FILE_TOO_LARGE', message: '图片大小上限约 15MB' }
        const mime = String(mime_type || 'image/jpeg').toLowerCase()
        const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : mime === 'image/gif' ? '.gif' : '.jpg'
        const filenameUuid = `${uuidv4()}${ext}`
        const finalPath = path.join(IMAGE_DIR, filenameUuid)
        await fs.mkdir(IMAGE_DIR, { recursive: true })
        await fs.writeFile(finalPath, buf)
        const originalName = (typeof filename === 'string' && filename) ? filename.slice(0, 255) : `image_${filenameUuid}`
        const exp = (typeof expires_at === 'string' && expires_at) ? new Date(expires_at).toISOString() : null
        const result = await pool.query(
          `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, expires_at)
           VALUES ($1, NULL, 'image', $2, $3, $4, $5, $6)
           RETURNING id, content_type, content_preview, content_size, created_at`,
          [
            userId, filenameUuid, originalName, buf.length,
            JSON.stringify({ originalName, mimeType: mime, originalSize: buf.length, compressedSize: buf.length, width: null, height: null }),
            exp,
          ]
        )
        const r = result.rows[0]
        return {
          id: r.id,
          contentType: r.content_type,
          filename: filenameUuid,
          originalName,
          sizeBytes: r.content_size,
          createdAt: r.created_at,
          note: '图片已写盘存储于服务端 images 目录。',
        }
  },

  'upload_file': async (args, userId, role) => {
        const { base64, mime_type, filename, expires_at } = args
        if (typeof base64 !== 'string' || !base64) return { error: 'BASE64_REQUIRED', code: 'BASE64_REQUIRED' }
        const buf = Buffer.from(base64, 'base64')
        if (buf.length === 0) return { error: 'INVALID_BASE64', code: 'INVALID_BASE64' }
        if (buf.length > 15 * 1024 * 1024) return { error: 'FILE_TOO_LARGE', code: 'FILE_TOO_LARGE', message: '文件大小上限约 15MB' }
        // B6：白名单制——扩展名必须在名单内，且不再从 mime 子类型反推扩展名；
        // 声明的 mime_type 与扩展名不同类时拒绝。
        let ext = ''
        if (typeof filename === 'string' && filename) ext = path.extname(filename).toLowerCase()
        const allowedMimes = UPLOAD_FILE_ALLOWED_EXT.get(ext)
        if (!ext || !allowedMimes) {
          return {
            error: 'EXTENSION_NOT_ALLOWED',
            code: 'EXTENSION_NOT_ALLOWED',
            message: `仅允许常用文本/图片/办公文档类型上传，不支持该扩展名：${ext || '(无)'}`,
          }
        }
        const declaredMime = typeof mime_type === 'string' ? mime_type.toLowerCase().trim() : ''
        if (declaredMime) {
          // ['text/'] 形式按前缀匹配家族，精确项按全等匹配
          const matched = allowedMimes.some((m) => (m.endsWith('/') ? declaredMime.startsWith(m) : declaredMime === m))
          if (!matched) {
            return {
              error: 'MIME_MISMATCH',
              code: 'MIME_MISMATCH',
              message: `声明的 MIME 类型（${declaredMime}）与扩展名 ${ext} 不匹配`,
            }
          }
        }
        const filenameUuid = `${uuidv4()}${ext}`
        const finalPath = path.join(FILE_DIR, filenameUuid)
        await fs.mkdir(FILE_DIR, { recursive: true })
        await fs.writeFile(finalPath, buf)
        const originalName = (typeof filename === 'string' && filename) ? filename.slice(0, 255) : `file_${filenameUuid}`
        const exp = (typeof expires_at === 'string' && expires_at) ? new Date(expires_at).toISOString() : null
        const result = await pool.query(
          `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, expires_at)
           VALUES ($1, NULL, 'file', $2, $3, $4, $5, $6)
           RETURNING id, content_type, content_preview, content_size, created_at`,
          [
            userId, filenameUuid, originalName, buf.length,
            JSON.stringify({ originalName, mimeType: mime_type || 'application/octet-stream', extension: ext }),
            exp,
          ]
        )
        const r = result.rows[0]
        return {
          id: r.id,
          contentType: r.content_type,
          filename: filenameUuid,
          originalName,
          sizeBytes: r.content_size,
          createdAt: r.created_at,
          note: '文件已写盘存储于服务端 files 目录。',
        }
  },
}