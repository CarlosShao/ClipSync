/**
 * 契约 v4：草稿态也能拿到模型预设/配置（resolve） + 事务批量保存（batch）。
 *
 * 覆盖需求四条：
 *   ① resolve（无 providerId）= 纯预设，值与 GET 完全同口径；给 providerId = 叠加覆盖行 → A 组
 *   ② resolve 鉴权/校验（他人 provider → 404；空/超长/超 500 → 400）+ **不写任何表** → A 组
 *   ③ batch 多模型多字段写入 → 200 + 逐条读回一致；一条非法 → 整批不落库（400） → B 组
 *   ④ batch 的 enabled↔selected_models 联动在同一事务（含回滚） + IDOR/超限 → B 组
 *
 * 关键回归点（本轮新增的价值所在）：
 *   · resolve 与 GET **必须同值**（共用 resolveItems/toItem/mergeModelSettings，不另写一套解析）；
 *   · resolve **纯读**（调用前后 ai_model_settings / ai_settings / ai_providers 快照逐字节相等）；
 *   · batch **整批原子**（校验失败一条不写；DB 失败整体 ROLLBACK）；
 *   · batch 事务内**读得到自己未提交的写入**（同一批次里对同一模型的第二次 patch 必须基于第一次结果合并，
 *     否则第二次会把第一次的字段按预设打回去）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import request from 'supertest'
import pool from '../src/db/pool.js'
import { authHeaders, ensureAuthUser, TEST_USER_ID } from './test-helpers.js'
import { encrypt } from '../src/utils/encryption.js'
import { setProbeFetchImpl, resetProbeFetchImpl } from '../src/utils/modelProbe.js'

let app
let auth
const createdProviderIds = []
const createdUserIds = []
const stamp = Date.now().toString().slice(-6)
let userSeq = 0

async function createUser(suffix) {
  userSeq += 1
  const phone = `1393${String(userSeq).padStart(3, '0')}${stamp.slice(-4)}`.slice(0, 11)
  const { rows } = await pool.query(
    `INSERT INTO users (phone, password_hash, nickname, created_at, updated_at)
     VALUES ($1, 'test_hash', $2, NOW(), NOW()) RETURNING id`,
    [phone, `v4_${suffix}_${stamp}`],
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
} = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ai_providers (user_id, provider, name, api_key_encrypted, base_url, model, models, api_format)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id`,
    [userId, provider, `v4_${provider}_${stamp}_${createdProviderIds.length}`, encrypt('sk-v4'), baseUrl, model, JSON.stringify(models), apiFormat],
  )
  createdProviderIds.push(rows[0].id)
  return rows[0].id
}

const resolveModels = (body, headers = auth) =>
  request(app).post('/api/ai/model-settings/resolve').set(headers).send(body)
const batchPut = (body, headers = auth) =>
  request(app).put('/api/ai/model-settings/batch').set(headers).send(body)
const getSettings = (providerId, headers = auth) =>
  request(app).get(`/api/ai/model-settings?providerId=${providerId}`).set(headers)

async function readRow(providerId, model, executor = pool) {
  const { rows } = await executor.query(
    'SELECT * FROM ai_model_settings WHERE provider_id = $1 AND model = $2',
    [providerId, model],
  )
  return rows[0] || null
}

async function readSelected(userId) {
  const { rows } = await pool.query('SELECT selected_models FROM ai_settings WHERE user_id = $1', [userId])
  return rows[0]?.selected_models || null
}

/** 全表快照（含 updated_at）：用于证明 resolve 一个字节都没写 */
async function snapshotModelSettings() {
  const { rows } = await pool.query(
    `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb) AS rows FROM ai_model_settings t`,
  )
  return rows[0].rows
}

async function snapshotProvider(providerId) {
  const { rows } = await pool.query('SELECT models FROM ai_providers WHERE id = $1', [providerId])
  return rows[0]?.models ?? null
}

beforeAll(async () => {
  const mod = await import('../src/index.js')
  app = mod.app
  await ensureAuthUser(pool)
  auth = authHeaders()
})

