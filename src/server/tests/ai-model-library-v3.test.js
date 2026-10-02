/**
 * 模型库契约 v3（迁移 083）回归测试。
 *
 * 覆盖需求六条：
 *   ① 新列（enabled / alias / sort_order）读写 + 校验 → A/B 组
 *   ② enabled ↔ ai_settings.selected_models 联动（**同一事务**）+ IDOR 404 → C 组
 *   ③ 「刷新绝不覆盖用户配置」两条事实（核实结论见 D 组注释） → D 组
 *   ④ classifyApplicability 各类正则 → E 组
 *   ⑤ probe 三条路径（成功 / 参数不支持→去掉后成功+suggestedProtocol / 两次失败保留上游错误）
 *      —— 用可注入 fetch，**不发任何真实外网** → F 组
 *   ⑥ probe 限流与鉴权 → G 组
 *
 * 刷新事实的**读码结论**（本文件把它钉成不可回退的回归测试）：
 *   · GET  /api/ai/providers/:id/models  → **只在上游返回结构合法数组时**才
 *     `UPDATE ai_providers SET models = …`（上游失败 / 解析不出模型数组一律**不改库**；
 *      本轮用户实测缺陷修复：旧实现的"无条件写回"会一次网络抖动就清空已存列表）
 *   · POST /api/ai/providers/fetch-models → **完全不写库**（route:302「不落地、不写库」）
 *   · PUT  /api/ai/providers/:id         → 写 ai_providers.models（用户显式保存，非刷新）
 *   · 全仓 `ai_model_settings` 的**唯一写入点**就是 PUT /api/ai/model-settings
 *     ⇒ 刷新结构上不可能覆盖模型级配置，也不可能复活 enabled=false 的模型。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import request from 'supertest'
import pool from '../src/db/pool.js'
import { authHeaders, ensureAuthUser, TEST_USER_ID } from './test-helpers.js'
import { encrypt } from '../src/utils/encryption.js'
import {
  classifyApplicability,
  APPLICABILITY_KINDS,
} from '../src/utils/modelPresets.js'
import { applySelectedModel } from '../src/utils/aiModelSettings.js'
import { setProbeFetchImpl, resetProbeFetchImpl } from '../src/utils/modelProbe.js'
import { setModelsFetchImpl, resetModelsFetchImpl } from '../src/utils/aiProviders.js'

let app
let auth
let probeUserId
let probeAuth
const createdProviderIds = []
const createdUserIds = []
const stamp = Date.now().toString().slice(-6)

let userSeq = 0
async function createUser(suffix, phonePrefix = '1392') {
  // 11 位手机号：前缀(4) + 序号(3) + 时间戳尾(4) —— 必须把序号塞进 11 位内，否则 slice 会把
  // suffix 截掉导致同一个号码撞 users_phone_key（首版就踩了这个坑）
  userSeq += 1
  const phone = `${phonePrefix}${String(userSeq).padStart(3, '0')}${stamp.slice(-4)}`.slice(0, 11)
  const { rows } = await pool.query(
    `INSERT INTO users (phone, password_hash, nickname, created_at, updated_at)
     VALUES ($1, 'test_hash', $2, NOW(), NOW()) RETURNING id`,
    [phone, `v3_${suffix}_${stamp}`],
  )
  createdUserIds.push(rows[0].id)
  return { id: rows[0].id, phone }
}

async function createProvider({
  userId = TEST_USER_ID,
  provider = 'custom',
  model = 'gpt-4o',
  models = [],
  apiFormat = 'openai',
  baseUrl = 'http://127.0.0.1:9/v1',
  apiKey = null,
} = {}) {
  const key = apiKey ? encrypt(apiKey) : 'enc_dummy'
  const { rows } = await pool.query(
    `INSERT INTO ai_providers (user_id, provider, name, api_key_encrypted, base_url, model, models, api_format)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id`,
    [userId, provider, `v3_${provider}_${stamp}_${createdProviderIds.length}`, key, baseUrl, model, JSON.stringify(models), apiFormat],
  )
  createdProviderIds.push(rows[0].id)
  return rows[0].id
}

const getSettings = (providerId, headers = auth) =>
  request(app).get(`/api/ai/model-settings?providerId=${providerId}`).set(headers)
const putSettings = (body, headers = auth) =>
  request(app).put('/api/ai/model-settings').set(headers).send(body)
const probe = (body = {}, headers = probeAuth) =>
  request(app).post('/api/ai/model-settings/probe').set(headers).send(body)

async function readSelected(userId) {
  const { rows } = await pool.query('SELECT selected_models FROM ai_settings WHERE user_id = $1', [userId])
  return rows[0]?.selected_models || null
}

async function readRow(providerId, model) {
  const { rows } = await pool.query(
    'SELECT * FROM ai_model_settings WHERE provider_id = $1 AND model = $2',
    [providerId, model],
  )
  return rows[0] || null
}

/** 可注入的假上游（不发真实外网）：按顺序返回预设响应，并记录每次请求 */
function makeFetch(responses) {
  const calls = []
  let i = 0
  const fn = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers })
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name) => r.headers?.[String(name).toLowerCase()] ?? null },
      text: async () => text,
      json: async () => JSON.parse(text),
    }
  }
  fn.calls = calls
  return fn
}

