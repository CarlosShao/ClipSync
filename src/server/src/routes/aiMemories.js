import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'

const router = Router()

const VALID_CATEGORIES = ['preference', 'fact', 'project', 'feedback', 'other']

// GET /api/ai/memories?category=xxx  —— 列出当前用户记忆（按 updated_at 倒序）
router.get('/', apiLimiter, async (req, res) => {
  try {
    const { category } = req.query
    let sql = 'SELECT id, user_id, category, title, content, created_at, updated_at FROM ai_memories WHERE user_id = $1'
    const params = [req.userId]
    if (category && VALID_CATEGORIES.includes(String(category))) {
      sql += ' AND category = $2'
      params.push(String(category))
    }
    sql += ' ORDER BY updated_at DESC'
    const result = await pool.query(sql, params)
    res.json({ items: result.rows, count: result.rowCount })
  } catch (err) {
    res.status(500).json({ error: 'Failed to list memories', detail: err.message })
  }
})

// POST /api/ai/memories  —— 新建记忆
router.post('/', apiLimiter, async (req, res) => {
  try {
    const { category = 'fact', title, content } = req.body || {}
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' })
    if (!content || !content.trim()) return res.status(400).json({ error: 'content is required' })
    const cat = VALID_CATEGORIES.includes(category) ? category : 'fact'
    const result = await pool.query(
      `INSERT INTO ai_memories (user_id, category, title, content)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, category, title, content, created_at, updated_at`,
      [req.userId, cat, title.trim(), content.trim()]
    )
    res.status(201).json({ memory: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Failed to create memory', detail: err.message })
  }
})

// PUT /api/ai/memories/:id  —— 更新记忆
router.put('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params
    const { category, title, content } = req.body || {}
    // 所有权校验
    const owned = await pool.query('SELECT id FROM ai_memories WHERE id = $1 AND user_id = $2', [id, req.userId])
    if (owned.rowCount === 0) return res.status(404).json({ error: 'Memory not found' })

    const sets = []
    const params = [id, req.userId]
    let i = 3
    if (title !== undefined) { sets.push(`title = $${i++}`); params.push(String(title).trim()) }
    if (content !== undefined) { sets.push(`content = $${i++}`); params.push(String(content).trim()) }
    if (category !== undefined) { sets.push(`category = $${i++}`); params.push(VALID_CATEGORIES.includes(category) ? category : 'fact') }
    sets.push(`updated_at = now()`)

    const result = await pool.query(
      `UPDATE ai_memories SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING id, user_id, category, title, content, created_at, updated_at`,
      params
    )
    res.json({ memory: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Failed to update memory', detail: err.message })
  }
})

// DELETE /api/ai/memories/:id  —— 删除记忆
router.delete('/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params
    const result = await pool.query('DELETE FROM ai_memories WHERE id = $1 AND user_id = $2', [id, req.userId])
    if (result.rowCount === 0) return res.status(404).json({ error: 'Memory not found' })
    res.json({ deleted: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete memory', detail: err.message })
  }
})

export default router
