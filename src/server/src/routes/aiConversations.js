import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { logger } from '../utils/logger.js'
import { isValidUUID } from '../validation/validator.js'

const router = Router()

function sanitizeTitle(t) {
  if (!t || typeof t !== 'string') return '新对话'
  return t.trim().slice(0, 100) || '新对话'
}

// GET /api/ai/conversations - 列出当前用户的对话（按更新时间倒序）
router.get('/', apiLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.title, c.model, c.mode, c.thinking_enabled, c.created_at, c.updated_at,
              c.prompt_tokens, c.completion_tokens, c.total_tokens, c.cache_read_tokens,
              c.cache_write_tokens, c.cache_hit_rate, c.thinking_tokens, c.reply_tokens,
              c.context_window,
              (SELECT COUNT(*)::int FROM ai_messages m WHERE m.conversation_id = c.id) AS message_count
       FROM ai_conversations c
       WHERE c.user_id = $1
       ORDER BY c.updated_at DESC
       LIMIT 200`,
      [req.userId]
    )
    res.json({ items: result.rows, count: result.rowCount })
  } catch (err) {
    logger.error('List AI conversations error:', err)
    res.status(500).json({ error: 'Failed to list conversations' })
  }
})

// POST /api/ai/conversations - 创建新对话
router.post('/', apiLimiter, async (req, res) => {
  try {
    const { title, providerId, model, mode = 'ask', thinkingEnabled = false } = req.body || {}
    const result = await pool.query(
      `INSERT INTO ai_conversations (user_id, title, provider_id, model, mode, thinking_enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, model, mode, thinking_enabled, created_at, updated_at`,
      [req.userId, sanitizeTitle(title), providerId || null, model || null, mode, !!thinkingEnabled]
    )
    res.status(201).json({ conversation: result.rows[0] })
  } catch (err) {
    logger.error('Create AI conversation error:', err)
    res.status(500).json({ error: 'Failed to create conversation' })
  }
})

// GET /api/ai/conversations/:id - 获取对话详情及消息
router.get('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID' })

    const convResult = await pool.query(
      `SELECT id, title, model, mode, thinking_enabled, created_at, updated_at,
              prompt_tokens, completion_tokens, total_tokens, cache_read_tokens,
              cache_write_tokens, cache_hit_rate, thinking_tokens, reply_tokens,
              context_window
       FROM ai_conversations
       WHERE id = $1 AND user_id = $2`,
      [id, req.userId]
    )
    if (convResult.rowCount === 0) return res.status(404).json({ error: 'Conversation not found' })

    const msgResult = await pool.query(
      `SELECT id, role, content, thinking, tool_calls, tool_results, metadata, created_at
       FROM ai_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [id]
    )

    res.json({
      conversation: convResult.rows[0],
      messages: msgResult.rows.map((m) => ({
        ...m,
        role: m.role,
        content: m.content,
        thinking: m.thinking,
        toolCalls: m.tool_calls || [],
        toolResults: m.tool_results || [],
        metadata: m.metadata || {},
      })),
    })
  } catch (err) {
    logger.error('Get AI conversation error:', err)
    res.status(500).json({ error: 'Failed to get conversation' })
  }
})

// PUT /api/ai/conversations/:id - 更新标题
router.put('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID' })
    const { title } = req.body || {}
    if (title === undefined) return res.status(400).json({ error: 'title is required' })

    const result = await pool.query(
      `UPDATE ai_conversations
       SET title = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING id, title, model, mode, thinking_enabled, created_at, updated_at`,
      [sanitizeTitle(title), id, req.userId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Conversation not found' })
    res.json({ conversation: result.rows[0] })
  } catch (err) {
    logger.error('Update AI conversation error:', err)
    res.status(500).json({ error: 'Failed to update conversation' })
  }
})

// DELETE /api/ai/conversations/:id - 删除对话
router.delete('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID' })
    const result = await pool.query(
      'DELETE FROM ai_conversations WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.userId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Conversation not found' })
    res.json({ deleted: true })
  } catch (err) {
    logger.error('Delete AI conversation error:', err)
    res.status(500).json({ error: 'Failed to delete conversation' })
  }
})

