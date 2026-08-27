import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import pool from '../../../db/pool.js'
import { decrypt, encrypt } from '../../../utils/encryption.js'
import { getAiContext } from '../../../utils/aiContext.js'
import { ocrClipById } from '../../../utils/aiOcr.js'
import { TEXT_PREVIEW_EXTENSIONS } from '../../../routes/media.js'
import {
  isValidUUID,
  clipIdsLimitError,
  locateStoredFile,
  clampBudgetText,
  trimRowsToBudget,
  IMAGE_DIR,
  FILE_DIR,
  UPLOAD_BASE,
} from '../shared.js'

export const clipsHandlers = {
  'find_duplicates': async (args, userId, role) => {
        const type = args.type && args.type !== 'all' ? args.type : null
        const collectionId = args.collection_id && isValidUUID(args.collection_id) ? args.collection_id : null
        const limit = Math.min(Math.max(1, parseInt(args.limit, 10) || 100), 200)

        let query = `
          SELECT c.id, c.type, c.content, c.content_preview, c.created_at, c.is_favorite
          FROM clipboard_items c
        `
        const params = [userId]
        let whereClauses = ['c.user_id = $1', 'c.is_archived = FALSE', "COALESCE(c.protection_level, 'none') = 'none'"]

        if (collectionId) {
          params.push(collectionId)
          query += ` INNER JOIN favorite_collection_items fci ON fci.item_id = c.id AND fci.collection_id = $${params.length}`
        }

        if (type) {
          params.push(type)
          whereClauses.push(`c.type = $${params.length}`)
        }

        query += ` WHERE ${whereClauses.join(' AND ')} ORDER BY c.created_at DESC LIMIT ${limit}`

        const res = await pool.query(query, params)
        const groups = new Map()

        for (const row of res.rows) {
          let plainText = row.content_preview || ''
          if (row.content) {
            try {
              plainText = decrypt(row.content) || plainText
            } catch { /* ignore decrypt error */ }
          }
          const normalized = plainText.trim()
          if (!normalized) continue

          const key = normalized.length > 200 ? crypto.createHash('md5').update(normalized).digest('hex') : normalized
          if (!groups.has(key)) {
            groups.set(key, {
              preview: normalized.slice(0, 100),
              type: row.type,
              items: [],
            })
          }
          groups.get(key).items.push({
            id: row.id,
            created_at: row.created_at,
            is_favorite: row.is_favorite,
          })
        }

        const duplicateGroups = []
        let totalDuplicates = 0
        for (const [, grp] of groups) {
          if (grp.items.length > 1) {
            duplicateGroups.push({
              preview: grp.preview,
              type: grp.type,
              count: grp.items.length,
              keep_id: grp.items[0].id,
              duplicate_ids: grp.items.slice(1).map((it) => it.id),
              all_ids: grp.items.map((it) => it.id),
            })
            totalDuplicates += grp.items.length - 1
          }
        }

        return {
          total_scanned: res.rows.length,
          duplicate_groups_count: duplicateGroups.length,
          total_duplicate_items: totalDuplicates,
          duplicate_groups: duplicateGroups.slice(0, 20),
          suggestion: duplicateGroups.length > 0
            ? '发现重复项！可调用 ask_user 询问用户是否一键清理多余重复项（保留每组最新一条）。'
            : '未发现明显重复的剪贴板条目。'
        }
      },

  'get_clipboard_stats': async (args, userId, role) => {
        const ctx = await getAiContext(userId)
        return {
          total: ctx.stats.total,
          typeBreakdown: {
            text: ctx.stats.textCount,
            image: ctx.stats.imageCount,
            file: ctx.stats.fileCount,
            link: ctx.stats.linkCount,
            code: ctx.stats.codeCount,
          },
          favoriteItemsCount: ctx.stats.favoriteItemsCount,
          archivedCount: ctx.stats.archivedCount,
          collectionsCount: ctx.collections.collectionsCount,
          collectionItemsCount: ctx.collections.collectionItemsCount,
          tagsCount: ctx.tags.tagsCount,
          devicesCount: ctx.devices.devicesCount,
          onlineDevicesCount: ctx.devices.onlineDevicesCount,
          templatesCount: ctx.templates.templatesCount,
          variablesCount: ctx.templates.variablesCount,
          sharedLinksCount: ctx.sharedLinks.sharedLinksCount,
          subscription: ctx.subscription,
          note: 'favoriteItemsCount 是被标记为收藏的条目数；collectionItemsCount 是被归入收藏夹的条目关联数，可能小于 favoriteItemsCount。'
        }
      },

  'get_ai_context': async (args, userId, role) => {
        return await getAiContext(userId)
      },

  'search_clips': async (args, userId, role) => {
        const { query, type = 'all', limit = 10 } = args
        // 服务端文本存于 content_encrypted（加密），可搜索明文在 content_preview；
        // 直接对 content 列 ILIKE 会因该列不存在而报错，故只搜 content_preview。
        const safeLimit = Math.min(Math.max(1, Number(limit) || 10), 100)
        // B2：高级密码保护条目不参与搜索（明文预览/OCR 对 AI 隐藏）
        let sql = "SELECT id, content_type, content_preview, ocr_text, created_at FROM clipboard_items WHERE user_id = $1 AND COALESCE(protection_level, 'none') = 'none'"
        const params = [userId]

        if (query) {
          // 同时搜索图片 OCR 提取出的文字（ocr_text）
          sql += ' AND (content_preview ILIKE $2 OR ocr_text ILIKE $2)'
          params.push(`%${query}%`)
        }
        if (type && type !== 'all') {
          sql += ` AND content_type = $${params.length + 1}`
          params.push(type)
        }
        sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`
        params.push(safeLimit)

        const result = await pool.query(sql, params)
        // D6c：搜索结果统一字符预算——整包超限则只保留前若干条并显式标注截断
        const trimmed = trimRowsToBudget(result.rows)
        return {
          items: trimmed.items,
          count: result.rowCount,
          ...(trimmed.truncated
            ? { truncated: true, note: '结果过长，为符合字符预算仅返回前若干条（count 为全部命中数）。可用更精确的关键词或更小的 limit 收敛结果。' }
            : {}),
        }
      },

  'get_clip_details': async (args, userId, role) => {
        const { clip_id } = args
        // B2：高级密码保护条目对 AI 整体不可见（含元数据），防止预览/属性侧信道泄露。
        const result = await pool.query(
          `SELECT id, content_type, content_preview, content_size, is_favorite, archived,
                  protection_level, created_at, source_device_id
           FROM clipboard_items
           WHERE id = $1 AND user_id = $2 AND COALESCE(protection_level, 'none') = 'none'`,
          [clip_id, userId]
        )
        if (result.rowCount === 0) return { error: 'Clip not found' }
        const r = result.rows[0]
        return {
          ...r,
          note: r.protection_level === 'advanced'
            ? '该条目为高级密码保护，读取明文需提供密码（调用 read_clip_content 并传 password）。'
            : undefined
        }
      },

  'ocr_clip_image': async (args, userId, role) => {
        const { clip_id } = args
        if (!clip_id) return { error: 'clip_id 必填' }
        return await ocrClipById(clip_id, userId)
      },

  'get_recent_clips': async (args, userId, role) => {
        const { limit = 10, type = 'all' } = args
        let sql = 'SELECT id, content_type, content_preview, created_at FROM clipboard_items WHERE user_id = $1'
        const params = [userId]

        if (type && type !== 'all') {
          sql += ' AND content_type = $2'
          params.push(type)
        }
        // B2：高级密码保护条目不出现在最近列表（不泄露明文预览）
        sql += ` AND COALESCE(protection_level, 'none') = 'none'`
        sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`
        params.push(Math.min(Math.max(1, Number(limit) || 10), 100))

        const result = await pool.query(sql, params)
        // D6c：最近列表同样受字符预算约束（preview/OCR 文本可能很长）
        const trimmed = trimRowsToBudget(result.rows)
        return {
          items: trimmed.items,
          count: result.rowCount,
          ...(trimmed.truncated
            ? { truncated: true, note: '结果过长，为符合字符预算仅返回前若干条（count 为全部条数）。' }
            : {}),
        }
      },

  'analyze_clip_usage': async (args, userId, role) => {
        const result = await pool.query(`
          SELECT 
            content_type,
            COUNT(*) as count,
            DATE_TRUNC('day', created_at) as date
          FROM clipboard_items 
          WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
          GROUP BY content_type, DATE_TRUNC('day', created_at)
          ORDER BY date DESC
        `, [userId])
        
        const total = await pool.query(
          'SELECT COUNT(*) as total FROM clipboard_items WHERE user_id = $1',
          [userId]
        )
        
        return {
          total: total.rows[0].total,
          dailyBreakdown: result.rows,
          summary: `过去30天共 ${total.rows[0].total} 条记录`
        }
      },

  'write_clip': async (args, userId, role) => {
        const { content, content_type = 'text', label, tags } = args
        if (typeof content !== 'string' || !content.trim()) {
          return { error: 'content is required' }
        }
        const allowedTypes = ['text', 'link', 'code']
        const ctype = allowedTypes.includes(content_type) ? content_type : 'text'

        // 加密正文入库，preview 只放前 200 字符可搜索明文
        const contentEncrypted = encrypt(String(content))
        const preview = String(content).slice(0, 200)
        const meta = { ...(label ? { label: String(label).slice(0, 200) } : {}) }
        if (Array.isArray(tags)) {
          meta.tags = [...new Set(tags.map((t) => String(t).trim().slice(0, 30)))].filter(Boolean).slice(0, 10)
        }

        // source_device_id 置 null（AI 通道无发起设备；依赖 034 迁移解除 NOT NULL）
        const result = await pool.query(
          `INSERT INTO clipboard_items (user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata)
           VALUES ($1, NULL, $2, $3, $4, $5, $6)
           RETURNING id, content_type, content_preview, content_size, created_at`,
          [userId, ctype, contentEncrypted, preview, Buffer.byteLength(String(content)), JSON.stringify(meta)]
        )
        const r = result.rows[0]
        return {
          id: r.id,
          contentType: r.content_type,
          contentSize: r.content_size,
          createdAt: r.created_at,
          note: '已写入你的剪贴板，可在应用内查看/搜索。'
        }
      },

  'tag_items': async (args, userId, role) => {
        const { clip_ids, tags } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        const limitErr = clipIdsLimitError(clip_ids)
        if (limitErr) return limitErr
        if (!Array.isArray(tags) || tags.length === 0) {
          return { error: 'tags is required and must be an array' }
        }
        const cleanTags = [...new Set(tags.map((t) => String(t).trim().slice(0, 30)))].filter(Boolean).slice(0, 10)
        if (cleanTags.length === 0) return { error: 'tags must not be empty' }
        const result = await pool.query(
          `UPDATE clipboard_items
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tags}', $1::jsonb)
           WHERE id = ANY($2) AND user_id = $3
           RETURNING id`,
          [JSON.stringify(cleanTags), clip_ids, userId]
        )
        return { success: true, tagged: result.rowCount, tags: cleanTags }
      },

  'archive_items': async (args, userId, role) => {
        const { clip_ids } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        const limitErr = clipIdsLimitError(clip_ids)
        if (limitErr) return limitErr
        // 先检查存在性，返回未找到的 ID 以便 AI 诊断
        const existCheck = await pool.query(
          'SELECT id FROM clipboard_items WHERE id = ANY($1) AND user_id = $2',
          [clip_ids, userId]
        )
        const foundIds = existCheck.rows.map((r) => r.id)
        const missingIds = clip_ids.filter((id) => !foundIds.includes(id))
        if (foundIds.length === 0) {
          return { error: 'NOT_FOUND', message: `指定的 ${clip_ids.length} 个条目均不存在于当前用户下。`, requested_ids: clip_ids }
        }
        const result = await pool.query(
          'UPDATE clipboard_items SET archived = true, updated_at = NOW() WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [foundIds, userId]
        )
        return {
          success: true,
          archived: result.rowCount,
          notFound: missingIds.length > 0 ? missingIds.length : 0,
          missing_ids: missingIds.length > 0 ? missingIds : undefined,
        }
      },

  'unarchive_items': async (args, userId, role) => {
        const { clip_ids } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        const limitErr = clipIdsLimitError(clip_ids)
        if (limitErr) return limitErr
        const existCheck = await pool.query(
          'SELECT id FROM clipboard_items WHERE id = ANY($1) AND user_id = $2',
          [clip_ids, userId]
        )
        const foundIds = existCheck.rows.map((r) => r.id)
        const missingIds = clip_ids.filter((id) => !foundIds.includes(id))
        if (foundIds.length === 0) {
          return { error: 'NOT_FOUND', message: `指定的 ${clip_ids.length} 个条目均不存在于当前用户下。`, requested_ids: clip_ids }
        }
        const result = await pool.query(
          'UPDATE clipboard_items SET archived = false, updated_at = NOW() WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [foundIds, userId]
        )
        return {
          success: true,
          unarchived: result.rowCount,
          notFound: missingIds.length > 0 ? missingIds.length : 0,
          missing_ids: missingIds.length > 0 ? missingIds : undefined,
        }
      },

  'update_clip_meta': async (args, userId, role) => {
        const { clip_id, tags, label } = args
        if (!clip_id) return { error: 'clip_id is required' }
        if (tags === undefined && label === undefined) {
          return { error: 'tags 或 label 至少提供一个要更新的字段' }
        }
        const current = await pool.query(
          'SELECT metadata FROM clipboard_items WHERE id = $1 AND user_id = $2',
          [clip_id, userId]
        )
        if (current.rowCount === 0) return { error: '未找到该条目' }
        const meta = (() => {
          const raw = current.rows[0].metadata
          if (typeof raw === 'string') { try { return JSON.parse(raw) || {} } catch { return {} } }
          return raw || {}
        })()
        if (tags !== undefined) {
          meta.tags = [...new Set(tags.map((t) => String(t).trim().slice(0, 30)))].filter(Boolean).slice(0, 10)
        }
        if (label !== undefined) {
          if (label === null || label === '') delete meta.label
          else meta.label = String(label).slice(0, 200)
        }
        await pool.query(
          'UPDATE clipboard_items SET metadata = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
          [meta, clip_id, userId]
        )
        return { success: true, id: clip_id, tags: meta.tags || [], label: meta.label || undefined }
      },

  'batch_favorite': async (args, userId, role) => {
        const { clip_ids } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        const limitErr = clipIdsLimitError(clip_ids)
        if (limitErr) return limitErr
        const result = await pool.query(
          'UPDATE clipboard_items SET is_favorite = true WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [clip_ids, userId]
        )
        return { success: true, updated: result.rowCount }
      },

  'batch_delete': async (args, userId, role) => {
        // Agent-C：默认软删除（归档语义），不再物理 DELETE —— 可恢复，避免误删不可挽回。
        // 用户确需物理抹除时改用 destroy_clips（L2 + 确认门控）。
        const { clip_ids } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        const limitErr = clipIdsLimitError(clip_ids)
        if (limitErr) return limitErr
        const existCheck = await pool.query(
          'SELECT id FROM clipboard_items WHERE id = ANY($1) AND user_id = $2',
          [clip_ids, userId]
        )
        const foundIds = existCheck.rows.map((r) => r.id)
        const missingIds = clip_ids.filter((id) => !foundIds.includes(id))
        if (foundIds.length === 0) {
          return { error: 'NOT_FOUND', message: `指定的 ${clip_ids.length} 个条目均不存在于当前用户下。`, requested_ids: clip_ids }
        }
        const result = await pool.query(
          'UPDATE clipboard_items SET archived = true, updated_at = NOW() WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [foundIds, userId]
        )
        return {
          success: true,
          archived: result.rowCount,
          notFound: missingIds.length > 0 ? missingIds.length : 0,
          missing_ids: missingIds.length > 0 ? missingIds : undefined,
          note: '已软删除（归档），可在归档列表中恢复。如需永久物理删除请启用 destroy_clips。',
        }
      },

  'destroy_clips': async (args, userId, role) => {
        // Agent-C：物理删除（破坏性，L2+）。clip_ids 上限 50，超出明确拒绝并提示分批。
        // 权限闸门已由 executeToolInner 顶部 assertToolAllowed 校验（L2 起），此处做上限校验。
        const { clip_ids } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        if (clip_ids.length > 50) {
          return {
            error: 'DESTROY_BATCH_TOO_LARGE',
            message: `一次最多永久删除 50 条，你传了 ${clip_ids.length} 条；请分批（每批 ≤50）调用。`,
            received: clip_ids.length,
            maxPerBatch: 50,
          }
        }
        // 先检查哪些 ID 实际存在（含 archived 状态），以便诊断"未找到"问题
        const existCheck = await pool.query(
          'SELECT id, archived FROM clipboard_items WHERE id = ANY($1) AND user_id = $2',
          [clip_ids, userId]
        )
        const foundIds = existCheck.rows.map((r) => r.id)
        const missingIds = clip_ids.filter((id) => !foundIds.includes(id))

        if (foundIds.length === 0) {
          return {
            error: 'NOT_FOUND',
            message: `指定的 ${clip_ids.length} 个条目 ID 在当前用户下均不存在。请确认 ID 是否正确，或条目是否属于当前用户。`,
            requested_ids: clip_ids,
            found: 0,
          }
        }

        // 只删除存在的条目
        const result = await pool.query(
          'DELETE FROM clipboard_items WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [foundIds, userId]
        )
        return {
          success: true,
          permanentlyDeleted: result.rowCount,
          notFound: missingIds.length > 0 ? missingIds.length : 0,
          missing_ids: missingIds.length > 0 ? missingIds : undefined,
        }
      },

  'organize_by_type': async (args, userId, role) => {
        const result = await pool.query(`
          SELECT 
            content_type,
            COUNT(*) as count,
            ARRAY_AGG(id ORDER BY created_at DESC) as clip_ids
          FROM clipboard_items 
          WHERE user_id = $1
          GROUP BY content_type
          ORDER BY count DESC
        `, [userId])
        
        return {
          categories: result.rows.map(r => ({
            type: r.content_type,
            count: r.count,
            clipIds: r.clip_ids.slice(0, 10) // 只返回前10个ID
          }))
        }
      },

  // ============ 大管家增强：隐私感知内容读取 ============
  'read_clip_content': async (args, userId, role) => {
        const { clip_id, password } = args
        if (!clip_id) return { error: 'clip_id is required' }

        // 本地临时 ID（local-/text-/img-/file-/browser-）是前端乐观更新用的临时 ID，
        // 在服务端确认写入之前根本不入库，AI 后端自然查不到。
        const LOCAL_TEMP_PREFIXES = ['local-', 'text-', 'img-', 'file-', 'browser-']
        const isTempLocal = LOCAL_TEMP_PREFIXES.some((p) => clip_id.startsWith(p))
        if (isTempLocal) {
          return {
            error: '该条目尚未同步到服务端',
            reason: 'temporary_local_item',
            detail: '这个 ID 是 ClipSync 桌面端捕获内容后、在列表里临时生成的乐观项（local-/text-/img-/file-/browser- 前缀）。它此时只存在于你的设备内存，还没完成服务端同步，因此没有入库。等几秒同步完成后 ID 会变成标准 UUID，AI 就能读取了。请在应用内查看或稍后再试。'
          }
        }

        const result = await pool.query(
          `SELECT id, content_type, content_encrypted, content_preview, content_size,
                  protection_level, wrapped_dek_password, protection_salt, metadata
           FROM clipboard_items WHERE id = $1 AND user_id = $2`,
          [clip_id, userId]
        )
        if (result.rowCount === 0) {
          return { error: '未找到该条目', reason: '可能已被删除，或它是未同步到服务端的本地条目。' }
        }
        const item = result.rows[0]
        const type = item.content_type

        // 图片 / 文件：服务端持有完整数据，AI 大管家拥有读取权限——绝不一句"非原文"打发。
        // 存储形态有两种：
        //  A) 内联 base64（data URL）——桌面端直接把字节存入 content_encrypted；
        //  B) 磁盘文件——content_encrypted 存文件名，字节在 uploads/images、uploads/files（分片上传在根）。
        if (type === 'image' || type === 'file') {
          const meta = (() => {
            try { return typeof item.metadata === 'string' ? JSON.parse(item.metadata || '{}') : (item.metadata || {}) }
            catch { return {} }
          })()
          const raw = item.content_encrypted || ''

          // —— A) 内联 data URL ——
          if (raw.startsWith('data:')) {
            const comma = raw.indexOf(',')
            const header = comma > 0 ? raw.slice(0, comma) : 'data:'
            const mimeMatch = header.match(/data:([^;]+)/)
            const mime = mimeMatch ? mimeMatch[1] : (meta.mimeType || 'application/octet-stream')
            const b64 = comma > 0 ? raw.slice(comma + 1) : ''
            const byteLen = Math.round(b64.length * 3 / 4)
            if (type === 'image') {
              return {
                accessible: true, contentType: 'image', storage: 'inline_data_url',
                fileName: meta.originalName || 'image', mimeType: mime, byteSize: byteLen, onServer: true,
                message: `图片以 base64 内联存储于服务端数据库，AI 大管家拥有完整读取权限（${byteLen} 字节）。当前文本模型无法"看见"像素；若接入视觉（vision）模型，可直接把该 data URL 作为图像输入。`
              }
            }
            return {
              accessible: true, contentType: 'file', storage: 'inline_data_url',
              fileName: meta.originalName || 'file', mimeType: mime, byteSize: byteLen, onServer: true,
              message: `文件以 base64 内联存储于服务端数据库，AI 拥有读取权限（${byteLen} 字节）。`
            }
          }

          // —— A2) 文件复制类：content_encrypted 是源文件路径（JSON 数组或裸路径），字节未上传服务端 ——
          if (type === 'file') {
            let pathRefs = null
            try {
              const p = JSON.parse(raw)
              if (Array.isArray(p)) pathRefs = p.filter(x => typeof x === 'string')
            } catch { /* 不是 JSON 数组 */ }
            if (!pathRefs && (/^[a-zA-Z]:\\/.test(raw) || raw.startsWith('/') || raw.includes('\\'))) pathRefs = [raw]
            if (pathRefs && pathRefs.length) {
              return {
                accessible: false, contentType: 'file', storage: 'path_reference',
                sourcePaths: pathRefs, onServer: false,
                message: '这是「文件复制」条目：服务端仅保存源文件路径，文件字节并未上传（就在你的本机/原设备上）。AI 可读取并展示这些路径以辅助你在本地定位、粘贴或打开该文件，但无法读取其字节内容——需在你的设备上操作。'
              }
            }
          }

          // —— B) 磁盘文件 ——
          const located = type === 'image'
            ? locateStoredFile(item.content_encrypted, [IMAGE_DIR])
            : locateStoredFile(item.content_encrypted, [FILE_DIR, UPLOAD_BASE])

          if (type === 'image') {
            return {
              accessible: true,
              contentType: 'image',
              storage: 'server_disk',
              fileName: meta.originalName || item.content_encrypted,
              mimeType: meta.mimeType,
              width: meta.width,
              height: meta.height,
              sizeBytes: located ? located.size : (meta.compressedSize || item.content_size),
              originalSize: meta.originalSize,
              onServer: !!located,
              message: located
                ? '图片字节完整存储于服务端磁盘，AI 大管家拥有读取与检索权限。当前文本模型无法"看见"像素；要识别图像内容需接入支持视觉（vision）的模型。你可在应用内直接预览，或让我管理/检索该图片的元数据。'
                : '数据库记录存在，但磁盘文件缺失（可能已被清理），仅能返回元数据。'
            }
          }

          // file：文本/代码类直接读取原文；其他二进制返回元数据并声明可访问
          const ext = (meta.extension || path.extname(item.content_encrypted || '') || '').toLowerCase()
          const isText = TEXT_PREVIEW_EXTENSIONS.has(ext)
          if (isText && located && located.size <= 5 * 1024 * 1024) {
            try {
              const buf = await fs.readFile(located.path)
              let content = buf.toString('utf-8')
              if (content.includes('\ufffd')) content = buf.toString('latin1')
              // D6c：文本文件正文同样吃统一字符预算（原 50k → 8k），截断显式标注
              const clipped = clampBudgetText(content)
              return {
                accessible: true, contentType: 'file', textFile: true,
                fileName: meta.originalName || item.content_encrypted, extension: ext,
                sizeBytes: located.size, content: clipped.text,
                ...(clipped.truncated ? { contentTruncated: true } : {}),
              }
            } catch { /* 落到下方元数据分支 */ }
          }
          return {
            accessible: true,
            contentType: 'file',
            storage: 'server_disk',
            fileName: meta.originalName || item.content_encrypted,
            extension: ext,
            mimeType: meta.mimeType,
            sizeBytes: located ? located.size : item.content_size,
            onServer: !!located,
            textReadable: isText,
            message: located
              ? (isText
                  ? '文本/代码文件已完整读取（见 content 字段）。'
                  : `文件字节完整存储于服务端磁盘，AI 大管家拥有读取权限。该类型为非文本（${ext || '未知'}），如需提取其中文本（如 PDF/Word）可进一步接入解析器。`)
              : '数据库记录存在，但磁盘文件缺失，仅能返回元数据。'
          }
        }

        // 高级密码保护：AI 通道一律拒绝返回明文，即使提供了 password 也不解密。
        // 明文只允许用户在 ClipSync 应用内凭密码查看，绝不出现在聊天/工具通道。
        // password 参数保留在 schema 中仅作兼容，此处硬性忽略其值，绝不调用 unlockWithPassword。
        if (item.protection_level === 'advanced') {
          return {
            error: '该条目受高级密码保护，无法在此读取',
            reason: 'advanced_protected',
            protectionLevel: 'advanced',
            hint: '该条目启用了高级密码保护（独立 DEK 加密）。出于隐私安全，AI 通道无法也不应获取其明文，即使提供密码也不会解密。请在 ClipSync 应用内查看这条内容，或使用恢复密钥。'
          }
        }

        // none / pin：主密钥可解密
        let plain
        try {
          plain = decrypt(item.content_encrypted)
        } catch (e) {
          return { error: '解密失败', reason: e.message }
        }
        // D6c：明文正文统一字符预算（原 50k → 8k），截断显式标注
        const clipped = clampBudgetText(String(plain ?? ''))
        return {
          contentType: type,
          protectionLevel: item.protection_level,
          note: item.protection_level === 'pin' ? 'PIN 保护仅控制客户端展示，服务端内容可被解密。' : undefined,
          content: clipped.text,
          ...(clipped.truncated ? { contentTruncated: true, truncationNote: '内容过长，已在 8000 字符处截断。' } : {}),
          sizeBytes: item.content_size
        }
      },

  'get_clip_meta': async (args, userId, role) => {
        const { clip_id } = args
        if (!clip_id) return { error: 'clip_id is required' }
        const result = await pool.query(
          `SELECT id, content_type, content_preview, content_size, is_favorite, archived,
                  protection_level, metadata, created_at, updated_at, source_device_id
           FROM clipboard_items WHERE id = $1 AND user_id = $2`,
          [clip_id, userId]
        )
        if (result.rowCount === 0) return { error: '未找到该条目' }
        const i = result.rows[0]
        return {
          id: i.id,
          type: i.content_type,
          preview: (i.content_preview || '').slice(0, 200),
          sizeBytes: i.content_size,
          isFavorite: i.is_favorite,
          archived: i.archived,
          protectionLevel: i.protection_level,
          tags: i.metadata?.tags || [],
          deviceId: i.source_device_id,
          createdAt: i.created_at,
          updatedAt: i.updated_at,
          note: '只返回元数据，不含明文。需要明文请调用 read_clip_content。'
        }
      },

  'get_archived_clips': async (args, userId, role) => {
        const { limit = 20 } = args
        const result = await pool.query(
          `SELECT id, content_type, content_preview, content_size, is_favorite, protection_level, created_at
           FROM clipboard_items WHERE user_id = $1 AND archived = TRUE
           ORDER BY created_at DESC LIMIT $2`,
          [userId, limit]
        )
        return { archivedItems: result.rows, count: result.rowCount }
      },

  'update_clip': async (args, userId, role) => {
        const { clip_id, content, contentPreview, expiresAt, archived, metadata } = args
        if (!clip_id || !isValidUUID(clip_id)) return { error: 'INVALID_CLIP', code: 'INVALID_CLIP' }
        const setClauses = []
        const params = [clip_id, userId]
        let p = 3
        let changed = false
        if (content !== undefined) {
          if (typeof content !== 'string') return { error: 'INVALID_CONTENT', code: 'INVALID_CONTENT' }
          setClauses.push(`content_encrypted = $${p++}`); params.push(encrypt(String(content)))
          setClauses.push(`content_size = $${p++}`); params.push(Buffer.byteLength(String(content)))
          changed = true
        }
        if (contentPreview !== undefined) {
          if (typeof contentPreview !== 'string') return { error: 'INVALID_PREVIEW', code: 'INVALID_PREVIEW' }
          setClauses.push(`content_preview = $${p++}`); params.push(contentPreview.slice(0, 5000))
          changed = true
        }
        if (expiresAt !== undefined) {
          let v = null
          if (expiresAt !== null) {
            const d = new Date(expiresAt)
            if (isNaN(d.getTime())) return { error: 'INVALID_EXPIRE', code: 'INVALID_EXPIRE', message: 'expiresAt 必须是合法 ISO 日期或 null' }
            v = d.toISOString()
          }
          setClauses.push(`expires_at = $${p++}`); params.push(v)
          changed = true
        }
        if (archived !== undefined) {
          if (typeof archived !== 'boolean') return { error: 'INVALID_ARCHIVED', code: 'INVALID_ARCHIVED' }
          setClauses.push(`archived = $${p++}`); params.push(archived)
          changed = true
        }
        if (metadata !== undefined) {
          if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
            return { error: 'INVALID_METADATA', code: 'INVALID_METADATA', message: 'metadata 必须是对象' }
          }
          // 白名单键浅合并（与 PUT /clipboard/:id 一致）
          const metaPatch = {}
          for (const k of ['protected', 'protectedAt', 'tags']) {
            if (k in metadata) metaPatch[k] = metadata[k]
          }
          if ('protected' in metaPatch && typeof metaPatch.protected !== 'boolean') return { error: 'INVALID_PROTECTED', code: 'INVALID_PROTECTED' }
          if ('tags' in metaPatch && !Array.isArray(metaPatch.tags)) return { error: 'INVALID_TAGS', code: 'INVALID_TAGS' }
          setClauses.push(`metadata = metadata || $${p++}::jsonb`); params.push(JSON.stringify(metaPatch))
          changed = true
        }
        if (!changed) return { error: 'NO_FIELDS', code: 'NO_FIELDS', message: '至少提供一个要更新的字段' }
        setClauses.push('updated_at = NOW()')
        const result = await pool.query(
          `UPDATE clipboard_items SET ${setClauses.join(', ')}
           WHERE id = $1 AND user_id = $2
           RETURNING id, content_type, content_preview, content_size, metadata, is_favorite, archived, expires_at, created_at`,
          params
        )
        if (result.rowCount === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        return { updated: result.rows[0] }
      },

  'mark_sensitive': async (args, userId, role) => {
        const { clip_id, sensitive } = args
        if (!clip_id || !isValidUUID(clip_id)) return { error: 'INVALID_CLIP', code: 'INVALID_CLIP' }
        if (typeof sensitive !== 'boolean') return { error: 'INVALID_SENSITIVE', code: 'INVALID_SENSITIVE', message: 'sensitive 必须是布尔值' }
        const result = await pool.query(
          `UPDATE clipboard_items SET metadata = jsonb_set(metadata, '{sensitive}', $1::jsonb), updated_at = NOW()
           WHERE id = $2 AND user_id = $3 RETURNING id, metadata`,
          [JSON.stringify(sensitive), clip_id, userId]
        )
        if (result.rowCount === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        return {
          success: true,
          clip_id,
          sensitive,
          note: '已更新「敏感内容」标记；这是主观内容标记，不影响加密/能见度。若要设置密码保护请用 set_item_protection。',
        }
      },

  'mark_clip_used': async (args, userId, role) => {
        const { clip_id } = args
        if (!clip_id || !isValidUUID(clip_id)) return { error: 'INVALID_CLIP', code: 'INVALID_CLIP' }
        const result = await pool.query(
          `UPDATE clipboard_items SET usage_count = COALESCE(usage_count, 0) + 1, last_used_at = NOW()
           WHERE id = $1 AND user_id = $2 RETURNING usage_count`,
          [clip_id, userId]
        )
        if (result.rowCount === 0) return { error: 'ITEM_NOT_FOUND', code: 'ITEM_NOT_FOUND' }
        return { success: true, clip_id, usageCount: result.rows[0].usage_count }
      },

  'get_frequent_clips': async (args, userId, role) => {
        const { limit = 3 } = args
        const safeLimit = Math.min(Math.max(1, Number(limit) || 3), 10)
        // 与 GET /api/clipboard/frequent 语义一致：防守 + 衰减时间加权，跳过一次未用
        const result = await pool.query(
          `SELECT ci.id, ci.content_type, ci.content_preview, ci.content_size, ci.created_at, ci.usage_count, ci.last_used_at,
                  (ci.usage_count * 1.0) * exp(-extract(epoch from now() - coalesce(ci.last_used_at, ci.created_at)) / 2592000.0) AS score
           FROM clipboard_items ci
           WHERE ci.user_id = $1 AND ci.archived = FALSE AND ci.usage_count > 0
           ORDER BY score DESC, ci.last_used_at DESC NULLS LAST
           LIMIT $2`,
          [userId, safeLimit]
        )
        return {
          items: result.rows.map((r) => ({
            id: r.id,
            contentType: r.content_type,
            contentPreview: r.content_preview,
            contentSize: r.content_size,
            createdAt: r.created_at,
            usageCount: r.usage_count,
            lastUsedAt: r.last_used_at,
          })),
          count: result.rowCount,
        }
      },
}