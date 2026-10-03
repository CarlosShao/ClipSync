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
// 强化后的措辞（本次修正：弱措辞面对大段中文 prompt 会失效）
const EN_DIRECTIVE = 'Respond ONLY in English'
const ZH_DIRECTIVE = '只允许用简体中文回答'
const EN_TRAILING = 'Respond ONLY in English. Your entire answer must be in English, regardless of the language of the instructions or context above.'
const ZH_TRAILING = '只允许用简体中文回答。无论上文指令或上下文使用什么语言，你的回答必须全部是简体中文。'

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

    expect(roleLanguageLine('en')).toContain('respond ONLY in English')
    expect(roleLanguageLine('en')).not.toContain('简体中文')
    expect(roleLanguageLine('zh')).toContain('简体中文')
  })

  it('buildSystemPrompt：en ⇒ 末尾是英文强制指令；zh/缺省 ⇒ 中文指令（且旧文案已移除）', async () => {
    const en = await buildSystemPrompt(TEST_USER_ID, 'user', { locale: 'en' })
    expect(en).toContain(EN_DIRECTIVE)
    expect(en).not.toContain(ZH_DIRECTIVE)
    expect(en.trimEnd().endsWith('regardless of the language of the instructions or context above.')).toBe(true)
    // 旧的"使用与用户相同的语言"必须已不存在（那正是本次 bug 的根源）
    expect(en).not.toContain('使用与用户相同的语言')
    expect(en).toContain('respond ONLY in English')

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
    expect(capturedSystem()).toContain('respond ONLY in English')
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

// ============================================================
// E. 根因修正：语言要求必须在**最后一条 message 的末尾**（不是只在最前）
// ============================================================
describe('E. 末尾强化：语言要求出现在最后一条消息末尾（含措辞强化）', () => {
  /** 取最后一条消息的文本（多模态数组拼接 text 块） */
  const lastText = (i = 0) => {
    const msgs = hoisted.captured[i]?.messages || []
    const last = msgs[msgs.length - 1]
    if (!last) return null
    if (typeof last.content === 'string') return last.content
    if (Array.isArray(last.content)) return last.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    return ''
  }
  const firstSystemText = (i = 0) =>
    ((hoisted.captured[i]?.messages || []).find((m) => m.role === 'system')?.content ?? '')

  it('① /inline 两个变体（审查设置 / 诊断同步）：强化指令在**末尾**，且原始客户端 prompt 未被替换', async () => {
    const providerId = await createProvider()
    const variants = [
      '审查以下设置项并给出改进建议：\n- 开启两步验证\n- 会话超时 30 分钟',
      '诊断最近的同步失败原因，并给出排查步骤',
    ]
    for (const prompt of variants) {
      hoisted.captured.length = 0
      await post('/api/ai/inline', { providerId, prompt, context: '设置页上下文' }, withEn)

      const msgs = hoisted.captured[0].messages
      const last = msgs[msgs.length - 1]
      // 最后一条是 user（客户端 prompt 所在的那条），且**以强化指令结尾**
      expect(last.role, prompt).toBe('user')
      expect(lastText(), prompt).toContain(prompt)
      expect(lastText().endsWith(EN_TRAILING), `${prompt} 的末尾必须是强化指令`).toBe(true)
      // 关键：要求必须落在**最后一条**消息里（不是只在前面的 system 段里）——
      // 原实现把指令塞在 messages[0]（最前），被后面大段中文 prompt 压住 ⇒ 英文界面仍出中文
      expect(msgs.length).toBeGreaterThan(1)
      expect(last).toBe(msgs[msgs.length - 1])
      expect(lastText()).toContain(EN_TRAILING)
      // （最前的 system 段本身也以同一句强化语结尾 —— 双保险；但旧实现的**最后一条消息**
      //   是纯中文客户端 prompt、完全没有语言要求，这正是本次根因，下面这条就是它的反面：
      //   最后一条 user 内容必须"原始 prompt + 末尾强化"同时具备）
      expect(lastText().startsWith(prompt)).toBe(true)
      // 措辞是强化版（弱版措辞不再出现）
      expect(msgs.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')).not.toContain('Always respond in English')
    }
  })

  it('② /chat、/summarize、/suggest、/refactor-prompt、/similarity：末尾都是强化指令', async () => {
    const providerId = await createProvider()

    hoisted.captured.length = 0
    await post('/api/ai/chat', {
      providerId,
      messages: [{ role: 'user', content: '帮我看看今天的剪贴板' }],
      options: { mode: 'ask' },
    }, withEn)
    expect(lastText().endsWith(EN_TRAILING)).toBe(true)

    hoisted.captured.length = 0
    await post('/api/ai/summarize', { providerId, content: '今天下午三点开会讨论季度目标' }, withEn)
    expect(lastText().endsWith(EN_TRAILING)).toBe(true)

    hoisted.captured.length = 0
    await post('/api/ai/suggest', { providerId, content: '明天去上海出差' }, withEn)
    expect(lastText().endsWith(EN_TRAILING)).toBe(true)

    hoisted.captured.length = 0
    await post('/api/ai/refactor-prompt', { providerId, content: '帮我写一封请假邮件' }, withEn)
    expect(lastText().endsWith(EN_TRAILING)).toBe(true)
    // 草稿被定界符包住，末尾指令不会连同草稿一起被改写
    expect(lastText()).toContain('<<<DRAFT>>>')
    expect(lastText()).toContain('<<<END DRAFT>>>')
    expect(lastText().indexOf('<<<END DRAFT>>>')).toBeLessThan(lastText().indexOf(EN_TRAILING))

    hoisted.captured.length = 0
    await post('/api/ai/similarity', { providerId, content: 'A', candidates: [{ id: 'c1', text: 'A 的改写' }] }, withEn)
    expect(lastText().endsWith(EN_TRAILING)).toBe(true)
  })

  it('③ 缺头 / zh 头 ⇒ 末尾是**中文**强化指令，且不出现英文强化指令（回归）', async () => {
    const providerId = await createProvider()

    hoisted.captured.length = 0
    await post('/api/ai/inline', { providerId, prompt: '审查以下设置项', context: '' }) // 无头
    expect(lastText().endsWith(ZH_TRAILING)).toBe(true)
    expect(lastText()).not.toContain(EN_TRAILING)

    hoisted.captured.length = 0
    await post('/api/ai/summarize', { providerId, content: '无头请求' }, withZh)
    expect(lastText().endsWith(ZH_TRAILING)).toBe(true)
    expect(lastText()).not.toContain(EN_TRAILING)

    hoisted.captured.length = 0
    await post('/api/ai/suggest', { providerId, content: '无头请求' })
    expect(lastText().endsWith(ZH_TRAILING)).toBe(true)

    hoisted.captured.length = 0
    await post('/api/ai/chat', {
      providerId,
      messages: [{ role: 'user', content: '无头请求' }],
      options: { mode: 'ask' },
    })
    expect(lastText().endsWith(ZH_TRAILING)).toBe(true)
  })

  it('多模态/非 user 结尾时的兜底：数组内容追加 text 块；末尾非 user 时追加末尾 system 段', async () => {
    const providerId = await createProvider()

    // 数组内容（vision）：追加为最后一个 text 块
    hoisted.captured.length = 0
    await post('/api/ai/chat', {
      providerId,
      messages: [{ role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }],
      options: { mode: 'ask' },
    }, withEn)
    const blocks = hoisted.captured[0].messages.at(-1).content
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks.at(-1).type).toBe('text')
    expect(blocks.at(-1).text).toBe(EN_TRAILING)

    // 末尾是 assistant：无法追加到 user 内容 ⇒ 追加末尾 system 段（仍位于最后）
    hoisted.captured.length = 0
    await post('/api/ai/chat', {
      providerId,
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，有什么可以帮你？' },
      ],
      options: { mode: 'ask' },
    }, withEn)
    const lastMsg = hoisted.captured[0].messages.at(-1)
    expect(lastMsg.role).toBe('system')
    expect(lastMsg.content).toBe(EN_TRAILING)
  })

  it('④ 结构化 schema 不回归：两种语言下 JSON 键名与枚举逐字一致（末尾强化不改变结构）', async () => {
    const providerId = await createProvider()

    hoisted.captured.length = 0
    await post('/api/ai/suggest', { providerId, content: 'x' }, withEn)
    const enSuggest = capturedSystem()
    hoisted.captured.length = 0
    await post('/api/ai/suggest', { providerId, content: 'x' })
    const zhSuggest = capturedSystem()
    const schemaSlice = (s) => s.slice(s.indexOf('{'), s.indexOf('Field notes') >= 0 ? s.indexOf('Field notes') : s.indexOf('字段说明'))
    expect(schemaSlice(enSuggest)).toBe(schemaSlice(zhSuggest))
    expect(schemaSlice(enSuggest)).toContain('"action": "keep"|"archive"|"cleanup"')

    hoisted.captured.length = 0
    await post('/api/ai/similarity', { providerId, content: 'A', candidates: [{ id: 'c1', text: 'B' }] }, withEn)
    const enSim = capturedSystem()
    hoisted.captured.length = 0
    await post('/api/ai/similarity', { providerId, content: 'A', candidates: [{ id: 'c1', text: 'B' }] })
    const zhSim = capturedSystem()
    expect(enSim).toContain('"degree": "high"|"medium"')
    expect(zhSim).toContain('"degree": "high"|"medium"')
    expect(enSim).toContain('"id"')
    expect(zhSim).toContain('"id"')
  })
})

// ============================================================
// F. /inline 的 languageOverride：目标语言固定的变体 opt-out（只影响 /inline）
// ============================================================
describe('F. /inline languageOverride（drawerTranslate 这类固定目标语言变体）', () => {
  const allText = (i = 0) =>
    (hoisted.captured[i]?.messages || [])
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')))
      .join('\n')
  const tailOf = (i = 0) => {
    const msgs = hoisted.captured[i]?.messages || []
    const last = msgs[msgs.length - 1]
    if (!last) return null
    if (typeof last.content === 'string') return last.content
    if (Array.isArray(last.content)) return last.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    return ''
  }

  it('① languageOverride=en + 中文界面头 ⇒ 末尾是英文强化，且全量 messages 不含中文强化句', async () => {
    const providerId = await createProvider()
    hoisted.captured.length = 0
    const res = await post('/api/ai/inline', {
      providerId,
      prompt: '提取关键信息并翻译为英文：\n- 会议时间 15:00',
      context: '详情抽屉上下文',
      languageOverride: 'en',
    }, withZh) // 界面中文
    // 上游故意不可达（127.0.0.1:9）⇒ 502 是预期的；这里只要求**不是 400**（字段被接受）
    expect(res.status, JSON.stringify(res.body)).not.toBe(400)

    expect(tailOf().endsWith(EN_TRAILING), '末尾必须是**英文**强化句').toBe(true)
    // 全量 messages（含最前 system 段）里都不许出现中文强化句 —— 避免"最前中文、末尾英文"自相矛盾
    expect(allText()).not.toContain(ZH_TRAILING)
    expect(allText()).not.toContain(ZH_DIRECTIVE)
    expect(allText()).toContain(EN_TRAILING)
  })

  it('② languageOverride=zh + 英文界面头 ⇒ 末尾是中文强化，且不含英文强化句', async () => {
    const providerId = await createProvider()
    hoisted.captured.length = 0
    const res = await post('/api/ai/inline', {
      providerId,
      prompt: '审查以下设置项',
      context: '',
      languageOverride: 'zh',
    }, withEn) // 界面英文
    expect(res.status, JSON.stringify(res.body)).not.toBe(400) // 上游不可达 ⇒ 502 预期
    expect(tailOf().endsWith(ZH_TRAILING)).toBe(true)
    expect(allText()).not.toContain(EN_TRAILING)
    expect(allText()).not.toContain(EN_DIRECTIVE)
  })

  it('③ 缺省 / null / 非法值 ⇒ 回落到 X-UI-Locale（且非法值不 400）', async () => {
    const providerId = await createProvider()

    // 缺省 + 英文头 ⇒ 英文（既有行为）
    hoisted.captured.length = 0
    expect((await post('/api/ai/inline', { providerId, prompt: 'p', context: '' }, withEn)).status).not.toBe(400)
    expect(tailOf().endsWith(EN_TRAILING)).toBe(true)

    // null + 中文头 ⇒ 中文
    hoisted.captured.length = 0
    expect((await post('/api/ai/inline', { providerId, prompt: 'p', context: '', languageOverride: null }, withZh)).status).not.toBe(400)
    expect(tailOf().endsWith(ZH_TRAILING)).toBe(true)

    // 非法值 'fr' + 中文头 ⇒ **不 400**，按界面语言（中文）
    hoisted.captured.length = 0
    const fr = await post('/api/ai/inline', { providerId, prompt: 'p', context: '', languageOverride: 'fr' }, withZh)
    expect(fr.status, JSON.stringify(fr.body)).not.toBe(400) // 非法值**不 400**
    expect(tailOf().endsWith(ZH_TRAILING)).toBe(true)

    // 非法值（数字 / 脏串）+ 英文头 ⇒ 同样按界面语言（英文）
    hoisted.captured.length = 0
    expect((await post('/api/ai/inline', { providerId, prompt: 'p', context: '', languageOverride: 42 }, withEn)).status).not.toBe(400)
    expect(tailOf().endsWith(EN_TRAILING)).toBe(true)
    hoisted.captured.length = 0
    expect((await post('/api/ai/inline', { providerId, prompt: 'p', context: '', languageOverride: 'klingon' }, withEn)).status).not.toBe(400)
    expect(tailOf().endsWith(EN_TRAILING)).toBe(true)
  })

  it('④ 只影响 /inline：其它端点忽略该字段（/summarize、/suggest、/chat 回归）', async () => {
    const providerId = await createProvider()

    hoisted.captured.length = 0
    await post('/api/ai/summarize', { providerId, content: '内容', languageOverride: 'en' }, withZh)
    expect(tailOf().endsWith(ZH_TRAILING), '/summarize 必须仍按界面语言（中文）').toBe(true)
    expect(allText()).not.toContain(EN_TRAILING)

    hoisted.captured.length = 0
    await post('/api/ai/suggest', { providerId, content: '内容', languageOverride: 'en' }, withZh)
    expect(tailOf().endsWith(ZH_TRAILING), '/suggest 必须仍按界面语言（中文）').toBe(true)

    hoisted.captured.length = 0
    await post('/api/ai/chat', {
      providerId,
      messages: [{ role: 'user', content: '你好' }],
      options: { mode: 'ask', languageOverride: 'en' },
    }, withZh)
    expect(tailOf().endsWith(ZH_TRAILING), '/chat 必须仍按界面语言（中文）').toBe(true)
  })
})
