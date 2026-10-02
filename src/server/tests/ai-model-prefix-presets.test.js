/**
 * 聚合网关前缀的模型名归一化（预设 + 分类 + 内置窗口表）。
 *
 * 根因（用户实测）：本地聚合网关（one-api 类）的 `/v1/models` 返回的名字带厂商/路径前缀，
 * 预设正则与分类此前都拿**原文**匹配 ⇒ `cmdc/meta/muse-spark-1.1` / `cmd/xai/grok-4.5` /
 * `step/step-3.7-flash` / `step/stepaudio-2.5-chat` 一条都命中不了（卡片"无预设"、值全空）。
 *
 * 本文件用**用户给的真实名字**钉住：
 *   ① 逐级降级候选（原文 → 去前缀尾部 → 末段）的规则本身 → A 组
 *   ② 带前缀与去前缀的同一模型**逐字段同值**（预设对象 + API item 两层） → B/C 组
 *   ③ 分类保守性（前缀里的 voice 不许误判；tts/asr 在尾段才算 audio） → D 组
 *   ④ 无前缀名字零回归、陌生人名不误判、GET 与 resolve 两条路径都生效 → D/E 组
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import pool from '../src/db/pool.js'
import { authHeaders, ensureAuthUser, TEST_USER_ID } from './test-helpers.js'
import {
  modelNameCandidates,
  modelNameClassifyCandidates,
  matchesModelName,
  resolveModelPreset,
  classifyApplicability,
} from '../src/utils/modelPresets.js'
import { lookupBuiltinContextWindow, getContextWindow } from '../src/utils/aiProviders.js'

let app
let auth
const createdProviderIds = []
const stamp = Date.now().toString().slice(-6)

async function createProvider({ model = 'gpt-4o', models = [] } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ai_providers (user_id, provider, name, api_key_encrypted, base_url, model, models, api_format)
     VALUES ($1, 'custom', $2, 'enc_dummy', 'http://127.0.0.1:9/v1', $3, $4::jsonb, 'openai') RETURNING id`,
    [TEST_USER_ID, `prefix_${stamp}_${createdProviderIds.length}`, model, JSON.stringify(models)],
  )
  createdProviderIds.push(rows[0].id)
  return rows[0].id
}

const resolveModels = (body) => request(app).post('/api/ai/model-settings/resolve').set(auth).send(body)

/** 除 model 名外的所有字段（用于"带前缀 vs 不带前缀逐字段同值"断言） */
function fieldsExceptModel(item) {
  const { model, ...rest } = item
  return rest
}

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
})

