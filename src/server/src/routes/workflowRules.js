import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { logger } from '../utils/logger.js'

/**
 * 工作流规则引擎（任务 #237）
 * 「当…时自动…」：用户配置规则，新剪贴板条目满足条件时自动执行动作。
 * 动作：favorite(收藏) / archive(归档) / tag(打标签) / move_to_collection(移入收藏夹)
 *
 * 注意：规则执行在创建条目之后异步进行，绝不阻塞/回滚剪贴板写入主流程。
 */
export const router = Router()

// 校验字段合法值
const VALID_TYPES = ['text', 'image', 'file', 'link', 'code']
const VALID_MODES = ['keyword', 'regex']
const VALID_ACTIONS = ['favorite', 'archive', 'tag', 'move_to_collection']

function sanitizeRule(body) {
  const name = String(body.name || '').trim().slice(0, 100)
  if (!name) return { error: 'name is required' }
  const content_type = VALID_TYPES.includes(body.contentType) ? body.contentType : 'text'
  const match_mode = VALID_MODES.includes(body.matchMode) ? body.matchMode : 'keyword'
  const keywords = Array.isArray(body.keywords)
    ? body.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim().slice(0, 100)).slice(0, 20)
    : []
  if (keywords.length === 0) return { error: 'at least one keyword/regex required' }
  const action_type = VALID_ACTIONS.includes(body.actionType) ? body.actionType : 'favorite'
  const action_value = typeof body.actionValue === 'string' ? body.actionValue.trim().slice(0, 100) : null
  const action_apply_tags = Array.isArray(body.actionApplyTags)
    ? body.actionApplyTags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 20)).slice(0, 10)
    : null
  const priority = Number.isFinite(Number(body.priority)) ? Math.min(1000, Math.max(0, Number(body.priority))) : 100
  const enabled = body.enabled !== false
  // tag 动作必须要有标签
  if (action_type === 'tag' && !action_value && (!action_apply_tags || action_apply_tags.length === 0)) {
    return { error: 'tag action requires actionValue or actionApplyTags' }
  }
  return {
    name,
    content_type,
    match_mode,
    keywords,
    action_type,
    action_value,
    action_apply_tags,
    priority,
    enabled,
  }
}

// GET /api/workflow-rules - 当前用户全部规则（按 priority 降序）
router.get('/', apiLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, enabled, content_type, match_mode, keywords, action_type,
              action_value, action_apply_tags, priority, created_at, updated_at
       FROM workflow_rules
       WHERE user_id = $1
       ORDER BY enabled DESC, priority DESC, created_at DESC`,
      [req.userId]
    )
    res.json({
      items: result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        contentType: r.content_type,
        matchMode: r.match_mode,
        keywords: r.keywords || [],
        actionType: r.action_type,
        actionValue: r.action_value,
        actionApplyTags: r.action_apply_tags || [],
        priority: r.priority,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    })
  } catch (err) {
    logger.error('List workflow rules error:', err.message)
    res.status(500).json({ error: 'Failed to list workflow rules' })
  }
})

// POST /api/workflow-rules - 创建规则
router.post('/', apiLimiter, async (req, res) => {
  try {
    const clean = sanitizeRule(req.body)
    if (clean.error) return res.status(400).json({ error: clean.error })
    const result = await pool.query(
      `INSERT INTO workflow_rules
         (user_id, name, enabled, content_type, match_mode, keywords, action_type, action_value, action_apply_tags, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, created_at`,
      [req.userId, clean.name, clean.enabled, clean.content_type, clean.match_mode, JSON.stringify(clean.keywords), clean.action_type, clean.action_value, clean.action_apply_tags ? JSON.stringify(clean.action_apply_tags) : null, clean.priority]
    )
    res.status(201).json({ id: result.rows[0].id })
  } catch (err) {
    logger.error('Create workflow rule error:', err.message)
    res.status(500).json({ error: 'Failed to create workflow rule' })
  }
})

// PUT /api/workflow-rules/:id - 更新规则
router.put('/:id', apiLimiter, async (req, res) => {
  try {
    const clean = sanitizeRule(req.body)
    if (clean.error) return res.status(400).json({ error: clean.error })
    const result = await pool.query(
      `UPDATE workflow_rules SET
         name=$1, enabled=$2, content_type=$3, match_mode=$4, keywords=$5,
         action_type=$6, action_value=$7, action_apply_tags=$8, priority=$9, updated_at=NOW()
       WHERE id=$10 AND user_id=$11
       RETURNING id`,
      [clean.name, clean.enabled, clean.content_type, clean.match_mode, JSON.stringify(clean.keywords), clean.action_type, clean.action_value, clean.action_apply_tags ? JSON.stringify(clean.action_apply_tags) : null, clean.priority, req.params.id, req.userId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Rule not found' })
    res.json({ ok: true })
  } catch (err) {
    logger.error('Update workflow rule error:', err.message)
    res.status(500).json({ error: 'Failed to update workflow rule' })
  }
})

// DELETE /api/workflow-rules/:id - 删除规则
router.delete('/:id', apiLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM workflow_rules WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Rule not found' })
    res.json({ ok: true })
  } catch (err) {
    logger.error('Delete workflow rule error:', err.message)
    res.status(500).json({ error: 'Failed to delete workflow rule' })
  }
})

// PATCH /api/workflow-rules/:id/toggle - 启停规则
router.patch('/:id/toggle', apiLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE workflow_rules SET enabled = NOT enabled, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id, enabled`,
      [req.params.id, req.userId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Rule not found' })
    res.json({ id: result.rows[0].id, enabled: result.rows[0].enabled })
  } catch (err) {
    logger.error('Toggle workflow rule error:', err.message)
    res.status(500).json({ error: 'Failed to toggle workflow rule' })
  }
})

export default router
