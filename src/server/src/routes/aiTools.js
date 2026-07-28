import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { logger } from '../utils/logger.js'
import { getAiContext } from '../utils/aiContext.js'

const router = Router()

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
      description: '保存一条用户长期记忆（如用户明确表达的偏好、项目事实、对我方产品的反馈）。仅当用户明确陈述了值得长期记住的信息时调用，避免记录临时内容。',
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
          'SELECT id, content_type, content_preview, created_at, is_favorite FROM clipboard_items WHERE id = $1 AND user_id = $2',
          [clip_id, userId]
        )
        return result.rows[0] || { error: 'Clip not found' }
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