const OK_BODY = { choices: [{ message: { role: 'assistant', content: 'ok' } }] }
const PARAM_REJECT_BODY = {
  error: {
    message: 'Unrecognized request argument supplied: reasoning_effort',
    type: 'invalid_request_error',
    code: 'unknown_parameter',
  },
}

beforeAll(async () => {
  const mod = await import('../src/index.js')
  app = mod.app
  await ensureAuthUser(pool)
  auth = authHeaders()

  // 探针用例用独立用户：思考强度显式设为 high，断言「带的就是用户选的那一档」
  const probeUser = await createUser('p')
  probeUserId = probeUser.id
  probeAuth = authHeaders({ userId: probeUser.id, phone: probeUser.phone })
  await pool.query(
    `INSERT INTO ai_settings (user_id, thinking_strength, created_at, updated_at)
     VALUES ($1, 'high', NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET thinking_strength = 'high'`,
    [probeUserId],
  )
})

afterAll(async () => {
  resetProbeFetchImpl()
  resetModelsFetchImpl()
  await pool.query('ALTER TABLE ai_model_settings DROP CONSTRAINT IF EXISTS tmp_v3_tx_guard').catch(() => {})
  for (const id of createdProviderIds) {
    await pool.query('DELETE FROM ai_providers WHERE id = $1', [id]).catch(() => {})
  }
  for (const id of createdUserIds) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
  }
})

afterEach(() => {
  resetProbeFetchImpl()
  resetModelsFetchImpl()
})

