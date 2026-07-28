import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { logger } from '../utils/logger.js'

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
      description: '获取剪贴板的统计数据，包括总数、各类型数量等',
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
        const result = await pool.query(`
          SELECT 
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE content_type = 'text') as text_count,
            COUNT(*) FILTER (WHERE content_type = 'image') as image_count,
            COUNT(*) FILTER (WHERE content_type = 'file') as file_count,
            COUNT(*) FILTER (WHERE content_type = 'link') as link_count,
            COUNT(*) FILTER (WHERE is_favorite = true) as favorites_count
          FROM clipboard_items WHERE user_id = $1
        `, [userId])
        return result.rows[0]
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
