import { Router } from 'express'
import path from 'path'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { logger } from '../utils/logger.js'
import { getAiContext } from '../utils/aiContext.js'
import { decrypt } from '../utils/encryption.js'
import { unlockWithPassword } from '../utils/protectionCrypto.js'
import { getFeatureDoc, getPrivacyModelDoc, getDeploymentDoc, getArchitectureDoc } from '../utils/aiKnowledge.js'
import { TEXT_PREVIEW_EXTENSIONS } from './media.js'

const router = Router()

// 服务端存储目录（与 storage.js / media.js 一致：src/server/uploads）
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const UPLOAD_BASE = path.join(__dirname, '../../uploads')
const IMAGE_DIR = path.join(UPLOAD_BASE, 'images')
const FILE_DIR = path.join(UPLOAD_BASE, 'files')

// 在多个候选目录中定位媒体文件（media 直传在 files/ 或 images/，分片上传在 uploads/ 根）
async function locateStoredFile(relName, dirs) {
  for (const d of dirs) {
    const p = path.join(d, relName)
    try {
      const s = await fs.stat(p)
      return { path: p, size: s.size }
    } catch { /* try next */ }
  }
  return null
}

/**
 * ClipSync 工具定义
 * 这些工具可以被 AI Agent 调用来执行实际操作
 */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_clipboard_stats',
      description: '获取剪贴板的完整统计数据，包括总条目数、各类型数量、收藏条目数、归档数、收藏夹数量、标签数、设备数、模板数、共享链接数、订阅套餐',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_ai_context',
      description: '一次性获取 ClipSync 完整上下文（统计、收藏夹、标签、设备、模板、共享链接、最近条目、订阅），回答综合问题时优先调用',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_clips',
      description: '搜索剪贴板内容',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          type: { type: 'string', enum: ['text', 'image', 'file', 'link', 'all'], description: '内容类型过滤' },
          limit: { type: 'number', description: '返回数量限制，默认10' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_clip_details',
      description: '获取指定剪贴板条目的详细信息',
      parameters: {
        type: 'object',
        properties: {
          clip_id: { type: 'string', description: '剪贴板条目ID' }
        },
        required: ['clip_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_clips',
      description: '获取最近的剪贴板条目',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回数量，默认10' },
          type: { type: 'string', enum: ['text', 'image', 'file', 'link', 'all'], description: '内容类型过滤' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_clip_usage',
      description: '分析剪贴板使用模式，提供使用统计和建议',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_collections',
      description: '获取用户所有收藏夹及其条目数量',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_tags',
      description: '获取用户所有收藏项中使用的标签列表',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_devices',
      description: '获取用户所有配对设备及其在线状态',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_templates',
      description: '获取用户的快速粘贴模板列表',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_shared_links',
      description: '获取用户创建的共享链接列表',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_memories',
      description: '读取用户的长期记忆（偏好/项目事实/反馈等跨会话信息）。当用户问到“你记得吗/我们之前说过/我的偏好”或需要结合历史背景时调用',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['preference', 'fact', 'project', 'feedback', 'other'], description: '可选：按类别过滤' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: '保存一条用户长期记忆。当你从对话中了解到用户的偏好、项目事实、工作习惯、对我方产品的反馈，或任何跨会话有用的信息时，主动调用此工具写入记忆，不要等用户要求。每次只保存一条最有价值的信息，标题简短，内容具体。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['preference', 'fact', 'project', 'feedback', 'other'], description: '记忆类别' },
          title: { type: 'string', description: '简短标题' },
          content: { type: 'string', description: '记忆内容' }
        },
        required: ['category', 'title', 'content']
      }
    }
  },
  // Agent 工作流工具
  {
    type: 'function',
    function: {
      name: 'create_workflow',
      description: '创建工作流，定义多步骤任务',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '工作流名称' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', description: '要执行的动作' },
                tool: { type: 'string', description: '要调用的工具名称' },
                params: { type: 'object', description: '工具参数' }
              }
            },
            description: '工作流步骤列表'
          }
        },
        required: ['name', 'steps']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_workflow_step',
      description: '执行工作流中的单个步骤',
      parameters: {
        type: 'object',
        properties: {
          step_id: { type: 'string', description: '步骤ID' },
          tool: { type: 'string', description: '要调用的工具名称' },
          params: { type: 'object', description: '工具参数' }
        },
        required: ['step_id', 'tool']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'batch_favorite',
      description: '批量收藏指定的剪贴板条目',
      parameters: {
        type: 'object',
        properties: {
          clip_ids: { type: 'array', items: { type: 'string' }, description: '要收藏的条目ID列表' }
        },
        required: ['clip_ids']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'batch_delete',
      description: '批量删除指定的剪贴板条目',
      parameters: {
        type: 'object',
        properties: {
          clip_ids: { type: 'array', items: { type: 'string' }, description: '要删除的条目ID列表' }
        },
        required: ['clip_ids']
      }
    }
  },
  {
    type: 'function',
        function: {
          name: 'organize_by_type',
          description: '按类型整理剪贴板内容，返回分类结果',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      },

      // ============ 大管家增强：隐私感知的内容读取 ============
      {
        type: 'function',
        function: {
          name: 'read_clip_content',
          description: '读取某条剪贴板条目的完整明文内容（解密后返回）。这是处理敏感数据的高权限工具，仅在用户明确要求「看这条内容 / 读出明文」时调用。' +
            '隐私规则：本地条目（local-/text-/img- 临时ID）内容不在服务端，无法读取并会说明；' +
            '高级密码保护（advanced）条目必须传入 password 才能解密，否则返回「需要密码」提示；' +
            '图片/文件的存储值实为服务端文件名而非原文，会返回引用名并说明如何查看。',
          parameters: {
            type: 'object',
            properties: {
              clip_id: { type: 'string', description: '剪贴板条目ID' },
              password: { type: 'string', description: '可选：该条目若启用高级密码保护，需提供用户密码才能解密明文' }
            },
            required: ['clip_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_clip_meta',
          description: '获取某条目的完整元数据（类型/预览/大小/收藏/归档/保护级别/标签/来源设备/时间），不含明文。先调用它判断条目性质，再决定是否 read_clip_content',
          parameters: {
            type: 'object',
            properties: {
              clip_id: { type: 'string', description: '剪贴板条目ID' }
            },
            required: ['clip_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_protected_clips',
          description: '列出所有开启了密码保护（protection_level <> none）的条目，返回 id/类型/保护级别，让用户知道哪些内容需要密码才能被 AI 读出',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_archived_clips',
          description: '列出已归档（archived=true）的剪贴板条目',
          parameters: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: '返回数量，默认20' }
            },
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_subscription_details',
          description: '获取当前订阅套餐（free/Pro/企业）及其设备数/历史条数/单文件大小/总存储等限制，并附当前用量',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_security_overview',
          description: '获取账号安全概览：两步验证(2FA)是否开启、账号是否活跃、设备总数与在线数、高级密码保护条目数',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_template_variables',
          description: '获取用户设置的全局模板变量（name→value），用于解释快捷模板的占位符来源',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_notifications',
          description: '获取用户最近的通知（类型/标题/内容/是否已读/时间）',
          parameters: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: '返回数量，默认20' }
            },
            required: []
          }
        }
      },

      // ============ 大管家增强：项目元知识（功能/隐私/部署/架构）============
      {
        type: 'function',
        function: {
          name: 'explain_feature',
          description: '讲解 ClipSync 的某项功能。传入功能 key（如 clipboard_sync / favorites / collections / templates / shared_links / devices_pairing / subscriptions_plans / security_2fa / item_protection / notifications / ai_agent / archive / search_filters / encryption_model）查看详情；不传则返回功能清单。',
          parameters: {
            type: 'object',
            properties: {
              feature: { type: 'string', description: '功能 key，见描述中的枚举' }
            },
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'explain_privacy_model',
          description: '讲解 ClipSync 的数据隐私与加密模型：服务端静态加密、本地条目为何 AI 读不到、高级密码保护为何需要用户密码、AI 能/不能做什么、用户如何查看明文、2FA 与数据导出等',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'explain_deployment',
          description: '讲解 ClipSync 如何启动与部署：本地开发（Node/Rust/Docker/PostgreSQL/Redis、dev 拓扑直连 localhost:3001）、构建打包（tauri build）、生产部署要点（ENCRYPTION_KEY、nginx、SSE 不缓冲）、常见排查',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_project_architecture',
          description: '讲解 ClipSync 整体技术架构：客户端（Tauri v2 + Vue3 + Vite + Pinia + shadcn-vue）、服务端（Express5 + PostgreSQL + Redis）、AI 代理 SSE 流式、实时同步（WebSocket + Redis Pub/Sub）',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      }
    ]

/**
 * 执行工具调用
 */
async function executeTool(toolName, args, userId) {
  try {
    switch (toolName) {
      case 'get_clipboard_stats': {
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
      }

      case 'get_ai_context': {
        return await getAiContext(userId)
      }

      case 'search_clips': {
        const { query, type = 'all', limit = 10 } = args
        let sql = 'SELECT id, content_type, content_preview, created_at FROM clipboard_items WHERE user_id = $1'
        const params = [userId]
        
        if (query) {
          sql += ' AND (content ILIKE $2 OR content_preview ILIKE $2)'
          params.push(`%${query}%`)
        }
        if (type && type !== 'all') {
          sql += ` AND content_type = $${params.length + 1}`
          params.push(type)
        }
        sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`
        params.push(limit)
        
        const result = await pool.query(sql, params)
        return { items: result.rows, count: result.rowCount }
      }

      case 'get_clip_details': {
        const { clip_id } = args
        const result = await pool.query(
          `SELECT id, content_type, content_preview, content_size, is_favorite, archived,
                  protection_level, created_at, source_device_id
           FROM clipboard_items WHERE id = $1 AND user_id = $2`,
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
      }

      case 'get_recent_clips': {
        const { limit = 10, type = 'all' } = args
        let sql = 'SELECT id, content_type, content_preview, created_at FROM clipboard_items WHERE user_id = $1'
        const params = [userId]
        
        if (type && type !== 'all') {
          sql += ' AND content_type = $2'
          params.push(type)
        }
        sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`
        params.push(limit)
        
        const result = await pool.query(sql, params)
        return { items: result.rows, count: result.rowCount }
      }

      case 'analyze_clip_usage': {
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
      }

      case 'batch_favorite': {
        const { clip_ids } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        const result = await pool.query(
          'UPDATE clipboard_items SET is_favorite = true WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [clip_ids, userId]
        )
        return { success: true, updated: result.rowCount }
      }

      case 'batch_delete': {
        const { clip_ids } = args
        if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
          return { error: 'clip_ids is required and must be an array' }
        }
        const result = await pool.query(
          'DELETE FROM clipboard_items WHERE id = ANY($1) AND user_id = $2 RETURNING id',
          [clip_ids, userId]
        )
        return { success: true, deleted: result.rowCount }
      }

      case 'organize_by_type': {
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
      }

      case 'create_workflow': {
        // 工作流创建（简化版，返回工作流定义）
        return {
          workflow: {
            id: `wf-${Date.now()}`,
            name: args.name,
            steps: args.steps,
            status: 'created'
          }
        }
      }

      case 'execute_workflow_step': {
        // 执行工作流步骤
        const { tool, params } = args
        const result = await executeTool(tool, params, userId)
        return {
          step_id: args.step_id,
          status: 'completed',
          result
        }
      }

      case 'get_collections': {
        const result = await pool.query(
          `SELECT id, name, icon, path::text AS path, sort_order,
                  (SELECT COUNT(*)::int FROM favorite_collection_items fci WHERE fci.collection_id = fc.id) AS item_count
           FROM favorite_collections fc
           WHERE fc.user_id = $1
           ORDER BY sort_order ASC, path ASC`,
          [userId]
        )
        return { collections: result.rows, count: result.rowCount }
      }

      case 'get_tags': {
        const result = await pool.query(
          `
          SELECT DISTINCT tag
          FROM (
            SELECT jsonb_array_elements_text(metadata->'tags') AS tag
            FROM clipboard_items
            WHERE user_id = $1 AND is_favorite = TRUE AND metadata->'tags' IS NOT NULL
          ) t
          WHERE tag IS NOT NULL
          ORDER BY tag
          `,
          [userId]
        )
        return { tags: result.rows.map((r) => r.tag), count: result.rowCount }
      }

      case 'get_devices': {
        const result = await pool.query(
          `SELECT id, device_name, device_type, platform, is_online, last_seen_at, created_at
           FROM devices
           WHERE user_id = $1
           ORDER BY last_seen_at DESC`,
          [userId]
        )
        return { devices: result.rows, count: result.rowCount }
      }

      case 'get_templates': {
        const result = await pool.query(
          `SELECT id, name, content_preview, shortcut, created_at
           FROM clipboard_templates
           WHERE user_id = $1
           ORDER BY updated_at DESC`,
          [userId]
        )
        return { templates: result.rows, count: result.rowCount }
      }

      case 'get_shared_links': {
        const result = await pool.query(
          `SELECT id, item_id, access_code, expires_at, created_at
           FROM shared_links
           WHERE user_id = $1
           ORDER BY created_at DESC`,
          [userId]
        )
        return { sharedLinks: result.rows, count: result.rowCount }
      }

      case 'get_memories': {
        const { category } = args
        let sql = 'SELECT id, category, title, content, updated_at FROM ai_memories WHERE user_id = $1'
        const params = [userId]
        if (category) { sql += ' AND category = $2'; params.push(category) }
        sql += ' ORDER BY updated_at DESC'
        const result = await pool.query(sql, params)
        return { memories: result.rows, count: result.rowCount }
      }

      case 'save_memory': {
        const { category = 'fact', title, content } = args
        if (!title || !content) return { error: 'title and content are required' }
        const cat = ['preference', 'fact', 'project', 'feedback', 'other'].includes(category) ? category : 'fact'
        const result = await pool.query(
          `INSERT INTO ai_memories (user_id, category, title, content)
           VALUES ($1, $2, $3, $4)
           RETURNING id, category, title, content, updated_at`,
          [userId, cat, String(title).trim(), String(content).trim()]
        )
        return { saved: result.rows[0] }
      }

      // ============ 大管家增强：隐私感知内容读取 ============
      case 'read_clip_content': {
        const { clip_id, password } = args
        if (!clip_id) return { error: 'clip_id is required' }

        // 本地临时 ID（local-/text-/img-）根本不入服务端库
        const isTempLocal = clip_id.startsWith('local-') || clip_id.startsWith('text-') || clip_id.startsWith('img-')
        if (isTempLocal) {
          return {
            error: '本地条目不可读',
            reason: '该条目是本地条目（仅存在于你的设备，未同步到服务端），AI 无法在服务端读取其明文。请在 ClipSync 应用内查看。'
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
              const limit = 50000
              const truncated = content.length > limit
                ? content.slice(0, limit) + `\n…[截断，原文 ${content.length} 字符]`
                : content
              return {
                accessible: true, contentType: 'file', textFile: true,
                fileName: meta.originalName || item.content_encrypted, extension: ext,
                sizeBytes: located.size, content: truncated
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

        // 高级密码保护：必须密码
        if (item.protection_level === 'advanced') {
          if (!password) {
            return {
              error: '需要密码',
              reason: '该条目启用了高级密码保护（独立 DEK 加密），服务端无密码无法还原明文。请在询问时提供密码，或使用恢复密钥。',
              protectionLevel: 'advanced'
            }
          }
          const plain = unlockWithPassword(item.content_encrypted, item.wrapped_dek_password, password, item.protection_salt)
          if (plain === null) {
            return { error: '密码错误', reason: '提供的解锁密码不正确，无法解密该条目。' }
          }
          return { contentType: type, protectionLevel: 'advanced', decryptedWithPassword: true, content: plain.slice(0, 50000) }
        }

        // none / pin：主密钥可解密
        let plain
        try {
          plain = decrypt(item.content_encrypted)
        } catch (e) {
          return { error: '解密失败', reason: e.message }
        }
        return {
          contentType: type,
          protectionLevel: item.protection_level,
          note: item.protection_level === 'pin' ? 'PIN 保护仅控制客户端展示，服务端内容可被解密。' : undefined,
          content: (plain || '').slice(0, 50000),
          sizeBytes: item.content_size
        }
      }

      case 'get_clip_meta': {
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
      }

      case 'get_protected_clips': {
        const result = await pool.query(
          `SELECT id, content_type, protection_level, content_size, created_at
           FROM clipboard_items WHERE user_id = $1 AND protection_level <> 'none'
           ORDER BY created_at DESC`,
          [userId]
        )
        return { protectedItems: result.rows, count: result.rowCount }
      }

      case 'get_archived_clips': {
        const { limit = 20 } = args
        const result = await pool.query(
          `SELECT id, content_type, content_preview, content_size, is_favorite, protection_level, created_at
           FROM clipboard_items WHERE user_id = $1 AND archived = TRUE
           ORDER BY created_at DESC LIMIT $2`,
          [userId, limit]
        )
        return { archivedItems: result.rows, count: result.rowCount }
      }

      case 'get_subscription_details': {
        const ctx = await getAiContext(userId)
        const sub = ctx.subscription
        const usage = await pool.query(
          `SELECT COUNT(*)::int AS total, COALESCE(SUM(content_size),0)::bigint AS total_bytes
           FROM clipboard_items WHERE user_id = $1`,
          [userId]
        )
        return {
          plan: sub
            ? {
                name: sub.plan_name,
                displayName: sub.display_name,
                maxDevices: sub.max_devices,
                maxItems: sub.max_clipboard_items,
                maxFileMb: sub.max_file_size_mb,
                maxStorageMb: sub.max_storage_mb
              }
            : 'free',
          usage: { totalItems: usage.rows[0].total, totalBytes: Number(usage.rows[0].total_bytes) },
          note: '套餐限制见 plan 字段；usage 为当前用量（条数 + 内容总字节）。'
        }
      }

      case 'get_security_overview': {
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

      case 'get_template_variables': {
        const result = await pool.query(
          'SELECT name, value, updated_at FROM template_variables WHERE user_id = $1 ORDER BY name',
          [userId]
        )
        return { variables: result.rows, count: result.rowCount }
      }

      case 'get_notifications': {
        const { limit = 20 } = args
        const result = await pool.query(
          `SELECT id, notification_type, title, body, read, created_at
           FROM notification_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
          [userId, limit]
        )
        return { notifications: result.rows, count: result.rowCount }
      }

      // ============ 大管家增强：项目元知识 ============
      case 'explain_feature': {
        const { feature } = args
        return { doc: getFeatureDoc(feature) }
      }
      case 'explain_privacy_model': {
        return { doc: getPrivacyModelDoc() }
      }
      case 'explain_deployment': {
        return { doc: getDeploymentDoc() }
      }
      case 'get_project_architecture': {
        return { doc: getArchitectureDoc() }
      }

      default:
        return { error: `Unknown tool: ${toolName}` }
    }
  } catch (err) {
    logger.error('Tool execution error:', err)
    return { error: err.message }
  }
}

// GET /api/ai/tools - 获取可用工具列表
router.get('/tools', apiLimiter, (req, res) => {
  res.json({ tools: TOOLS })
})

// POST /api/ai/tools/execute - 执行工具调用
router.post('/tools/execute', apiLimiter, async (req, res) => {
  try {
    const { toolName, args } = req.body
    if (!toolName) return res.status(400).json({ error: 'toolName is required' })
    
    const result = await executeTool(toolName, args || {}, req.userId)
    res.json({ result })
  } catch (err) {
    logger.error('Tool execute error:', err)
    res.status(500).json({ error: err.message })
  }
})

export { executeTool }
export default router
