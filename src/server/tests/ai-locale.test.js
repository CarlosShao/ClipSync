/**
 * 契约 v6：AI 生成内容跟随界面语言（`X-UI-Locale`）。
 *
 * 用户实测：界面切到英文后，「Review settings」等 AI 功能生成的内容仍是中文 —— 因为服务端
 * 提示词写的是「使用与用户相同的语言」，而用户输入/被审内容本身是中文。
 *
 * 覆盖：
 *   A 归一化（resolveRequestLocale / normalizeLocale / 缺省 zh）
 *   B 提示词构造层：en ⇒ 英文指令且**不含**中文反向指令；zh ⇒ 反之（含 buildSystemPrompt）
 *   C 端到端（注入 buildUpstreamChat 捕获请求体）：带 X-UI-Locale: en 的各功能 messages 里有英文指令；
 *     不带该头 ⇒ 与今天行为一致（中文指令）
 *   D 结构化字段（JSON 键名/枚举）两种语言逐字一致 ⇒ 前端照旧解析
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import request from 'supertest'
import http from 'node:http'
import pool from '../src/db/pool.js'
import { authHeaders, ensureAuthUser, TEST_USER_ID } from './test-helpers.js'
import { encrypt } from '../src/utils/encryption.js'
import {
  DEFAULT_LOCALE,
  UI_LOCALE_HEADER,
  normalizeLocale,
  resolveLocale,
  resolveRequestLocale,
  languageDirective,
  roleLanguageLine,
  summarizeSystemPrompt,
  similaritySystemPrompt,
  refactorSystemPrompt,
  suggestCollectionHint,
  suggestBatchSystemPrompt,
  suggestSingleSystemPrompt,
  suggestBatchUserPrompt,
  favoriteMarker,
  inlineContextSystemPrompt,
  compressSummarySystemPrompt,
} from '../src/utils/aiLocale.js'
import { buildSystemPrompt } from '../src/utils/aiSystemPrompt.js'

const CJK = /[\u4e00-\u9fa5]/
const EN_DIRECTIVE = 'Always respond in English'
const ZH_DIRECTIVE = '始终用简体中文回答'

// 捕获真实构造出的上游请求体；baseUrl 可被单个用例改写（默认必然拒连的本地端口）
const hoisted = vi.hoisted(() => ({ captured: [], baseUrl: 'http://127.0.0.1:9/v1' }))
vi.mock('../src/utils/aiProviders.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    buildUpstreamChat: (cfg) => {
      hoisted.captured.push(cfg)
      return actual.buildUpstreamChat({ ...cfg, baseUrl: hoisted.baseUrl })
    },
  }
})

let app
let auth
const createdProviderIds = []
const stamp = Date.now().toString().slice(-6)

async function createProvider() {
  const { rows } = await pool.query(
    `INSERT INTO ai_providers (user_id, provider, name, api_key_encrypted, base_url, model, models, api_format)
     VALUES ($1, 'custom', $2, $3, 'https://gateway.example.com/v1', 'gpt-4o', '["gpt-4o"]'::jsonb, 'openai') RETURNING id`,
    [TEST_USER_ID, `loc_${stamp}_${createdProviderIds.length}`, encrypt('sk-locale')],
  )
  createdProviderIds.push(rows[0].id)
  return rows[0].id
}

const post = (path, body, headers = {}) => request(app).post(path).set({ ...auth, ...headers }).send(body)
const withEn = { [UI_LOCALE_HEADER]: 'en' }
const withZh = { [UI_LOCALE_HEADER]: 'zh-CN' }

/** 捕获到的"会发给上游"的 system 文本 */
const capturedSystem = (i = 0) =>
  (hoisted.captured[i]?.messages || [])
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')

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

beforeEach(() => {
  hoisted.captured.length = 0
  hoisted.baseUrl = 'http://127.0.0.1:9/v1'
})