// POST /api/ai/conversations/:id/messages - 批量保存消息
router.post('/:id/messages', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID' })
    const { messages } = req.body || {}
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' })
    }

    // 验证对话归属
    const convCheck = await pool.query(
      'SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    )
    if (convCheck.rowCount === 0) return res.status(404).json({ error: 'Conversation not found' })

    // 用“替换”语义保存消息：先清空该对话的现有消息，再全量插入。
    // 但角色为 system 且 metadata.is_context_summary=true 的"自动压缩摘要"行
    // 不属于前端要管理的内容，必须保留——否则下次进入对话时上一次压缩的要点
    // 就被下一次 saveCurrent 覆盖，破坏"无感延续记忆"。
    await pool.query('BEGIN')
    try {
      await pool.query(
        `DELETE FROM ai_messages
         WHERE conversation_id = $1
           AND COALESCE(metadata->>'is_context_summary', 'false') <> 'true'`,
        [id],
      )

      const inserted = []
      for (const m of messages) {
        if (!m || !m.role) continue
        const result = await pool.query(
          `INSERT INTO ai_messages (conversation_id, role, content, thinking, tool_calls, tool_results, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '{}'::jsonb))
           RETURNING id, role, content, thinking, tool_calls, tool_results, metadata, created_at`,
          [
            id,
            m.role,
            m.content || '',
            m.thinking || null,
            Array.isArray(m.toolCalls) ? JSON.stringify(m.toolCalls) : '[]',
            Array.isArray(m.toolResults) ? JSON.stringify(m.toolResults) : '[]',
            typeof m.metadata === 'object' && m.metadata ? JSON.stringify(m.metadata) : null,
          ]
        )
        inserted.push(result.rows[0])
      }

      // 更新对话 updated_at
      await pool.query('UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1', [id])
      await pool.query('COMMIT')
      res.status(201).json({ messages: inserted })
    } catch (txErr) {
      await pool.query('ROLLBACK')
      throw txErr
    }
    return

  } catch (err) {
    logger.error('Save AI messages error:', err)
    res.status(500).json({ error: 'Failed to save messages' })
  }
})

/**
 * 把单次 SSE 流返回的 token 用量持久化到 ai_conversations。
 * 供 aiChat.js 在流结束后调用；不暴露为公开 API，避免前端伪造用量。
 */
export async function updateConversationUsage(id, userId, usage) {
  if (!id || !userId || !usage) return
  if (!isValidUUID(id)) {
    logger.warn('[updateConversationUsage] invalid conversation id:', id)
    return
  }

  const promptTokens = Math.max(0, Number(usage.promptTokens) || 0)
  const completionTokens = Math.max(0, Number(usage.completionTokens) || 0)
  const totalTokens = Math.max(0, Number(usage.totalTokens) || promptTokens + completionTokens)
  const cacheReadTokens = Math.max(0, Number(usage.cacheReadTokens) || 0)
  const cacheWriteTokens = Math.max(0, Number(usage.cacheWriteTokens) || 0)
  const thinkingTokens = Math.max(0, Number(usage.thinkingTokens) || 0)
  const replyTokens = Math.max(0, Number(usage.replyTokens) || Math.max(0, completionTokens - thinkingTokens))
  const contextWindow = Math.max(0, Number(usage.contextWindow) || 0)
  // 缓存命中率 = 命中 / 输入总量（近似）
  const cacheHitRate = promptTokens > 0
    ? Math.round((cacheReadTokens / promptTokens) * 1000) / 10
    : 0

  try {
    await pool.query(
      `UPDATE ai_conversations
       SET prompt_tokens = $1,
           completion_tokens = $2,
           total_tokens = $3,
           cache_read_tokens = $4,
           cache_write_tokens = $5,
           cache_hit_rate = $6,
           thinking_tokens = $7,
           reply_tokens = $8,
           context_window = $9,
           updated_at = NOW()
       WHERE id = $10 AND user_id = $11`,
      [
        promptTokens,
        completionTokens,
        totalTokens,
        cacheReadTokens,
        cacheWriteTokens,
        cacheHitRate,
        thinkingTokens,
        replyTokens,
        contextWindow,
        id,
        userId,
      ]
    )
  } catch (err) {
    logger.error('[updateConversationUsage] failed:', err)
  }
}

export default router
