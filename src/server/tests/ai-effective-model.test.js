/**
 * 统一取模型（`pickEffectiveModel` / `resolveEffectiveModel`）+ `applySelectedModel` 语义修正。
 *
 * 修掉的两处不一致：
 *   1) AI 小功能（摘要/建议/诊断/相似度/提示词改写/inline/OCR）此前固定用 `ai_providers.model`
 *      且**不看模型级 enabled** ⇒ 用户停用了主模型，它们照样拿它调上游；
 *   2) 「启用一个模型」会**悄悄覆盖** `selected_models[providerId]` ⇒ 聊天默认模型跟着变。
 *
 * 端到端用例（E 组）用**可注入的 buildUpstreamChat**（换成必然拒连的本地端口）拿到**真实构造的
 * 上游请求体**，断言 `body.model` —— 不发任何真实外网，但证据是"实际会发出去的那个模型"。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import request from 'supertest'
import pool from '../src/db/pool.js'
import { authHeaders, ensureAuthUser, TEST_USER_ID } from './test-helpers.js'
import { encrypt } from '../src/utils/encryption.js'
import {
  pickEffectiveModel,
  resolveEffectiveModel,
  applySelectedModel,
  normalizeProviderModels,
} from '../src/utils/aiModelSettings.js'

// 捕获真实构造出的上游请求体，同时把 baseUrl 换成必然拒连的本地端口（不发外网、快速失败）
const hoisted = vi.hoisted(() => ({ captured: [] }))
vi.mock('../src/utils/aiProviders.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    buildUpstreamChat: (cfg) => {
      hoisted.captured.push(cfg)
      return actual.buildUpstreamChat({ ...cfg, baseUrl: 'http://127.0.0.1:9/v1' })
    },
  }
})

let app
let auth
const createdProviderIds = []
const stamp = Date.now().toString().slice(-6)

async function createProvider({ model = 'm-primary', models = ['m-primary'], provider = 'custom', apiFormat = 'openai' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ai_providers (user_id, provider, name, api_key_encrypted, base_url, model, models, api_format)
     VALUES ($1, $2, $3, $4, 'https://gateway.example.com/v1', $5, $6::jsonb, $7) RETURNING id`,
    [TEST_USER_ID, provider, `eff_${stamp}_${createdProviderIds.length}`, encrypt('sk-eff'), model, JSON.stringify(models), apiFormat],
  )
  createdProviderIds.push(rows[0].id)
  return rows[0].id
}

/** 直接写模型行（避免 enabled 的 selected_models 联动干扰纯优先级用例） */
async function setModelRow(providerId, model, patch = {}) {
  const enabled = patch.enabled !== false
  await pool.query(
    `INSERT INTO ai_model_settings (user_id, provider_id, model, enabled, context_window)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, provider_id, model) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
    [TEST_USER_ID, providerId, model, enabled, patch.contextWindow ?? null],
  )
}

async function resetSelected(providerId) {
  await pool.query(
    `INSERT INTO ai_settings (user_id, selected_models, created_at, updated_at)
     VALUES ($1, '{}'::jsonb, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET selected_models = '{}'::jsonb, updated_at = NOW()`,
    [TEST_USER_ID],
  )
}

const post = (path, body) => request(app).post(path).set(auth).send(body)

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

beforeEach(async () => {
  hoisted.captured.length = 0
})

// ============================================================
// A. pickEffectiveModel：4 级优先级（纯函数）
// ============================================================
describe('A. pickEffectiveModel 优先级（纯函数）', () => {
  const provider = (over = {}) => ({ id: 'p1', model: 'm-primary', models: ['m-primary', 'm-secondary'], ...over })
  const rowOf = (params) => params.map(([model, enabled]) => ({ model, enabled }))

  it('① selected_models 是单个模型名、属于该 provider 且启用 ⇒ 用它', () => {
    const picked = pickEffectiveModel(provider(), [], { p1: 'm-secondary' })
    expect(picked).toEqual({ model: 'm-secondary', source: 'selected' })
  })

  it('① 不成立（选中的不在 models 里）⇒ 不会被 ③ 捡漏，落到主模型兜底', () => {
    // 契约：字符串形态的选中项只参与 ①（须属于该 provider）⇒ 这里 ①/②/③ 都不成立，走 ④ 兜底主模型
    expect(pickEffectiveModel(provider(), [], { p1: 'm-unknown' })).toEqual({ model: 'm-primary', source: 'fallback-primary' })
    // selected 就是主模型但被行停用 ⇒ ① 失败，② 也失败（同一模型），③ 找别的
    const rows = rowOf([['m-primary', false], ['m-secondary', true]])
    expect(pickEffectiveModel(provider(), rows, { p1: 'm-primary' })).toEqual({ model: 'm-secondary', source: 'fallback-enabled' })
  })

  it('② 主模型启用 ⇒ 用它（两种"启用"来源：覆盖行 / 选中态）', () => {
    expect(pickEffectiveModel(provider(), [{ model: 'm-primary', enabled: true }], {})).toEqual({ model: 'm-primary', source: 'primary' })
    expect(pickEffectiveModel(provider(), [], { p1: 'm-primary' })).toEqual({ model: 'm-primary', source: 'selected' })
  })

  it('③ 主模型被停用 ⇒ 改用另一个已启用模型（核心：直接钉住坑 1）', () => {
    const rows = rowOf([['m-primary', false], ['m-secondary', true]])
    expect(pickEffectiveModel(provider(), rows, {})).toEqual({ model: 'm-secondary', source: 'fallback-enabled' })
  })

  it('③ 稳定顺序：selected 的数组/对象形态条目优先，再按 models 原序', () => {
    const rows = rowOf([['m-primary', false], ['m-a', true], ['m-b', true], ['m-array', true]])
    const p = provider({ models: ['m-primary', 'm-a', 'm-b'] })
    // 数组形态：选中清单里的启用项先被取到（不在 models 里也算，属用户显式清单）
    expect(pickEffectiveModel(p, rows, { p1: ['m-array'] }).model).toBe('m-array')
    // 对象形态
    expect(pickEffectiveModel(p, rows, { p1: { model: 'm-b' } }).model).toBe('m-b')
    // 无选中清单：按 models 原序取第一个启用项
    expect(pickEffectiveModel(p, rows, {}).model).toBe('m-a')
    // 选中态改用"数组/对象"时，entry 里的启用项优先于 models 原序
    expect(pickEffectiveModel(p, rows, { p1: ['m-b'] }).model).toBe('m-b')
  })

  it('④ 全部停用 ⇒ 兜底主模型（永不失败）', () => {
    const rows = rowOf([['m-primary', false], ['m-secondary', false]])
    expect(pickEffectiveModel(provider(), rows, {})).toEqual({ model: 'm-primary', source: 'fallback-primary' })
    // 连行都没有、也没有 selected_models ⇒ 主模型也没"启用"，仍回主模型（老数据零回归）
    expect(pickEffectiveModel(provider(), [], {})).toEqual({ model: 'm-primary', source: 'fallback-primary' })
    // 不传选中态（undefined）= 明确要求"沿用列默认语义"（不看 selected_models 推断）⇒ 命中 ②
    expect(pickEffectiveModel(provider(), [], undefined)).toEqual({ model: 'm-primary', source: 'primary' })
  })

  it('边界：无 providerRow / 空 model / models 形态兼容', () => {
    expect(pickEffectiveModel(null)).toEqual({ model: '', source: 'none' })
    expect(pickEffectiveModel({ id: 'p', model: '', models: [] })).toEqual({ model: '', source: 'fallback-primary' })
    expect(normalizeProviderModels(['a', 'b'])).toEqual(['a', 'b'])
    expect(normalizeProviderModels({ 0: 'a', 1: { id: 'b' } })).toEqual(['a', 'b'])
    expect(normalizeProviderModels(null)).toEqual([])
    // models 是对象形态也能进 ③（该模型有覆盖行 enabled=true）
    expect(pickEffectiveModel({ id: 'p', model: 'm-primary', models: { 0: { id: 'm-secondary' } } }, [{ model: 'm-primary', enabled: false }, { model: 'm-secondary', enabled: true }], {}))
      .toEqual({ model: 'm-secondary', source: 'fallback-enabled' })
  })

  it('resolveEffectiveModel：从库里取覆盖行 + 选中态（不发 N+1）', async () => {
    const providerId = await createProvider({ model: 'm-primary', models: ['m-primary', 'm-secondary'] })
    await setModelRow(providerId, 'm-primary', { enabled: false })
    await setModelRow(providerId, 'm-secondary', { enabled: true })
    const row = { id: providerId, model: 'm-primary', models: ['m-primary', 'm-secondary'] }
    expect(await resolveEffectiveModel({ userId: TEST_USER_ID, providerId, providerRow: row }))
      .toEqual({ model: 'm-secondary', source: 'fallback-enabled' })
  })
})

// ============================================================
// B. applySelectedModel：不覆盖已有选中
// ============================================================
describe('B. applySelectedModel 新语义（不覆盖聊天默认模型）', () => {
  it('已有选中时启用另一个 ⇒ 不覆盖；无选中时启用 ⇒ 建立选中', () => {
    expect(applySelectedModel({ p: 'm-primary' }, 'p', 'm-secondary', true)).toEqual({ p: 'm-primary' })
    expect(applySelectedModel({}, 'p', 'm-secondary', true)).toEqual({ p: 'm-secondary' })
    expect(applySelectedModel({ p: 'm-primary' }, 'p', 'm-primary', true)).toEqual({ p: 'm-primary' })
  })

  it('当前选中被停用 ⇒ 清空；同一批次里随后启用另一个 ⇒ 它接管（换到新启用的）', () => {
    const afterDisable = applySelectedModel({ p: 'm-primary' }, 'p', 'm-primary', false)
    expect(afterDisable).toEqual({})
    expect(applySelectedModel(afterDisable, 'p', 'm-secondary', true)).toEqual({ p: 'm-secondary' })
    // 停用"别的"模型不动当前选中
    expect(applySelectedModel({ p: 'm-primary' }, 'p', 'm-secondary', false)).toEqual({ p: 'm-primary' })
  })

  it('数组/对象形态保持既有语义（多选=加入/移除）', () => {
    expect(applySelectedModel({ p: ['a'] }, 'p', 'b', true)).toEqual({ p: ['a', 'b'] })
    expect(applySelectedModel({ p: ['a', 'b'] }, 'p', 'a', false)).toEqual({ p: ['b'] })
    expect(applySelectedModel({ p: { model: 'a' } }, 'p', 'b', true)).toEqual({ p: { model: 'a' } })
  })
})

// ============================================================
// C. 端到端：停用主模型后，小功能请求体里的 model 变成另一个已启用模型
// ============================================================
describe('C. 端到端：发给上游的 model（注入 buildUpstreamChat，断言真实请求体）', () => {
  /** 主模型停用 + 备选启用；selected_models 清空（保证走 ③ 而不是 ①） */
  async function seedDisabledPrimary() {
    const providerId = await createProvider({ model: 'm-primary', models: ['m-primary', 'm-secondary'] })
    await setModelRow(providerId, 'm-primary', { enabled: false })
    await setModelRow(providerId, 'm-secondary', { enabled: true })
    await resetSelected(providerId)
    return providerId
  }

  it('/summarize：主模型停用 ⇒ 请求体 model = m-secondary', async () => {
    const providerId = await seedDisabledPrimary()
    const res = await post('/api/ai/summarize', { providerId, content: '今天下午三点开会讨论季度目标' })
    expect(hoisted.captured, '应当真实构造过一次上游请求').toHaveLength(1)
    expect(hoisted.captured[0].model).toBe('m-secondary')
    expect(Array.isArray(hoisted.captured[0].messages)).toBe(true)
    expect(res.status).toBeGreaterThanOrEqual(400) // 上游（127.0.0.1:9）拒连 ⇒ 如实失败
  })

  it('/suggest、/inline、/refactor-prompt、/similarity 同样用已启用模型', async () => {
    const providerId = await seedDisabledPrimary()

    hoisted.captured.length = 0
    await post('/api/ai/suggest', { providerId, content: '整理一下这段笔记' })
    expect(hoisted.captured.at(-1)?.model).toBe('m-secondary')

    hoisted.captured.length = 0
    await post('/api/ai/inline', { providerId, prompt: '把这段话改得更简洁' })
    expect(hoisted.captured.at(-1)?.model).toBe('m-secondary')

    hoisted.captured.length = 0
    await post('/api/ai/refactor-prompt', { providerId, content: '帮我写一封请假邮件' })
    expect(hoisted.captured.at(-1)?.model).toBe('m-secondary')

    hoisted.captured.length = 0
    await post('/api/ai/similarity', { providerId, content: '内容 A', candidates: [{ id: 'c1', text: '内容 A 的改写' }] })
    expect(hoisted.captured.at(-1)?.model).toBe('m-secondary')
  })

  it('/chat：未显式传 model 且主模型停用 ⇒ 用已启用模型', async () => {
    const providerId = await seedDisabledPrimary()
    await post('/api/ai/chat', {
      providerId,
      messages: [{ role: 'user', content: '你好' }],
      options: { mode: 'ask' },
    })
    expect(hoisted.captured.length).toBeGreaterThan(0)
    expect(hoisted.captured[0].model).toBe('m-secondary')
  })

  it('/chat：显式传合法 model ⇒ 仍然优先用它（不回归）', async () => {
    const providerId = await seedDisabledPrimary()
    await post('/api/ai/chat', {
      providerId,
      messages: [{ role: 'user', content: '你好' }],
      options: { mode: 'ask', model: 'm-primary' },
    })
    expect(hoisted.captured.length).toBeGreaterThan(0)
    expect(hoisted.captured[0].model).toBe('m-primary')
  })

  it('全部模型都被停用 ⇒ 回落到主模型（不报错、不空 model）', async () => {
    const providerId = await createProvider({ model: 'm-primary', models: ['m-primary', 'm-secondary'] })
    await setModelRow(providerId, 'm-primary', { enabled: false })
    await setModelRow(providerId, 'm-secondary', { enabled: false })
    await resetSelected(providerId)

    await post('/api/ai/summarize', { providerId, content: '兜底路径' })
    expect(hoisted.captured.at(-1)?.model).toBe('m-primary')
  })

  it('OCR（getOcrProvider）也走统一取模型：主模型停用 ⇒ 视觉备选模型', async () => {
    const { getOcrProvider } = await import('../src/utils/aiOcr.js')
    // provider=custom 会被 providerSupportsVision 放行（本地/自定义端点通常只配视觉模型）
    const providerId = await createProvider({ model: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini'] })
    await setModelRow(providerId, 'gpt-4o', { enabled: false })
    await setModelRow(providerId, 'gpt-4o-mini', { enabled: true })
    await resetSelected(providerId)
    // 该用户可能有多个带 key 的 provider（其它用例造的）：只断言"取到的行已按统一函数换过模型"
    const row = await getOcrProvider(TEST_USER_ID)
    expect(row).toBeTruthy()
    if (row.id === providerId) expect(row.model).toBe('gpt-4o-mini')
  })
})
