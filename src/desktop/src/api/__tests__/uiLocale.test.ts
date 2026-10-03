// @vitest-environment jsdom
// === 证据：AI 生成内容跟随界面语言（X-UI-Locale） ===
//
// 用户需求（原话）：「英文环境下，这类 AI 功能**生成的内容**也要是英文的，就是生成的内容也要根据当前语言
// 切换……**所有这类的 AI 功能**，不是这一个。」
//
// 冻结合约 v6：桌面端所有 AI 请求都带 `X-UI-Locale: zh | en`，取值来自**当前界面语言**且**每请求实时取**；
// 服务端按该头指示模型用对应语言回答，无头保持原行为。
//
// 本文件用**真实的 api() / 真实的 AI api 函数**（只桩掉 fetch 出口）来证明：
//   ① api() 发出的请求头带 X-UI-Locale，切语言后**下一个请求立刻变**（不重启模块 ⇒ 实时取值）
//   ② 各 AI 入口（chat / summarize / suggest / inline / refactor）都带该头（一处生效）
//   ③ 原先的两处**裸 fetch**（流式 chat / 提示词改写）现在同时带鉴权与 locale（顺带补上 CSRF）
//   ④ 归一化规则（zh-CN / zh-Hans → zh；en-US → en；未知 → en）
//   ⑤ 词典兜底守卫：AI 相关键在中英词典都必须存在，且英文值不得含中文（这正是用户截图里那类"英文界面出中文"）
//   ⑥ 渲染级：英文环境下 AI 消息占位文案渲染英文（i18n 漏网修复点之一）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'
import { normalizeUiLocale, uiLocaleHeader, useI18n } from '@/composables/useI18n'
import { useConfigStore } from '@/stores/configStore'

// jsdom 的 AbortSignal 没有 timeout()；api() 用它做 30s 兜底 ⇒ 补桩（仅测试环境）
vi.hoisted(() => {
  const AS = globalThis.AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }
  if (typeof AS?.timeout !== 'function') {
    AS.timeout = () => new AbortController().signal
  }
})

type Call = { url: string; init: RequestInit }
const calls: Call[] = []

function stubFetch() {
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url.includes('/api/csrf-token')) {
        return new Response(JSON.stringify({ token: 'csrf-1' }), { status: 200 })
      }
      if (url.includes('/api/ai/chat') || url.includes('/api/ai/refactor-prompt')) {
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }),
  )
}

/** 取最后一次命中该路径的请求头 */
function headerOf(path: string, name: string): string | undefined {
  const call = [...calls].reverse().find((c) => c.url.includes(path))
  return (call?.init.headers as Record<string, string> | undefined)?.[name]
}
const lastCallTo = (path: string) => [...calls].reverse().find((c) => c.url.includes(path))

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

