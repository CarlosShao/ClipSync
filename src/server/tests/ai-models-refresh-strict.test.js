/**
 * 刷新模型列表：**不假成功 + 不毁数据**（本轮用户实测缺陷的回归测试）
 *
 * 用户实测：服务端跑在 Docker 里，供应商 Base URL = http://127.0.0.1:3800/v1（容器内的 127.0.0.1
 * 是容器自己 ⇒ 从容器视角必然连不上），点「刷新模型列表」→ 界面弹「模型列表已刷新」却一个模型
 * 都没有（该网关其实有很多模型）。
 *
 * 两个缺陷（本文件把它们钉成不可回退的契约）：
 *   ① 静默失败 + 假成功：旧实现 catch 吞掉上游错误，且 fetchProviderModels 失败时还会回退
 *      preset.defaultModel（custom 预设没有默认模型 ⇒ []）→ 调用方无法区分"失败/空/有值"，
 *      接口永远 200 → 前端只能弹"已刷新"。
 *   ② 数据破坏：旧实现无论成败都 `UPDATE ai_providers SET models = …` —— 一次网络抖动就把上一次
 *      成功刷出来的模型列表清空。
 *
 * 新契约：
 *   · 上游失败              → 4xx/5xx + 稳定 code + details{upstreamStatus,upstreamMessage}，**库不动**
 *   · 上游 200 但结构非法    → 同上（ai_upstream_invalid_response），**库不动**
 *   · 上游 200 且 data:[]    → 200 { models: [], upstreamEmpty: true }（合法空列表，允许写库）
 *   · 上游 200 且 data:[N]   → 200 { models, count:N, upstreamEmpty:false }，写库
 *   · 容器 + 回环地址        → code=ai_base_url_loopback_in_container + 可直接照做的替换地址
 *   · POST fetch-models（预览）与 GET 同一套失败语义，但**任何情况都不写库**
 *
 * 出网一律用注入的假 fetch（setModelsFetchImpl / opts.fetchImpl），**不发任何真实外网**。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import request from 'supertest'
import pool from '../src/db/pool.js'
import { authHeaders, ensureAuthUser, TEST_USER_ID } from './test-helpers.js'
import { encrypt } from '../src/utils/encryption.js'
import {
  fetchProviderModelsStrict,
  fetchProviderModels,
  setModelsFetchImpl,
  resetModelsFetchImpl,
  isRunningInContainer,
  isLoopbackUpstreamHost,
  AI_UPSTREAM_IN_CONTAINER_ENV,
} from '../src/utils/aiProviders.js'

let app
let auth

const createdProviderIds = []
const stamp = Math.random().toString(36).slice(2, 8)

beforeAll(async () => {
  const mod = await import('../src/index.js')
  app = mod.app
  await ensureAuthUser(pool)
  auth = authHeaders()
})

afterAll(async () => {
  resetModelsFetchImpl()
  for (const id of createdProviderIds) {
    await pool.query('DELETE FROM ai_providers WHERE id = $1', [id]).catch(() => {})
  }
})

afterEach(() => {
  resetModelsFetchImpl()
  delete process.env[AI_UPSTREAM_IN_CONTAINER_ENV]
})

/* ===================== 夹具 ===================== */

