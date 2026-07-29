import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { encrypt, decrypt } from '../utils/encryption.js'
import { listPresets, getPreset, buildUpstreamChat, fetchProviderModels } from '../utils/aiProviders.js'
import { getAiContext } from '../utils/aiContext.js'
import { logger } from '../utils/logger.js'

const router = Router()

// GET /api/ai/providers - 列出当前用户的供应商（不返回密钥明文，仅 hasKey 标记）
router.get('/providers', apiLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, provider, name, base_url, model, models, is_default, created_at, updated_at,
              (api_key_encrypted IS NOT NULL AND api_key_encrypted <> '') AS has_key
       FROM ai_providers
       WHERE user_id = $1
       ORDER BY is_default DESC, created_at ASC`,
      [req.userId]
    )
    res.json({ items: result.rows, count: result.rowCount })
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
    const { provider, name, apiKey, baseUrl, model, models, isDefault } = req.body || {}
    if (!provider || !getPreset(provider)) {
      return res.status(400).json({ error: 'Invalid provider' })
    }
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Name is required' })
    }
    if (!model || typeof model !== 'string' || model.trim().length === 0) {
      return res.status(400).json({ error: 'Model is required' })
    }

    let encryptedKey = null
    if (apiKey && typeof apiKey === 'string' && apiKey.trim().length > 0) {
      encryptedKey = encrypt(apiKey.trim())
    }

    const wantDefault = isDefault === true

    // models：可选，客户端可传入已知模型列表；不传则默认空数组（由 /providers/:id/models 刷新补全）
    let modelsJson = '[]'
    if (Array.isArray(models)) {
      modelsJson = JSON.stringify(models.filter((m) => typeof m === 'string'))
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (wantDefault) {
        await client.query('UPDATE ai_providers SET is_default = FALSE WHERE user_id = $1', [req.userId])
      }
      const result = await client.query(
        `INSERT INTO ai_providers (user_id, provider, name, api_key_encrypted, base_url, model, models, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING id, provider, name, base_url, model, models, is_default, created_at, updated_at,
                   (api_key_encrypted IS NOT NULL AND api_key_encrypted <> '') AS has_key`,
        [req.userId, provider, name.trim(), encryptedKey, baseUrl || null, model.trim(), modelsJson, wantDefault]
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
    const { name, apiKey, baseUrl, model, models, isDefault } = req.body || {}

    const existing = await pool.query('SELECT * FROM ai_providers WHERE id = $1 AND user_id = $2', [id, req.userId])
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Provider not found' })
    }
    const cur = existing.rows[0]

    const newName = name != null ? String(name).trim() : cur.name
    const newBaseUrl = baseUrl != null ? (baseUrl || null) : cur.base_url
    const newModel = model != null ? String(model).trim() : cur.model

    // models：仅当客户端显式传入数组时才覆盖（否则保留已刷新的列表）
    let modelsJson = null
    if (Array.isArray(models)) {
      modelsJson = JSON.stringify(models.filter((m) => typeof m === 'string'))
    }

    // apiKey：提供且非空 → 重新加密覆盖；不提供 → 保留旧值
    let encryptedKey = cur.api_key_encrypted
    if (apiKey != null && String(apiKey).trim().length > 0) {
      encryptedKey = encrypt(String(apiKey).trim())
    }

    const wantDefault = isDefault === true ? true : (isDefault === false ? false : cur.is_default)

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
             is_default = $7, updated_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING id, provider, name, base_url, model, models, is_default, created_at, updated_at,
                   (api_key_encrypted IS NOT NULL AND api_key_encrypted <> '') AS has_key`,
        [id, req.userId, newName, encryptedKey, newBaseUrl, newModel, wantDefault, modelsJson]
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

    const upstreamRes = await fetch(upstream.url, {
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
