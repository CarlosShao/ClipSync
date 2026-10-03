// @vitest-environment jsdom
// === 证据：页内 AI 小功能的提示词跟随界面语言（输出才跟着变英文） ===
//
// 用户实测：界面切 English 后，「Review settings」的**生成条目**仍是中文。
// 根因：服务端按 X-UI-Locale 注入的英文指令被**前端写死的中文 prompt 本体**压住了。
// 修法：提示词收敛到 utils/inlinePrompts.ts（zh/en 双份一处维护），并在**末尾**补语言要求。
//
// 本文件证明：
//   ① en：**每个**变体的提示词都不含任何中文，且末段是英文语言要求（"Answer in English"）
//   ② zh：反之（中文提示词 + 中文末段）
//   ③ 切语言后**下一个请求立刻生效**（不重启模块），并且**真实请求体**（/api/ai/inline）里就是英文
//   ④ 聊天/Agent 不受影响：streamChat 的 messages 原样透传，不追加任何语言尾巴
//   ⑤ 静态守卫：7 个页内小功能入口都改走 inlinePromptFor，且不再残留写死的中文提示词
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useI18n } from '@/composables/useI18n'
import { useConfigStore } from '@/stores/configStore'
import {
  INLINE_LANG_TAIL,
  INLINE_PROMPTS,
  inlinePromptFor,
  type InlinePromptVariant,
  INLINE_CONTEXT_LABELS,
  inlineContextLabel,
} from '@/utils/inlinePrompts'

const VARIANTS: InlinePromptVariant[] = [
  'diagnose',
  'review',
  'summarizeToday',
  'organizeFavorites',
  'generateTemplate',
  'summarizeCollection',
  'drawerSummary',
  'drawerExtract',
  'drawerTranslate',
]
const CJK = /[\u4e00-\u9fff]/

type Call = { url: string; init: RequestInit }
const calls: Call[] = []

vi.hoisted(() => {
  const AS = globalThis.AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }
  if (typeof AS?.timeout !== 'function') AS.timeout = () => new AbortController().signal
})

function stubFetch() {
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url.includes('/api/csrf-token')) return new Response(JSON.stringify({ token: 'csrf-1' }), { status: 200 })
      if (url.includes('/api/ai/chat')) return new Response('data: [DONE]\n\n', { status: 200 })
      return new Response(JSON.stringify({ ok: true, text: 'ok' }), { status: 200 })
    }),
  )
}