// ============================================================
// A. 归一化规则本身
// ============================================================
describe('A. 模型名逐级降级候选', () => {
  it('逐级去前缀：原文 → 去首段尾部 → 末段（保序去重）', () => {
    expect(modelNameCandidates('cmdc/meta/muse-spark-1.1')).toEqual([
      'cmdc/meta/muse-spark-1.1',
      'meta/muse-spark-1.1',
      'muse-spark-1.1',
    ])
    expect(modelNameCandidates('cmd/xai/grok-4.5')).toEqual(['cmd/xai/grok-4.5', 'xai/grok-4.5', 'grok-4.5'])
    expect(modelNameCandidates('step/step-3.7-flash')).toEqual(['step/step-3.7-flash', 'step-3.7-flash'])
    // 无前缀：候选就是它自己（既有行为不变）
    expect(modelNameCandidates('stepaudio-2.5-tts')).toEqual(['stepaudio-2.5-tts'])
    expect(modelNameCandidates('  gpt-4o  ')).toEqual(['gpt-4o'])
    expect(modelNameCandidates('')).toEqual([])
    expect(modelNameCandidates(null)).toEqual([])
    // ':' 也算分隔符（网关 provider:model 写法）
    expect(modelNameCandidates('azure:gpt-4o')).toEqual(['azure:gpt-4o', 'gpt-4o'])
    // 去重（大小写不敏感）
    expect(modelNameCandidates('gpt-4o/GPT-4O')).toEqual(['gpt-4o/GPT-4O', 'GPT-4O'])
  })

  it('分类候选更保守：带 "/" 时不用原文（防前缀厂商词误判），不带 "/" 时尾段优先、原文兜底', () => {
    expect(modelNameClassifyCandidates('my-voice-gateway/gpt-4o')).toEqual(['gpt-4o'])
    expect(modelNameClassifyCandidates('cmdc/meta/muse-spark-1.1')).toEqual(['meta/muse-spark-1.1', 'muse-spark-1.1'])
    // Ollama 标签写法：':' 是标签不是前缀 ⇒ 原文必须在候选里（否则 bge-m3:latest 会丢 embedding 判定）
    expect(modelNameClassifyCandidates('bge-m3:latest')).toEqual(['latest', 'bge-m3:latest'])
    expect(modelNameClassifyCandidates('whisper-1')).toEqual(['whisper-1'])
    expect(modelNameClassifyCandidates('')).toEqual([])
  })

  it('matchesModelName：可指定 tailOnly（分类口径）', () => {
    expect(matchesModelName('step/step-explore', /^step-explore/i)).toBe(true)
    expect(matchesModelName('vendor:step-explore', /step-explore/i)).toBe(true)
    expect(matchesModelName('my-voice-gateway/gpt-4o', /voice/i, { tailOnly: true })).toBe(false)
    expect(matchesModelName('my-voice-gateway/gpt-4o', /voice/i)).toBe(true) // 原文命中（预设口径允许）
  })
})

// ============================================================
// B. 真实名字命中预设 + 与去前缀版本逐字段同值（预设对象层）
// ============================================================
describe('B. 真实（带前缀）模型名命中预设，且与去前缀版本同值', () => {
  const pairs = [
    ['cmdc/meta/muse-spark-1.1', 'muse-spark-1.1'],
    ['cmdc/meta/muse-spark-1.2-contributor', 'muse-spark-1.2-contributor'],
    ['cmd/xai/grok-4.5', 'grok-4.5'],
    ['cmd/xai/grok-4.6', 'grok-4.6'],
    ['step/step-3.7-flash', 'step-3.7-flash'],
    ['step/stepaudio-2.5-chat', 'stepaudio-2.5-chat'],
  ]

  it('① 四个指定名字（含 muse/grok/step/stepaudio）都 isPreset=true', () => {
    for (const name of ['cmdc/meta/muse-spark-1.1', 'cmd/xai/grok-4.5', 'step/step-3.7-flash', 'step/stepaudio-2.5-chat']) {
      const p = resolveModelPreset(name)
      expect(p.matched, `${name} 应命中预设`).toBe(true)
      expect(p.note).toBeTruthy()
    }
  })

  it('② 带前缀 vs 去前缀：预设对象逐字段完全一致（含 ruleId/协议/窗口/多模态）', () => {
    for (const [prefixed, bare] of pairs) {
      const a = resolveModelPreset(prefixed)
      const b = resolveModelPreset(bare)
      expect(a, `${prefixed} 应与 ${bare} 同预设`).toEqual(b)
      expect(a.contextWindow).toBe(b.contextWindow)
      expect(a.reasoningProtocol).toBe(b.reasoningProtocol)
      expect(a.supportsImage).toBe(b.supportsImage)
      expect(a.supportsAudio).toBe(b.supportsAudio)
      expect(a.ruleId).toBe(b.ruleId)
    }
  })

  it('③ 既有规则值未被改动（抽查已知模型）', () => {
    expect(resolveModelPreset('gpt-4o').contextWindow).toBe(128000)
    expect(resolveModelPreset('gpt-4o').maxOutput).toBe(16384)
    expect(resolveModelPreset('step-explore').reasoningProtocol).toBe('none')
    expect(resolveModelPreset('step-explore').contextWindow).toBe(1000000)
    expect(resolveModelPreset('claude-3-5-sonnet-latest').reasoningProtocol).toBe('anthropic_thinking')
    expect(resolveModelPreset('step-3.5-flash').ruleId).toBe('step-any')
    expect(resolveModelPreset('step-3.5-flash').contextWindow).toBe(32768)
  })

  it('④ 内置窗口表同样逐级降级（带前缀与不带前缀同值）', () => {
    expect(lookupBuiltinContextWindow('step/step-3.7-flash')).toBe(32768)
    expect(lookupBuiltinContextWindow('cmd/x/qwen3-max')).toBe(131072) // 预设窗口为空 ⇒ 靠内置表
    expect(lookupBuiltinContextWindow('qwen3-max')).toBe(131072)
    expect(getContextWindow('cmd/x/qwen3-max')).toBe(131072)
    // 未知名字仍然 null / 兜底 128000（不放宽）
    expect(lookupBuiltinContextWindow('foo/bar-unknown')).toBeNull()
    expect(getContextWindow('foo/bar-unknown')).toBe(128000)
  })
})