// ============================================================
// A. 归一化
// ============================================================
describe('A. X-UI-Locale 归一化', () => {
  it('normalizeLocale：中英各种写法归一，未知/空返回 null', () => {
    for (const v of ['zh', 'zh-CN', 'zh-Hans', 'zh_Hans_CN', 'zh-TW', 'ZH-CN', ' zh-cn ']) {
      expect(normalizeLocale(v), v).toBe('zh')
    }
    for (const v of ['en', 'en-US', 'en_GB', 'EN-us']) {
      expect(normalizeLocale(v), v).toBe('en')
    }
    for (const v of ['fr', 'de-DE', 'klingon', '', '   ', null, undefined]) {
      expect(normalizeLocale(v), String(v)).toBeNull()
    }
  })

  it('resolveLocale：未知/缺失兜底 DEFAULT_LOCALE=zh', () => {
    expect(DEFAULT_LOCALE).toBe('zh')
    expect(resolveLocale(undefined)).toBe('zh')
    expect(resolveLocale('fr')).toBe('zh')
    expect(resolveLocale('en-US')).toBe('en')
  })

  it('resolveRequestLocale：读头并兜底；数组头取第一个；只认这一个头', () => {
    expect(resolveRequestLocale({ headers: { [UI_LOCALE_HEADER]: 'en-US' } })).toBe('en')
    expect(resolveRequestLocale({ headers: { [UI_LOCALE_HEADER]: 'zh-Hans' } })).toBe('zh')
    expect(resolveRequestLocale({ headers: { [UI_LOCALE_HEADER]: 'fr' } })).toBe('zh') // 未知 → 缺省
    expect(resolveRequestLocale({ headers: {} })).toBe('zh') // 无头 → 向后兼容
    expect(resolveRequestLocale({})).toBe('zh')
    expect(resolveRequestLocale(null)).toBe('zh')
    expect(resolveRequestLocale({ headers: { [UI_LOCALE_HEADER]: ['en-GB', 'zh'] } })).toBe('en')
    // 只认 X-UI-Locale：Accept-Language 不参与（语义不同，避免不可预期）
    expect(resolveRequestLocale({ headers: { 'accept-language': 'en-US,en;q=0.9' } })).toBe('zh')
  })
})

