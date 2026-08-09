import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { logger } from '../utils/logger.js'
import { isValidUUID } from '../validation/validator.js'
import { decrypt } from '../utils/encryption.js'

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

// GET /api/ai/conversations/search?q=xxx - 在当前用户所有对话中搜索历史消息片段（#231）
// 排除 system 角色与"上下文压缩摘要"（metadata.is_context_summary=true），
// 返回命中的对话 + 匹配片段 + 消息在对话中的位置索引（用于前端定位跳转）。
router.get('/search', apiLimiter, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim()
    if (!q) return res.json({ items: [], count: 0 })
    if (q.length > 100) return res.status(400).json({ error: 'Query too long' })
    const like = `%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`
    const result = await pool.query(
      `WITH ranked AS (
         SELECT
           c.id AS conversation_id,
           c.title AS conversation_title,
           m.id AS message_id,
           m.role,
           m.content,
           m.created_at AS message_created_at,
           ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY m.created_at ASC) AS pos_in_conv,
           (SELECT COUNT(*)::int FROM ai_messages mm WHERE mm.conversation_id = c.id) AS total_in_conv
         FROM ai_messages m
         JOIN ai_conversations c ON c.id = m.conversation_id
         WHERE c.user_id = $1
           AND m.role <> 'system'
           AND COALESCE(m.metadata->>'is_context_summary', 'false') <> 'true'
           AND m.content ILIKE $2 ESCAPE '\\'
       )
       SELECT
         conversation_id, conversation_title, message_id, role, content, pos_in_conv, total_in_conv, message_created_at
       FROM ranked
       ORDER BY message_created_at DESC
       LIMIT 50`,
      [req.userId, like]
    )
    // 生成片段：截取关键词附近 ±60 字符，高亮关键词（前端处理高亮）
    const items = result.rows.map((r) => {
      const idx = r.content.toLowerCase().indexOf(q.toLowerCase())
      let snippet = r.content
      if (idx >= 0) {
        const start = Math.max(0, idx - 60)
        const end = Math.min(r.content.length, idx + q.length + 60)
        snippet = r.content.slice(start, end)
      }
      return {
        conversationId: r.conversation_id,
        conversationTitle: r.conversation_title,
        messageId: r.message_id,
        role: r.role,
        snippet: snippet.length > 180 ? `${snippet.slice(0, 180)}…` : snippet,
        snippetStart: idx >= 0 ? Math.max(0, idx - 60) : 0,
        posInConv: r.pos_in_conv,
        totalInConv: r.total_in_conv,
        messageCreatedAt: r.message_created_at,
      }
    })
    res.json({ items, count: items.length, query: q })
  } catch (err) {
    logger.error('Search AI conversations error:', err)
    res.status(500).json({ error: 'Failed to search conversations' })
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
       ORDER BY created_at ASC, id ASC`,
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

// POST /api/ai/conversations/:id/compact - 手动压缩指定对话的上下文历史
// 由前端 /compact 命令触发；后端会：
//   1) 加载该对话的 messages（过滤掉已有的"自动压缩摘要"行）
//   2) 用 LLM 生成新的更精炼摘要
//   3) 持久化到 ai_messages (role=system, metadata.is_context_summary=true)
//   4) 返回压缩前后 token 估算与摘要预览
// 客户端收到结果后只需展示"已压缩 N 条历史，节省约 M tokens"提示，不需要再保存 messages。
router.post('/:id/compact', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID' })

    // 1. 验证对话归属当前用户（ai_conversations 没有 system_prompt 列，
    //    system 消息存在 ai_messages 表里）
    const convRes = await pool.query(
      `SELECT id, provider_id FROM ai_conversations
       WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [id, req.userId],
    )
    if (convRes.rowCount === 0) {
      return res.status(404).json({ ok: false, reason: 'not_found', error: 'Conversation not found' })
    }
    const conv = convRes.rows[0]

    // 2. 解析供应商与 API key（与 chat 路径相同的解析顺序：
    //    body.providerId > conversation.provider_id > 用户默认供应商）
    const requestedProviderId = req.body?.providerId
    let providerRow = null
    if (requestedProviderId && isValidUUID(requestedProviderId)) {
      const r = await pool.query(
        `SELECT * FROM ai_providers WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [requestedProviderId, req.userId],
      )
      if (r.rowCount) providerRow = r.rows[0]
    }
    if (!providerRow && conv.provider_id) {
      const r = await pool.query(
        `SELECT * FROM ai_providers WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [conv.provider_id, req.userId],
      )
      if (r.rowCount) providerRow = r.rows[0]
    }
    if (!providerRow) {
      const r = await pool.query(
        `SELECT * FROM ai_providers WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1`,
        [req.userId],
      )
      if (r.rowCount) providerRow = r.rows[0]
    }
    if (!providerRow) {
      return res.status(400).json({ ok: false, reason: 'no_provider', error: '未配置 AI 供应商' })
    }
    const apiKey = providerRow.api_key_encrypted ? decrypt(providerRow.api_key_encrypted) : ''
    if (!apiKey) {
      return res.status(400).json({ ok: false, reason: 'no_key', error: '供应商未配置 API key' })
    }

    // 3. 调用 manualCompactConversation（核心压缩 + 持久化）
    const { manualCompactConversation } = await import('./aiChatCore.js')
    const result = await manualCompactConversation({
      conversationId: id,
      userId: req.userId,
      providerRow,
      apiKey,
      role: req.role || 'user',
    })

    if (!result.ok) {
      if (result.reason === 'too_short') {
        return res.json({ ok: false, reason: 'too_short', error: result.message })
      }
      return res.status(400).json(result)
    }

    // 4. 取出最新持久化的摘要预览（首行），回给前端展示
    const summaryRes = await pool.query(
      `SELECT content FROM ai_messages
       WHERE conversation_id = $1 AND role = 'system'
         AND COALESCE(metadata->>'is_context_summary','false') = 'true'
       ORDER BY created_at DESC LIMIT 1`,
      [id],
    )
    const summaryText = summaryRes.rows[0]?.content || ''
    res.json({
      ok: true,
      removed: result.removed,
      summaryTokens: result.summaryTokens,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      savedTokens: Math.max(0, result.beforeTokens - result.afterTokens),
      summaryPreview: summaryText.slice(0, 600),
      summaryLength: summaryText.length,
    })
  } catch (err) {
    logger.error('Manual compact conversation error:', err)
    res.status(500).json({ ok: false, reason: 'failed', error: err.message || 'Failed to compact conversation' })
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
        // 保留前端传来的原始 created_at（若有），避免全量重插把所有消息的
        // created_at 刷成同一次 NOW() —— 那会导致 GET 按 created_at 排序失效，
        // 消息顺序退化为随机 UUID，聊天区出现"历史消息乱序 / 凭空冒出"。
        // 前端 select() 已把 DB 的 created_at 存到 createdAt 字段随消息带回。
        const ts = m.createdAt || m.created_at || null
        const result = await pool.query(
          `INSERT INTO ai_messages (conversation_id, role, content, thinking, tool_calls, tool_results, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '{}'::jsonb), $8)
           RETURNING id, role, content, thinking, tool_calls, tool_results, metadata, created_at`,
          [
            id,
            m.role,
            m.content || '',
            m.thinking || null,
            Array.isArray(m.toolCalls) ? JSON.stringify(m.toolCalls) : '[]',
            Array.isArray(m.toolResults) ? JSON.stringify(m.toolResults) : '[]',
            typeof m.metadata === 'object' && m.metadata ? JSON.stringify(m.metadata) : null,
            ts, // 若为 null，created_at 会用数据库默认 NOW()
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