// ============================================================
// A. 新列：默认值 / 读写 / 校验
// ============================================================
describe('A. 契约 v3 新列（enabled / alias / sortOrder / applicability）', () => {
  it('无覆盖行时：alias/sortOrder=null、并带 applicability', async () => {
    const providerId = await createProvider({ model: 'gpt-4o', models: ['gpt-4o', 'whisper-1'] })
    const res = await getSettings(providerId)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const gpt = res.body.items.find((i) => i.model === 'gpt-4o')
    // ⚠️ 契约 v5 修正：无覆盖行且不在 selected_models 里 ⇒ enabled=false
    //（v3 曾写"无行默认 true"，导致刷新出来的模型全部显示已选中 —— 见 ai-model-enabled-source-v5.test.js）
    expect(gpt.enabled).toBe(false)
    expect(gpt.alias).toBeNull()
    expect(gpt.sortOrder).toBeNull()
    expect(gpt.applicability).toBe('chat')
    expect(gpt.isOverridden).toBe(false)
    // applicability 只是「判断依据」：服务端不据此过滤，非对话模型照样出现在列表里
    expect(res.body.items.map((i) => i.model)).toContain('whisper-1')
    expect(res.body.items.find((i) => i.model === 'whisper-1').applicability).toBe('audio')
  })

  it('PUT 写入 alias / sortOrder / enabled，GET 与库里都读得回', async () => {
    const providerId = await createProvider({ model: 'gpt-4o', models: ['gpt-4o'] })
    const put = await putSettings({
      providerId,
      model: 'gpt-4o',
      patch: { alias: '我的主力模型', sortOrder: -5, enabled: false },
    })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(put.body.item.alias).toBe('我的主力模型')
    expect(put.body.item.sortOrder).toBe(-5)
    expect(put.body.item.enabled).toBe(false)

    const row = await readRow(providerId, 'gpt-4o')
    expect(row.alias).toBe('我的主力模型')
    expect(row.sort_order).toBe(-5)
    expect(row.enabled).toBe(false)

    const res = await getSettings(providerId)
    const item = res.body.items.find((i) => i.model === 'gpt-4o')
    expect(item.alias).toBe('我的主力模型')
    expect(item.sortOrder).toBe(-5)
    expect(item.enabled).toBe(false)
  })

  it('alias 空串 / sortOrder null = 清除；enabled null = 回到默认启用', async () => {
    const providerId = await createProvider({ model: 'gpt-4o', models: ['gpt-4o'] })
    await putSettings({ providerId, model: 'gpt-4o', patch: { alias: 'x', sortOrder: 3, enabled: false } })
    const put = await putSettings({ providerId, model: 'gpt-4o', patch: { alias: '   ', sortOrder: null, enabled: null } })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(put.body.item.alias).toBeNull()
    expect(put.body.item.sortOrder).toBeNull()
    expect(put.body.item.enabled).toBe(true)
    const row = await readRow(providerId, 'gpt-4o')
    expect(row.alias).toBeNull()
    expect(row.sort_order).toBeNull()
    expect(row.enabled).toBe(true)
  })

  it('非法值一律 400（超长别名 / 控制字符 / 越界排序 / 错类型）', async () => {
    const providerId = await createProvider({ model: 'gpt-4o', models: ['gpt-4o'] })
    const bad = [
      { alias: 'x'.repeat(81) },
      { alias: 123 },
      { alias: `bad\u0000name` },
      { sortOrder: 10001 },
      { sortOrder: -10001 },
      { sortOrder: 1.5 },
      { sortOrder: '1' },
      { enabled: 'yes' },
    ]
    for (const patch of bad) {
      const res = await putSettings({ providerId, model: 'gpt-4o', patch })
      expect(res.status, `patch=${JSON.stringify(patch)} body=${JSON.stringify(res.body)}`).toBe(400)
    }
    // 边界值合法
    const ok = await putSettings({
      providerId,
      model: 'gpt-4o',
      patch: { alias: 'x'.repeat(80), sortOrder: 10000 },
    })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const ok2 = await putSettings({ providerId, model: 'gpt-4o', patch: { sortOrder: -10000 } })
    expect(ok2.status, JSON.stringify(ok2.body)).toBe(200)
  })

  it('GET 排序：sort_order 升序 → NULL 最后 → 模型名字典序', async () => {
    const providerId = await createProvider({
      model: 'sort-b',
      models: ['sort-b', 'sort-a', 'sort-c', 'z-null', 'a-null'],
    })
    await putSettings({ providerId, model: 'sort-b', patch: { sortOrder: 20 } })
    await putSettings({ providerId, model: 'sort-a', patch: { sortOrder: 10 } })
    await putSettings({ providerId, model: 'sort-c', patch: { sortOrder: 30 } })
    // z-null / a-null 不设 sortOrder（NULL 最后，彼此按名字典序）

    const res = await getSettings(providerId)
    expect(res.status).toBe(200)
    const order = res.body.items.map((i) => i.model)
    expect(order).toEqual(['sort-a', 'sort-b', 'sort-c', 'a-null', 'z-null'])

    await putSettings({ providerId, model: 'sort-c', patch: { sortOrder: 0 } })
    const res2 = await getSettings(providerId)
    expect(res2.body.items.map((i) => i.model)).toEqual(['sort-c', 'sort-a', 'sort-b', 'a-null', 'z-null'])
  })
})

// ============================================================
// B. classifyApplicability（契约 ④）
// ============================================================
describe('B. classifyApplicability 各类正则', () => {
  it('audio：tts / asr / audio / speech / voice / realtime / whisper', () => {
    for (const m of [
      'tts-1', 'gpt-4o-mini-tts', 'whisper-1', 'qwen-audio-turbo',
      'gpt-4o-realtime-preview', 'gpt-4o-audio-preview', 'fun-asr', 'cosyvoice-v1',
    ]) {
      expect(classifyApplicability(m), m).toBe('audio')
    }
  })

  it('image：image-* / dall* / flux* / edit-* / vision-gen*', () => {
    for (const m of ['dall-e-3', 'flux-pro-1.1', 'gpt-image-1', 'gpt-image-1-edit', 'sdxl-vision-gen', 'imagen-3.0-generate']) {
      expect(classifyApplicability(m), m).toBe('image')
    }
  })

  it('embedding：embed* / bge* / *rerank*', () => {
    for (const m of ['text-embedding-3-small', 'bge-m3', 'bge-large-zh-v1.5', 'rerank-english-v3.0', 'qwen3-reranker-8b']) {
      expect(classifyApplicability(m), m).toBe('embedding')
    }
  })

  it('其余（含 vision 理解型多模态）都是 chat', () => {
    for (const m of [
      'gpt-4o', 'claude-3-5-sonnet-latest', 'deepseek-chat', 'LongCat-Flash-Chat',
      'qwen-vl-max', // 视觉**理解**型：能对话，不是画图模型
      'step-explore', 'mimo-v2.5', 'agnes-2.0-flash',
    ]) {
      expect(classifyApplicability(m), m).toBe('chat')
    }
    expect(classifyApplicability('')).toBe('chat')
    expect(classifyApplicability(undefined)).toBe('chat')
  })

  it('枚举包含契约声明的 5 个取值', () => {
    expect(APPLICABILITY_KINDS).toEqual(['chat', 'audio', 'image', 'embedding', 'other'])
  })
})

