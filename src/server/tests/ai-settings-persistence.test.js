import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import pool from '../src/db/pool.js'
import { authHeaders, ensureAuthUser, TEST_USER_ID } from './test-helpers.js'

/**
 * AI 设置持久化：PUT /api/ai/settings → GET → **直接查库**
 *
 * 触发背景（用户实测）：设置 → AI →「联网搜索」的选择、「全局系统提示词」，
 * 刷新后回到未配置状态；而同一张表的 search_api_key_encrypted 却有值。
 * dev 库该用户实际行的值是：search_provider='' / search_base_url='' / custom_system_prompt=''，
 * 但 has_key=t —— 于是"能存"和"不能存"同时出现在同一个端点上。
 *
 * 静态读码结论：前端（AIProviderSettings 的 loadAllSettings / savePrefs）、服务端
 * sanitize() 白名单、落库 SQL 的 baseCols 都**包含**这些字段，两侧看起来都对。
 * 所以本文件用**运行时**证据把它钉死：
 *   · PUT 若是 4xx/5xx —— 断言信息里会带上真实状态码与响应体（一眼看到被谁拒了）；
 *   · PUT 200 但 GET 读不回 —— 问题在写入/读回映射；
 *   · GET 对了但库里为空 —— 问题在 SQL；
 *   · 三条全过 —— 说明后端没问题，嫌疑回到"前端到底发没发请求"（再用组件测试验证）。
 *
 * 注意：写请求走真 CSRF 中间件，必须带真签 Bearer 头，且 authenticateToken 会查库校验
 * 账户活性 ⇒ beforeAll 里先 ensureAuthUser。
 */

let app
let auth

beforeAll(async () => {
  const mod = await import('../src/index.js')
  app = mod.app
  await ensureAuthUser(pool)
  auth = authHeaders()
})

afterAll(async () => {
  // 只清本用例写入的三列，不删整行（避免影响其它测试/人工排查）
  await pool.query(
    `UPDATE ai_settings
        SET search_provider = '', search_base_url = '', custom_system_prompt = ''
      WHERE user_id = $1`,
    [TEST_USER_ID],
  )
})

const put = (body) => request(app).put('/api/ai/settings').set(auth).send(body)
const get = () => request(app).get('/api/ai/settings').set(auth)
const rawRow = async () => {
  const r = await pool.query(
    'SELECT search_provider, search_base_url, custom_system_prompt, default_mode FROM ai_settings WHERE user_id = $1',
    [TEST_USER_ID],
  )
  return r.rows[0] ?? null
}

// ⚠️ 当前 skip：本文件是**复现探针**，在测试库上稳定复现出真实缺陷 ——
//    PUT /api/ai/settings 返回 500（PG code 42703 undefined_column，position 155 = custom_system_prompt），
//    因为 aiSettings.js 的 baseCols 对 memory_enabled / custom_system_prompt / parallel_enabled
//    是**无条件写**，而测试库缺这些列（搜索列反而做了存在性探测）⇒ 整条保存 500、所有 AI 设置存不进去。
//    待 P0 修复（探测扩展到基础可选列，或启动时 ADD COLUMN IF NOT EXISTS 兜底）后，
//    去掉 .skip 即可转为常驻回归测试。
describe('AI 设置持久化：PUT → GET → 查库', () => {
  it('searchProvider / searchBaseUrl / customSystemPrompt 必须被写入且读得回', async () => {
    const res = await put({
      searchProvider: 'anysearch',
      searchBaseUrl: 'https://search.example.com',
      customSystemPrompt: '只回答中文',
    })
    // 状态码不带 200 时，把真实响应体打进断言消息里 —— 这就是"运行时证据"
    expect(res.status, `PUT /api/ai/settings 返回 ${res.status}，body=${JSON.stringify(res.body)}`).toBe(200)

    const back = await get()
    expect(back.status).toBe(200)
    expect(back.body.searchProvider).toBe('anysearch')
    expect(back.body.searchBaseUrl).toBe('https://search.example.com')
    expect(back.body.customSystemPrompt).toBe('只回答中文')

    const row = await rawRow()
    expect(row, 'ai_settings 里应当有该用户的行').toBeTruthy()
    expect(row.search_provider).toBe('anysearch')
    expect(row.search_base_url).toBe('https://search.example.com')
    expect(row.custom_system_prompt).toBe('只回答中文')
  })

  it('只提交单个字段时，其余已存字段不得被清空（局部更新语义）', async () => {
    const res = await put({ defaultMode: 'agent' })
    expect(res.status, `PUT 返回 ${res.status}，body=${JSON.stringify(res.body)}`).toBe(200)

    const row = await rawRow()
    expect(row.default_mode).toBe('agent')
    // 这三条是"被清空"的经典症状：设置了别的开关，把搜索/提示词一起抹掉
    expect(row.search_provider, '保存其它字段不应清空 search_provider').toBe('anysearch')
    expect(row.search_base_url, '保存其它字段不应清空 search_base_url').toBe('https://search.example.com')
    expect(row.custom_system_prompt, '保存其它字段不应清空 custom_system_prompt').toBe('只回答中文')
  })
})
