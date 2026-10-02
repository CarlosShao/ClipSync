// @vitest-environment jsdom
// === 证据：思考强度 5 档（low | medium | high | xhigh | max）直接英文、原样透传、能存住 ===
// 用户需求（原话）：「你要起码得有这么多等级，也不用翻译成低中高了，直接英文就行，不用管映射」。
// 冻结契约 v2：枚举 5 档、原样透传上游、不再有 reasoningLevels 映射表；
// 前端白名单（TS 联合类型 + 持久化归一）必须放行 xhigh / max。
//
// ① 设置页（AIProviderSettings）「思考强度」下拉：5 个英文选项 Low/Medium/High/XHigh/Max，
//    选 XHigh 后的 payload 是 thinkingStrength='xhigh'（PUT /api/ai/settings）。
//    本文件把界面语言固定成中文 → 顺带证明这些档位**不走 i18n 翻译**（中英 locale 写的是同一份英文）。
// ② AI 侧栏（AiChatComposer）思考等级选择器：同样 5 档英文 + 保留「关闭思考」，选 Max 外抛 'max'，
//    并把回流值渲染回触发按钮；同一行的「模式（问答/代理）」「模型」两个下拉仍可用（未被改坏）。
// ③ 持久化：normalize 放行 xhigh / max 且脏值兜底 medium；localStorage 瞬时回退 round-trip；
//    saveSettings 把 'max' 原样写进 PUT body。
//
// 只桩掉网络出口（@/api/client）与 toast / 权限组合式；@/api/ai 走真实实现（saveSettings 是它的薄封装），
// i18n、UI 组件、AiChatComposer、utils/aiThinking 照常执行 ⇒ 断言对象就是真实会发出的请求与真实 DOM。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.hoisted(() => {
  // 界面语言设为中文：验证"档位文案不翻译"（若有人把档位翻成 轻量/均衡/深度，本文件立刻红）
  try {
    localStorage.setItem('clipsync-lang', 'zh')
  } catch {
    /* 非 jsdom 环境忽略 */
  }
  // jsdom 未实现 scrollIntoView（供应商表单展开时会调用）→ 补桩
  const proto = (globalThis as unknown as { Element?: { prototype: Record<string, unknown> } }).Element?.prototype
  if (proto && typeof proto.scrollIntoView !== 'function') {
    proto.scrollIntoView = () => {}
  }
})

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  showToast: vi.fn(),
  can: vi.fn(),
}))

vi.mock('@/api/client', () => ({ api: mocks.api }))
vi.mock('@/composables/useSonner', () => ({
  useSonner: () => ({ show: mocks.showToast, loading: vi.fn(), dismiss: vi.fn(), rateLimited: vi.fn() }),
}))
vi.mock('@/composables/useMenuAccess', () => ({
  useMenuAccess: () => ({ can: mocks.can, modeOf: () => 'ok', setOverrides: vi.fn(), resetOverrides: vi.fn() }),
}))

import { createApp, h, nextTick, ref, type Component } from 'vue'
import AIProviderSettings from '../settings/settings-dialog/AIProviderSettings.vue'
import AiChatComposer from '../ai/AiChatComposer.vue'
import { getSettings, saveSettings } from '@/api/ai'
import { useI18n } from '@/composables/useI18n'
import {
  THINKING_STRENGTHS,
  THINKING_STRENGTH_LABELS,
  normalizeThinkingStrength,
  readStoredThinkingStrength,
  writeStoredThinkingStrength,
  type ThinkingStrength,
} from '@/utils/aiThinking'

const PROVIDER_ID = '11111111-2222-3333-4444-555555555555'

const { t } = useI18n()

/* ===================== 工具 ===================== */

async function flush(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await nextTick()
}

function mount(component: Component | (() => ReturnType<typeof h>)) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(component as Component)
  app.mount(host)
  return {
    unmount: () => {
      app.unmount()
      host.remove()
    },
  }
}

const trimmed = (el: Element | null) => (el?.textContent || '').trim()

/* ===================== ① 设置页：5 档英文 + 提交 payload ===================== */