// ============================================================
// C. enabled ↔ selected_models 联动（事务）+ IDOR
// ============================================================
describe('C. enabled 副作用与归属校验', () => {
  it('enabled=false 从 selected_models 移除；enabled=true 加回去（同一事务）', async () => {
    const user = await createUser('c1')
    const headers = authHeaders({ userId: user.id, phone: user.phone })
    const providerId = await createProvider({ userId: user.id, model: 'gpt-4o', models: ['gpt-4o'] })
    await pool.query(
      `INSERT INTO ai_settings (user_id, selected_models, created_at, updated_at)
       VALUES ($1, $2::jsonb, NOW(), NOW()) ON CONFLICT (user_id) DO NOTHING`,
      [user.id, JSON.stringify({ [providerId]: 'gpt-4o' })],
    )

    const off = await putSettings({ providerId, model: 'gpt-4o', patch: { enabled: false } }, headers)
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(off.body.item.enabled).toBe(false)
    let selected = await readSelected(user.id)
    expect(selected[providerId]).toBeUndefined()

    const on = await putSettings({ providerId, model: 'gpt-4o', patch: { enabled: true } }, headers)
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    selected = await readSelected(user.id)
    expect(selected[providerId]).toBe('gpt-4o')
  })

  it('patch 里没有 enabled 时绝不碰 selected_models（避免"只改上下文窗口"顺手改掉聊天模型）', async () => {
    const user = await createUser('c2')
    const headers = authHeaders({ userId: user.id, phone: user.phone })
    const providerId = await createProvider({ userId: user.id, model: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini'] })
    await pool.query(
      `INSERT INTO ai_settings (user_id, selected_models, created_at, updated_at)
       VALUES ($1, $2::jsonb, NOW(), NOW()) ON CONFLICT (user_id) DO NOTHING`,
      [user.id, JSON.stringify({ [providerId]: 'gpt-4o-mini' })],
    )
    const res = await putSettings({ providerId, model: 'gpt-4o', patch: { contextWindow: 64000 } }, headers)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const selected = await readSelected(user.id)
    expect(selected[providerId]).toBe('gpt-4o-mini')
  })

  it('写库失败时联动一起回滚（注入约束失败证明事务化）', async () => {
    const user = await createUser('c3')
    const headers = authHeaders({ userId: user.id, phone: user.phone })
    const providerId = await createProvider({ userId: user.id, model: 'gpt-4o', models: ['gpt-4o'] })
    await pool.query(
      `INSERT INTO ai_settings (user_id, selected_models, created_at, updated_at)
       VALUES ($1, '{}'::jsonb, NOW(), NOW()) ON CONFLICT (user_id) DO NOTHING`,
      [user.id],
    )

    // 临时约束：让「该模型行的写入」必然失败（模拟任何写库错误）
    await pool.query('ALTER TABLE ai_model_settings DROP CONSTRAINT IF EXISTS tmp_v3_tx_guard')
    await pool.query(`ALTER TABLE ai_model_settings ADD CONSTRAINT tmp_v3_tx_guard CHECK (model <> '__v3_tx_fail__')`)
    try {
      const res = await putSettings({ providerId, model: '__v3_tx_fail__', patch: { enabled: true } }, headers)
      expect(res.status, JSON.stringify(res.body)).toBe(500)
    } finally {
      await pool.query('ALTER TABLE ai_model_settings DROP CONSTRAINT IF EXISTS tmp_v3_tx_guard')
    }

    // 模型行没写成，selected_models 也必须没变（同一 client 事务）
    expect(await readRow(providerId, '__v3_tx_fail__')).toBeNull()
    const selected = await readSelected(user.id)
    expect(selected[providerId]).toBeUndefined()
  })

  it('纯函数 applySelectedModel：字符串/数组/对象三种历史形态都兼容', () => {
    // 字符串（桌面端主形态）
    expect(applySelectedModel({ p1: 'a' }, 'p1', 'b', true)).toEqual({ p1: 'b' })
    expect(applySelectedModel({ p1: 'a' }, 'p1', 'a', false)).toEqual({})
    expect(applySelectedModel({ p1: 'a' }, 'p1', 'b', false)).toEqual({ p1: 'a' })
    // 数组
    expect(applySelectedModel({ p1: ['a'] }, 'p1', 'b', true)).toEqual({ p1: ['a', 'b'] })
    expect(applySelectedModel({ p1: ['a', 'b'] }, 'p1', 'a', false)).toEqual({ p1: ['b'] })
    expect(applySelectedModel({ p1: ['a'] }, 'p1', 'a', false)).toEqual({})
    // 对象
    expect(applySelectedModel({ p1: { model: 'a' } }, 'p1', 'a', false)).toEqual({})
    expect(applySelectedModel({}, 'p1', 'x', true)).toEqual({ p1: 'x' })
    // 不污染入参
    const input = { p1: 'a' }
    applySelectedModel(input, 'p1', 'b', true)
    expect(input).toEqual({ p1: 'a' })
  })

  it('IDOR：他人/不存在/非法 providerId 一律 404（GET / PUT / probe）', async () => {
    const victim = await createUser('c4')
    const victimProvider = await createProvider({ userId: victim.id, model: 'gpt-5', models: ['gpt-5'], provider: 'openai', apiKey: 'sk-x' })
    const ghost = '11111111-1111-1111-1111-111111111111'

    expect((await getSettings(victimProvider)).status).toBe(404)
    expect((await putSettings({ providerId: victimProvider, model: 'gpt-5', patch: { enabled: false } })).status).toBe(404)
    expect((await probe({ providerId: victimProvider, model: 'gpt-5' })).status).toBe(404)
    expect((await getSettings(ghost)).status).toBe(404)
    expect((await getSettings('not-a-uuid')).status).toBe(404)
    expect((await probe({ providerId: 'not-a-uuid', model: 'gpt-5' })).status).toBe(404)

    // 别人的行没被写
    expect(await readRow(victimProvider, 'gpt-5')).toBeNull()
  })
})

// ============================================================
// D. 「刷新绝不覆盖用户配置」（契约 ③ —— 先核实，再用测试钉死）
// ============================================================
describe('D. 刷新只写 ai_providers.models，绝不动 ai_model_settings', () => {
  it('刷新前后：该模型行逐字段完全未变，且刷新确实写进了 ai_providers.models', async () => {
    const providerId = await createProvider({
      model: 'r-alpha',
      models: ['r-alpha', 'r-beta'],
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:9/v1', // 真实环境中必然拒连：本用例用注入假 fetch 控制成功/失败
      apiKey: 'sk-refresh',              // 刷新路径会 decrypt；必须存真加密值
    })
    // 用户自定义配置
    const put = await putSettings({
      providerId,
      model: 'r-alpha',
      patch: {
        contextWindow: 55555,
        maxOutput: 4096,
        supportsImage: true,
        supportsVideo: true,
        reasoningEnabled: true,
        reasoningProtocol: 'openai_reasoning_effort',
        alias: '别被刷新冲掉',
        sortOrder: 7,
      },
    })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    const before = await readRow(providerId, 'r-alpha')
    expect(before).toBeTruthy()

    // 触发「刷新」的**成功分支**：GET /providers/:id/models 只在上游返回结构合法数组时才写回
    // ai_providers.models（用户实测缺陷修复：失败**不再**覆盖已存列表）
    setModelsFetchImpl(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ object: 'list', data: [{ id: 'r-alpha' }, { id: 'r-gamma' }] }),
    }))
    const refresh = await request(app).get(`/api/ai/providers/${providerId}/models`).set(auth)
    expect(refresh.status, JSON.stringify(refresh.body)).toBe(200)
    expect(refresh.body.models).toEqual(['r-alpha', 'r-gamma'])

    // 刷新确实写了 ai_providers.models（证明这条分支真的跑了）
    const prov = await pool.query('SELECT models FROM ai_providers WHERE id = $1', [providerId])
    expect(prov.rows[0].models).toEqual(['r-alpha', 'r-gamma'])

    // ★ 失败刷新（上游连不通）→ 非 2xx 且**库里的列表一字未改**（旧实现会把它写成 []）
    setModelsFetchImpl(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' })
    })
    const failed = await request(app).get(`/api/ai/providers/${providerId}/models`).set(auth)
    expect(failed.status, JSON.stringify(failed.body)).toBe(502)
    expect(failed.body.code).toBe('ai_upstream_unavailable')
    const provKept = await pool.query('SELECT models FROM ai_providers WHERE id = $1', [providerId])
    expect(provKept.rows[0].models).toEqual(['r-alpha', 'r-gamma'])

    // 模型级配置逐字段未变（含 updated_at —— 刷新根本没碰这张表）
    const after = await readRow(providerId, 'r-alpha')
    expect(after).toEqual(before)
    expect(after.context_window).toBe(55555)
    expect(after.supports_video).toBe(true)
    expect(after.reasoning_protocol).toBe('openai_reasoning_effort')
    expect(after.alias).toBe('别被刷新冲掉')
    expect(after.sort_order).toBe(7)

    // 预览型刷新（POST fetch-models）**完全不写库**：失败也一样（上游仍是上面那个拒连的假实现）
    await pool.query('UPDATE ai_providers SET models = $2::jsonb WHERE id = $1', [providerId, JSON.stringify(['r-alpha'])])
    const preview = await request(app)
      .post('/api/ai/providers/fetch-models')
      .set(auth)
      .send({ providerId })
    expect(preview.status, JSON.stringify(preview.body)).toBe(502)
    expect(preview.body.code).toBe('ai_upstream_unavailable')
    const prov2 = await pool.query('SELECT models FROM ai_providers WHERE id = $1', [providerId])
    expect(prov2.rows[0].models).toEqual(['r-alpha'])
    expect(await readRow(providerId, 'r-alpha')).toEqual(after)
  })

  it('被停用的模型：刷新不会复活它（仍 enabled=false 且配置保留）', async () => {
    const providerId = await createProvider({
      model: 'd-base',
      models: ['d-base', 'd-off'],
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-refresh',
    })
    const off = await putSettings({
      providerId,
      model: 'd-off',
      patch: { enabled: false, contextWindow: 123456, alias: '停用但保留' },
    })
    expect(off.status, JSON.stringify(off.body)).toBe(200)

    // 刷新：上游这次**成功**返回了一个不含 d-off 的清单（写 ai_providers.models；
    // 用户实测缺陷修复后，只有成功才写库，所以这里注入假 fetch 让上游成功）
    setModelsFetchImpl(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ object: 'list', data: [{ id: 'd-base' }] }),
    }))
    const refresh = await request(app).get(`/api/ai/providers/${providerId}/models`).set(auth)
    expect(refresh.status, JSON.stringify(refresh.body)).toBe(200)
    expect(refresh.body.models).toEqual(['d-base'])

    const res = await getSettings(providerId)
    expect(res.status).toBe(200)
    const item = res.body.items.find((i) => i.model === 'd-off')
    expect(item, '停用模型仍要在列表里（配置保留可恢复）').toBeTruthy()
    expect(item.enabled).toBe(false)
    expect(item.contextWindow).toBe(123456)
    expect(item.alias).toBe('停用但保留')
  })
})