// ============================================================
// B. 提示词构造层
// ============================================================
describe('B. 语言指令与各功能提示词', () => {
  it('languageDirective / roleLanguageLine：en 不含中文反向指令，zh 反之', () => {
    expect(languageDirective('en-US')).toContain(EN_DIRECTIVE)
    expect(languageDirective('en-US')).not.toContain(ZH_DIRECTIVE)
    expect(languageDirective('en-US')).not.toMatch(CJK)

    expect(languageDirective('zh-CN')).toContain(ZH_DIRECTIVE)
    expect(languageDirective('zh-CN')).not.toContain(EN_DIRECTIVE)
    expect(languageDirective(undefined)).toContain(ZH_DIRECTIVE) // 缺省 zh

    expect(roleLanguageLine('en')).toContain('always respond in English')
    expect(roleLanguageLine('en')).not.toContain('简体中文')
    expect(roleLanguageLine('zh')).toContain('简体中文')
  })

  it('buildSystemPrompt：en ⇒ 末尾是英文强制指令；zh/缺省 ⇒ 中文指令（且旧文案已移除）', async () => {
    const en = await buildSystemPrompt(TEST_USER_ID, 'user', { locale: 'en' })
    expect(en).toContain(EN_DIRECTIVE)
    expect(en).not.toContain(ZH_DIRECTIVE)
    expect(en.trimEnd().endsWith('This overrides any other language preference stated elsewhere.')).toBe(true)
    // 旧的"使用与用户相同的语言"必须已不存在（那正是本次 bug 的根源）
    expect(en).not.toContain('使用与用户相同的语言')
    expect(en).toContain('always respond in English')

    const zh = await buildSystemPrompt(TEST_USER_ID, 'user', { locale: 'zh' })
    expect(zh).toContain(ZH_DIRECTIVE)
    expect(zh).not.toContain(EN_DIRECTIVE)
    expect(zh).not.toContain('使用与用户相同的语言')

    const dflt = await buildSystemPrompt(TEST_USER_ID, 'user', {})
    expect(dflt).toContain(ZH_DIRECTIVE) // 不带 locale = 改造前默认（中文）
  })

  it('各功能提示词：en 版本不含中文，zh 版本为中文', () => {
    const builders = [
      ['summarize', summarizeSystemPrompt],
      ['refactor', refactorSystemPrompt],
      ['similarity', (l) => similaritySystemPrompt(l, 'c1: hello')],
      ['suggestBatch', (l) => suggestBatchSystemPrompt(l, 2, '')],
      ['suggestSingle', (l) => suggestSingleSystemPrompt(l, '')],
      ['suggestBatchUser', (l) => suggestBatchUserPrompt(l, 2, '[0] id=x preview: y')],
      ['collectionHint', (l) => suggestCollectionHint(l, ['Work', 'Ideas'])],
      ['inlineContext', (l) => inlineContextSystemPrompt(l, 'CTX')],
      ['compressSummary', compressSummarySystemPrompt],
    ]
    for (const [name, fn] of builders) {
      const en = fn('en')
      expect(en, `${name} en`).not.toMatch(CJK)
      expect(fn('zh'), `${name} zh`).toMatch(CJK)
      expect(fn(undefined), `${name} 缺省= zh`).toBe(fn('zh'))
    }
    expect(favoriteMarker('en')).toBe(' [favorited]')
    expect(favoriteMarker('zh')).toBe(' [已收藏]')
  })

  it('结构化字段稳定：JSON 键名与枚举两种语言逐字一致（前端无需按语言改解析）', () => {
    const schemaOf = (s) => s.slice(s.indexOf('{'), s.indexOf('Field notes') >= 0 ? s.indexOf('Field notes') : s.indexOf('字段说明'))
    // /suggest 批量
    expect(schemaOf(suggestBatchSystemPrompt('en', 3, ''))).toBe(schemaOf(suggestBatchSystemPrompt('zh', 3, '')))
    expect(schemaOf(suggestBatchSystemPrompt('en', 3, ''))).toContain('"action": "keep"|"archive"|"cleanup"')
    // /suggest 单条
    expect(schemaOf(suggestSingleSystemPrompt('en', ''))).toBe(schemaOf(suggestSingleSystemPrompt('zh', '')))
    // /similarity
    const simEn = similaritySystemPrompt('en', 'c1: x')
    const simZh = similaritySystemPrompt('zh', 'c1: x')
    expect(simEn).toContain('[{"id": "<candidate id>", "reason": "<one sentence explaining why it is a duplicate>", "degree": "high"|"medium"}]')
    expect(simZh).toContain('[{"id": "<候选id>", "reason": "<一句话说明为什么重复>", "degree": "high"|"medium"}]')
    expect(simEn).toContain('"degree": "high"|"medium"')
    expect(simZh).toContain('"degree": "high"|"medium"')
  })
})