const bodyOf = (path: string) => {
  const call = [...calls].reverse().find((c) => c.url.includes(path))
  return JSON.parse(String(call?.init.body ?? '{}')) as Record<string, unknown>
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  const config = useConfigStore()
  config.config.token = 't-1'
  config.config.server_url = 'http://localhost:3000'
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('页内 AI 小功能提示词跟随界面语言', () => {
  it('① en：每个变体的提示词**不含任何中文**，且末段要求用英文回答', () => {
    const { setLang } = useI18n()
    setLang('en')
    for (const variant of VARIANTS) {
      const prompt = inlinePromptFor(variant)
      expect(CJK.test(prompt), `${variant} 的英文提示词仍含中文：${prompt.slice(0, 80)}`).toBe(false)
      expect(prompt.trimEnd().endsWith(INLINE_LANG_TAIL.en), `${variant} 末段缺少英文语言要求`).toBe(true)
      expect(prompt).toContain('Answer in English')
      // 不能是空壳：正文长度要够（防"只留一句语言要求"的假绿）
      expect(prompt.replace(INLINE_LANG_TAIL.en, '').trim().length).toBeGreaterThan(20)
    }
  })

  it('② zh：每个变体是中文提示词 + 中文末段（且与英文版确实不同）', () => {
    const { setLang } = useI18n()
    setLang('zh')
    for (const variant of VARIANTS) {
      const prompt = inlinePromptFor(variant)
      expect(CJK.test(prompt), `${variant} 的中文提示词丢了中文`).toBe(true)
      expect(prompt.trimEnd().endsWith(INLINE_LANG_TAIL.zh)).toBe(true)
    }
    for (const variant of VARIANTS) {
      expect(INLINE_PROMPTS[variant].zh.join('\n')).not.toBe(INLINE_PROMPTS[variant].en.join('\n'))
    }
  })

  it('③ 切语言后下一个请求立刻生效；真实请求体（/api/ai/inline）里就是英文', async () => {
    const { setLang } = useI18n()
    setLang('zh')
    const zhPrompt = inlinePromptFor('review')
    setLang('en') // 同一模块内切换，不重启
    const enPrompt = inlinePromptFor('review')
    expect(CJK.test(zhPrompt)).toBe(true)
    expect(CJK.test(enPrompt)).toBe(false)

    // 走组件同一条路：inlinePromptFor → inlineChat → POST /api/ai/inline
    const { inlineChat } = await import('@/api/ai')
    await inlineChat(enPrompt)
    const body = bodyOf('/api/ai/inline')
    expect(CJK.test(String(body.prompt))).toBe(false)
    expect(String(body.prompt)).toContain('Answer in English')
  })

  it('④ 聊天/Agent 不受影响：streamChat 的 messages 原样透传，不追加语言尾巴', async () => {
    const { setLang } = useI18n()
    setLang('en')
    const { streamChat } = await import('@/api/ai')
    const messages = [{ role: 'user' as const, content: '用中文回答这个问题：你好' }]

    await streamChat({ providerId: 'p-1', messages, onDelta: () => {} })
    const body = bodyOf('/api/ai/chat')
    expect(body.messages).toEqual(messages) // 原样
    expect(JSON.stringify(body)).not.toContain('Answer in English')
    expect(CJK.test(String((body.messages as { content: string }[])[0].content))).toBe(true) // 用户的中文输入未被改写
  })

  it('⑤ 静态守卫：7 个页内小功能入口都走 inlinePromptFor，且不再残留写死的中文提示词', () => {
    const files = [
      'components/settings/DevicesView.vue',
      'components/settings/SettingsView.vue',
      'components/clipboard/ClipboardView.vue',
      'components/clipboard/FavOrganizeFlow.vue',
      'components/clipboard/TemplateGenerateDialog.vue',
      'components/clipboard/FavoritesView.vue',
      'components/clipboard/ClipDetailDrawer.vue',
    ]
    const banned = [
      '中文输出',
      '你是桌面端设置审查助手',
      '你是剪贴板同步链路的诊断助手',
      '你是剪贴板收藏整理助手',
      '你是剪贴板文本模板生成助手',
      '一句话中文建议',
    ]
    for (const rel of files) {
      const src = readFileSync(resolve(process.cwd(), 'src', rel), 'utf8')
      expect(src, `${rel} 未改用 inlinePromptFor`).toContain('inlinePromptFor')
      for (const bad of banned) {
        expect(src, `${rel} 仍写死中文提示词：${bad}`).not.toContain(bad)
      }
    }

    // 上下文标签：只看 **context 拼装函数体**（组件里还有 i18n 的 UI 文案 fallback，那是正常的）
    const fnBody = (src: string, name: string) => {
      const start = src.indexOf(`function ${name}`)
      if (start < 0) throw new Error(`未找到函数 ${name}`)
      const end = src.indexOf('\n}', start)
      // 去掉注释：注释里提到旧文案（说明改动原因）不算泄漏
      return src
        .slice(start, end < 0 ? src.length : end)
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
    }
    const contextSites: [string, string][] = [
      ['components/settings/DevicesView.vue', 'buildDiagContext'],
      ['components/clipboard/FavOrganizeFlow.vue', 'contentPreview'],
      ['components/clipboard/FavoritesView.vue', 'buildFavoriteDigest'],
    ]
    for (const [rel, fn] of contextSites) {
      const body = fnBody(readFileSync(resolve(process.cwd(), 'src', rel), 'utf8'), fn)
      for (const bad of ['（图片）', '已配对设备', '端到端加密：已开启', '本机最近同步流水']) {
        expect(body, `${rel} 的 ${fn} 上下文标签仍写死中文：${bad}`).not.toContain(bad)
      }
      expect(body, `${rel} 的 ${fn} 应改用 inlineContextLabel`).toContain('inlineContextLabel')
    }
  })

  it('⑥ languageOverride：只有「翻译为英文」带 languageOverride=en，其余变体不带', async () => {
    const { setLang } = useI18n()
    setLang('zh') // 中文界面：翻译变体仍必须显式声明目标语言，否则会与服务端的"用中文回答"冲突
    const { inlineChat } = await import('@/api/ai')

    await inlineChat(inlinePromptFor('drawerTranslate'), 'hello', undefined, undefined, 'en')
    expect(bodyOf('/api/ai/inline').languageOverride).toBe('en')

    await inlineChat(inlinePromptFor('review'), 'ctx')
    expect('languageOverride' in bodyOf('/api/ai/inline')).toBe(false)

    // 接线守卫：抽屉里只有 translate 变体带 languageOverride
    const drawer = readFileSync(resolve(process.cwd(), 'src/components/clipboard/ClipDetailDrawer.vue'), 'utf8')
    expect(drawer).toMatch(/promptKey: 'drawerTranslate',\s*\n\s*languageOverride: 'en'/)
    expect(drawer).not.toMatch(/promptKey: 'drawerSummary',\s*\n\s*languageOverride/)
    expect(drawer).not.toMatch(/promptKey: 'drawerExtract',\s*\n\s*languageOverride/)
  })

  it('⑦ 上下文标签：en 下不含中日韩字符，且真实请求体的 context 无中文', async () => {
    const { setLang } = useI18n()
    setLang('en')
    for (const key of Object.keys(INLINE_CONTEXT_LABELS) as (keyof typeof INLINE_CONTEXT_LABELS)[]) {
      const label = inlineContextLabel(key, { n: 3 })
      expect(CJK.test(label), `en 标签含中文：${key} = ${label}`).toBe(false)
    }
    setLang('zh')
    for (const key of Object.keys(INLINE_CONTEXT_LABELS) as (keyof typeof INLINE_CONTEXT_LABELS)[]) {
      const label = inlineContextLabel(key, { n: 3 })
      expect(label.length).toBeGreaterThan(0)
    }

    // 真实请求体：en 语言 + 用双语标签拼出的 context ⇒ 不含中文
    setLang('en')
    const context = [
      inlineContextLabel('pairedDevices', { n: 2 }),
      inlineContextLabel('e2eOn'),
      inlineContextLabel('recentSyncLog'),
      `${inlineContextLabel('image')} clipboard item`,
    ].join('\n')
    expect(CJK.test(context)).toBe(false)

    const { inlineChat } = await import('@/api/ai')
    await inlineChat(inlinePromptFor('diagnose'), context)
    const body = bodyOf('/api/ai/inline')
    expect(CJK.test(String(body.context))).toBe(false)
    expect(String(body.context)).toContain('Paired devices (2):')
  })
})