async function createProvider({ baseUrl = 'http://127.0.0.1:3800/v1', provider = 'custom', models = [], apiKey = 'sk-test' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ai_providers (user_id, provider, name, api_key_encrypted, base_url, model, models, api_format)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'openai') RETURNING id, models`,
    [TEST_USER_ID, provider, `strict_${provider}_${stamp}_${createdProviderIds.length}`, encrypt(apiKey), baseUrl, 'm', JSON.stringify(models)],
  )
  createdProviderIds.push(rows[0].id)
  return rows[0].id
}

const readModels = async (id) => (await pool.query('SELECT models FROM ai_providers WHERE id = $1', [id])).rows[0].models
const refresh = (id, headers = auth) => request(app).get(`/api/ai/providers/${id}/models`).set(headers)
const preview = (body) => request(app).post('/api/ai/providers/fetch-models').set(auth).send(body)

/** 假上游响应（只实现 fetchProviderModelsStrict 用到的字段：ok/status/text） */
function fakeResponse(status, body, { raw } = {}) {
  const text = raw !== undefined ? raw : typeof body === 'string' ? body : JSON.stringify(body ?? {})
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}

/** 固定的假 fetch：永远返回同一个响应，并记录调用 */
function fetchReturning(resp) {
  const calls = []
  const fn = async (url, options) => {
    calls.push({ url, options })
    return resp
  }
  fn.calls = calls
  return fn
}

/** 固定的假 fetch：永远抛同一个错误 */
function fetchThrowing(err) {
  const calls = []
  const fn = async (url, options) => {
    calls.push({ url, options })
    throw err
  }
  fn.calls = calls
  return fn
}

const connRefused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3800'), { code: 'ECONNREFUSED' })
const timeoutErr = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })

/* ===================== A. 单元层：fetchProviderModelsStrict ===================== */

describe('A. fetchProviderModelsStrict —— 失败不回退预设默认模型（"假成功"根因）', () => {
  it('① 上游连不通 → ok:false + ai_upstream_unavailable（**不回退** stepfun 预设默认模型）', async () => {
    const r = await fetchProviderModelsStrict(
      { provider: 'stepfun', baseUrl: 'http://127.0.0.1:3800/v1', apiKey: 'sk-x' },
      { fetchImpl: fetchThrowing(connRefused()), isInContainer: false },
    )
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ai_upstream_unavailable')
    expect(r.httpStatus).toBe(502)
    expect(r.details.upstreamMessage).toMatch(/ECONNREFUSED/)
    // ★ 关键：不再把 step-3.7-flash（预设默认模型）冒充成"刷新结果"
    expect(r.models).toBeUndefined()
  })

  it('① 超时 → ai_upstream_timeout / 504', async () => {
    const r = await fetchProviderModelsStrict(
      { provider: 'custom', baseUrl: 'http://127.0.0.1:3800/v1', apiKey: 'sk-x' },
      { fetchImpl: fetchThrowing(timeoutErr()), isInContainer: false },
    )
    expect(r.code).toBe('ai_upstream_timeout')
    expect(r.httpStatus).toBe(504)
  })

  it('② 200 但非 JSON / 无 data 数组 / 条目没有 id → ai_upstream_invalid_response', async () => {
    const cases = [
      fakeResponse(200, null, { raw: 'not-json-at-all' }),
      fakeResponse(200, { object: 'list' }),
      fakeResponse(200, { data: 'nope' }),
      fakeResponse(200, { data: [{ foo: 1 }, { bar: 2 }] }),
    ]
    for (const resp of cases) {
      const r = await fetchProviderModelsStrict(
        { provider: 'custom', baseUrl: 'http://127.0.0.1:3800/v1', apiKey: 'sk-x' },
        { fetchImpl: fetchReturning(resp), isInContainer: false },
      )
      expect(r.ok, JSON.stringify(resp)).toBe(false)
      expect(r.code, JSON.stringify(resp)).toBe('ai_upstream_invalid_response')
      expect(r.httpStatus).toBe(502)
      expect(r.details.upstreamStatus).toBe(200)
    }
  })

  it('③ data: [] → ok:true 且 upstreamEmpty=true（合法空列表，不是失败）', async () => {
    const r = await fetchProviderModelsStrict(
      { provider: 'custom', baseUrl: 'http://127.0.0.1:3800/v1', apiKey: 'sk-x' },
      { fetchImpl: fetchReturning(fakeResponse(200, { object: 'list', data: [] })), isInContainer: false },
    )
    expect(r.ok).toBe(true)
    expect(r.models).toEqual([])
    expect(r.count).toBe(0)
    expect(r.upstreamEmpty).toBe(true)
  })

  it('④ N 个模型 → 去重保序 + count；请求头带 Bearer key 且打到 {baseUrl}/models', async () => {
    const fn = fetchReturning(
      fakeResponse(200, { object: 'list', data: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-1' }, { nope: 1 }] }),
    )
    const r = await fetchProviderModelsStrict(
      { provider: 'custom', baseUrl: 'http://127.0.0.1:3800/v1', apiKey: 'sk-secret' },
      { fetchImpl: fn, isInContainer: false },
    )
    expect(r.ok).toBe(true)
    expect(r.models).toEqual(['m-1', 'm-2'])
    expect(r.count).toBe(2)
    expect(r.upstreamEmpty).toBe(false)
    expect(fn.calls[0].url).toBe('http://127.0.0.1:3800/v1/models')
    expect(fn.calls[0].options.headers.Authorization).toBe('Bearer sk-secret')
  })

  it('⑤ 容器 + 回环 → ai_base_url_loopback_in_container + 可照做的替换地址', async () => {
    const r = await fetchProviderModelsStrict(
      { provider: 'custom', baseUrl: 'http://127.0.0.1:3800/v1', apiKey: 'sk-x' },
      { fetchImpl: fetchThrowing(connRefused()), isInContainer: true },
    )
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ai_base_url_loopback_in_container')
    expect(r.httpStatus).toBe(502)
    expect(r.message).toContain('127.0.0.1')
    // 建议必须是"用户该填的 Base URL"：带真实端口 + 原路径前缀，且**不含**内部拼的 /models
    expect(r.message).toContain('http://host.docker.internal:3800/v1（')
    expect(r.message).toContain('http://192.168.1.10:3800/v1。')
    expect(r.message).not.toContain('/models')
  })

  it('⑤ 非容器（或非回环主机）→ 不误报容器提示', async () => {
    const notContainer = await fetchProviderModelsStrict(
      { provider: 'custom', baseUrl: 'http://127.0.0.1:3800/v1', apiKey: 'sk-x' },
      { fetchImpl: fetchThrowing(connRefused()), isInContainer: false },
    )
    expect(notContainer.code).toBe('ai_upstream_unavailable')

    const containerPublic = await fetchProviderModelsStrict(
      { provider: 'custom', baseUrl: 'http://8.8.8.8/v1', apiKey: 'sk-x' },
      { fetchImpl: fetchThrowing(connRefused()), isInContainer: true },
    )
    expect(containerPublic.code).toBe('ai_upstream_unavailable')
  })

  it('上游非 2xx → 状态分类 + 原样带 upstreamStatus/Message/ErrorCode', async () => {
    const resp = fakeResponse(404, { error: { message: 'no such route', code: 'not_found' } })
    const r = await fetchProviderModelsStrict(
      { provider: 'custom', baseUrl: 'http://127.0.0.1:3800/v1', apiKey: 'sk-x' },
      { fetchImpl: fetchReturning(resp), isInContainer: false },
    )
    expect(r.code).toBe('ai_upstream_endpoint')
    expect(r.httpStatus).toBe(502)
    expect(r.details.upstreamStatus).toBe(404)
    expect(r.details.upstreamErrorCode).toBe('not_found')
    expect(r.details.upstreamMessage).toContain('no such route')
  })

  it('SSRF 策略拒绝时原样透传 ai_base_url_*（且**不发请求**）', async () => {
    const fn = fetchReturning(fakeResponse(200, { data: [] }))
    const r = await fetchProviderModelsStrict(
      { provider: 'custom', baseUrl: 'http://169.254.169.254/latest/meta-data', apiKey: 'sk-x' },
      { fetchImpl: fn, isInContainer: false },
    )
    expect(r.code).toBe('ai_base_url_blocked_address')
    expect(r.httpStatus).toBe(400)
    expect(fn.calls).toHaveLength(0)
  })

  it('缺 key / 缺 baseUrl / 未知预设 → 前置失败（不发请求）', async () => {
    const noKey = await fetchProviderModelsStrict(
      { provider: 'custom', baseUrl: 'http://127.0.0.1:3800/v1' },
      { fetchImpl: fetchReturning(fakeResponse(200, { data: [] })) },
    )
    expect(noKey.code).toBe('ai_no_api_key')
    const noBase = await fetchProviderModelsStrict({ provider: 'custom', apiKey: 'sk-x' }, { fetchImpl: () => {} })
    expect(noBase.code).toBe('ai_no_base_url')
    const unknown = await fetchProviderModelsStrict({ provider: 'nope', baseUrl: 'http://8.8.8.8/v1', apiKey: 'k' }, { fetchImpl: () => {} })
    expect(unknown.code).toBe('ai_no_provider')
  })

  it('旧接口 fetchProviderModels 仍是"吞错 + 回退预设"（已标 @deprecated，仅供历史调用）', async () => {
    setModelsFetchImpl(fetchThrowing(connRefused()))
    const r = await fetchProviderModels({ provider: 'stepfun', baseUrl: 'http://127.0.0.1:3800/v1', apiKey: 'sk-x' })
    expect(r).toEqual(['step-3.7-flash']) // 预设默认模型兜底 —— 这正是新路径不再做的"假成功"
  })
})

/* ===================== B. 容器判定（注入缝，不依赖测试机真的是容器） ===================== */

describe('B. isRunningInContainer / isLoopbackUpstreamHost', () => {
  const fakeFs = ({ dockerenv = false, cgroup = '' } = {}) => ({
    existsSync: (p) => p === '/.dockerenv' && dockerenv,
    readFileSync: () => cgroup,
  })

  it('未命中任何标记 → 宿主机（不误判）', () => {
    expect(isRunningInContainer({ env: {}, fs: fakeFs() })).toBe(false)
  })

  it('/.dockerenv 存在 → 容器', () => {
    expect(isRunningInContainer({ env: {}, fs: fakeFs({ dockerenv: true }) })).toBe(true)
  })

  it('/proc/1/cgroup 命中 docker/kubepods → 容器', () => {
    expect(isRunningInContainer({ env: {}, fs: fakeFs({ cgroup: '11:devices:/docker/abc123' }) })).toBe(true)
    expect(isRunningInContainer({ env: {}, fs: fakeFs({ cgroup: '1:name=systemd:/kubepods/besteffort/pod1' }) })).toBe(true)
    expect(isRunningInContainer({ env: {}, fs: fakeFs({ cgroup: '0::/init.scope' }) })).toBe(false)
  })

  it('KUBERNETES_SERVICE_HOST → 容器', () => {
    expect(isRunningInContainer({ env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' }, fs: fakeFs() })).toBe(true)
  })

  it('显式开关 AI_UPSTREAM_IN_CONTAINER 优先（1/true 视为容器，0/false 强制宿主机）', () => {
    expect(isRunningInContainer({ env: { [AI_UPSTREAM_IN_CONTAINER_ENV]: '1' }, fs: fakeFs({ dockerenv: true }) })).toBe(true)
    expect(isRunningInContainer({ env: { [AI_UPSTREAM_IN_CONTAINER_ENV]: 'true' }, fs: fakeFs() })).toBe(true)
    expect(isRunningInContainer({ env: { [AI_UPSTREAM_IN_CONTAINER_ENV]: 'false' }, fs: fakeFs({ dockerenv: true }) })).toBe(false)
    expect(isRunningInContainer({ env: { [AI_UPSTREAM_IN_CONTAINER_ENV]: '0' }, fs: fakeFs({ cgroup: '/docker/x' }) })).toBe(false)
  })

  it('isLoopbackUpstreamHost：127/8、::1、localhost 是回环；私网/公网/网关别名不是', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost', 'LOCALHOST', 'localhost.', ' 127.0.0.1 ']) {
      expect(isLoopbackUpstreamHost(h), h).toBe(true)
    }
    for (const h of ['192.168.1.10', '10.0.0.5', '8.8.8.8', 'host.docker.internal', '', 'metadata.google.internal']) {
      expect(isLoopbackUpstreamHost(h), h).toBe(false)
    }
  })
})

/* ===================== C. 路由层：GET /providers/:id/models ===================== */

describe('C. GET /api/ai/providers/:id/models —— 失败不假成功、不毁数据', () => {
  it('① 上游连不通 → 502 + code + details，且**库里的 models 一字未改**', async () => {
    const id = await createProvider({ models: ['keep-a', 'keep-b'] })
    setModelsFetchImpl(fetchThrowing(connRefused()))

    const res = await refresh(id)
    expect(res.status, JSON.stringify(res.body)).toBe(502)
    expect(res.body.code).toBe('ai_upstream_unavailable')
    expect(res.body.details.upstreamMessage).toMatch(/ECONNREFUSED/)
    expect(res.body.provider.name).toContain('strict_')
    // ★ 核心断言：失败不覆盖已存列表（旧实现会把它写成 []）
    expect(await readModels(id)).toEqual(['keep-a', 'keep-b'])
    // 响应也把"未改动的列表"带回去，前端可继续展示
    expect(res.body.models).toEqual(['keep-a', 'keep-b'])
    expect(res.body.modelsUnchanged).toBe(true)
  })

  it('② 上游 200 但结构非法 → 502 + ai_upstream_invalid_response，库仍未改', async () => {
    const id = await createProvider({ models: ['keep-a'] })
    setModelsFetchImpl(fetchReturning(fakeResponse(200, { object: 'list', models: ['m1'] })))

    const res = await refresh(id)
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('ai_upstream_invalid_response')
    expect(res.body.details.upstreamStatus).toBe(200)
    expect(await readModels(id)).toEqual(['keep-a'])
  })

  it('上游 503 → 502 + ai_upstream_unavailable + upstreamStatus=503，库仍未改', async () => {
    const id = await createProvider({ models: ['keep-a'] })
    setModelsFetchImpl(fetchReturning(fakeResponse(503, { error: { message: 'upstream busy' } })))

    const res = await refresh(id)
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('ai_upstream_unavailable')
    expect(res.body.upstreamStatus).toBe(503)
    expect(res.body.upstreamMessage).toContain('upstream busy')
    expect(await readModels(id)).toEqual(['keep-a'])
  })

  it('上游 401 → 502 + ai_upstream_auth，库仍未改', async () => {
    const id = await createProvider({ models: ['keep-a'] })
    setModelsFetchImpl(fetchReturning(fakeResponse(401, { error: { message: 'bad key', code: 'invalid_api_key' } })))

    const res = await refresh(id)
    expect(res.body.code).toBe('ai_upstream_auth')
    expect(res.body.upstreamErrorCode).toBe('invalid_api_key')
    expect(await readModels(id)).toEqual(['keep-a'])
  })

  it('③ 上游 200 且 data: [] → 200 { models: [], upstreamEmpty: true }，允许写库为 []', async () => {
    const id = await createProvider({ models: ['old-a', 'old-b'] })
    setModelsFetchImpl(fetchReturning(fakeResponse(200, { object: 'list', data: [] })))

    const res = await refresh(id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.models).toEqual([])
    expect(res.body.count).toBe(0)
    expect(res.body.upstreamEmpty).toBe(true)
    expect(await readModels(id)).toEqual([]) // 合法空列表 = 成功，按契约允许写库
  })

  it('④ 上游 200 且 N 个模型 → 200 + count，写库', async () => {
    const id = await createProvider({ models: ['old'] })
    setModelsFetchImpl(
      fetchReturning(fakeResponse(200, { object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] })),
    )

    const res = await refresh(id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.models).toEqual(['gpt-4o', 'gpt-4o-mini'])
    expect(res.body.count).toBe(2)
    expect(res.body.upstreamEmpty).toBe(false)
    // added/previousCount：前端"新增 N 个模型"的依据（相对刷新前库里的 ['old']）
    expect(res.body.added).toBe(2)
    expect(res.body.previousCount).toBe(1)
    expect(await readModels(id)).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  it('⑤ 容器 + 回环地址（注入环境判定缝）→ ai_base_url_loopback_in_container，库仍未改', async () => {
    const id = await createProvider({ models: ['keep-a'] })
    process.env[AI_UPSTREAM_IN_CONTAINER_ENV] = '1'
    setModelsFetchImpl(fetchThrowing(connRefused()))

    const res = await refresh(id)
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('ai_base_url_loopback_in_container')
    expect(res.body.error).toContain('host.docker.internal:3800/v1（')
    expect(res.body.error).toContain('192.168.1.10:3800/v1。')
    expect(res.body.error).not.toContain('/models')
    expect(await readModels(id)).toEqual(['keep-a'])
  })

  it('⑤ 同一失败在宿主机上仍是 ai_upstream_unavailable（证明差异来自容器判定）', async () => {
    const id = await createProvider({ models: ['keep-a'] })
    process.env[AI_UPSTREAM_IN_CONTAINER_ENV] = '0'
    setModelsFetchImpl(fetchThrowing(connRefused()))

    const res = await refresh(id)
    expect(res.body.code).toBe('ai_upstream_unavailable')
    expect(res.body.error).not.toContain('host.docker.internal')
  })

  it('SSRF 策略仍生效：元数据地址 → 400 + ai_base_url_blocked_address，且不发请求', async () => {
    const id = await createProvider({ baseUrl: 'http://169.254.169.254/latest/meta-data', models: ['keep-a'] })
    const fn = fetchReturning(fakeResponse(200, { data: [{ id: 'evil' }] }))
    setModelsFetchImpl(fn)

    const res = await refresh(id)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('ai_base_url_blocked_address')
    expect(fn.calls).toHaveLength(0)
    expect(await readModels(id)).toEqual(['keep-a'])
  })

  it('没 key 的供应商 → 400 ai_no_api_key；不存在的 id → 404 ai_no_provider', async () => {
    const { rows } = await pool.query(
      `INSERT INTO ai_providers (user_id, provider, name, api_key_encrypted, base_url, model, models)
       VALUES ($1, 'custom', $2, NULL, 'http://127.0.0.1:3800/v1', 'm', '["keep-a"]'::jsonb) RETURNING id`,
      [TEST_USER_ID, `strict_nokey_${stamp}`],
    )
    createdProviderIds.push(rows[0].id)
    const noKey = await refresh(rows[0].id)
    expect(noKey.status).toBe(400)
    expect(noKey.body.code).toBe('ai_no_api_key')

    const missing = await refresh('11111111-1111-1111-1111-111111111111')
    expect(missing.status).toBe(404)
    expect(missing.body.code).toBe('ai_no_provider')
  })
})

/* ===================== D. 路由层：POST /providers/fetch-models（预览，不写库） ===================== */

describe('D. POST /api/ai/providers/fetch-models —— 与刷新同一套失败语义，且绝不写库', () => {
  it('模式 1（providerId）：上游失败 → 502 + code；库不动', async () => {
    const id = await createProvider({ models: ['keep-a', 'keep-b'] })
    setModelsFetchImpl(fetchThrowing(connRefused()))

    const res = await preview({ providerId: id })
    expect(res.status, JSON.stringify(res.body)).toBe(502)
    expect(res.body.code).toBe('ai_upstream_unavailable')
    expect(res.body.details.upstreamMessage).toMatch(/ECONNREFUSED/)
    expect(await readModels(id)).toEqual(['keep-a', 'keep-b'])
  })

  it('模式 1：upstreamEmpty 原样透传给前端', async () => {
    const id = await createProvider({ models: ['keep-a'] })
    setModelsFetchImpl(fetchReturning(fakeResponse(200, { data: [] })))

    const res = await preview({ providerId: id })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.models).toEqual([])
    expect(res.body.upstreamEmpty).toBe(true)
    expect(await readModels(id)).toEqual(['keep-a']) // 预览写不写库：不写
  })

  it('模式 1：成功（N 个）→ 200 + count，库仍不动', async () => {
    const id = await createProvider({ models: ['keep-a'] })
    setModelsFetchImpl(fetchReturning(fakeResponse(200, { data: [{ id: 'a' }, { id: 'b' }] })))

    const res = await preview({ providerId: id })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ models: ['a', 'b'], count: 2, upstreamEmpty: false, added: 2, previousCount: 1 })
    expect(await readModels(id)).toEqual(['keep-a'])
  })

  it('模式 2（未保存配置）：上游失败 → 502 + code + details；成功 → 200', async () => {
    setModelsFetchImpl(fetchThrowing(connRefused()))
    const failed = await preview({ provider: 'custom', apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:3800/v1' })
    expect(failed.status).toBe(502)
    expect(failed.body.code).toBe('ai_upstream_unavailable')
    expect(failed.body.details).toBeTruthy()

    setModelsFetchImpl(fetchReturning(fakeResponse(200, { data: [{ id: 'local-1' }] })))
    const ok = await preview({ provider: 'custom', apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:3800/v1' })
    expect(ok.status).toBe(200)
    expect(ok.body.models).toEqual(['local-1'])
    expect(ok.body.upstreamEmpty).toBe(false)
  })

  it('模式 2：provider=custom 时**确实去连了上游**（不会被预设白名单拦掉）', async () => {
    const fn = fetchReturning(fakeResponse(200, { data: [{ id: 'm-1' }, { id: 'm-2' }] }))
    setModelsFetchImpl(fn)
    const res = await preview({ provider: 'custom', apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:3800/v1' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(fn.calls).toHaveLength(1) // 真的打到了上游
    expect(fn.calls[0].url).toBe('http://127.0.0.1:3800/v1/models')
    expect(fn.calls[0].options.headers.Authorization).toBe('Bearer sk-x')
  })

  it('模式 2：provider 为空/未知 → 400 + 可操作文案，且**一个上游请求都不发**（本轮用户实测的坑）', async () => {
    const fn = fetchReturning(fakeResponse(200, { data: [{ id: 'm-1' }] }))
    setModelsFetchImpl(fn)
    // 草稿态「供应商」下拉为空时前端会发 provider: ''（也可能是 undefined / 不在预设表里的值）
    for (const bad of ['', undefined, 'not-a-preset']) {
      const res = await preview({ provider: bad, apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:3800/v1' })
      expect(res.status, String(bad)).toBe(400)
      expect(res.body.error, String(bad)).toBe('Invalid provider') // 沿用既有 error 值
      expect(res.body.code, String(bad)).toBe('INVALID_PROVIDER')
      expect(String(res.body.message), String(bad)).toContain('Custom')
    }
    // ★ 根因：地址填 127.0.0.1 还是 host.docker.internal 表现一样，就是因为根本没走到上游
    expect(fn.calls).toHaveLength(0)
  })
})
