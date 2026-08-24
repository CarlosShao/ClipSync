import { Router } from 'express'
import dns from 'node:dns'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { encrypt, decrypt } from '../utils/encryption.js'
import {
  listPresets,
  getPreset,
  buildUpstreamChat,
  fetchProviderModels,
  isPrivateIp,
  BLOCKED_HOSTNAMES,
  safeUpstreamFetch,
} from '../utils/aiProviders.js'
import { getAiContext } from '../utils/aiContext.js'
import { logger } from '../utils/logger.js'

const router = Router()

async function validateProviderBaseUrl(input) {
  if (!input || typeof input !== 'string' || input.trim().length === 0) {
    return { ok: true } // 空 baseUrl 允许，回退到预设默认地址
  }
  let parsed
  try {
    parsed = new URL(input.trim())
  } catch {
    return { ok: false, error: 'Invalid base URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Base URL must use http or https' }
  }
  const host = parsed.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.includes(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.svc')) {
    return { ok: false, error: 'Base URL host is not allowed' }
  }
  // 直接是 IP：立即校验
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) return { ok: false, error: 'Base URL resolves to a blocked internal address' }
    return { ok: true }
  }
  // 主机名：解析后再校验一次，防 DNS rebinding 指向内网
  try {
    const { address } = await dns.promises.lookup(host)
    if (isPrivateIp(address)) return { ok: false, error: 'Base URL resolves to a blocked internal address' }
  } catch {
    return { ok: false, error: 'Base URL host cannot be resolved' }
  }
  return { ok: true }
}

