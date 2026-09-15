import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { logger } from '../utils/logger.js'
import { encrypt } from '../utils/encryption.js'

const router = Router()

// 联网搜索源白名单（与 utils/searchProviders.SEARCH_PROVIDERS 对齐）
const SEARCH_PROVIDERS = ['anysearch', 'bocha', 'brave', 'tavily', 'searxng']

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
  // 联网搜索源配置：provider（空=未配置，走管理台全局兜底）、baseUrl（SearXNG 自建源用）；
  // key 明文永不回传，GET 只给 hasKey 布尔（对齐供应商 has_key 模式）。
  searchProvider: '',
  searchBaseUrl: '',
  searchHasKey: false,
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
  // 联网搜索源：provider 必须在白名单内，空串 = 未配置（走管理台全局兜底）
  if (b.searchProvider !== undefined) {
    o.searchProvider = b.searchProvider && SEARCH_PROVIDERS.includes(b.searchProvider) ? b.searchProvider : ''
  }
  if (typeof b.searchBaseUrl === 'string') o.searchBaseUrl = b.searchBaseUrl.trim().slice(0, 500)
  // 搜索 Key：沿用内部标记 —— __keep__ = 不修改（GET 永不回传明文，前端以此表达"未改动"）；
  // null/空串 = 清空；非空字符串 = 加密更新。existing 透传供 PUT 组装 SQL。
  if (b.searchApiKey !== undefined) o.searchApiKey = b.searchApiKey
  return o
}

// 将 DB 行（snake_case）映射为前端响应（camelCase）；无行时返回默认值。
// searchApiKey 明文永不回传：只给 searchHasKey 布尔。列尚不存在（迁移未跑）时按未配置处理。
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
      searchProvider: '',
      searchBaseUrl: '',
      searchHasKey: false,
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
    searchProvider: row.search_provider || '',
    searchBaseUrl: row.search_base_url || '',
    searchHasKey: !!(row.search_api_key_encrypted && row.search_api_key_encrypted !== ''),
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
    const existing = existingResult.rows[0] || null
    const s = sanitize(req.body, existing)

    // 搜索列可能尚不存在（070 迁移未跑）：探测后决定 SQL 是否带搜索列，避免整单 500。
    let hasSearchCols = false
    try {
      const colRes = await pool.query(
        `SELECT COUNT(*)::int AS n FROM information_schema.columns
         WHERE table_name = 'ai_settings' AND column_name IN ('search_provider', 'search_api_key_encrypted', 'search_base_url')`,
      )
      hasSearchCols = Number(colRes.rows[0]?.n) === 3
    } catch {
      hasSearchCols = false
    }

    // 搜索 Key 三态：'__keep__'/undefined = 不修改；null/'' = 清空；非空 = 加密更新
    let searchKeyEnc = existing?.search_api_key_encrypted ?? null
    if (hasSearchCols && s.searchApiKey !== undefined && s.searchApiKey !== '__keep__') {
      if (s.searchApiKey == null || s.searchApiKey === '') {
        searchKeyEnc = null
      } else {
        searchKeyEnc = encrypt(String(s.searchApiKey).trim())
      }
    }
    const searchProvider = hasSearchCols ? (s.searchProvider || '') : undefined
    const searchBaseUrl = hasSearchCols ? (s.searchBaseUrl || '') : undefined

    const baseCols = ['user_id', 'default_provider_id', 'default_model', 'selected_models', 'default_mode', 'thinking_enabled', 'thinking_strength', 'memory_enabled', 'custom_system_prompt', 'parallel_enabled']
    const baseVals = [req.userId, s.defaultProviderId, s.defaultModel, JSON.stringify(s.selectedModels), s.defaultMode, s.thinkingEnabled, s.thinkingStrength, s.memoryEnabled, s.customSystemPrompt, false]
    const baseSets = ['default_provider_id', 'default_model', 'selected_models', 'default_mode', 'thinking_enabled', 'thinking_strength', 'memory_enabled', 'custom_system_prompt', 'parallel_enabled']
    let cols = [...baseCols]
    let vals = [...baseVals]
    let sets = [...baseSets]
    if (hasSearchCols) {
      cols = [...cols, 'search_provider', 'search_api_key_encrypted', 'search_base_url']
      vals = [...vals, searchProvider, searchKeyEnc, searchBaseUrl]
      sets = [...sets, 'search_provider', 'search_api_key_encrypted', 'search_base_url']
    }
    const placeholders = vals.map((_, i) => (i === 3 ? `$${i + 1}::jsonb` : `$${i + 1}`))
    const result = await pool.query(
      `INSERT INTO ai_settings (${cols.join(', ')}, created_at, updated_at)
       VALUES (${placeholders.join(', ')}, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         ${sets.map((c) => `${c} = EXCLUDED.${c}`).join(',\n         ')},
         updated_at = NOW()
       RETURNING *`,
      vals,
    )
    const row = result.rows[0]
    res.json(rowToResponse(row))
  } catch (err) {
    logger.error('Put AI settings error:', err)
    res.status(500).json({ error: 'Failed to save AI settings' })
  }
})

// POST /api/ai/settings/search-test - 测试搜索源连通性（设置页"测试"按钮）。
// body: { provider, apiKey?, baseUrl? } —— apiKey 传 '__keep__'/空表示用已存 key。
router.post('/search-test', apiLimiter, async (req, res) => {
  try {
    const { provider, apiKey, baseUrl } = req.body || {}
    if (!provider || !SEARCH_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: 'INVALID_PROVIDER', message: '请选择搜索源' })
    }
    let key = typeof apiKey === 'string' ? apiKey : ''
    if (key === '__keep__' || key === '') {
      // 用已存 key（列不存在则视为空）
      try {
        const srow = await pool.query('SELECT search_api_key_encrypted FROM ai_settings WHERE user_id = $1', [req.userId])
        const enc = srow.rows[0]?.search_api_key_encrypted || ''
        if (enc) {
          const { decrypt } = await import('../utils/encryption.js')
          key = decrypt(enc) || ''
        } else {
          key = ''
        }
      } catch {
        key = ''
      }
    }
    const { testSearchConfig } = await import('../utils/searchProviders.js')
    const out = await testSearchConfig(provider, { apiKey: key, baseUrl: baseUrl || '' })
    if (out.error) return res.status(502).json(out)
    res.json(out)
  } catch (err) {
    logger.error('Search test error:', err)
    res.status(500).json({ error: 'Search test failed' })
  }
})

export default router