// ============================================================
// C. API item 层：resolve 与 GET 两条路径都生效
// ============================================================
describe('C. item 级：resolve 与 GET 都能拿到预设，且前缀不改变任何字段', () => {
  const PAIRS = [
    ['cmdc/meta/muse-spark-1.1', 'muse-spark-1.1'],
    ['cmd/xai/grok-4.5', 'grok-4.5'],
    ['step/step-3.7-flash', 'step-3.7-flash'],
    ['step/stepaudio-2.5-chat', 'stepaudio-2.5-chat'],
    ['cmd/x/qwen3-max', 'qwen3-max'],
  ]

  it('POST /resolve（草稿态路径）：带前缀与去前缀 **除模型名外逐字段相等**', async () => {
    const models = PAIRS.flat()
    const res = await resolveModels({ models })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const by = Object.fromEntries(res.body.items.map((i) => [i.model, i]))
    for (const [prefixed, bare] of PAIRS) {
      expect(by[prefixed], `${prefixed} 应出现在 items`).toBeTruthy()
      expect(by[bare], `${bare} 应出现在 items`).toBeTruthy()
      expect(fieldsExceptModel(by[prefixed]), `${prefixed} vs ${bare}`).toEqual(fieldsExceptModel(by[bare]))
      expect(by[prefixed].isPreset, `${prefixed} isPreset`).toBe(true)
      expect(by[prefixed].contextWindow).toBe(by[bare].contextWindow)
    }
  })

  it('GET /api/ai/model-settings（已保存路径）：同样命中预设且与 resolve 同值', async () => {
    const models = PAIRS.flat()
    const providerId = await createProvider({ model: models[0], models })
    const viaGet = await request(app).get(`/api/ai/model-settings?providerId=${providerId}`).set(auth)
    expect(viaGet.status).toBe(200)
    const viaResolve = await resolveModels({ models })
    expect(viaResolve.status).toBe(200)

    const getBy = Object.fromEntries(viaGet.body.items.map((i) => [i.model, i]))
    const resBy = Object.fromEntries(viaResolve.body.items.map((i) => [i.model, i]))
    for (const name of models) {
      expect(getBy[name], `GET 应包含 ${name}`).toBeTruthy()
      expect(getBy[name].isPreset, `GET 里 ${name} 应命中预设`).toBe(true)
      expect(getBy[name]).toEqual(resBy[name])
    }
    for (const [prefixed, bare] of PAIRS) {
      expect(fieldsExceptModel(getBy[prefixed])).toEqual(fieldsExceptModel(getBy[bare]))
    }
  })
})