describe('思考强度（设置页 AIProviderSettings）', () => {
  it('① 下拉渲染 5 个英文档位（含 XHigh / Max），选 XHigh 提交 thinkingStrength=xhigh', async () => {
    const m = mount(AIProviderSettings as Component)
    await flush()

    const row = document.querySelector('.ai-pref-row--sub')
    expect(row).not.toBeNull()
    const trigger = row?.querySelector('.custom-select-trigger') as HTMLButtonElement
    expect(trigger).toBeTruthy()
    // 当前档位（服务端回传 medium）直接显示英文
    expect(trimmed(trigger)).toContain('Medium')

    trigger.click()
    await flush()

    const options = Array.from(row?.querySelectorAll('.custom-select-option') || [])
    expect(options.map((o) => trimmed(o))).toEqual(['Low', 'Medium', 'High', 'XHigh', 'Max'])
    // 中英 locale 都是英文 ⇒ 中文界面下也不会出现"轻量/均衡/深度"
    const rowText = row?.textContent || ''
    for (const zhWord of ['轻量', '均衡', '深度']) {
      expect(rowText.includes(zhWord)).toBe(false)
    }

    const xhigh = options.find((o) => trimmed(o) === 'XHigh') as HTMLElement
    expect(xhigh).toBeTruthy()
    xhigh.click()
    await flush()

    // 提交的就是原样档位（不是映射后的上游取值）
    const put = mocks.api.mock.calls.find((c) => c[0] === 'PUT' && c[1] === '/api/ai/settings')
    expect(put).toBeTruthy()
    expect(put?.[2]).toEqual({ thinkingStrength: 'xhigh' })
    expect(trimmed(document.querySelector('.ai-pref-row--sub .custom-select-trigger'))).toContain('XHigh')

    m.unmount()
  })
})

/* ===================== ② AI 侧栏：5 档英文 + 关闭思考 ===================== */

describe('思考强度（AI 侧栏 AiChatComposer）', () => {
  it('② 侧栏选择器有 5 档英文 + 关闭思考，选 Max 外抛 max 并回流到触发按钮', async () => {
    const emitted: ThinkingStrength[] = []
    const strength = ref<ThinkingStrength>('high')
    const m = mount({
      render: () =>
        h(AiChatComposer as Component, {
          disabled: false,
          isStreaming: false,
          providers: [PROVIDER],
          selectedProviderId: PROVIDER_ID,
          selectedModel: 'gpt-4o-mini',
          thinkingEnabled: true,
          thinkingStrength: strength.value,
          mode: 'ask',
          contextUsage: null,
          onSetThinkingStrength: (s: ThinkingStrength) => {
            emitted.push(s)
            strength.value = s
          },
        }),
    })
    await flush()

    // 触发按钮显示当前档位英文
    const trigger = document.querySelector('.ai-tag-btn') as HTMLButtonElement
    expect(trimmed(trigger)).toContain('High')

    trigger.click()
    await flush()

    const popup = document.querySelector('.ai-popup') as HTMLElement
    expect(popup).not.toBeNull()
    const labels = Array.from(popup.querySelectorAll('button')).map((b) => trimmed(b))
    // 5 档英文 + 保留「关闭思考」（off）
    expect(labels).toEqual(['Low', 'Medium', 'High', 'XHigh', 'Max', '关闭思考'])

    const maxBtn = Array.from(popup.querySelectorAll('button')).find((b) => trimmed(b) === 'Max') as HTMLElement
    maxBtn.click()
    await flush()

    expect(emitted).toEqual(['max'])
    // 回流后触发按钮变成 Max（选择器关掉 Popover）
    expect(trimmed(document.querySelector('.ai-tag-btn'))).toContain('Max')
    expect(document.querySelector('.ai-popup')).toBeNull()

    // 旁边的「模式（问答/代理）」与「模型」两个下拉原样可用，没有被本次改动弄坏
    const tagButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.ai-tag-btn'))
    tagButtons()[1].click()
    await flush()
    const modeLabels = Array.from(document.querySelector('.ai-popup')?.querySelectorAll('button') || []).map((b) =>
      trimmed(b),
    )
    expect(modeLabels).toEqual([t('ai_mode_ask'), t('ai_mode_agent')])
    tagButtons()[1].click()
    await flush()
    expect(document.querySelector('.ai-popup')).toBeNull()

    tagButtons()[2].click()
    await flush()
    const modelPopup = document.querySelector('.ai-popup') as HTMLElement
    expect(modelPopup).not.toBeNull()
    expect(trimmed(modelPopup)).toContain('gpt-4o-mini')

    m.unmount()
  })
})