// ============================================================
// C. 端到端：带 X-UI-Locale: en ⇒ 上游请求体里有英文指令
// ============================================================
describe('C. 端到端：请求体里的语言指令', () => {
  it('/summarize、/suggest、/similarity、/refactor-prompt：en 头 ⇒ 英文指令', async () => {
    const providerId = await createProvider()

    hoisted.captured.length = 0
    await post('/api/ai/summarize', { providerId, content: '今天下午三点开会' }, withEn)
    expect(capturedSystem()).toContain(EN_DIRECTIVE)
    expect(capturedSystem()).not.toContain(ZH_DIRECTIVE)

    hoisted.captured.length = 0
    await post('/api/ai/suggest', { providerId, content: '明天要去上海出差' }, withEn)
    expect(capturedSystem()).toContain(EN_DIRECTIVE)
    expect(capturedSystem()).toContain('"action": "keep"|"archive"|"cleanup"') // 结构不变

    hoisted.captured.length = 0
    await post('/api/ai/similarity', { providerId, content: 'A', candidates: [{ id: 'c1', text: 'A 的改写' }] }, withEn)
    expect(capturedSystem()).toContain(EN_DIRECTIVE)

    hoisted.captured.length = 0
    await post('/api/ai/refactor-prompt', { providerId, content: '帮我写一封请假邮件' }, withEn)
    expect(capturedSystem()).toContain(EN_DIRECTIVE)
  })

  it('/inline：两个不同变体的客户端 prompt 都被同一条英文指令约束', async () => {
    const providerId = await createProvider()
    // 变体 1：审查设置（用户截图里那条）
    hoisted.captured.length = 0
    await post('/api/ai/inline', {
      providerId,
      prompt: '审查以下设置项并给出改进建议：\n- 开启两步验证\n- 会话超时 30 分钟',
      context: '设置页上下文',
    }, withEn)
    expect(capturedSystem()).toContain(EN_DIRECTIVE)
    expect(capturedSystem()).not.toContain(ZH_DIRECTIVE)

    // 变体 2：AI 诊断同步
    hoisted.captured.length = 0
    await post('/api/ai/inline', { providerId, prompt: '诊断最近的同步失败原因', context: '' }, withEn)
    expect(capturedSystem()).toContain(EN_DIRECTIVE)
  })

  it('/chat：en 头 ⇒ system 提示词含英文强制指令；zh 头 ⇒ 中文指令', async () => {
    const providerId = await createProvider()
    hoisted.captured.length = 0
    await post('/api/ai/chat', {
      providerId,
      messages: [{ role: 'user', content: '帮我看看今天的剪贴板' }],
      options: { mode: 'ask' },
    }, withEn)
    expect(capturedSystem()).toContain(EN_DIRECTIVE)
    expect(capturedSystem()).not.toContain(ZH_DIRECTIVE)
    expect(capturedSystem()).toContain('always respond in English')
  })

  it('回归：不带 X-UI-Locale ⇒ 与今天行为一致（中文指令）', async () => {
    const providerId = await createProvider()

    await post('/api/ai/summarize', { providerId, content: '无头请求' })
    expect(capturedSystem()).toContain(ZH_DIRECTIVE)
    expect(capturedSystem()).not.toContain(EN_DIRECTIVE)

    hoisted.captured.length = 0
    await post('/api/ai/inline', { providerId, prompt: '无头请求', context: '' })
    expect(capturedSystem()).toContain(ZH_DIRECTIVE)

    hoisted.captured.length = 0
    await post('/api/ai/suggest', { providerId, content: '无头请求' })
    expect(capturedSystem()).toContain(ZH_DIRECTIVE)
    expect(capturedSystem()).toContain('"action": "keep"|"archive"|"cleanup"')

    hoisted.captured.length = 0
    await post('/api/ai/chat', {
      providerId,
      messages: [{ role: 'user', content: '无头请求' }],
      options: { mode: 'ask' },
    })
    expect(capturedSystem()).toContain(ZH_DIRECTIVE)

    // zh 头（zh-CN）等价于缺省
    hoisted.captured.length = 0
    await post('/api/ai/summarize', { providerId, content: 'zh 头' }, withZh)
    expect(capturedSystem()).toContain(ZH_DIRECTIVE)
  })

  it('④ 结构化返回：两种语言下解析出的都是稳定 code（不是中文句子）', async () => {
    // 起一个本地假上游（SSE），让 /suggest 真的走完解析路径
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const payload = JSON.stringify({
        worth_favorite: true,
        reason: 'looks reusable',
        suggested_collection: null,
        action: 'keep',
        action_reason: 'still useful',
        suggested_tags: ['work'],
      })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    hoisted.baseUrl = `http://127.0.0.1:${port}/v1`
    try {
      const providerId = await createProvider()

      hoisted.captured.length = 0
      const en = await post('/api/ai/suggest', { providerId, content: 'notes' }, withEn)
      expect(en.status, JSON.stringify(en.body)).toBe(200)
      expect(en.body.suggestion.action).toBe('keep') // 稳定枚举 code
      expect(en.body.suggestion.action_reason).toBe('still useful')
      expect(en.body.suggestion.suggested_tags).toEqual(['work'])
      expect(capturedSystem()).toContain(EN_DIRECTIVE)

      hoisted.captured.length = 0
      const zh = await post('/api/ai/suggest', { providerId, content: '笔记' })
      expect(zh.status, JSON.stringify(zh.body)).toBe(200)
      expect(zh.body.suggestion.action).toBe('keep') // 同一套 code
      expect(Object.keys(zh.body.suggestion).sort()).toEqual(Object.keys(en.body.suggestion).sort())
      expect(capturedSystem()).toContain(ZH_DIRECTIVE)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
