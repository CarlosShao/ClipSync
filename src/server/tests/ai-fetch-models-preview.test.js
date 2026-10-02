import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import request from 'supertest'
import pool from '../src/db/pool.js'
import { authHeaders, ensureAuthUser, TEST_USER_ID } from './test-helpers.js'

/**
 * POST /api/ai/providers/fetch-models —— 未保存预览模式
 *
 * 背景 1（本文件原有契约）：这个端点曾被 P0 加固（commit 4a67beb）成"只认 providerId"，导致前端
 * 「刷新模型列表」必须先保存一条供应商记录才能用（用户反馈：有 key 和 baseUrl 就该能直接拉列表）。
 * 现在恢复"直接吃表单里的 provider/apiKey/baseUrl"的预览模式，但**必须与保存路径同一套安全强度**：
 * 传入的 baseUrl 走 validateProviderBaseUrl —— 与 POST/PUT /providers 保存路径同一套 SSRF 校验。
 *
 * 背景 2（本次用户反馈的策略变更）：旧策略把「私网/环回地址」一律拒绝，导致桌面端配置**本地聚合
 * 网关**（Base URL = http://127.0.0.1:3800/v1，one-api / vLLM / Ollama 这类）时报
 * 「Base URL resolves to a blocked internal address」。这是正当的自托管用法，现已放行：
 *   ★ 放行（默认 AI_ALLOW_LOCAL_BASE_URL=true）：环回 127/8、::1、localhost；私网 10/8、
 *     172.16/12、192.168/16；IPv6 ULA fc00::/7；以及解析到上述范围的主机名。
 *   ★ 仍禁（与开关无关）：云元数据/链路本地 169.254.0.0/16（含 169.254.169.254）、fe80::/10；
 *     组播/广播/保留/未指定段（0.0.0.0 等）；非 http(s)（file: 等）；带用户信息（user:pass@）。
 *   ★ 开关 AI_ALLOW_LOCAL_BASE_URL=false → 恢复旧行为（内网/环回重新被拒）。
 *
 * 本文件通过**保存路径**（POST /providers，纯校验、不发任何上游请求）与预览路径双向钉住这个策略，
 * 不发任何外部网络请求（127.0.0.1:9 是必然拒连的本地端口，只用来证明"校验已放行"）。
 *
 * 注意：写请求要走真 CSRF 中间件，必须带真签 Bearer 头（authenticateToken 会查库校验账户活性，
 * 所以 beforeAll 里用 ensureAuthUser 建好测试用户）。
 */

let app
let auth
const preview = (body) => request(app).post('/api/ai/providers/fetch-models').set(auth).send(body)
const save = (body) => request(app).post('/api/ai/providers').set(auth).send(body)
// 用一个确定存在的预设（stepfun）+ 显式 baseUrl，避免依赖预设默认地址
const BASE = { provider: 'stepfun', apiKey: 'sk-test-key' }
const NAME_PREFIX = 'ssrf-local-gateway-'
// 每次运行换一个后缀：即使上一次运行异常退出、afterAll 没跑到，也不会撞上残留记录
const RUN = Math.random().toString(36).slice(2, 8)
const nameOf = (label) => `${NAME_PREFIX}${RUN}-${label}`

beforeAll(async () => {
  const mod = await import('../src/index.js')
  app = mod.app
  await ensureAuthUser(pool)
  auth = authHeaders()
})

afterAll(async () => {
  // 清掉本文件新建的供应商（只删自己造的，不动其它用例/真实数据）
  await pool.query('DELETE FROM ai_providers WHERE user_id = $1 AND name LIKE $2', [TEST_USER_ID, `${NAME_PREFIX}%`])
})

afterEach(() => {
  // 开关是环境变量：任何用例结束后必须还原，避免污染同进程内的其它测试文件
  delete process.env.AI_ALLOW_LOCAL_BASE_URL
})

