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
      `SELECT id, title, model, mode, thinking_enabled, created_at, updated_at
       FROM ai_conversations
       WHERE id = $1 AND user_id = $2`,
      [id, req.userId]
    )
    if (convResult.rowCount === 0) return res.status(404).json({ error: 'Conversation not found' })

    const msgResult = await pool.query(
      `SELECT id, role, content, thinking, tool_calls, tool_results, created_at
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
    // 这样前端可以安全地每次发送整个 messages 数组，而不会出现重复条目。
    await pool.query('BEGIN')
    try {
      await pool.query('DELETE FROM ai_messages WHERE conversation_id = $1', [id])

      const inserted = []
      for (const m of messages) {
        if (!m || !m.role) continue
        const result = await pool.query(
          `INSERT INTO ai_messages (conversation_id, role, content, thinking, tool_calls, tool_results)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, role, content, thinking, tool_calls, tool_results, created_at`,
          [
            id,
            m.role,
            m.content || '',
            m.thinking || null,
            Array.isArray(m.toolCalls) ? JSON.stringify(m.toolCalls) : '[]',
            Array.isArray(m.toolResults) ? JSON.stringify(m.toolResults) : '[]',
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

export default router