/* ===================== ③ 持久化白名单与请求体 ===================== */

describe('思考强度（5 档白名单 / 持久化）', () => {
  it('③ xhigh / max 不被白名单拦掉，可读写 localStorage，saveSettings 原样提交', async () => {
    expect(THINKING_STRENGTHS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(THINKING_STRENGTH_LABELS).toEqual({
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'XHigh',
      max: 'Max',
    })

    // 5 档全放行；脏值/空值兜底 medium
    expect(THINKING_STRENGTHS.map((s) => normalizeThinkingStrength(s))).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(normalizeThinkingStrength(undefined)).toBe('medium')
    expect(normalizeThinkingStrength('')).toBe('medium')
    expect(normalizeThinkingStrength('ultra')).toBe('medium')

    // localStorage 瞬时回退（侧栏 hydrate）能存住两个新档位
    writeStoredThinkingStrength('xhigh')
    expect(localStorage.getItem('ai-thinking-strength')).toBe('xhigh')
    expect(readStoredThinkingStrength()).toBe('xhigh')
    writeStoredThinkingStrength('max')
    expect(readStoredThinkingStrength()).toBe('max')

    // GET 回传新档位时不丢：调用真实的 saveSettings 薄封装 → PUT body 原样
    mocks.api.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { ok: true, thinkingStrength: 'max' },
    })
    const res = await saveSettings({ thinkingStrength: 'max' })
    expect(res.ok).toBe(true)
    expect(mocks.api).toHaveBeenCalledWith('PUT', '/api/ai/settings', { thinkingStrength: 'max' })

    // 读接口也走同一条链路（计划里的 GET /api/ai/settings）
    mocks.api.mockResolvedValueOnce({ ok: true, status: 200, data: { thinkingStrength: 'xhigh' } })
    const got = await getSettings()
    expect(got.data?.thinkingStrength).toBe('xhigh')
    expect(normalizeThinkingStrength(got.data?.thinkingStrength)).toBe('xhigh')
  })
})

/* ===================== 夹具 ===================== */

const PROVIDER = {
  id: PROVIDER_ID,
  provider: 'custom',
  name: 'My Provider',
  base_url: 'https://api.example.com',
  model: 'gpt-4o-mini',
  models: ['gpt-4o-mini'],
  is_default: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  has_key: true,
  api_format: 'openai',
}

beforeEach(() => {
  mocks.api.mockReset()
  mocks.showToast.mockReset()
  mocks.can.mockReset()
  mocks.can.mockReturnValue(true)
  localStorage.removeItem('ai-thinking-strength')

  mocks.api.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path === '/api/ai/providers') {
      return { ok: true, status: 200, data: { items: [PROVIDER], count: 1 } }
    }
    if (method === 'GET' && path === '/api/ai/presets') {
      return {
        ok: true,
        status: 200,
        data: {
          items: [
            { provider: 'custom', label: 'Custom', family: 'custom', defaultBaseUrl: '', defaultModel: 'gpt-4o-mini' },
          ],
        },
      }
    }
    if (method === 'GET' && path === '/api/ai/settings') {
      return {
        ok: true,
        status: 200,
        data: {
          defaultProviderId: PROVIDER_ID,
          defaultModel: 'gpt-4o-mini',
          selectedModels: {},
          defaultMode: 'ask',
          thinkingEnabled: true,
          thinkingStrength: 'medium',
          memoryEnabled: false,
          customSystemPrompt: '',
          searchProvider: '',
          searchBaseUrl: '',
          searchHasKey: false,
        },
      }
    }
    return { ok: true, status: 200, data: {} }
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
})
