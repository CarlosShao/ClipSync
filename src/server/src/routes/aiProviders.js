import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { encrypt, decrypt } from '../utils/encryption.js'
import {
  listPresets,
  getPreset,
  resolveFamily,
  buildUpstreamChat,
  fetchProviderModelsStrict,
  checkUpstreamUrl,
  safeUpstreamFetch,
} from '../utils/aiProviders.js'
// 供应商摘要（probe / 失败响应同一套字段，前端同一套展示逻辑）
import { providerBrief } from '../utils/aiFailure.js'
import { getAiContext } from '../utils/aiContext.js'
import { logger } from '../utils/logger.js'

const router = Router()

// 兼容格式取值枚举：openai（兼容） / anthropic / responses
const VALID_API_FORMATS = ['openai', 'anthropic', 'responses']

/**
 * 归一化 / 校验 apiFormat。
 * - 未传或空 → 默认 'openai'（兼容历史表单 / 老数据）
 * - 取值必须在枚举内，否则返回 null（调用方应回 400）
 * - 仅 custom 供应商可使用 anthropic / responses；非 custom 一律按 'openai' 处理，
 *   若显式传入非 openai 值视为非法
 * @returns {string|null} 归一化后的格式，非法返回 null
 */
function normalizeApiFormat(raw, isCustom) {
  if (raw === undefined || raw === null || raw === '') return 'openai'
  if (!VALID_API_FORMATS.includes(raw)) return null
  if (!isCustom && raw !== 'openai') return null
  return raw
}

/**
 * 校验用户填写的 provider base_url（保存路径 POST/PUT /providers 与未保存预览
 * POST /providers/fetch-models 共用）。
 *
 * 判定策略与所有出站请求（safeUpstreamFetch → assertSafeUpstreamUrl）**完全同源**：
 * 两边都调 utils/aiProviders.js 的 checkUpstreamUrl，从根上杜绝"两套口径漂移"。
 * 默认放行环回 / 私网 / IPv6 ULA —— 本地模型网关（one-api / vLLM / Ollama）是正当的
 * 自托管用法，开关 AI_ALLOW_LOCAL_BASE_URL 默认 true；仍拒绝云元数据 / 链路本地
 * （169.254/16 含 169.254.169.254、fe80::/10）、组播 / 广播 / 保留 / 未指定段、
 * 非 http(s) 协议、带用户信息（user:pass@）、畸形 / 超长 URL；
 * 主机名一律先解析、再对**每条**解析结果判定（DNS 重绑定防护），解析失败即拒绝。
 *
 * 失败时返回稳定机器码 code（前端据 code 映射人话，不解析 message 文本）。
 * @returns {Promise<{ok: boolean, error?: string, code?: string, addressClass?: string}>}
 */
async function validateProviderBaseUrl(input) {
  // 空 baseUrl 允许：回退到该供应商的预设默认地址
  if (!input || typeof input !== 'string' || input.trim().length === 0) return { ok: true }
  const r = await checkUpstreamUrl(input)
  if (r.ok) return { ok: true }
  return { ok: false, error: r.message, code: r.code, addressClass: r.addressClass }
}