// GET /api/ai/providers - 列出当前用户的供应商（不返回密钥明文，仅 hasKey 标记）
router.get('/providers', apiLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, provider, name, base_url, model, models, is_default, context_window, created_at, updated_at,
              (api_key_encrypted IS NOT NULL AND api_key_encrypted <> '') AS has_key
       FROM ai_providers
       WHERE user_id = $1
       ORDER BY is_default DESC, created_at ASC`,
      [req.userId]
    )
    // 给每个供应商附加协议层能力标志（如 supportsCache），让前端能区分
    // "供应商不支持 cache" 与 "支持但本次 0%" 两种显示状态。
    const items = result.rows.map((row) => ({
      ...row,
      supports_cache: getPreset(row.provider)?.supportsCache === true,
    }))
    res.json({ items, count: result.rowCount })
  } catch (err) {
    logger.error('List AI providers error:', err)
    res.status(500).json({ error: 'Failed to list AI providers' })
  }
})

// GET /api/ai/presets - 内置供应商预设（脱敏，仅下拉用）
router.get('/presets', apiLimiter, async (req, res) => {
  res.json({ items: listPresets() })
})

// GET /api/ai/context - 聚合当前用户的 ClipSync 上下文（供 AI system prompt 使用）
router.get('/context', apiLimiter, async (req, res) => {
  try {
    const context = await getAiContext(req.userId)
    res.json({ context })
  } catch (err) {
    logger.error('Get AI context error:', err)
    res.status(500).json({ error: 'Failed to get AI context' })
  }
})

// POST /api/ai/providers - 新建供应商
router.post('/providers', apiLimiter, async (req, res) => {
  try {
    const { provider, name, apiKey, baseUrl, model, models, isDefault, contextWindow } = req.body || {}
    if (!provider || !getPreset(provider)) {
      return res.status(400).json({ error: 'Invalid provider' })
    }
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Name is required' })
    }

    if (baseUrl) {
      const vb = await validateProviderBaseUrl(baseUrl)
      if (!vb.ok) return res.status(400).json({ error: vb.error })
    }

    // models 多选列表：至少选一个模型；model 字段取 models[0]（或显式传入的 model）
    const selectedModels = Array.isArray(models)
      ? models.filter((m) => typeof m === 'string' && m.trim().length > 0)
      : []
    const activeModel = typeof model === 'string' && model.trim().length > 0
      ? model.trim()
      : selectedModels[0] || ''

    let encryptedKey = null
    if (apiKey && typeof apiKey === 'string' && apiKey.trim().length > 0) {
      encryptedKey = encrypt(apiKey.trim())
    }

    const wantDefault = isDefault === true
    const modelsJson = JSON.stringify(selectedModels)
    const parsedCtx = (() => {
      const n = typeof contextWindow === 'number' ? contextWindow : parseInt(contextWindow, 10)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    })()

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (wantDefault) {
        await client.query('UPDATE ai_providers SET is_default = FALSE WHERE user_id = $1', [req.userId])
      }
      const result = await client.query(
        `INSERT INTO ai_providers (user_id, provider, name, api_key_encrypted, base_url, model, models, is_default, context_window)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         RETURNING id, provider, name, base_url, model, models, is_default, context_window, created_at, updated_at,
                   (api_key_encrypted IS NOT NULL AND api_key_encrypted <> '') AS has_key`,
        [req.userId, provider, name.trim(), encryptedKey, baseUrl || null, activeModel, modelsJson, wantDefault, parsedCtx]
      )
      await client.query('COMMIT')
      res.status(201).json(result.rows[0])
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  } catch (err) {
    logger.error('Create AI provider error:', err)
    res.status(500).json({ error: 'Failed to create AI provider' })
  }
})

// PUT /api/ai/providers/:id - 更新供应商
router.put('/providers/:id', apiLimiter, async (req, res) => {
  try {
    const id = req.params.id
    const { name, apiKey, baseUrl, model, models, isDefault, contextWindow } = req.body || {}

    const existing = await pool.query('SELECT * FROM ai_providers WHERE id = $1 AND user_id = $2', [id, req.userId])
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Provider not found' })
    }
    const cur = existing.rows[0]

    const newName = name != null ? String(name).trim() : cur.name
    const newBaseUrl = baseUrl != null ? (baseUrl || null) : cur.base_url

    if (newBaseUrl) {
      const vb = await validateProviderBaseUrl(newBaseUrl)
      if (!vb.ok) return res.status(400).json({ error: vb.error })
    }

    // models 多选列表：客户端显式传入数组时覆盖；同时保证 model 落在 models 内
    const selectedModels = Array.isArray(models)
      ? models.filter((m) => typeof m === 'string' && m.trim().length > 0)
      : null
    const newModel = model != null
      ? String(model).trim()
      : (selectedModels?.[0] || cur.model)
    const modelsJson = selectedModels ? JSON.stringify(selectedModels) : null

    // apiKey：提供且非空 → 重新加密覆盖；不提供 → 保留旧值
    let encryptedKey = cur.api_key_encrypted
    if (apiKey != null && String(apiKey).trim().length > 0) {
      encryptedKey = encrypt(String(apiKey).trim())
    }

    const wantDefault = isDefault === true ? true : (isDefault === false ? false : cur.is_default)
    const newContextWindow = contextWindow !== undefined
      ? (() => {
          const n = typeof contextWindow === 'number' ? contextWindow : parseInt(contextWindow, 10)
          return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
        })()
      : cur.context_window

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (wantDefault) {
        await client.query('UPDATE ai_providers SET is_default = FALSE WHERE user_id = $1 AND id <> $2', [req.userId, id])
      }
      const result = await client.query(
        `UPDATE ai_providers
         SET name = $3, api_key_encrypted = $4, base_url = $5, model = $6,
             models = COALESCE($8::jsonb, models),
             is_default = $7, context_window = $9, updated_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING id, provider, name, base_url, model, models, is_default, context_window, created_at, updated_at,
                   (api_key_encrypted IS NOT NULL AND api_key_encrypted <> '') AS has_key`,
        [id, req.userId, newName, encryptedKey, newBaseUrl, newModel, wantDefault, modelsJson, newContextWindow]
      )
      await client.query('COMMIT')
      res.json(result.rows[0])
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  } catch (err) {
    logger.error('Update AI provider error:', err)
    res.status(500).json({ error: 'Failed to update AI provider' })
  }
})

// GET /api/ai/providers/:id/models - 拉取该供应商可用模型列表（刷新标签），并写回 models 字段
router.get('/providers/:id/models', apiLimiter, async (req, res) => {
  try {
    const id = req.params.id
    const result = await pool.query('SELECT * FROM ai_providers WHERE id = $1 AND user_id = $2', [id, req.userId])
    if (result.rowCount === 0) return res.status(404).json({ error: 'Provider not found' })
    const row = result.rows[0]
    if (!row.api_key_encrypted) {
      return res.status(400).json({ error: 'No API key configured', models: [] })
    }

    const apiKey = decrypt(row.api_key_encrypted)
    let models = []
    try {
      models = await fetchProviderModels({ provider: row.provider, baseUrl: row.base_url, apiKey })
    } catch (e) {
      logger.warn('Fetch provider models failed:', e.message)
    }
    // 持久化到 models 字段（即便为空也更新，避免反复拉取失败）
    await pool.query('UPDATE ai_providers SET models = $1, updated_at = NOW() WHERE id = $2', [
      JSON.stringify(models),
      id,
    ])
    res.json({ models })
  } catch (err) {
    logger.error('Get provider models error:', err)
    res.status(500).json({ error: 'Failed to fetch provider models' })
  }
})

// POST /api/ai/providers/fetch-models - 用已存供应商的加密密钥拉取模型列表（不落地）
// 安全：不再从请求体接收明文 apiKey，统一按 providerId 取库中加密密钥解密后使用；
// 且不再采信请求体 baseUrl，只使用库中 base_url（body baseUrl 被忽略，防止借此打内网）。
router.post('/providers/fetch-models', apiLimiter, async (req, res) => {
  try {
    const { providerId } = req.body || {}
    if (!providerId) {
      return res.status(400).json({ error: 'providerId is required', models: [] })
    }
    const result = await pool.query('SELECT * FROM ai_providers WHERE id = $1 AND user_id = $2', [providerId, req.userId])
    if (result.rowCount === 0) return res.status(404).json({ error: 'Provider not found', models: [] })
    const row = result.rows[0]
    if (!row.api_key_encrypted) {
      return res.status(400).json({ error: 'No API key configured', models: [] })
    }
    const apiKey = decrypt(row.api_key_encrypted)
    // 只使用库中 base_url；不再采信请求体的 baseUrl 字段（校验无效，提示客户端忽略）。
    const models = await fetchProviderModels({ provider: row.provider, baseUrl: row.base_url, apiKey })
    res.json({ models, note: 'baseUrl 字段被忽略，仅使用该供应商已配置的 base_url' })
  } catch (err) {
    logger.error('Fetch models (preview) error:', err)
    res.status(500).json({ error: 'Failed to fetch provider models' })
  }
})

// DELETE /api/ai/providers/:id
router.delete('/providers/:id', apiLimiter, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM ai_providers WHERE id = $1 AND user_id = $2', [req.params.id, req.userId])
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Provider not found' })
    }
    res.json({ ok: true })
  } catch (err) {
    logger.error('Delete AI provider error:', err)
    res.status(500).json({ error: 'Failed to delete AI provider' })
  }
})

// POST /api/ai/providers/:id/test - 用最小非流式请求验证密钥/配置是否可用
router.post('/providers/:id/test', apiLimiter, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ai_providers WHERE id = $1 AND user_id = $2', [req.params.id, req.userId])
    if (result.rowCount === 0) return res.status(404).json({ error: 'Provider not found' })
    const row = result.rows[0]
    if (!row.api_key_encrypted) return res.status(400).json({ error: 'No API key configured' })

    const apiKey = decrypt(row.api_key_encrypted)
    const upstream = buildUpstreamChat({
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
      apiKey,
      messages: [{ role: 'user', content: 'ping' }],
      options: { maxTokens: 8, stream: false },
    })

    const upstreamRes = await safeUpstreamFetch(upstream.url, {
      method: 'POST',
      headers: upstream.headers,
      body: JSON.stringify(upstream.body),
    })

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => '')
      return res.status(502).json({ ok: false, status: upstreamRes.status, detail: text.slice(0, 500) })
    }
    res.json({ ok: true })
  } catch (err) {
    logger.error('Test AI provider error:', err)
    res.status(502).json({ ok: false, error: err.message })
  }
})

export default router