describe('未保存预览：参数校验', () => {
  it('缺 provider → 400 Invalid provider', async () => {
    const res = await preview({ ...BASE, provider: '' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid provider')
  })

  it('未知 provider → 400（不能借 provider 字段绕开预设表）', async () => {
    const res = await preview({ ...BASE, provider: 'not-a-preset' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid provider')
  })

  it('缺 apiKey → 400 apiKey is required（有 key 才能问上游）', async () => {
    const res = await preview({ provider: 'stepfun', baseUrl: 'http://127.0.0.1:3800/v1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('apiKey is required')
  })

  it('非 http(s) 协议 → 400（带稳定 code）', async () => {
    const res = await preview({ ...BASE, baseUrl: 'file:///etc/passwd' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Base URL must use http or https')
    expect(res.body.code).toBe('ai_base_url_scheme_not_allowed')
  })
})

describe('① 本地/内网网关地址通过校验（用户反馈的正当自托管用法）', () => {
  const localUrls = [
    'http://127.0.0.1:3800/v1', // 用户反馈里的本地聚合服务
    'http://192.168.1.10:8000/v1',
    'http://localhost:11434/v1',
    'http://10.0.0.5:8000/v1',
    'http://[::1]:11434/v1',
  ]

  for (const baseUrl of localUrls) {
    it(`保存路径放行 ${baseUrl}（不再报 blocked internal address）`, async () => {
      const res = await save({
        provider: 'custom',
        name: nameOf(Buffer.from(baseUrl).toString('hex').slice(0, 12)),
        baseUrl,
        model: 'local-model',
        models: ['local-model'],
        apiKey: 'sk-local',
      })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(res.body.base_url).toBe(baseUrl)
    })
  }

  it('未保存预览路径同样不再以 SSRF 错误拒绝本地地址', async () => {
    // 127.0.0.1:9 是必然拒连的本地端口：能走到"真实连接失败后回退默认模型"这一步，
    // 就证明它已经穿过了地址校验（旧策略在这里会直接 400 blocked internal address）。
    const res = await preview({ ...BASE, baseUrl: 'http://127.0.0.1:9/v1' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.code).toBeUndefined()
  })
})

describe('② 仍然拒绝：云元数据 / 链路本地 / 保留段 / 协议 / 用户信息', () => {
  const stillBlocked = [
    ['http://169.254.169.254/latest/meta-data/', 'ai_base_url_blocked_address'],
    ['http://[fe80::1]/', 'ai_base_url_blocked_address'],
    ['http://0.0.0.0:8000', 'ai_base_url_blocked_address'],
    ['http://255.255.255.255/', 'ai_base_url_blocked_address'],
    ['file:///etc/passwd', 'ai_base_url_scheme_not_allowed'],
    ['http://user:pass@127.0.0.1:3800/v1', 'ai_base_url_userinfo_not_allowed'],
    ['http://metadata.google.internal/', 'ai_base_url_host_not_allowed'],
  ]

  for (const [baseUrl, code] of stillBlocked) {
    it(`预览路径拒绝 ${baseUrl}（code=${code}）`, async () => {
      const res = await preview({ ...BASE, baseUrl })
      expect(res.status, JSON.stringify(res.body)).toBe(400)
      expect(res.body.code).toBe(code)
      // 文案可行动：写清"哪一类被拒 + 怎么解决"，不是 blocked internal address 黑话
      expect(String(res.body.error)).toMatch(/blocked|not allowed|must use http or https|credentials/i)
      expect(String(res.body.error)).not.toBe('Base URL resolves to a blocked internal address')
    })
  }

  it('保存路径与预览路径对同一危险地址给出同样的拒绝（口径一致）', async () => {
    const baseUrl = 'http://169.254.169.254/latest/meta-data/'
    const saved = await save({
      provider: 'custom',
      name: nameOf('meta'),
      baseUrl,
      model: 'm',
      models: ['m'],
    })
    expect(saved.status).toBe(400)
    expect(saved.body.code).toBe('ai_base_url_blocked_address')
    const prev = await preview({ ...BASE, baseUrl })
    expect(prev.status).toBe(400)
    expect(prev.body.code).toBe('ai_base_url_blocked_address')
    expect(saved.body.addressClass).toBe(prev.body.addressClass)
    expect(saved.body.addressClass).toBe('link-local')
  })
})

describe('③ AI_ALLOW_LOCAL_BASE_URL=false 时开关真的生效（恢复旧行为）', () => {
  it('127.0.0.1 重新被拒，且文案告诉用户怎么开回来', async () => {
    process.env.AI_ALLOW_LOCAL_BASE_URL = 'false'
    const baseUrl = 'http://127.0.0.1:3800/v1'

    const saved = await save({
      provider: 'custom',
      name: nameOf('strict'),
      baseUrl,
      model: 'm',
      models: ['m'],
    })
    expect(saved.status).toBe(400)
    expect(saved.body.code).toBe('ai_base_url_local_disabled')
    expect(String(saved.body.error)).toMatch(/AI_ALLOW_LOCAL_BASE_URL=true/)

    const prev = await preview({ ...BASE, baseUrl })
    expect(prev.status).toBe(400)
    expect(prev.body.code).toBe('ai_base_url_local_disabled')
  })

  it('开关关闭不影响"永远拒绝"的类别（元数据地址的 code 不变）', async () => {
    process.env.AI_ALLOW_LOCAL_BASE_URL = 'false'
    const res = await preview({ ...BASE, baseUrl: 'http://169.254.169.254/latest/meta-data/' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('ai_base_url_blocked_address')
  })

  it('开关默认为放行（AI_ALLOW_LOCAL_BASE_URL 未设置 / true 时本地地址通过）', async () => {
    expect(process.env.AI_ALLOW_LOCAL_BASE_URL).toBeUndefined()
    const res = await save({
      provider: 'custom',
      name: nameOf('default'),
      baseUrl: 'http://127.0.0.1:3800/v1',
      model: 'm',
      models: ['m'],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    process.env.AI_ALLOW_LOCAL_BASE_URL = 'true'
    const res2 = await save({
      provider: 'custom',
      name: nameOf('explicit-true'),
      baseUrl: 'http://127.0.0.1:3800/v1',
      model: 'm',
      models: ['m'],
    })
    expect(res2.status, JSON.stringify(res2.body)).toBe(201)
  })
})
