/**
 * 契约 v5：`enabled` 的唯一事实来源（根因修复 —— 刷新后 169 个胶囊全被算作"已启用"）。
 *
 * 用户实测：新加供应商 → 只勾 1 个模型 → 保存 → 再点「刷新模型列表」继续加 ⇒ 169 个胶囊
 * 又全变"已启用/选中" ✗。根因：GET /api/ai/model-settings 与 POST /resolve 对**没有
 * ai_model_settings 行的模型**默认返回 enabled=true，而刷新出来的模型天生没有行 ⇒ 全军覆没。
 *
 * 新规则（GET 与 resolve 必须一致）：
 *   有行                                  → row.enabled            （显式覆盖优先）
 *   无行 + 在 selected_models[providerId] → true
 *   无行 + 不在 selected_models 里        → false                  ← 本次修正的核心
 *   草稿态（resolve 无 providerId）        → 一律 false
 *
 * 写路径语义：显式传 enabled 才改；不传则"不动"（不动的是**当前解析值**，不是列默认 true）——
 * 否则"只改上下文窗口"会给刷新出来的模型凭空建一条 enabled=true 的行，把它变成已选中。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import pool from '../src/db/pool.js'
import { authHeaders, ensureAuthUser, TEST_USER_ID } from './test-helpers.js'
import { encrypt } from '../src/utils/encryption.js'
import { isModelSelected, mergeModelSettings } from '../src/utils/aiModelSettings.js'
import { resolveModelPreset } from '../src/utils/modelPresets.js'

let app
let auth
let owner
let ownerAuth
const createdProviderIds = []
const createdUserIds = []
const stamp = Date.now().toString().slice(-6)

async function createUser(suffix) {
  const phone = `1394${suffix}${stamp.slice(-5)}`.slice(0, 11)
  const { rows } = await pool.query(
    `INSERT INTO users (phone, password_hash, nickname, created_at, updated_at)
     VALUES ($1, 'test_hash', $2, NOW(), NOW()) RETURNING id`,
    [phone, `v5_${suffix}_${stamp}`],
  )
  createdUserIds.push(rows[0].id)
  const id = rows[0].id
  await pool.query(
    `INSERT INTO ai_settings (user_id, selected_models, created_at, updated_at)
     VALUES ($1, '{}'::jsonb, NOW(), NOW()) ON CONFLICT (user_id) DO NOTHING`,
    [id],
  )
  return { id, phone }
}

async function createProvider({ userId = TEST_USER_ID, model = 'gpt-4o', models = [] } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ai_providers (user_id, provider, name, api_key_encrypted, base_url, model, models, api_format)
     VALUES ($1, 'custom', $2, $3, 'http://127.0.0.1:9/v1', $4, $5::jsonb, 'openai') RETURNING id`,
    [userId, `v5_${stamp}_${createdProviderIds.length}`, encrypt('sk-v5'), model, JSON.stringify(models)],
  )
  createdProviderIds.push(rows[0].id)
  return rows[0].id
}

async function setSelected(userId, providerId, value) {
  await pool.query(
    `UPDATE ai_settings SET selected_models = $2::jsonb, updated_at = NOW() WHERE user_id = $1`,
    [userId, JSON.stringify({ [providerId]: value })],
  )
}

const getSettings = (providerId, headers) =>
  request(app).get(`/api/ai/model-settings?providerId=${providerId}`).set(headers)
const resolveModels = (body, headers) =>
  request(app).post('/api/ai/model-settings/resolve').set(headers).send(body)
const putSetting = (body, headers) =>
  request(app).put('/api/ai/model-settings').set(headers).send(body)
const batchPut = (body, headers) =>
  request(app).put('/api/ai/model-settings/batch').set(headers).send(body)

/** 用户场景：上游刷新出 169 个候选（ai_providers.models），ai_model_settings 里一行都没有 */
const REFRESHED_169 = Array.from({ length: 169 }, (_, i) => `model-${String(i).padStart(3, '0')}`)

beforeAll(async () => {
  const mod = await import('../src/index.js')
  app = mod.app
  await ensureAuthUser(pool)
  auth = authHeaders()
  owner = await createUser('o')
  ownerAuth = authHeaders({ userId: owner.id, phone: owner.phone })
})

afterAll(async () => {
  for (const id of createdProviderIds) {
    await pool.query('DELETE FROM ai_providers WHERE id = $1', [id]).catch(() => {})
  }
  for (const id of createdUserIds) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
  }
})