// ============================================================
// E. probe 判定矩阵（契约 ⑤ —— 可注入 fetch，不发真实外网）
// ============================================================
describe('E. POST /api/ai/model-settings/probe 三条路径', () => {
  it('路径①成功：显式协议带参数、上游接受 → supportsReasoningParam=true', async () => {
    const providerId = await createProvider({
      userId: probeUserId,
      provider: 'openai',
      model: 'gpt-5',
      models: ['gpt-5'],
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-probe',
    })
    const fetchMock = makeFetch([{ status: 200, body: { ...OK_BODY, context_window: 272000 } }])
    setProbeFetchImpl(fetchMock)

    const res = await probe({ providerId, model: 'gpt-5' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.protocolTried).toBe('openai_reasoning_effort')
    expect(res.body.usedReasoningParam).toBe(true)
    expect(res.body.supportsReasoningParam).toBe(true)
    expect(res.body.upstreamStatus).toBe(200)
    expect(typeof res.body.latencyMs).toBe('number')
    expect(res.body.observedContextWindow).toBe(272000) // 上游给了就如实观察
    expect(fetchMock.calls).toHaveLength(1)
    // 探针请求本身：max_tokens=1 + 极短消息 + 用户选的等级原样透传
    expect(fetchMock.calls[0].body.max_tokens).toBe(1)
    expect(fetchMock.calls[0].body.messages).toEqual([{ role: 'user', content: 'ping' }])
    expect(fetchMock.calls[0].body.reasoning_effort).toBe('high')
    expect(fetchMock.calls[0].body.stream).toBe(false)
  })

  it('路径②参数相关 4xx → 去掉参数重试成功 → supportsReasoningParam=false + suggestedProtocol', async () => {
    const providerId = await createProvider({
      userId: probeUserId,
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      models: ['claude-3-5-sonnet-latest'],
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-probe',
    })
    const fetchMock = makeFetch([
      { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'thinking is not supported for this model' } } },
      { status: 200, body: OK_BODY },
    ])
    setProbeFetchImpl(fetchMock)

    const res = await probe({ providerId, model: 'claude-3-5-sonnet-latest' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.protocolTried).toBe('anthropic_thinking')
    expect(res.body.usedReasoningParam).toBe(false)
    expect(res.body.supportsReasoningParam).toBe(false)
    expect(res.body.suggestedProtocol).toBe('inherit')
    expect(res.body.upstreamStatus).toBe(200) // 最后一次（成功那次）的状态
    expect(res.body.attempts).toHaveLength(2)
    expect(res.body.attempts[0].status).toBe(400)
    expect(res.body.attempts[0].errorCode).toBe('invalid_request_error')
    // 第一次带 thinking（budget_tokens 由内部换算：high=8192），第二次一个字都不带
    expect(fetchMock.calls).toHaveLength(2)
    expect(fetchMock.calls[0].body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(fetchMock.calls[1].body.thinking).toBeUndefined()
    expect(fetchMock.calls[1].body.reasoning_effort).toBeUndefined()
  })

  it('路径②推论：错误文案点名别的字段 → suggestedProtocol 指向那个协议', async () => {
    const providerId = await createProvider({
      userId: probeUserId,
      provider: 'openai',
      model: 'gpt-5',
      models: ['gpt-5'],
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-probe',
    })
    const fetchMock = makeFetch([
      { status: 400, body: { error: { code: 'unknown_parameter', message: 'Unsupported parameter: output_config' } } },
      { status: 200, body: OK_BODY },
    ])
    setProbeFetchImpl(fetchMock)

    const res = await probe({ providerId, model: 'gpt-5' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.supportsReasoningParam).toBe(false)
    expect(res.body.suggestedProtocol).toBe('output_config_effort')
  })

  it('路径③两次都失败 → ok=false，且原样保留上游错误码/文案（不许吞）', async () => {
    const providerId = await createProvider({
      userId: probeUserId,
      provider: 'openai',
      model: 'gpt-5',
      models: ['gpt-5'],
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-probe',
    })
    const fetchMock = makeFetch([
      { status: 400, body: { error: { code: 'unknown_parameter', message: 'Unrecognized request argument: reasoning_effort' } } },
      { status: 429, body: { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for gpt-5' } } },
    ])
    setProbeFetchImpl(fetchMock)

    const res = await probe({ providerId, model: 'gpt-5' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.usedReasoningParam).toBe(false)
    expect(res.body.supportsReasoningParam).toBe(false)
    expect(res.body.upstreamStatus).toBe(429)
    expect(res.body.upstreamErrorCode).toBe('rate_limit_exceeded')
    expect(res.body.upstreamMessage).toBe('Rate limit reached for gpt-5')
    expect(res.body.attempts).toHaveLength(2)
    expect(res.body.attempts[1].status).toBe(429)
  })

  it('非参数类失败（401）：不重试，错误原样保留，supportsReasoningParam=unknown', async () => {
    const providerId = await createProvider({
      userId: probeUserId,
      provider: 'openai',
      model: 'gpt-5',
      models: ['gpt-5'],
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-probe',
    })
    const fetchMock = makeFetch([
      { status: 401, body: { error: { code: 'invalid_api_key', message: 'Incorrect API key provided' } } },
    ])
    setProbeFetchImpl(fetchMock)

    const res = await probe({ providerId, model: 'gpt-5' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.upstreamStatus).toBe(401)
    expect(res.body.upstreamErrorCode).toBe('invalid_api_key')
    expect(res.body.upstreamMessage).toBe('Incorrect API key provided')
    expect(res.body.supportsReasoningParam).toBe('unknown')
    expect(fetchMock.calls).toHaveLength(1) // 不重试
  })

  it('protocol=none（step-explore）：不下发任何推理参数，supportsReasoningParam=false', async () => {
    const providerId = await createProvider({
      userId: probeUserId,
      provider: 'custom',
      model: 'step-explore',
      models: ['step-explore'],
      apiFormat: 'anthropic',
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: 'sk-probe',
    })
    const fetchMock = makeFetch([{ status: 200, body: OK_BODY }])
    setProbeFetchImpl(fetchMock)

    const res = await probe({ providerId, model: 'step-explore' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.protocolTried).toBe('none')
    expect(res.body.usedReasoningParam).toBe(false)
    expect(res.body.supportsReasoningParam).toBe(false)
    expect(fetchMock.calls[0].body.thinking).toBeUndefined()
    expect(fetchMock.calls[0].body.output_config).toBeUndefined()
  })

  it('protocol=inherit（OpenAI 兼容族）：测不到 → unknown；且绝不塞未知字段', async () => {
    const providerId = await createProvider({
      userId: probeUserId,
      provider: 'longcat',
      model: 'LongCat-Flash-Chat',
      models: ['LongCat-Flash-Chat'],
      baseUrl: 'https://api.longcat.chat/openai',
      apiKey: 'sk-probe',
    })
    const fetchMock = makeFetch([{ status: 200, body: OK_BODY }])
    setProbeFetchImpl(fetchMock)

    const res = await probe({ providerId, model: 'LongCat-Flash-Chat' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.protocolTried).toBe('inherit')
    expect(res.body.usedReasoningParam).toBe(false)
    expect(res.body.supportsReasoningParam).toBe('unknown')
    for (const k of ['thinking', 'output_config', 'reasoning_effort', 'reasoning', 'enable_thinking']) {
      expect(fetchMock.calls[0].body[k]).toBeUndefined()
    }
  })

  it('传输层失败（连不上）：ok=false + upstreamErrorCode=transport_error（不伪装成上游 4xx）', async () => {
    const providerId = await createProvider({
      userId: probeUserId,
      provider: 'openai',
      model: 'gpt-5',
      models: ['gpt-5'],
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-probe',
    })
    setProbeFetchImpl(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9')
    })

    const res = await probe({ providerId, model: 'gpt-5' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.upstreamStatus).toBeNull()
    expect(res.body.upstreamErrorCode).toBe('transport_error')
    expect(String(res.body.upstreamMessage)).toMatch(/ECONNREFUSED/)
  })

  it('probe 参数校验：缺 model → 400；provider 无 key → 400', async () => {
    const providerId = await createProvider({ userId: probeUserId, model: 'gpt-5', models: ['gpt-5'], provider: 'openai', apiKey: 'sk-probe' })
    expect((await probe({ providerId })).status).toBe(400)
    expect((await probe({ providerId, model: '   ' })).status).toBe(400)

    const noKey = await createProvider({ userId: probeUserId, model: 'gpt-5', models: ['gpt-5'], provider: 'openai' })
    await pool.query('UPDATE ai_providers SET api_key_encrypted = NULL WHERE id = $1', [noKey])
    const res = await probe({ providerId: noKey, model: 'gpt-5' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('NO_API_KEY')
  })
})

// ============================================================
// F. probe 限流与鉴权（契约 ⑥）
// ============================================================
describe('F. probe 限流与鉴权', () => {
  it('未登录 → 401', async () => {
    const providerId = await createProvider({ userId: probeUserId, model: 'gpt-5', provider: 'openai', apiKey: 'sk-probe' })
    const res = await request(app).post('/api/ai/model-settings/probe').send({ providerId, model: 'gpt-5' })
    expect(res.status).toBe(401)
  })

  it('独立限流桶：10 次/分/用户，第 11 次 429（且带 Retry-After）', async () => {
    const providerId = await createProvider({
      userId: probeUserId,
      provider: 'longcat',
      model: 'LongCat-Flash-Chat',
      models: ['LongCat-Flash-Chat'],
      baseUrl: 'https://api.longcat.chat/openai',
      apiKey: 'sk-probe',
    })
    setProbeFetchImpl(makeFetch([{ status: 200, body: OK_BODY }]))

    for (let i = 0; i < 10; i++) {
      const res = await probe({ providerId, model: 'LongCat-Flash-Chat' })
      expect(res.status, `第 ${i + 1} 次应当放行`).toBe(200)
    }
    const blocked = await probe({ providerId, model: 'LongCat-Flash-Chat' })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
  })
})
