// AI 失败分类的证据（P0：用户此前只能看到笼统的「AI 调用失败」）
// 这里只测纯函数：不连数据库、不发起上游请求。
import { describe, it, expect } from 'vitest'
import { classifyAiFailure, providerBrief, providerPrecheckFailure } from '../src/utils/aiFailure.js'

/** openUpstreamStream 抛出的真实形态：`Upstream error: <status> <body>` */
const upstreamErr = (status, body = '{}') => new Error(`Upstream error: ${status} ${body}`)

describe('classifyAiFailure — 上游鉴权', () => {
  it('401 / 403 归为 ai_upstream_auth', () => {
    expect(classifyAiFailure(upstreamErr(401)).code).toBe('ai_upstream_auth')
    expect(classifyAiFailure(upstreamErr(403)).code).toBe('ai_upstream_auth')
    expect(classifyAiFailure(upstreamErr(401)).httpStatus).toBe(502)
  })

  it('无状态码但报文含 invalid api key 也归为鉴权', () => {
    expect(classifyAiFailure(new Error('{"error":{"message":"Invalid API key"}}')).code).toBe('ai_upstream_auth')
  })
})

describe('classifyAiFailure — 限流 / 配额', () => {
  it('429 / rate limit / quota 归为 ai_upstream_rate_limit', () => {
    expect(classifyAiFailure(upstreamErr(429)).code).toBe('ai_upstream_rate_limit')
    expect(classifyAiFailure(new Error('rate limit exceeded')).code).toBe('ai_upstream_rate_limit')
    expect(classifyAiFailure(new Error('insufficient balance')).code).toBe('ai_upstream_rate_limit')
  })
})

describe('classifyAiFailure — 模型与地址', () => {
  it('提到 model 不存在 → ai_upstream_model', () => {
    expect(classifyAiFailure(upstreamErr(404, '{"message":"model not found"}')).code).toBe('ai_upstream_model')
    expect(classifyAiFailure(new Error('unknown model: foo')).code).toBe('ai_upstream_model')
  })

  it('纯 404（没提 model）→ ai_upstream_endpoint，而不是被兜底吞掉', () => {
    expect(classifyAiFailure(upstreamErr(404, '<html>not found</html>')).code).toBe('ai_upstream_endpoint')
  })
})

describe('classifyAiFailure — 超时 / 网络 / 兜底', () => {
  it('UPSTREAM_TIMEOUT 与 timeout 字样 → ai_upstream_timeout（504）', () => {
    expect(classifyAiFailure(new Error('UPSTREAM_TIMEOUT')).code).toBe('ai_upstream_timeout')
    expect(classifyAiFailure(new Error('UPSTREAM_TIMEOUT')).httpStatus).toBe(504)
    expect(classifyAiFailure(new Error('request timed out')).code).toBe('ai_upstream_timeout')
  })

  it('fetch failed / 5xx → ai_upstream_unavailable', () => {
    expect(classifyAiFailure(new Error('fetch failed')).code).toBe('ai_upstream_unavailable')
    expect(classifyAiFailure(upstreamErr(503)).code).toBe('ai_upstream_unavailable')
  })

  it('认不出来的 → ai_failed（500），不误报成具体原因', () => {
    expect(classifyAiFailure(new Error('something odd')).code).toBe('ai_failed')
    expect(classifyAiFailure(new Error('something odd')).httpStatus).toBe(500)
    expect(classifyAiFailure(undefined).code).toBe('ai_failed')
  })
})

describe('providerBrief / providerPrecheckFailure', () => {
  it('providerBrief 只暴露前端要展示的字段，绝不带 key', () => {
    const brief = providerBrief({
      id: 'p1',
      name: 'StepFun',
      provider: 'stepfun',
      model: 'step-3.7-flash',
      is_default: true,
      api_key_encrypted: 'SECRET',
    })
    expect(brief).toEqual({ id: 'p1', name: 'StepFun', provider: 'stepfun', model: 'step-3.7-flash', isDefault: true })
    expect(JSON.stringify(brief)).not.toContain('SECRET')
  })

  it('providerBrief(null) → null', () => {
    expect(providerBrief(null)).toBeNull()
  })

  it('前置检查：没供应商 → 404 + ai_no_provider', () => {
    const f = providerPrecheckFailure('no_provider')
    expect(f.httpStatus).toBe(404)
    expect(f.body.code).toBe('ai_no_provider')
    expect(f.body.provider).toBeNull()
  })

  it('前置检查：供应商没填 key → 400 + ai_no_api_key（并带上供应商名）', () => {
    const f = providerPrecheckFailure('no_key', { id: 'p1', name: 'StepFun', is_default: false })
    expect(f.httpStatus).toBe(400)
    expect(f.body.code).toBe('ai_no_api_key')
    expect(f.body.provider.name).toBe('StepFun')
  })
})