// GET /api/ai/providers - 列出当前用户的供应商（不返回密钥明文，仅 hasKey 标记）
// AN-03：管理台禁用（enabled=FALSE）的供应商不返回 → 桌面端不可选（聊天/OCR 链路同步过滤）
router.get('/providers', apiLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, provider, name, base_url, model, models, is_default, context_window, api_format, enabled, created_at, updated_at,
              (api_key_encrypted IS NOT NULL AND api_key_encrypted <> '') AS has_key
       FROM ai_providers
       WHERE user_id = $1 AND enabled = TRUE
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
    const { provider, name, apiKey, baseUrl, model, models, isDefault, contextWindow, apiFormat } = req.body || {}
    if (!provider || !getPreset(provider)) {
      // 用户实测反馈：新增供应商草稿态下「供应商」下拉为空就点保存/刷新，只看到裸英文
      // 「Invalid provider」，完全不知道下一步该干什么（自定义网关应当选 Custom）。
      // error 原值保持不变（既有契约/测试），另补可操作 message 与稳定 code 供前端映射。
      return res.status(400).json({
        error: 'Invalid provider',
        code: 'INVALID_PROVIDER',
        message: '请选择供应商；自定义/本地网关请选 Custom',
      })
    }
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Name is required' })
    }
    // apiFormat 校验：仅 custom 可用 anthropic / responses，取值非法回 400
    const newApiFormat = normalizeApiFormat(apiFormat, provider === 'custom')
    if (newApiFormat === null) {
      return res.status(400).json({ error: 'Invalid api_format' })
    }

    if (baseUrl) {
      const vb = await validateProviderBaseUrl(baseUrl)
      if (!vb.ok) {
        return res.status(400).json({ error: vb.error, code: vb.code, addressClass: vb.addressClass })
      }
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
        `INSERT INTO ai_providers (user_id, provider, name, api_key_encrypted, base_url, model, models, is_default, context_window, api_format)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
         RETURNING id, provider, name, base_url, model, models, is_default, context_window, api_format, created_at, updated_at,
                   (api_key_encrypted IS NOT NULL AND api_key_encrypted <> '') AS has_key`,
        [req.userId, provider, name.trim(), encryptedKey, baseUrl || null, activeModel, modelsJson, wantDefault, parsedCtx, newApiFormat]
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
    const { name, apiKey, baseUrl, model, models, isDefault, contextWindow, apiFormat } = req.body || {}

    const existing = await pool.query('SELECT * FROM ai_providers WHERE id = $1 AND user_id = $2', [id, req.userId])
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Provider not found' })
    }
    const cur = existing.rows[0]

    const newName = name != null ? String(name).trim() : cur.name
    const newBaseUrl = baseUrl != null ? (baseUrl || null) : cur.base_url

    if (newBaseUrl) {
      const vb = await validateProviderBaseUrl(newBaseUrl)
      if (!vb.ok) {
        return res.status(400).json({ error: vb.error, code: vb.code, addressClass: vb.addressClass })
      }
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

    // apiFormat：提供时校验（仅 custom 可用 anthropic / responses，非法回 400）；不提供则保留旧值
    let newApiFormat = cur.api_format || 'openai'
    if (apiFormat !== undefined && apiFormat !== null && apiFormat !== '') {
      const v = normalizeApiFormat(apiFormat, cur.provider === 'custom')
      if (v === null) return res.status(400).json({ error: 'Invalid api_format' })
      newApiFormat = v
    }

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
             is_default = $7, context_window = $9, api_format = $10, updated_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING id, provider, name, base_url, model, models, is_default, context_window, api_format, created_at, updated_at,
                   (api_key_encrypted IS NOT NULL AND api_key_encrypted <> '') AS has_key`,
        [id, req.userId, newName, encryptedKey, newBaseUrl, newModel, wantDefault, modelsJson, newContextWindow, newApiFormat]
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

/**
 * 模型列表刷新失败的响应体：稳定 code + 上游原始 status/文案/错误码 + 供应商摘要 + 当前（未改动）
 * 的已存列表。字段名与 utils/modelProbe.js 的 probe 失败响应保持一致（前端可复用同一套展示逻辑）。
 */
function modelsFailureBody(r, providerRow = null, extra = {}) {
  const details = r.details || {}
  return {
    error: r.message,
    code: r.code,
    details,
    upstreamStatus: details.upstreamStatus ?? null,
    upstreamMessage: details.upstreamMessage ?? null,
    upstreamErrorCode: details.upstreamErrorCode ?? null,
    provider: providerBrief(providerRow),
    ...extra,
  }
}

/** 库里已存的 models（jsonb → 数组；异常形态一律当空数组，避免把脏数据回给前端） */
function storedModelsOf(row) {
  const v = row && row.models
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

// GET /api/ai/providers/:id/models - 拉取该供应商可用模型列表（刷新），**只有成功才写回** models 字段
//
// 用户实测反馈（服务端在 Docker 里，Base URL = http://127.0.0.1:3800/v1 从容器视角必然连不上）：
//   ① 假成功：旧实现 catch 吞掉上游错误 → 永远 200 → 前端弹「模型列表已刷新」却一个模型都没有；
//   ② 数据破坏：旧实现无论成败都 `UPDATE ai_providers SET models = …` —— 一次网络抖动就把上一次
//      成功刷出来的模型列表清空（注释里"避免反复拉取失败"是错的设计取向）。
// 现在按上游真实结果分三种，语义互不混淆：
//   · 成功且 N>0        → 200 { models, count:N, upstreamEmpty:false }，并写回 models
//   · 成功且 N=0（合法）→ 200 { models:[], count:0, upstreamEmpty:true }，并写回 models
//                          （前端按 warning 提示"上游返回 0 个模型"，不当成功）
//   · 失败              → 4xx/5xx + code + details{upstreamStatus,upstreamMessage}，**绝不改库**
router.get('/providers/:id/models', apiLimiter, async (req, res) => {
  try {
    const id = req.params.id
    const result = await pool.query('SELECT * FROM ai_providers WHERE id = $1 AND user_id = $2', [id, req.userId])
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Provider not found', code: 'ai_no_provider' })
    }
    const row = result.rows[0]
    if (!row.api_key_encrypted) {
      return res.status(400).json({
        error: 'No API key configured',
        code: 'ai_no_api_key',
        provider: providerBrief(row),
        models: storedModelsOf(row),
      })
    }

    const apiKey = decrypt(row.api_key_encrypted)
    const r = await fetchProviderModelsStrict({
      provider: row.provider,
      baseUrl: row.base_url,
      apiKey,
      apiFormat: row.api_format,
    })

    if (!r.ok) {
      logger.warn(
        `[aiProviders] refresh models failed: code=${r.code} provider=${row.name} ` +
          `upstreamStatus=${r.details?.upstreamStatus ?? '-'} message=${r.message}`,
      )
      // ★ 失败**不写库**：把用户已存的列表原样带回去（前端继续展示它，并就近显示失败原因）
      return res
        .status(r.httpStatus || 502)
        .json(modelsFailureBody(r, row, { models: storedModelsOf(row), modelsUnchanged: true }))
    }

    // ★ 只有上游返回结构合法数组（含合法空数组）才写回 models —— 误刷新不再毁数据
    await pool.query('UPDATE ai_providers SET models = $1, updated_at = NOW() WHERE id = $2', [
      JSON.stringify(r.models),
      id,
    ])
    // added/previousCount：给前端"新增 N 个模型"的依据（相对刷新前库里的列表）
    const previous = storedModelsOf(row)
    res.json({
      models: r.models,
      count: r.count,
      upstreamEmpty: r.upstreamEmpty,
      upstreamStatus: r.upstreamStatus,
      added: r.models.filter((m) => !previous.includes(m)).length,
      previousCount: previous.length,
    })
  } catch (err) {
    logger.error('Get provider models error:', err)
    res.status(500).json({ error: 'Failed to fetch provider models', code: 'ai_failed' })
  }
})

// POST /api/ai/providers/fetch-models - 拉取供应商可用模型列表（不落地、不写库）
//
// 两种用法：
//   1) { providerId }                          → 用库里已存的加密 key + base_url
//      （编辑已保存的供应商、且没重新输 key 时走这条）
//   2) { provider, apiKey, baseUrl, apiFormat } → 直接用表单里填的值预览
//      （新增供应商、或刚改了 key / 地址时走这条：有 key 和 baseUrl 就该能直接看模型列表，
//        不必先保存一条记录）
//
// 安全：模式 2 收到的 baseUrl 必须过 validateProviderBaseUrl —— 与保存路径（POST/PUT
// /providers）**同一套 SSRF 校验**（都调 utils/aiProviders.js 的 checkUpstreamUrl）：
// 默认放行环回/私网/ULA（本地模型网关是正当的自托管用法，见 AI_ALLOW_LOCAL_BASE_URL），
// 仍拒云元数据/链路本地（169.254/16、fe80::/10）、组播/广播/保留段、非 http(s)、
// 带用户信息、畸形/超长 URL；主机名全部解析结果逐条校验，解析失败 fail-closed。
// 因此放宽"必须已保存"并不会降低防护强度：这条路径能打到的地址，和"先存下来再拉"
// 能打到的完全一致。
// 明文 apiKey 仅在请求体内传输、用完即弃、不落库也不进日志，与 POST/PUT /providers 保存路径
// 同等信任级别（key 本来就是靠请求体传给服务端加密入的库）。
//
// 失败语义与 GET /providers/:id/models 完全一致（同用 fetchProviderModelsStrict，本路径不写库）：
// 上游失败 → 非 2xx + code + details{upstreamStatus,upstreamMessage}，**绝不假成功**；
// 上游合法返回 0 个 → 200 { models: [], upstreamEmpty: true }（前端按 warning 提示）。
router.post('/providers/fetch-models', apiLimiter, async (req, res) => {
  try {
    const { providerId, provider, apiKey, baseUrl, apiFormat } = req.body || {}

    // ---- 模式 2：未保存配置直连预览 ----
    if (!providerId) {
      if (!provider || !getPreset(provider)) {
        // 根因提示（本轮用户实测）：provider 取自表单「供应商」下拉，草稿态为空 ⇒ 这里直接 400，
        // **根本没发出上游请求**，所以换 127.0.0.1 / host.docker.internal 表现一模一样（与网络无关）。
        return res.status(400).json({
          error: 'Invalid provider',
          code: 'INVALID_PROVIDER',
          message: '请先选择供应商；自定义/本地网关请选 Custom',
          models: [],
        })
      }
      const key = typeof apiKey === 'string' ? apiKey.trim() : ''
      if (!key) {
        return res.status(400).json({ error: 'apiKey is required', models: [] })
      }
      const preset = getPreset(provider)
      const effectiveBaseUrl = (typeof baseUrl === 'string' && baseUrl.trim()) || preset.defaultBaseUrl || undefined
      const vb = await validateProviderBaseUrl(effectiveBaseUrl)
      if (!vb.ok) {
        return res.status(400).json({ error: vb.error, code: vb.code, addressClass: vb.addressClass, models: [] })
      }
      const r = await fetchProviderModelsStrict({
        provider,
        baseUrl: effectiveBaseUrl,
        apiKey: key,
        apiFormat: normalizeApiFormat(apiFormat, provider === 'custom') || 'openai',
      })
      if (!r.ok) return res.status(r.httpStatus || 502).json(modelsFailureBody(r, null, { models: [] }))
      return res.json({
        models: r.models,
        count: r.count,
        upstreamEmpty: r.upstreamEmpty,
        upstreamStatus: r.upstreamStatus,
      })
    }

    // ---- 模式 1：已保存供应商（用库里的加密 key / base_url）----
    const result = await pool.query('SELECT * FROM ai_providers WHERE id = $1 AND user_id = $2', [providerId, req.userId])
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Provider not found', code: 'ai_no_provider', models: [] })
    }
    const row = result.rows[0]
    if (!row.api_key_encrypted) {
      return res.status(400).json({
        error: 'No API key configured',
        code: 'ai_no_api_key',
        provider: providerBrief(row),
        models: storedModelsOf(row),
      })
    }
    const apiKeyStored = decrypt(row.api_key_encrypted)
    const r = await fetchProviderModelsStrict({
      provider: row.provider,
      baseUrl: row.base_url,
      apiKey: apiKeyStored,
      apiFormat: row.api_format,
    })
    if (!r.ok) {
      return res
        .status(r.httpStatus || 502)
        .json(modelsFailureBody(r, row, { models: storedModelsOf(row), modelsUnchanged: true }))
    }
    const previous = storedModelsOf(row)
    res.json({
      models: r.models,
      count: r.count,
      upstreamEmpty: r.upstreamEmpty,
      upstreamStatus: r.upstreamStatus,
      added: r.models.filter((m) => !previous.includes(m)).length,
      previousCount: previous.length,
    })
  } catch (err) {
    logger.error('Fetch models error:', err)
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
      apiFormat: row.api_format,
    })
    // Responses 族：用最小请求 {model, input:'ping', stream:false, max_output_tokens:8}，
    // 直接以字符串 input 探测上游连通性（与结构化转换等价但更贴近官方最小示例）。
    if (upstream.family === 'responses') {
      upstream.body.input = 'ping'
    }

    const upstreamRes = await safeUpstreamFetch(upstream.url, {
      method: 'POST',
      headers: upstream.headers,
      body: JSON.stringify(upstream.body),
    })

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => '')
      return res.status(502).json({ ok: false, status: upstreamRes.status, detail: text.slice(0, 500) })
    }
    // 非流式响应（openai：choices[].message；responses：output[].content[].text）
    // 仅校验 HTTP ok，无需解析 body，故两类协议均可直接通过。
    res.json({ ok: true })
  } catch (err) {
    logger.error('Test AI provider error:', err)
    res.status(502).json({ ok: false, error: err.message })
  }
})

export default router
