import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { logger } from '../utils/logger.js'

const router = Router()

// 默认值：用户尚未保存任何偏好时返回。
const DEFAULTS = {
  defaultProviderId: null,
  defaultModel: null,
  selectedModels: {},
  defaultMode: 'ask',
  thinkingEnabled: false,
  thinkingStrength: 'medium',
  // 长程记忆开关：是否把用户记忆注入 AI system prompt（Agent-F）
  memoryEnabled: false,
  // 全局自定义系统提示词：追加到角色/产品知识之后、thinking 增强之前（Agent-F 040）
  customSystemPrompt: '',
  // parallelEnabled 已废弃：是否派发子代理改由 Agent 模式下的协调器模型自行决定，不再提供手动开关。
  // DB 列仍保留以保证兼容性，但接口不再读取/返回该字段。
}

// 合并策略：以「已存值优先、客户端显式传入才覆盖」的方式构造最终写入对象。
function sanitize(input, existing) {
  const o = { ...DEFAULTS, ...(existing || {}) }
  if (input == null) return o
  const b = input
  if (b.defaultProviderId !== undefined) o.defaultProviderId = b.defaultProviderId || null
  if (b.defaultModel !== undefined) o.defaultModel = b.defaultModel ? String(b.defaultModel) : null
  if (b.selectedModels !== undefined && b.selectedModels !== null && typeof b.selectedModels === 'object') {
    o.selectedModels = b.selectedModels
  }
  if (b.defaultMode === 'ask' || b.defaultMode === 'agent') o.defaultMode = b.defaultMode
  if (typeof b.thinkingEnabled === 'boolean') o.thinkingEnabled = b.thinkingEnabled
  if (['low', 'medium', 'high'].includes(b.thinkingStrength)) o.thinkingStrength = b.thinkingStrength
  if (typeof b.memoryEnabled === 'boolean') o.memoryEnabled = b.memoryEnabled
  if (typeof b.customSystemPrompt === 'string') o.customSystemPrompt = b.customSystemPrompt
  return o
}

// 将 DB 行（snake_case）映射为前端响应（camelCase）；无行时返回默认值。
function rowToResponse(row) {
  if (!row) {
    return {
      defaultProviderId: null,
      defaultModel: null,
      selectedModels: {},
      defaultMode: 'ask',
      thinkingEnabled: false,
      thinkingStrength: 'medium',
      memoryEnabled: false,
      customSystemPrompt: '',
    }
  }
  return {
    defaultProviderId: row.default_provider_id,
    defaultModel: row.default_model,
    selectedModels: row.selected_models,
    defaultMode: row.default_mode,
    thinkingEnabled: row.thinking_enabled,
    thinkingStrength: row.thinking_strength,
    memoryEnabled: row.memory_enabled === true,
    customSystemPrompt: row.custom_system_prompt || '',
  }
}

// GET /api/ai/settings - 返回用户 AI 偏好（无则默认值）
router.get('/', apiLimiter, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ai_settings WHERE user_id = $1', [req.userId])
    res.json(rowToResponse(result.rows[0]))
  } catch (err) {
    logger.error('Get AI settings error:', err)
    res.status(500).json({ error: 'Failed to get AI settings' })
  }
})

// PUT /api/ai/settings - upsert 用户 AI 偏好
router.put('/', apiLimiter, async (req, res) => {
  try {
    const existingResult = await pool.query('SELECT * FROM ai_settings WHERE user_id = $1', [req.userId])
    const s = sanitize(req.body, existingResult.rows[0] || null)

    const result = await pool.query(
      `INSERT INTO ai_settings (user_id, default_provider_id, default_model, selected_models, default_mode, thinking_enabled, thinking_strength, memory_enabled, custom_system_prompt, parallel_enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         default_provider_id = EXCLUDED.default_provider_id,
         default_model = EXCLUDED.default_model,
         selected_models = EXCLUDED.selected_models,
         default_mode = EXCLUDED.default_mode,
         thinking_enabled = EXCLUDED.thinking_enabled,
         thinking_strength = EXCLUDED.thinking_strength,
         memory_enabled = EXCLUDED.memory_enabled,
         custom_system_prompt = EXCLUDED.custom_system_prompt,
         parallel_enabled = EXCLUDED.parallel_enabled,
         updated_at = NOW()
       RETURNING *`,
      [req.userId, s.defaultProviderId, s.defaultModel, JSON.stringify(s.selectedModels), s.defaultMode, s.thinkingEnabled, s.thinkingStrength, s.memoryEnabled, s.customSystemPrompt, false]
    )
    const row = result.rows[0]
    res.json(rowToResponse(row))
  } catch (err) {
    logger.error('Put AI settings error:', err)
    res.status(500).json({ error: 'Failed to save AI settings' })
  }
})

export default router
