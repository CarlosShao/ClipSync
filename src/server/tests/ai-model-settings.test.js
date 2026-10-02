/**
 * 按模型配置（ai_model_settings，迁移 081）+ 「思考强度 → 推理等级」真生效（核心修复）。
 *
 * 覆盖用户需求的两条：
 *   1) 模型不只有名字：上下文窗口 / 最大输出 / 多模态能力（文本·识图·视频·音频分开）/
 *      推理协议与等级，全部**按模型**配置；内置预设只作默认值，配置入口
 *      GET/PUT /api/ai/model-settings 必须把覆盖暴露出来 → 见 A/B 组。
 *   2) 「思考强度」此前是半假功能（只在 Anthropic 协议分支下发）→ 见 D 组：
 *      直接断言 buildUpstreamChat 产出的**上游请求体**，逐协议钉死下发字段，
 *      并钉死「不支持的协议一个字都不许塞」（否则上游 400）。
 *
 * 数据链路是「DB 覆盖行 → mergeModelSettings → buildReasoningRequest → 请求体」，
 * 因此 B/D 组的用例是端到端的（PUT 落库 → 读回生效值 → 产出请求体），而不是只测纯函数。
 *
 * 鉴权：真签 Bearer（见 tests/test-helpers.js），固定测试用户
 * 00000000-0000-0000-0000-000000000001（beforeAll 里 ensureAuthUser）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import pool from '../src/db/pool.js'
import { authHeaders, ensureAuthUser, TEST_USER_ID } from './test-helpers.js'
import { buildUpstreamChat } from '../src/utils/aiProviders.js'
import {
  resolveModelPreset,
  buildReasoningRequest,
  buildThinkingOptions,
  REASONING_PROTOCOLS,
} from '../src/utils/modelPresets.js'
import { mergeModelSettings, loadEffectiveModelSettings } from '../src/utils/aiModelSettings.js'

let app
let auth
const createdProviderIds = []
const createdUserIds = []
const stamp = Date.now().toString().slice(-6)

async function createUser(suffix) {
  const { rows } = await pool.query(
    `INSERT INTO users (phone, password_hash, nickname, created_at, updated_at)
     VALUES ($1, 'test_hash', $2, NOW(), NOW()) RETURNING id`,
    [`1391${stamp}${suffix}`.slice(0, 11), `meta_${suffix}_${stamp}`],
  )
  createdUserIds.push(rows[0].id)
  return rows[0].id
}

async function createProvider({
  userId = TEST_USER_ID,
  provider = 'custom',
  model = 'gpt-4o',
  models = [],
  apiFormat = 'openai',
  baseUrl = 'https://gateway.example.com/v1',
} = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ai_providers (user_id, provider, name, api_key_encrypted, base_url, model, models, api_format)
     VALUES ($1, $2, $3, 'enc_dummy', $4, $5, $6::jsonb, $7) RETURNING id`,
    [userId, provider, `meta_${provider}_${stamp}_${createdProviderIds.length}`, baseUrl, model, JSON.stringify(models), apiFormat],
  )
  createdProviderIds.push(rows[0].id)
  return rows[0].id
}

const getSettings = (providerId) =>
  request(app).get(`/api/ai/model-settings?providerId=${providerId}`).set(auth)
const putSettings = (body) => request(app).put('/api/ai/model-settings').set(auth).send(body)

beforeAll(async () => {
  const mod = await import('../src/index.js')
  app = mod.app
  await ensureAuthUser(pool)
  auth = authHeaders()
})

afterAll(async () => {
  for (const id of createdProviderIds) {
    await pool.query('DELETE FROM ai_providers WHERE id = $1', [id]).catch(() => {})
  }
  for (const id of createdUserIds) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
  }
})

// ============================================================
// A. GET：无覆盖行时也要返回「内置预设值」
// ============================================================
describe('A. GET /api/ai/model-settings 无覆盖行返回内置预设', () => {
  it('模型集合 = model + models(jsonb)；每项带预设的上下文窗口与多模态能力', async () => {
    const providerId = await createProvider({ model: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini'] })
    const res = await getSettings(providerId)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const names = res.body.items.map((i) => i.model)
    expect(names).toContain('gpt-4o')
    expect(names).toContain('gpt-4o-mini')

    const item = res.body.items.find((i) => i.model === 'gpt-4o')
    expect(item.contextWindow).toBe(128000) // 预设（OpenAI 官方 gpt-4o 128k）
    expect(item.maxOutput).toBe(16384)
    expect(item.supportsText).toBe(true)
    expect(item.supportsImage).toBe(true) // 识图能力与文本分开配置
    expect(item.supportsVideo).toBe(false)
    expect(item.supportsAudio).toBe(false)
    expect(item.isPreset).toBe(true)
    expect(item.isOverridden).toBe(false)
    expect(REASONING_PROTOCOLS).toContain(item.reasoningProtocol)
  })

  it('推理协议预设：o 系/gpt-5 → openai_reasoning_effort；Claude → anthropic_thinking；step-explore → none', async () => {
    expect(resolveModelPreset('gpt-5').reasoningProtocol).toBe('openai_reasoning_effort')
    expect(resolveModelPreset('o3-mini').reasoningProtocol).toBe('openai_reasoning_effort')
    expect(resolveModelPreset('claude-3-5-sonnet-latest').reasoningProtocol).toBe('anthropic_thinking')
    expect(resolveModelPreset('qwen3-max').reasoningProtocol).toBe('qwen_enable_thinking')
    expect(resolveModelPreset('step-explore').reasoningProtocol).toBe('none')
    expect(resolveModelPreset('step-explore').reasoningEnabled).toBe(false)
    // 未命中预设：保守 inherit（沿用既有行为，绝不塞未知字段）
    expect(resolveModelPreset('totally-unknown-model-xyz').reasoningProtocol).toBe('inherit')
    expect(resolveModelPreset('totally-unknown-model-xyz').matched).toBe(false)
  })
})

// ============================================================
// B. PUT → GET → 查库：覆盖值生效且 isOverridden=true
// ============================================================
describe('B. PUT /api/ai/model-settings 覆盖预设并读回', () => {
  it('PUT 覆盖后 GET 返回覆盖值，isOverridden=true，且真的落库', async () => {
    const providerId = await createProvider({ model: 'gpt-4o' })
    const put = await putSettings({
      providerId,
      model: 'gpt-4o',
      patch: {
        contextWindow: 64000,
        maxOutput: 8192,
        supportsImage: true,
        supportsVideo: false,
        supportsAudio: false,
        reasoningEnabled: true,
        reasoningProtocol: 'openai_reasoning_effort',
        reasoningLevels: { low: 'minimal', medium: 'medium', high: 'high' },
      },
    })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(put.body.ok).toBe(true)
    expect(put.body.item.contextWindow).toBe(64000)
    expect(put.body.item.isOverridden).toBe(true)

    const res = await getSettings(providerId)
    const item = res.body.items.find((i) => i.model === 'gpt-4o')
    expect(item.contextWindow).toBe(64000)
    expect(item.maxOutput).toBe(8192)
    expect(item.supportsImage).toBe(true)
    expect(item.reasoningEnabled).toBe(true)
    expect(item.reasoningProtocol).toBe('openai_reasoning_effort')
    expect(item.reasoningLevels.low).toBe('minimal')
    expect(item.isOverridden).toBe(true)

    const row = await pool.query(
      'SELECT * FROM ai_model_settings WHERE provider_id = $1 AND model = $2',
      [providerId, 'gpt-4o'],
    )
    expect(row.rowCount).toBe(1)
    expect(row.rows[0].context_window).toBe(64000)
    expect(row.rows[0].reasoning_protocol).toBe('openai_reasoning_effort')
    expect(row.rows[0].reasoning_levels.low).toBe('minimal')
  })

  it('只改一个字段不会把其它字段打回 DEFAULT（避免 reasoning_enabled 被静默关掉）', async () => {
    const providerId = await createProvider({ provider: 'anthropic', model: 'claude-3-5-sonnet-latest' })
    const put = await putSettings({ providerId, model: 'claude-3-5-sonnet-latest', patch: { supportsImage: false } })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    // 预设里 claude 系默认 reasoningEnabled=true / anthropic_thinking / 200k 上下文，
    // 若写库只写单列，NOT NULL DEFAULT FALSE 会把思考开关静默关掉（本用例即回归护栏）
    expect(put.body.item.reasoningEnabled).toBe(true)
    expect(put.body.item.reasoningProtocol).toBe('anthropic_thinking')
    expect(put.body.item.contextWindow).toBe(200000)
    expect(put.body.item.supportsImage).toBe(false)

    // contextWindow=null 表示「清空覆盖，回退预设」
    const clear = await putSettings({ providerId, model: 'claude-3-5-sonnet-latest', patch: { contextWindow: null } })
    expect(clear.status).toBe(200)
    expect(clear.body.item.contextWindow).toBe(200000)
    const raw = await pool.query(
      'SELECT context_window FROM ai_model_settings WHERE provider_id = $1 AND model = $2',
      [providerId, 'claude-3-5-sonnet-latest'],
    )
    expect(raw.rows[0].context_window).toBeNull()
  })

  it('桌面端「恢复预设」提交的全 null patch 必须被接受并回退到预设值', async () => {
    // 与 src/desktop/src/api/modelSettings.ts 的 RESTORE_PRESET_PATCH 逐字段对齐
    const RESTORE_PRESET_PATCH = {
      contextWindow: null,
      maxOutput: null,
      supportsText: null,
      supportsImage: null,
      supportsVideo: null,
      supportsAudio: null,
      reasoningEnabled: null,
      reasoningProtocol: 'inherit',
      reasoningLevels: null,
    }
    const providerId = await createProvider({ provider: 'anthropic', model: 'claude-3-5-sonnet-latest' })
    // 先改脏
    const dirty = await putSettings({
      providerId,
      model: 'claude-3-5-sonnet-latest',
      patch: {
        contextWindow: 32000,
        maxOutput: 2048,
        supportsImage: false,
        supportsVideo: true,
        reasoningEnabled: false,
        reasoningProtocol: 'none',
        reasoningLevels: { high: 'x' },
      },
    })
    expect(dirty.status).toBe(200)
    expect(dirty.body.item.supportsVideo).toBe(true)

    const restored = await putSettings({ providerId, model: 'claude-3-5-sonnet-latest', patch: RESTORE_PRESET_PATCH })
    expect(restored.status, JSON.stringify(restored.body)).toBe(200)
    // 布尔/数值/等级回到预设；协议按桌面端选择回到 inherit
    expect(restored.body.item.contextWindow).toBe(200000)
    expect(restored.body.item.maxOutput).toBeNull()
    expect(restored.body.item.supportsText).toBe(true)
    expect(restored.body.item.supportsImage).toBe(true)
    expect(restored.body.item.supportsVideo).toBe(false)
    expect(restored.body.item.supportsAudio).toBe(false)
    expect(restored.body.item.reasoningEnabled).toBe(true)
    expect(restored.body.item.reasoningProtocol).toBe('inherit')
    expect(restored.body.item.reasoningLevels).toEqual({ low: 1024, medium: 4096, high: 8192 })

    // 单档 null = 清掉该档位的覆盖（回退预设值），不是 400。
    // 注意：生效值里的档位缺失时会用预设/同名档位补齐（anthropic 预设 low=1024），所以 low 仍在。
    const perKeyNull = await putSettings({
      providerId,
      model: 'claude-3-5-sonnet-latest',
      patch: { reasoningLevels: { low: null, high: '131072' } },
    })
    expect(perKeyNull.status, JSON.stringify(perKeyNull.body)).toBe(200)
    expect(perKeyNull.body.item.reasoningLevels).toEqual({ low: 1024, medium: 4096, high: '131072' })
  })

  it('用户覆盖值优先于 provider 级 context_window（模型级更具体）', async () => {
    const providerId = await createProvider({ model: 'gpt-4o' })
    await pool.query('UPDATE ai_providers SET context_window = 32000 WHERE id = $1', [providerId])
    const before = await loadEffectiveModelSettings({
      userId: TEST_USER_ID,
      providerId,
      model: 'gpt-4o',
    })
    expect(before.contextWindowFromRow).toBe(false)
    await putSettings({ providerId, model: 'gpt-4o', patch: { contextWindow: 96000 } })
    const after = await loadEffectiveModelSettings({
      userId: TEST_USER_ID,
      providerId,
      model: 'gpt-4o',
    })
    expect(after.contextWindowFromRow).toBe(true)
    expect(after.contextWindow).toBe(96000)
  })
})

// ============================================================
// C. 归属校验（IDOR）+ 数值边界
// ============================================================
describe('C. 归属校验与参数校验', () => {
  it('他人的 providerId：GET/PUT 一律 404，且写不进别人的行（IDOR）', async () => {
    const victim = await createUser('v')
    const victimProvider = await createProvider({ userId: victim, model: 'gpt-4o' })

    const get = await getSettings(victimProvider)
    expect([403, 404]).toContain(get.status)
    expect(get.status).toBe(404)

    const put = await putSettings({
      providerId: victimProvider,
      model: 'gpt-4o',
      patch: { contextWindow: 99999 },
    })
    expect([403, 404]).toContain(put.status)
    expect(put.status).toBe(404)

    const rows = await pool.query('SELECT 1 FROM ai_model_settings WHERE provider_id = $1', [victimProvider])
    expect(rows.rowCount).toBe(0)
  })

  it('不存在的 / 非法的 providerId → 404；缺 model → 400', async () => {
    const ghost = await getSettings('11111111-1111-1111-1111-111111111111')
    expect(ghost.status).toBe(404)

    const malformedGet = await getSettings('not-a-uuid')
    expect([403, 404]).toContain(malformedGet.status)

    const malformedPut = await putSettings({ providerId: 'not-a-uuid', model: 'gpt-4o', patch: {} })
    expect([403, 404]).toContain(malformedPut.status)

    const providerId = await createProvider({ model: 'gpt-4o' })
    const noModel = await putSettings({ providerId, patch: {} })
    expect(noModel.status).toBe(400)

    const blankModel = await putSettings({ providerId, model: '   ', patch: {} })
    expect(blankModel.status).toBe(400)
  })

  it('越界数值 / 非法枚举 / 非法类型 → 400；边界值 → 200', async () => {
    const providerId = await createProvider({ model: 'gpt-4o' })
    const bad = [
      { contextWindow: 1023 },
      { contextWindow: 2000001 },
      { contextWindow: 128000.5 },
      { contextWindow: '128000' },
      { maxOutput: 0 },
      { maxOutput: 200001 },
      { reasoningProtocol: 'bogus_protocol' },
      { supportsImage: 'yes' },
      { reasoningLevels: { ultra: 'x' } },
      { reasoningLevels: { low: {} } },
    ]
    for (const patch of bad) {
      const res = await putSettings({ providerId, model: 'gpt-4o', patch })
      expect(res.status, `patch=${JSON.stringify(patch)} body=${JSON.stringify(res.body)}`).toBe(400)
    }

    const okMin = await putSettings({ providerId, model: 'gpt-4o', patch: { contextWindow: 1024, maxOutput: 1 } })
    expect(okMin.status, JSON.stringify(okMin.body)).toBe(200)
    const okMax = await putSettings({
      providerId,
      model: 'gpt-4o',
      patch: { contextWindow: 2000000, maxOutput: 200000, reasoningProtocol: 'none' },
    })
    expect(okMax.status, JSON.stringify(okMax.body)).toBe(200)
    expect(okMax.body.item.reasoningProtocol).toBe('none')
  })
})

// ============================================================
// D. 核心：思考强度真的作用到推理参数（断言上游请求体，逐协议）
// ============================================================
const MSG = [{ role: 'user', content: 'hi' }]

describe('D. 思考强度 → 上游请求体（逐协议下发）', () => {
  it('openai_reasoning_effort：低/中/高分别产出 reasoning_effort 的对应值', async () => {
    const settings = mergeModelSettings('gpt-5', resolveModelPreset('gpt-5'), null)
    expect(settings.reasoningProtocol).toBe('openai_reasoning_effort')
    expect(settings.reasoningEnabled).toBe(true)

    const expected = { low: 'low', medium: 'medium', high: 'high' }
    for (const strength of ['low', 'medium', 'high']) {
      const reasoning = buildReasoningRequest({ settings, strength })
      expect(reasoning).toBeTruthy()
      const up = buildUpstreamChat({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-5',
        messages: MSG,
        options: { stream: false, thinking: true, thinkingStrength: strength, reasoning },
      })
      expect(up.body.reasoning_effort).toBe(expected[strength])
      // 不该顺手塞 Anthropic 的字段
      expect(up.body.thinking).toBeUndefined()
      expect(up.body.output_config).toBeUndefined()
    }
  })

  it('用户自定义等级映射（PUT 到库里）直接变成 reasoning_effort 的值', async () => {
    const providerId = await createProvider({ provider: 'openai', model: 'gpt-5' })
    const put = await putSettings({
      providerId,
      model: 'gpt-5',
      patch: {
        reasoningEnabled: true,
        reasoningProtocol: 'openai_reasoning_effort',
        reasoningLevels: { low: 'minimal', medium: 'medium', high: 'high' },
      },
    })
    expect(put.status, JSON.stringify(put.body)).toBe(200)

    // 从库里读回生效值（聊天链路 runChatLoop 用的就是这条路径）
    const settings = await loadEffectiveModelSettings({
      userId: TEST_USER_ID,
      providerId,
      model: 'gpt-5',
    })
    const reasoning = buildReasoningRequest({ settings, strength: 'low' })
    const up = buildUpstreamChat({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-5',
      messages: MSG,
      options: { stream: false, thinking: true, thinkingStrength: 'low', reasoning },
    })
    expect(up.body.reasoning_effort).toBe('minimal')
  })

  it('anthropic_thinking：低/中/高 → budget_tokens 1024/4096/8192', () => {
    const settings = mergeModelSettings('claude-3-5-sonnet-latest', resolveModelPreset('claude-3-5-sonnet-latest'), null)
    const expected = { low: 1024, medium: 4096, high: 8192 }
    for (const strength of ['low', 'medium', 'high']) {
      const reasoning = buildReasoningRequest({ settings, strength })
      const up = buildUpstreamChat({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-test',
        model: 'claude-3-5-sonnet-latest',
        messages: MSG,
        options: { stream: false, thinking: true, thinkingStrength: strength, reasoning },
      })
      expect(up.body.thinking).toEqual({ type: 'enabled', budget_tokens: expected[strength] })
      expect(up.body.reasoning_effort).toBeUndefined()
    }
  })

  it('output_config_effort（Anthropic 兼容网关）→ body.output_config.effort', () => {
    const settings = {
      reasoningEnabled: true,
      reasoningProtocol: 'output_config_effort',
      reasoningLevels: { low: 'low', medium: 'medium', high: 'high' },
    }
    const reasoning = buildReasoningRequest({ settings, strength: 'high' })
    const up = buildUpstreamChat({
      provider: 'custom',
      baseUrl: 'https://gateway.example.com/v1',
      apiFormat: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-20250514',
      messages: MSG,
      options: { stream: false, thinking: true, thinkingStrength: 'high', reasoning },
    })
    expect(up.family).toBe('anthropic')
    expect(up.body.output_config).toEqual({ effort: 'high' })
    expect(up.body.thinking).toBeUndefined()
  })

  it('qwen_enable_thinking → body.enable_thinking（qwen 供应商再带 thinking_budget）', () => {
    const settings = mergeModelSettings('qwen3-max', resolveModelPreset('qwen3-max'), null)
    expect(settings.reasoningProtocol).toBe('qwen_enable_thinking')
    const reasoning = buildReasoningRequest({ settings, strength: 'high' })
    const up = buildUpstreamChat({
      provider: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-test',
      model: 'qwen3-max',
      messages: MSG,
      options: { stream: false, thinking: true, thinkingStrength: 'high', reasoning },
    })
    expect(up.body.enable_thinking).toBe(true)
    expect(up.body.thinking_budget).toBe(8192)

    // 非 DashScope 的兼容网关：只发 enable_thinking，不塞它可能不认识的 thinking_budget
    const other = buildUpstreamChat({
      provider: 'custom',
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: 'sk-test',
      model: 'qwen3-max',
      messages: MSG,
      options: { stream: false, thinking: true, thinkingStrength: 'high', reasoning },
    })
    expect(other.body.enable_thinking).toBe(true)
    expect(other.body.thinking_budget).toBeUndefined()
  })

  it('Responses 协议：openai_reasoning_effort → reasoning.effort（Responses API 字段形态）', () => {
    const settings = mergeModelSettings('gpt-5', resolveModelPreset('gpt-5'), null)
    const reasoning = buildReasoningRequest({ settings, strength: 'medium' })
    const up = buildUpstreamChat({
      provider: 'custom',
      baseUrl: 'https://gateway.example.com/v1',
      apiFormat: 'responses',
      apiKey: 'sk-test',
      model: 'gpt-5',
      messages: MSG,
      options: { stream: false, thinking: true, thinkingStrength: 'medium', reasoning },
    })
    expect(up.family).toBe('responses')
    expect(up.body.reasoning).toEqual({ effort: 'medium' })
  })

  it('安全底线：none / inherit / 未开启 reasoning_enabled → 一个字都不许塞', () => {
    const forbidden = ['thinking', 'output_config', 'reasoning_effort', 'reasoning', 'enable_thinking', 'thinking_budget']
    const assertClean = (body, label) => {
      for (const k of forbidden) {
        expect(body[k], `${label} 不该出现字段 ${k}（body=${JSON.stringify(body)}）`).toBeUndefined()
      }
    }

    // ① step-explore：预设就是 none ⇒ 不产出任何推理参数，连 Anthropic 的 legacy 路径也关掉
    const stepSettings = mergeModelSettings('step-explore', resolveModelPreset('step-explore'), null)
    expect(buildReasoningRequest({ settings: stepSettings, strength: 'high' })).toBeNull()
    const stepOpts = buildThinkingOptions({ settings: stepSettings, enabled: true, strength: 'high' })
    expect(stepOpts.reasoning).toBeUndefined()
    expect(stepOpts.thinking).toBeUndefined()

    // ② 即便有人显式给 step-explore 传了协议，Anthropic 分支的硬闸门也必须拦住（官方文档明确不支持）
    const stepUp = buildUpstreamChat({
      provider: 'custom',
      baseUrl: 'https://gateway.example.com/v1',
      apiFormat: 'anthropic',
      apiKey: 'sk-test',
      model: 'step-explore',
      messages: MSG,
      options: {
        stream: false,
        thinking: true,
        thinkingStrength: 'high',
        thinkingBudget: 8192,
        reasoning: { protocol: 'output_config_effort', strength: 'high', value: 'high' },
      },
    })
    assertClean(stepUp.body, 'step-explore')

    // ③ protocol='none'（显式声明不支持）→ 调用方不产出 reasoning、也不置 thinking
    const noneSettings = {
      reasoningEnabled: true,
      reasoningProtocol: 'none',
      reasoningLevels: { low: 'low', medium: 'medium', high: 'high' },
    }
    expect(buildReasoningRequest({ settings: noneSettings, strength: 'high' })).toBeNull()
    const noneOpts = buildThinkingOptions({ settings: noneSettings, enabled: true, strength: 'high' })
    expect(noneOpts.reasoning).toBeUndefined()
    expect(noneOpts.thinking).toBeUndefined()
    const noneUp = buildUpstreamChat({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      messages: MSG,
      options: { stream: false, reasoning: { protocol: 'none', strength: 'high', value: 'high' }, ...noneOpts },
    })
    assertClean(noneUp.body, 'protocol=none')

    // ④ inherit（LongCat 等 OpenAI 兼容族）：沿用既有行为 —— 思考强度本就不下发，但绝不塞新字段
    const inheritSettings = mergeModelSettings('LongCat-Flash-Chat', resolveModelPreset('LongCat-Flash-Chat'), null)
    expect(inheritSettings.reasoningProtocol).toBe('inherit')
    expect(buildReasoningRequest({ settings: inheritSettings, strength: 'high' })).toBeNull()
    const inheritOpts = buildThinkingOptions({ settings: inheritSettings, enabled: true, strength: 'high' })
    expect(inheritOpts.thinking).toBe(true) // 沿用既有行为（Anthropic 族才会真正读它）
    expect(inheritOpts.reasoning).toBeUndefined()
    const longcatUp = buildUpstreamChat({
      provider: 'longcat',
      baseUrl: 'https://api.longcat.chat/openai',
      apiKey: 'sk-test',
      model: 'LongCat-Flash-Chat',
      messages: MSG,
      options: { stream: false, ...inheritOpts },
    })
    assertClean(longcatUp.body, 'inherit/longcat')

    // ⑤ 显式协议但 reasoning_enabled=false → 尊重「未开启」，不下发（legacy 路径也关掉）
    const offSettings = {
      reasoningEnabled: false,
      reasoningProtocol: 'anthropic_thinking',
      reasoningLevels: { low: 1024, medium: 4096, high: 8192 },
    }
    expect(buildReasoningRequest({ settings: offSettings, strength: 'high' })).toBeNull()
    const offOpts = buildThinkingOptions({ settings: offSettings, enabled: true, strength: 'high' })
    expect(offOpts.thinking).toBeUndefined()
    expect(offOpts.reasoning).toBeUndefined()
    const offUp = buildUpstreamChat({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet-latest',
      messages: MSG,
      options: { stream: false, ...offOpts },
    })
    assertClean(offUp.body, 'reasoning_enabled=false')

    // ⑥ 用户没开思考开关 → 也不下发
    const userOff = buildThinkingOptions({ settings: mergeModelSettings('gpt-5', resolveModelPreset('gpt-5'), null), enabled: false, strength: 'high' })
    expect(userOff.reasoning).toBeUndefined()
    expect(userOff.thinking).toBeUndefined()
  })

  it('回归：未传 options.reasoning 时 Anthropic 老调用方行为不变（thinking / output_config）', () => {
    const legacy = buildUpstreamChat({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet-latest',
      messages: MSG,
      options: { stream: false, thinking: true, thinkingStrength: 'high', thinkingBudget: 8192 },
    })
    expect(legacy.body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })

    const gateway = buildUpstreamChat({
      provider: 'stepfun-anthropic',
      baseUrl: 'https://api.stepfun.com/step_plan/v1',
      apiKey: 'sk-test',
      model: 'step-3.7-flash',
      messages: MSG,
      options: { stream: false, thinking: true, thinkingStrength: 'low', thinkingBudget: 1024 },
    })
    expect(gateway.body.output_config).toEqual({ effort: 'low' })
  })
})