describe('v5 核心：刷新出的模型默认"未启用"，只有 selected_models 里的才算选中', () => {
  it('① 169 个候选 + selected_models 只含 1 个 + 零覆盖行 ⇒ GET 恰好 1 个 enabled=true', async () => {
    const providerId = await createProvider({
      userId: owner.id,
      model: 'model-000',
      models: REFRESHED_169,
    })
    await setSelected(owner.id, providerId, 'model-000')

    // 前提断言：这个 provider 下确实一行 ai_model_settings 都没有
    const rows = await pool.query('SELECT count(*)::int AS n FROM ai_model_settings WHERE provider_id = $1', [providerId])
    expect(rows.rows[0].n).toBe(0)

    const res = await getSettings(providerId, ownerAuth)
    expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(200)
    expect(res.body.items).toHaveLength(169)
    const enabled = res.body.items.filter((i) => i.enabled === true)
    expect(enabled.map((i) => i.model)).toEqual(['model-000'])
    expect(res.body.items.filter((i) => i.enabled === false)).toHaveLength(168)
    // 值口径不变：非选中模型仍然带着预设/内置窗口等，只是"未启用"
    const one = res.body.items.find((i) => i.model === 'model-001')
    expect(one.enabled).toBe(false)
    expect(one.isOverridden).toBe(false)
    expect(one.applicability).toBe('chat')

    // 读接口不写库
    const after = await pool.query('SELECT count(*)::int AS n FROM ai_model_settings WHERE provider_id = $1', [providerId])
    expect(after.rows[0].n).toBe(0)
  })

  it('①-b selected_models 为数组/对象（历史形态）同样算选中', async () => {
    const providerId = await createProvider({ userId: owner.id, model: 'a-1', models: ['a-1', 'a-2', 'a-3'] })
    await setSelected(owner.id, providerId, ['a-1', 'a-3'])
    let res = await getSettings(providerId, ownerAuth)
    expect(res.body.items.filter((i) => i.enabled).map((i) => i.model).sort()).toEqual(['a-1', 'a-3'])

    await setSelected(owner.id, providerId, { model: 'a-2' })
    res = await getSettings(providerId, ownerAuth)
    expect(res.body.items.filter((i) => i.enabled).map((i) => i.model)).toEqual(['a-2'])
  })

  it('② 显式覆盖行优先：行 false 即便在 selected_models 里也是 false；行 true 即便不在也是 true', async () => {
    const providerId = await createProvider({ userId: owner.id, model: 'r-1', models: ['r-1', 'r-2'] })
    await setSelected(owner.id, providerId, 'r-1')

    // 行 enabled=false 但仍在 selected_models 里 ⇒ 行覆盖 ⇒ false
    const off = await putSetting({ providerId, model: 'r-1', patch: { enabled: false } }, ownerAuth)
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    let res = await getSettings(providerId, ownerAuth)
    expect(res.body.items.find((i) => i.model === 'r-1').enabled).toBe(false)
    expect((await pool.query('SELECT enabled FROM ai_model_settings WHERE provider_id=$1 AND model=$2', [providerId, 'r-1'])).rows[0].enabled).toBe(false)

    // 行 enabled=true 但不在 selected_models 里 ⇒ 行覆盖 ⇒ true
    const on = await putSetting({ providerId, model: 'r-2', patch: { enabled: true } }, ownerAuth)
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    res = await getSettings(providerId, ownerAuth)
    expect(res.body.items.find((i) => i.model === 'r-2').enabled).toBe(true)
    // 且启用会把该模型写入 selected_models（写入联动不变）
    const sel = await pool.query('SELECT selected_models FROM ai_settings WHERE user_id = $1', [owner.id])
    expect(sel.rows[0].selected_models[providerId]).toBe('r-2')
  })

  it('③ resolve：无 providerId ⇒ 全 false（草稿态）；有 providerId ⇒ 与 GET 逐字段同值', async () => {
    const providerId = await createProvider({ userId: owner.id, model: 'model-000', models: REFRESHED_169 })
    await setSelected(owner.id, providerId, 'model-000')

    const draft = await resolveModels({ models: REFRESHED_169.slice(0, 20) }, ownerAuth)
    expect(draft.status).toBe(200)
    expect(draft.body.items.every((i) => i.enabled === false)).toBe(true)

    const withProvider = await resolveModels({ models: REFRESHED_169, providerId }, ownerAuth)
    const viaGet = await getSettings(providerId, ownerAuth)
    expect(withProvider.status).toBe(200)
    const resBy = Object.fromEntries(withProvider.body.items.map((i) => [i.model, i]))
    const getBy = Object.fromEntries(viaGet.body.items.map((i) => [i.model, i]))
    for (const model of REFRESHED_169) {
      expect(resBy[model], `resolve 应包含 ${model}`).toBeTruthy()
      expect(resBy[model]).toEqual(getBy[model])
    }
    expect(withProvider.body.items.filter((i) => i.enabled === true).map((i) => i.model)).toEqual(['model-000'])
  })

  it('④ 写路径："不传 enabled 不动" —— 只改配置不会把未选中的模型变成已启用', async () => {
    const providerId = await createProvider({ userId: owner.id, model: 'w-1', models: ['w-1', 'w-2'] })
    await setSelected(owner.id, providerId, 'w-1')

    // 未选中的 w-2：只改上下文窗口（patch 里没有 enabled）
    const put = await putSetting({ providerId, model: 'w-2', patch: { contextWindow: 32000 } }, ownerAuth)
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(put.body.item.contextWindow).toBe(32000)
    expect(put.body.item.enabled).toBe(false) // 不动 = 仍是"未启用"
    const row = await pool.query('SELECT enabled, context_window FROM ai_model_settings WHERE provider_id=$1 AND model=$2', [providerId, 'w-2'])
    expect(row.rows[0].enabled).toBe(false)
    expect(row.rows[0].context_window).toBe(32000)
    // 联动也没被碰：selected_models 仍是 w-1
    const sel = await pool.query('SELECT selected_models FROM ai_settings WHERE user_id = $1', [owner.id])
    expect(sel.rows[0].selected_models[providerId]).toBe('w-1')

    // batch 同理
    const batch = await batchPut({ providerId, items: [{ model: 'w-1', patch: { maxOutput: 2048 } }] }, ownerAuth)
    expect(batch.status, JSON.stringify(batch.body)).toBe(200)
    expect(batch.body.items[0].enabled).toBe(true) // w-1 本就在 selected_models 里 ⇒ 保持启用
    // 显式 enabled 仍然照常生效
    const off = await putSetting({ providerId, model: 'w-1', patch: { enabled: false } }, ownerAuth)
    expect(off.body.item.enabled).toBe(false)
    const on = await putSetting({ providerId, model: 'w-2', patch: { enabled: true } }, ownerAuth)
    expect(on.body.item.enabled).toBe(true)
  })

  it('⑤ 空/未见过的模型名 ⇒ enabled=false，isPreset 仍按名字判定', async () => {
    const providerId = await createProvider({ userId: owner.id, model: 'gpt-4o', models: ['gpt-4o'] })
    const res = await resolveModels({ models: ['gpt-4o', 'never-seen-xyz'] }, ownerAuth)
    const by = Object.fromEntries(res.body.items.map((i) => [i.model, i]))
    expect(by['gpt-4o'].enabled).toBe(false)
    expect(by['gpt-4o'].isPreset).toBe(true)
    expect(by['never-seen-xyz'].enabled).toBe(false)
    expect(by['never-seen-xyz'].isPreset).toBe(false)
    // 该 provider 下也没有行（读接口不建行）
    const rows = await pool.query('SELECT count(*)::int AS n FROM ai_model_settings WHERE provider_id = $1', [providerId])
    expect(rows.rows[0].n).toBe(0)
  })

  it('纯函数：isModelSelected 三形态 + mergeModelSettings 的 v5 口径', () => {
    expect(isModelSelected({ p: 'a' }, 'p', 'a')).toBe(true)
    expect(isModelSelected({ p: 'a' }, 'p', 'b')).toBe(false)
    expect(isModelSelected({ p: ['a', 'b'] }, 'p', 'b')).toBe(true)
    expect(isModelSelected({ p: [{ model: 'a' }] }, 'p', 'a')).toBe(true)
    expect(isModelSelected({ p: { modelId: 'a' } }, 'p', 'a')).toBe(true)
    expect(isModelSelected({}, 'p', 'a')).toBe(false)
    expect(isModelSelected(null, 'p', 'a')).toBe(false)

    const preset = resolveModelPreset('gpt-4o')
    // 提供选中态上下文：无行 ⇒ 看 selected_models
    expect(mergeModelSettings('gpt-4o', preset, null, { selectedModels: { p: 'gpt-4o' }, providerId: 'p' }).enabled).toBe(true)
    expect(mergeModelSettings('gpt-4o', preset, null, { selectedModels: {}, providerId: 'p' }).enabled).toBe(false)
    // 有行 ⇒ 行优先
    expect(mergeModelSettings('gpt-4o', preset, { enabled: true }, { selectedModels: {}, providerId: 'p' }).enabled).toBe(true)
    expect(mergeModelSettings('gpt-4o', preset, { enabled: false }, { selectedModels: { p: 'gpt-4o' }, providerId: 'p' }).enabled).toBe(false)
  })
})