// ============================================================
// D. 分类：真实名字 + 保守性 + 回归
// ============================================================
describe('D. classifyApplicability 与预设一致、前缀不误判', () => {
  it('audio 类：tts/asr 在尾段才算；stepaudio 的 audio 语义来自模型名本身', () => {
    expect(classifyApplicability('stepaudio-2.5-tts')).toBe('audio')
    expect(classifyApplicability('cmdc/meta/xxx-tts')).toBe('audio')
    expect(classifyApplicability('step/stepaudio-2.5-chat')).toBe('audio')
    expect(classifyApplicability('gateway/fun-asr')).toBe('audio')
    expect(classifyApplicability('gateway/whisper-1')).toBe('audio')
  })

  it('保守性：路径前缀里的厂商描述词**不许**参与判定', () => {
    expect(classifyApplicability('my-voice-gateway/gpt-4o')).toBe('chat')
    expect(classifyApplicability('audio-router/deepseek-chat')).toBe('chat')
    expect(classifyApplicability('speech-proxy/claude-3-5-sonnet-latest')).toBe('chat')
    // 但尾段命中就该判 audio/embedding
    expect(classifyApplicability('my-gateway/tts-1')).toBe('audio')
    expect(classifyApplicability('my-gateway/bge-m3')).toBe('embedding')
    // ':' 标签写法不回归（原文本就是模型名）
    expect(classifyApplicability('bge-m3:latest')).toBe('embedding')
    expect(classifyApplicability('whisper-1:latest')).toBe('audio')
  })

  it('无前缀名字的分类与改造前完全一致（回归）', () => {
    expect(classifyApplicability('gpt-4o')).toBe('chat')
    expect(classifyApplicability('qwen-vl-max')).toBe('chat') // 视觉"理解"型仍属 chat
    expect(classifyApplicability('whisper-1')).toBe('audio')
    expect(classifyApplicability('text-embedding-3-small')).toBe('embedding')
    expect(classifyApplicability('dall-e-3')).toBe('image')
    expect(classifyApplicability('LongCat-Flash-Chat')).toBe('chat')
    expect(classifyApplicability('')).toBe('chat')
  })

  it('陌生人名（带/不带前缀）都不误判：isPreset=false + chat', () => {
    for (const name of ['foo/bar-unknown', 'bar-unknown', 'dy/Agents-A1', 'atria/Atria-Dawn-Preview']) {
      const p = resolveModelPreset(name)
      expect(p.matched, name).toBe(false)
      expect(classifyApplicability(name), name).toBe('chat')
    }
    // 前后缀都不影响结论：dy/Agents-A1 与 Agents-A1 同结论
    expect(resolveModelPreset('dy/Agents-A1').matched).toBe(resolveModelPreset('Agents-A1').matched)
    expect(classifyApplicability('dy/Agents-A1')).toBe(classifyApplicability('Agents-A1'))
  })

  it('预设与分类不矛盾：命中 stepaudio 规则的模型一定是 audio', () => {
    for (const name of ['stepaudio-2.5-tts', 'stepaudio-2.5-chat', 'step/stepaudio-2.5-chat', 'step/stepaudio-2.5-tts']) {
      const p = resolveModelPreset(name)
      expect(p.matched, name).toBe(true)
      expect(p.ruleId, name).toBe('stepaudio')
      expect(p.supportsAudio, name).toBe(true)
      expect(classifyApplicability(name), name).toBe('audio')
    }
  })
})

// ============================================================
// E. 聊天链路：step-explore 硬闸门也要认前缀
// ============================================================
describe('E. 前缀归一化在请求体侧同样生效（step-explore 硬闸门）', () => {
  it('带前缀的 step-explore 也不会被塞 thinking/output_config（否则上游 400）', async () => {
    const { buildUpstreamChat } = await import('../src/utils/aiProviders.js')
    for (const model of ['step-explore', 'step/step-explore', 'vendor:step-explore']) {
      const up = buildUpstreamChat({
        provider: 'custom',
        baseUrl: 'https://gateway.example.com/v1',
        apiFormat: 'anthropic',
        apiKey: 'sk-test',
        model,
        messages: [{ role: 'user', content: 'ping' }],
        options: {
          stream: false,
          thinking: true,
          thinkingStrength: 'high',
          thinkingBudget: 8192,
          reasoning: { protocol: 'output_config_effort', strength: 'high', value: 'high' },
        },
      })
      expect(up.body.thinking, model).toBeUndefined()
      expect(up.body.output_config, model).toBeUndefined()
    }
  })
})