describe('AI 生成内容跟随界面语言（X-UI-Locale）', () => {
  it('① api() 带 X-UI-Locale；切到 en 后**下一个请求立刻变成 en**（实时取值，不重启模块）', async () => {
    const { setLang } = useI18n()
    const { api } = await import('@/api/client')

    setLang('zh')
    await api('GET', '/api/ai/providers')
    expect(headerOf('/api/ai/providers', 'X-UI-Locale')).toBe('zh')

    // 同一个模块、同一个 api()：切语言后立刻生效
    setLang('en')
    await api('GET', '/api/ai/providers')
    expect(headerOf('/api/ai/providers', 'X-UI-Locale')).toBe('en')

    expect(uiLocaleHeader()).toBe('en')
  })

  it('② 逐个 AI 入口都带该头：summarize / suggest / inline / chat / refactor', async () => {
    const { setLang } = useI18n()
    setLang('en')
    const { summarizeClipboard, suggestClipboard, inlineChat, streamChat, streamRefactorPrompt } =
      await import('@/api/ai')

    await summarizeClipboard({ providerId: 'p-1', content: 'hello' })
    expect(headerOf('/api/ai/summarize', 'X-UI-Locale')).toBe('en')

    await suggestClipboard({ providerId: 'p-1', content: 'hello' })
    expect(headerOf('/api/ai/suggest', 'X-UI-Locale')).toBe('en')

    await inlineChat('诊断同步')
    expect(headerOf('/api/ai/inline', 'X-UI-Locale')).toBe('en')

    await streamChat({
      providerId: 'p-1',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: () => {},
    })
    expect(headerOf('/api/ai/chat', 'X-UI-Locale')).toBe('en')

    await streamRefactorPrompt({ providerId: 'p-1', content: '草稿', onDelta: () => {} })
    expect(headerOf('/api/ai/refactor-prompt', 'X-UI-Locale')).toBe('en')
  })

  it('③ 原先的两处裸 fetch（流式 chat / 提示词改写）现在同时带鉴权 + locale（顺带补 CSRF）', async () => {
    const { setLang } = useI18n()
    setLang('zh')
    const { streamChat, streamRefactorPrompt } = await import('@/api/ai')

    await streamChat({ providerId: 'p-1', messages: [{ role: 'user', content: 'hi' }], onDelta: () => {} })
    // 改前：只有 Authorization + X-CSRF-Token（裸 fetch）；改后多了 locale
    expect(headerOf('/api/ai/chat', 'Authorization')).toBe('Bearer t-1')
    expect(headerOf('/api/ai/chat', 'X-CSRF-Token')).toBe('csrf-1')
    expect(headerOf('/api/ai/chat', 'X-UI-Locale')).toBe('zh')
    expect(lastCallTo('/api/ai/chat')!.init.credentials).toBe('include')

    await streamRefactorPrompt({ providerId: 'p-1', content: '草稿', onDelta: () => {} })
    expect(headerOf('/api/ai/refactor-prompt', 'Authorization')).toBe('Bearer t-1')
    expect(headerOf('/api/ai/refactor-prompt', 'X-UI-Locale')).toBe('zh')
  })

  it('④ 归一化规则：zh-CN / zh-Hans / zh-TW → zh；en-US → en；未知或空 → en', () => {
    expect(normalizeUiLocale('zh')).toBe('zh')
    expect(normalizeUiLocale('zh-CN')).toBe('zh')
    expect(normalizeUiLocale('zh-Hans')).toBe('zh')
    expect(normalizeUiLocale('ZH-TW')).toBe('zh')
    expect(normalizeUiLocale('en')).toBe('en')
    expect(normalizeUiLocale('en-US')).toBe('en')
    expect(normalizeUiLocale('fr-FR')).toBe('en')
    expect(normalizeUiLocale('')).toBe('en')
    expect(normalizeUiLocale(null)).toBe('en')
  })

  it('⑤ 词典守卫：AI 相关键中英都有，且英文值不含中文（用户截图那类"英文界面出中文"）', () => {
    const AI_KEYS = [
      'ai_content_waiting',
      'ai_ruler_question',
      'fav_ai_org_groups',
      'fav_ai_org_tags',
      'inline_ai_org_adopt_confirm',
      'inline_ai_org_apply_fail',
      'inline_ai_org_applying',
      'inline_ai_org_copy_list',
      'inline_ai_org_done',
      'inline_ai_org_parse_fail',
      'inline_ai_org_preview',
      'inline_ai_org_undo_hint',
      'tpl_ai_gen_default_name',
      'tpl_ai_gen_dialog_title',
      'tpl_ai_gen_empty_intent',
      'tpl_ai_gen_generate',
      'tpl_ai_gen_intent_hint',
      'tpl_ai_gen_intent_label',
      'tpl_ai_gen_intent_ph',
      'tpl_ai_gen_parse_fail',
      'tpl_ai_gen_preview',
      'tpl_ai_gen_regen',
      'tpl_ai_gen_save',
      'tpl_ai_gen_vars',
    ] as const
    const enDict = en as Record<string, string>
    const zhDict = zh as Record<string, string>
    for (const key of AI_KEYS) {
      expect(zhDict[key], `zh.${key} 缺失`).toBeTruthy()
      expect(enDict[key], `en.${key} 缺失`).toBeTruthy()
      expect(/[\u4e00-\u9fff]/.test(enDict[key]), `en.${key} 含中文：${enDict[key]}`).toBe(false)
    }
  })

  it('⑥ 渲染级：英文环境下 AI 消息占位文案是英文（中文环境仍是中文）', async () => {
    const { createApp, h, nextTick } = await import('vue')
    const AiMessage = (await import('@/components/ai/AiMessage.vue')).default
    const { setLang } = useI18n()

    // 流式开始、只有 thinking、没有正文 ⇒ 走 ai_content_waiting 占位
    const message = { id: 'm-1', role: 'assistant', content: '', thinking: '思考一下', thinkingActive: true }
    const renderWith = async (lang: 'en' | 'zh') => {
      setLang(lang)
      const host = document.createElement('div')
      document.body.appendChild(host)
      const app = createApp({
        render: () => h(AiMessage as never, { message, index: 0, isStreaming: true, isLatest: true } as never),
      })
      app.mount(host)
      await nextTick()
      const text = host.textContent || ''
      app.unmount()
      host.remove()
      return text
    }

    expect(await renderWith('en')).toContain(enDictValue('ai_content_waiting'))
    expect(await renderWith('zh')).toContain('思考中，正文稍候…')
  })
})

function enDictValue(key: string): string {
  return (en as Record<string, string>)[key]
}
