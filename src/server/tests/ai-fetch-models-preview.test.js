import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import pool from '../src/db/pool.js'
import { authHeaders, ensureAuthUser } from './test-helpers.js'

/**
 * POST /api/ai/providers/fetch-models —— 未保存预览模式
 *
 * 背景：这个端点曾被 P0 加固（commit 4a67beb）成"只认 providerId"，导致前端「刷新模型列表」
 * 必须先保存一条供应商记录才能用（用户反馈：有 key 和 baseUrl 就该能直接拉列表，
 * 先保存再刷新是脱裤子放屁）。
 *
 * 现在恢复"直接吃表单里的 provider/apiKey/baseUrl"的预览模式，但**必须保持同等安全强度**：
 * 传入的 baseUrl 走 validateProviderBaseUrl —— 与 POST/PUT /providers 保存路径同一套 SSRF 校验。
 * 本文件就是钉住这一点：放宽了"必须先保存"，但内网地址依旧打不出去。
 *
 * 注意：写请求要走真 CSRF 中间件，必须带真签 Bearer 头（authenticateToken 会查库校验账户活性，
 * 所以 beforeAll 里用 ensureAuthUser 建好测试用户）。
 */

let app
let auth
const preview = (body) => request(app).post('/api/ai/providers/fetch-models').set(auth).send(body)
// 用一个确定存在的预设（stepfun）+ 显式 baseUrl，避免依赖预设默认地址
const BASE = { provider: 'stepfun', apiKey: 'sk-test-key' }

beforeAll(async () => {
  const mod = await import('../src/index.js')
  app = mod.app
  await ensureAuthUser(pool)
  auth = authHeaders()
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
    const res = await preview({ provider: 'stepfun', baseUrl: 'https://api.example.com/v1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('apiKey is required')
  })

  it('非 http(s) 协议 → 400', async () => {
    const res = await preview({ ...BASE, baseUrl: 'file:///etc/passwd' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Base URL must use http or https')
  })
})

describe('未保存预览：SSRF 门禁仍然有效（这是放宽"必须先保存"的前提）', () => {
  const internalUrls = [
    'http://127.0.0.1:9999/v1',
    'http://10.0.0.5/v1',
    'http://192.168.1.1/v1',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/v1',
  ]

  for (const baseUrl of internalUrls) {
    it(`内网/环回地址被拒：${baseUrl}`, async () => {
      const res = await preview({ ...BASE, baseUrl })
      expect(res.status).toBe(400)
      expect(String(res.body.error)).toMatch(/blocked|not allowed|cannot be resolved/i)
    })
  }
})