afterAll(async () => {
  resetProbeFetchImpl()
  await pool.query('ALTER TABLE ai_model_settings DROP CONSTRAINT IF EXISTS tmp_v4_batch_guard').catch(() => {})
  for (const id of createdProviderIds) {
    await pool.query('DELETE FROM ai_providers WHERE id = $1', [id]).catch(() => {})
  }
  for (const id of createdUserIds) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
  }
})

afterEach(() => {
  resetProbeFetchImpl()
})

// ============================================================
// A. POST /resolve（草稿态预设解析，纯读）
// ============================================================
describe('A. POST /api/ai/model-settings/resolve', () => {
  it('不给 providerId：返回纯预设（enabled=true / alias=null / isOverridden=false / applicability 正确）', async () => {
    const res = await resolveModels({ models: ['gpt-4o', 'step-explore', 'whisper-1', 'text-embedding-3-small', 'claude-3-5-sonnet-latest'] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const by = Object.fromEntries(res.body.items.map((i) => [i.model, i]))

    expect(by['gpt-4o'].contextWindow).toBe(128000)
    expect(by['gpt-4o'].supportsImage).toBe(true)
    expect(by['gpt-4o'].reasoningProtocol).toBe('inherit')
    expect(by['gpt-4o'].applicability).toBe('chat')
    expect(by['gpt-4o'].enabled).toBe(true)
    expect(by['gpt-4o'].alias).toBeNull()
    expect(by['gpt-4o'].sortOrder).toBeNull()
    expect(by['gpt-4o'].isPreset).toBe(true)
    expect(by['gpt-4o'].isOverridden).toBe(false)

    expect(by['step-explore'].contextWindow).toBe(1000000)
    expect(by['step-explore'].reasoningProtocol).toBe('none')
    expect(by['whisper-1'].applicability).toBe('audio')
    expect(by['text-embedding-3-small'].applicability).toBe('embedding')
    expect(by['claude-3-5-sonnet-latest'].reasoningProtocol).toBe('anthropic_thinking')
    expect(by['claude-3-5-sonnet-latest'].contextWindow).toBe(200000)
  })

  it('与 GET 完全同值同口径（同一模型逐字段相等）', async () => {
    const models = ['gpt-4o', 'whisper-1', 'step-explore']
    const providerId = await createProvider({ model: 'gpt-4o', models })
    const viaGet = await getSettings(providerId)
    expect(viaGet.status).toBe(200)
    const viaResolve = await resolveModels({ models, providerId })
    expect(viaResolve.status).toBe(200)

    for (const m of models) {
      const a = viaGet.body.items.find((i) => i.model === m)
      const b = viaResolve.body.items.find((i) => i.model === m)
      expect(a, `GET 应包含 ${m}`).toBeTruthy()
      expect(b, `resolve 应包含 ${m}`).toBeTruthy()
      expect(b, `${m} 的 resolve 值必须与 GET 一致`).toEqual(a)
    }
  })

  it('去重 + 保持入参顺序（不按名字重排）', async () => {
    const res = await resolveModels({ models: ['whisper-1', 'gpt-4o', 'whisper-1', 'a-unknown-model'] })
    expect(res.status).toBe(200)
    expect(res.body.items.map((i) => i.model)).toEqual(['whisper-1', 'gpt-4o', 'a-unknown-model'])
  })

  it('给了本人的 providerId：叠加覆盖行，isOverridden=true', async () => {
    const providerId = await createProvider({ model: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini'] })
    const put = await request(app)
      .put('/api/ai/model-settings')
      .set(auth)
      .send({ providerId, model: 'gpt-4o', patch: { contextWindow: 64000, alias: '草稿覆盖', enabled: false } })
    expect(put.status, JSON.stringify(put.body)).toBe(200)

    const res = await resolveModels({ models: ['gpt-4o', 'gpt-4o-mini'], providerId })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const a = res.body.items.find((i) => i.model === 'gpt-4o')
    expect(a.isOverridden).toBe(true)
    expect(a.contextWindow).toBe(64000)
    expect(a.alias).toBe('草稿覆盖')
    expect(a.enabled).toBe(false)
    // 同 provider 下没有覆盖行的模型仍是纯预设
    const b = res.body.items.find((i) => i.model === 'gpt-4o-mini')
    expect(b.isOverridden).toBe(false)
    expect(b.contextWindow).toBe(128000)
  })

  it('别人的 / 不存在的 / 非法 providerId → 404（沿用 IDOR 口径）', async () => {
    const victim = await createUser('victim')
    const victimProvider = await createProvider({ userId: victim.id, model: 'gpt-4o', models: ['gpt-4o'] })

    const other = await resolveModels({ models: ['gpt-4o'], providerId: victimProvider })
    expect([403, 404]).toContain(other.status)
    expect(other.status).toBe(404)

    expect((await resolveModels({ models: ['gpt-4o'], providerId: '11111111-1111-1111-1111-111111111111' })).status).toBe(404)
    expect((await resolveModels({ models: ['gpt-4o'], providerId: 'not-a-uuid' })).status).toBe(404)
  })

  it('models 校验：非数组 / 空数组 / 超 500 / 非法元素 → 400（带稳定 code 与下标）', async () => {
    const notArray = await resolveModels({ models: 'gpt-4o' })
    expect(notArray.status).toBe(400)
    expect(notArray.body.code).toBe('MODELS_NOT_ARRAY')

    const empty = await resolveModels({ models: [] })
    expect(empty.status).toBe(400)
    expect(empty.body.code).toBe('MODELS_EMPTY')
    expect((await resolveModels({})).status).toBe(400)

    const tooMany = await resolveModels({ models: Array.from({ length: 501 }, (_, i) => `m-${i}`) })
    expect(tooMany.status).toBe(400)
    expect(tooMany.body.code).toBe('MODELS_TOO_MANY')

    const byElement = await resolveModels({ models: ['gpt-4o', 42] })
    expect(byElement.status).toBe(400)
    expect(byElement.body.code).toBe('INVALID_MODEL')
    expect(byElement.body.index).toBe(1)

    const blank = await resolveModels({ models: ['   '] })
    expect(blank.status).toBe(400)
    expect(blank.body.code).toBe('INVALID_MODEL')

    const tooLong = await resolveModels({ models: ['x'.repeat(201)] })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.code).toBe('INVALID_MODEL')

    // 边界：500 个合法模型名 → 200
    const exactly = await resolveModels({ models: Array.from({ length: 500 }, (_, i) => `m-${i}`) })
    expect(exactly.status, JSON.stringify(exactly.body).slice(0, 200)).toBe(200)
    expect(exactly.body.items).toHaveLength(500)
  })

  it('resolve 一个字节都不写：三张表快照前后完全相等', async () => {
    const providerId = await createProvider({ model: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini'] })
    const before = {
      settings: await snapshotModelSettings(),
      selected: await readSelected(TEST_USER_ID),
      providerModels: await snapshotProvider(providerId),
    }

    // 不带 providerId（草稿态）＋ 带 providerId（已保存态）＋ 含从未见过的模型名
    expect((await resolveModels({ models: ['gpt-4o', 'brand-new-model', 'whisper-1'] })).status).toBe(200)
    expect((await resolveModels({ models: ['gpt-4o', 'brand-new-model'], providerId })).status).toBe(200)
    expect((await resolveModels({ models: ['gpt-4o'], providerId, extraIgnored: true })).status).toBe(200)

    const after = {
      settings: await snapshotModelSettings(),
      selected: await readSelected(TEST_USER_ID),
      providerModels: await snapshotProvider(providerId),
    }
    expect(after.settings).toEqual(before.settings)
    expect(after.selected).toEqual(before.selected)
    expect(after.providerModels).toEqual(before.providerModels)
    // 明确断言「没给草稿模型建行」
    expect(await readRow(providerId, 'brand-new-model')).toBeNull()
  })

  it('未登录 → 401', async () => {
    const res = await request(app).post('/api/ai/model-settings/resolve').send({ models: ['gpt-4o'] })
    expect(res.status).toBe(401)
  })

  it('providerId 为 null / 空串 = 草稿态（纯预设）；未知模型 isPreset=false 且窗口留空', async () => {
    for (const providerId of [null, '', undefined]) {
      const res = await resolveModels({ models: ['gpt-4o', 'totally-unknown-xyz'], providerId })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const unk = res.body.items.find((i) => i.model === 'totally-unknown-xyz')
      expect(unk.isPreset).toBe(false)
      expect(unk.isOverridden).toBe(false)
      expect(unk.contextWindow).toBeNull()
      expect(unk.reasoningProtocol).toBe('inherit')
      expect(unk.enabled).toBe(true)
    }
  })

  it('草稿 provider（还没填 API key）也能 resolve —— 与 probe 不同，resolve 不需要 key', async () => {
    const providerId = await createProvider({ model: 'gpt-4o', models: ['gpt-4o'] })
    await pool.query('UPDATE ai_providers SET api_key_encrypted = NULL WHERE id = $1', [providerId])
    const res = await resolveModels({ models: ['gpt-4o'], providerId })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.items[0].contextWindow).toBe(128000)
  })
})

// ============================================================
// B. PUT /batch（事务批量 upsert）
// ============================================================
describe('B. PUT /api/ai/model-settings/batch', () => {
  it('多模型多字段写入 → 200，items 顺序与入参一致，逐条读回一致', async () => {
    const providerId = await createProvider({ model: 'ba', models: ['ba', 'bb', 'bc'] })
    const res = await batchPut({
      providerId,
      items: [
        { model: 'bc', patch: { contextWindow: 40000, supportsVideo: true, alias: 'C', sortOrder: 3 } },
        { model: 'ba', patch: { supportsImage: true, reasoningEnabled: true, reasoningProtocol: 'openai_reasoning_effort' } },
        { model: 'bb', patch: { enabled: false, maxOutput: 2048 } },
      ],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.updated).toBe(3)
    expect(res.body.items.map((i) => i.model)).toEqual(['bc', 'ba', 'bb'])

    const viaGet = await getSettings(providerId)
    const by = Object.fromEntries(viaGet.body.items.map((i) => [i.model, i]))
    expect(by.bc.contextWindow).toBe(40000)
    expect(by.bc.supportsVideo).toBe(true)
    expect(by.bc.alias).toBe('C')
    expect(by.bc.sortOrder).toBe(3)
    expect(by.ba.supportsImage).toBe(true)
    expect(by.ba.reasoningEnabled).toBe(true)
    expect(by.ba.reasoningProtocol).toBe('openai_reasoning_effort')
    expect(by.bb.enabled).toBe(false)
    expect(by.bb.maxOutput).toBe(2048)
    // 返回的 items 与 GET 读回逐字段一致
    for (const item of res.body.items) {
      expect(by[item.model]).toEqual(item)
    }
  })

  it('其中一条非法（contextWindow 越界）→ 400 且整批一条都不落库', async () => {
    const providerId = await createProvider({ model: 'ba', models: ['ba', 'bb'] })
    const beforeRows = (await pool.query('SELECT count(*)::int AS n FROM ai_model_settings WHERE provider_id = $1', [providerId])).rows[0].n

    const res = await batchPut({
      providerId,
      items: [
        { model: 'ba', patch: { contextWindow: 64000 } },       // 合法
        { model: 'bb', patch: { contextWindow: 99999999 } },    // 越界
      ],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe('INVALID_BATCH_ITEM')
    expect(res.body.index).toBe(1)
    expect(res.body.field).toBe('contextWindow')
    expect(res.body.code).toBe('OUT_OF_RANGE')

    // 整批不落库：合法的那条也没写
    const afterRows = (await pool.query('SELECT count(*)::int AS n FROM ai_model_settings WHERE provider_id = $1', [providerId])).rows[0].n
    expect(afterRows).toBe(beforeRows)
    expect(await readRow(providerId, 'ba')).toBeNull()
    expect(await readRow(providerId, 'bb')).toBeNull()
  })

  it('enabled 联动 selected_models 在同一事务里生效（批内多条累进）', async () => {
    const user = await createUser('b1')
    const headers = authHeaders({ userId: user.id, phone: user.phone })
    const providerId = await createProvider({ userId: user.id, model: 'ba', models: ['ba', 'bb', 'bc'] })
    await pool.query(
      `INSERT INTO ai_settings (user_id, selected_models, created_at, updated_at)
       VALUES ($1, '{}'::jsonb, NOW(), NOW()) ON CONFLICT (user_id) DO NOTHING`,
      [user.id],
    )

    // 先启用 bb（写入 selected_models），再在本批里停用 bb、启用 bc
    await batchPut({ providerId, items: [{ model: 'bb', patch: { enabled: true } }] }, headers)
    expect((await readSelected(user.id))[providerId]).toBe('bb')

    const res = await batchPut({
      providerId,
      items: [
        { model: 'bb', patch: { enabled: false } },
        { model: 'bc', patch: { enabled: true, alias: 'C' } },
      ],
    }, headers)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.items[0].enabled).toBe(false)
    expect(res.body.items[1].enabled).toBe(true)
    expect((await readSelected(user.id))[providerId]).toBe('bc')
  })

  it('批内写库失败 → 整体回滚（含 selected_models 联动），一条都不留', async () => {
    const user = await createUser('b2')
    const headers = authHeaders({ userId: user.id, phone: user.phone })
    const providerId = await createProvider({ userId: user.id, model: 'ba', models: ['ba'] })
    await pool.query(
      `INSERT INTO ai_settings (user_id, selected_models, created_at, updated_at)
       VALUES ($1, '{}'::jsonb, NOW(), NOW()) ON CONFLICT (user_id) DO NOTHING`,
      [user.id],
    )

    await pool.query('ALTER TABLE ai_model_settings DROP CONSTRAINT IF EXISTS tmp_v4_batch_guard')
    await pool.query(`ALTER TABLE ai_model_settings ADD CONSTRAINT tmp_v4_batch_guard CHECK (model <> '__v4_batch_fail__')`)
    try {
      const res = await batchPut({
        providerId,
        items: [
          { model: 'ba', patch: { enabled: true, contextWindow: 50000 } },
          { model: '__v4_batch_fail__', patch: { enabled: true } },
        ],
      }, headers)
      expect(res.status, JSON.stringify(res.body)).toBe(500)
    } finally {
      await pool.query('ALTER TABLE ai_model_settings DROP CONSTRAINT IF EXISTS tmp_v4_batch_guard')
    }

    expect(await readRow(providerId, 'ba')).toBeNull()
    expect(await readRow(providerId, '__v4_batch_fail__')).toBeNull()
    expect((await readSelected(user.id))[providerId]).toBeUndefined()
  })

  it('同一批次内对同一模型两次 patch：第二次基于第一次结果合并（事务内读得到未提交写入）', async () => {
    const providerId = await createProvider({ model: 'dup', models: ['dup'] })
    const res = await batchPut({
      providerId,
      items: [
        { model: 'dup', patch: { contextWindow: 50000 } },
        { model: 'dup', patch: { maxOutput: 1234 } },
      ],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.updated).toBe(2)
    const row = await readRow(providerId, 'dup')
    // 若第二次读的是池连接上的旧值（预设 128000），contextWindow 会被打回 128000
    expect(row.context_window).toBe(50000)
    expect(row.max_output).toBe(1234)
  })

  it('items 校验：非数组 / 空 / 超 200 / 元素非法 → 400', async () => {
    const providerId = await createProvider({ model: 'gpt-4o', models: ['gpt-4o'] })
    expect((await batchPut({ providerId, items: 'x' })).status).toBe(400)
    expect((await batchPut({ providerId, items: [] })).status).toBe(400)

    const tooMany = await batchPut({
      providerId,
      items: Array.from({ length: 201 }, (_, i) => ({ model: `m-${i}`, patch: {} })),
    })
    expect(tooMany.status).toBe(400)
    expect(tooMany.body.code).toBe('ITEMS_TOO_MANY')

    const badItem = await batchPut({ providerId, items: ['gpt-4o'] })
    expect(badItem.status).toBe(400)
    expect(badItem.body.index).toBe(0)
    expect(badItem.body.code).toBe('INVALID_BATCH_ITEM')

    const noModel = await batchPut({ providerId, items: [{ patch: {} }] })
    expect(noModel.status).toBe(400)
    expect(noModel.body.field).toBe('model')

    const badAlias = await batchPut({ providerId, items: [{ model: 'gpt-4o', patch: { alias: 'x'.repeat(81) } }] })
    expect(badAlias.status).toBe(400)
    expect(badAlias.body.field).toBe('alias')

    // 边界：200 条合法 → 200
    const exactly = await batchPut({
      providerId,
      items: Array.from({ length: 200 }, (_, i) => ({ model: `m-${i}`, patch: { sortOrder: i } })),
    })
    expect(exactly.status, JSON.stringify(exactly.body).slice(0, 200)).toBe(200)
    expect(exactly.body.updated).toBe(200)
  })

  it('IDOR：他人 / 不存在 / 非法 providerId → 404，且不写别人的行', async () => {
    const victim = await createUser('b3')
    const victimProvider = await createProvider({ userId: victim.id, model: 'ba', models: ['ba'] })

    const other = await batchPut({ providerId: victimProvider, items: [{ model: 'ba', patch: { contextWindow: 50000 } }] })
    expect([403, 404]).toContain(other.status)
    expect(other.status).toBe(404)
    expect(await readRow(victimProvider, 'ba')).toBeNull()

    expect((await batchPut({ providerId: 'not-a-uuid', items: [{ model: 'ba', patch: {} }] })).status).toBe(404)
    expect((await batchPut({ providerId: '11111111-1111-1111-1111-111111111111', items: [{ model: 'ba', patch: {} }] })).status).toBe(404)
  })

  it('未登录 → 401；独立限流桶：10 次/分/用户，第 11 次 429', async () => {
    const providerId = await createProvider({ model: 'gpt-4o', models: ['gpt-4o'] })
    const anon = await request(app).put('/api/ai/model-settings/batch').send({ providerId, items: [{ model: 'gpt-4o', patch: {} }] })
    expect(anon.status).toBe(401)

    for (let i = 0; i < 10; i++) {
      const res = await batchPut({ providerId, items: [{ model: 'gpt-4o', patch: { sortOrder: i } }] })
      expect(res.status, `第 ${i + 1} 次应当放行`).toBe(200)
    }
    const blocked = await batchPut({ providerId, items: [{ model: 'gpt-4o', patch: {} }] })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('batch 支持「回退预设」语义：patch 里传 null（数值列写 NULL，读时回预设）', async () => {
    const providerId = await createProvider({ model: 'gpt-4o', models: ['gpt-4o'] })
    await batchPut({ providerId, items: [{ model: 'gpt-4o', patch: { contextWindow: 64000, alias: 'X', sortOrder: 5 } }] })
    const res = await batchPut({
      providerId,
      items: [{ model: 'gpt-4o', patch: { contextWindow: null, alias: '', sortOrder: null, supportsVideo: null } }],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.items[0].contextWindow).toBe(128000) // 回退 gpt-4o 预设
    expect(res.body.items[0].alias).toBeNull()
    expect(res.body.items[0].sortOrder).toBeNull()
    expect(res.body.items[0].supportsVideo).toBe(false)
    const row = await readRow(providerId, 'gpt-4o')
    expect(row.context_window).toBeNull()
    expect(row.alias).toBeNull()
    expect(row.sort_order).toBeNull()
  })

  it('既有的单条 PUT 与 probe 端点行为不受影响（新增而非替换）', async () => {
    const providerId = await createProvider({ provider: 'openai', model: 'gpt-5', models: ['gpt-5'], baseUrl: 'https://api.openai.com/v1' })
    const single = await request(app)
      .put('/api/ai/model-settings')
      .set(auth)
      .send({ providerId, model: 'gpt-5', patch: { alias: '单条仍可用' } })
    expect(single.status, JSON.stringify(single.body)).toBe(200)
    expect(single.body.item.alias).toBe('单条仍可用')

    // probe 仍走可注入 fetch（本次不动它，只确认路由还在且语义不变）
    setProbeFetchImpl(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    }))
    const probed = await request(app).post('/api/ai/model-settings/probe').set(auth).send({ providerId, model: 'gpt-5' })
    expect(probed.status).toBe(200)
    expect(probed.body.ok).toBe(true)
    expect(probed.body.supportsReasoningParam).toBe(true)
  })
})
