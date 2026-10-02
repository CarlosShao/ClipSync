// @vitest-environment jsdom
// === 证据：设置 → AI → 供应商编辑 →「模型库」（契约 v3）===
// 用户实测第一版后的重构要求，逐条在此落地：
//   ① 单排胶囊（不再上下两排）+ 选中态；点击切换 enabled（payload 正确）
//   ② 切换失败 → 乐观更新回滚
//   ③ 不适用对话分组：默认折叠 + 默认不启用，展开后可手动启用
//   ④ 刷新后一次性建议条：文案 + 三个动作产生的 PUT 集合；关闭后本会话不再出现
//   ⑤ 行内图标操作（自检/配置/停用/清除）不弄丢已启用集合（emit 回父组件）
//   ⑥ 能力自检三态：✅ 可用（耗时）/ ⚠️ 不支持该推理参数 → 一键改协议 / ❌ 不可用（原样展示上游错误）
//   ⑦ 别名与拖拽排序的 payload 正确
//   ⑧ 配置弹窗逐字段来源标记 + 单项恢复 patch 正确
//   ⑨ 搜索与「只看已启用 / 只看对话模型」筛选生效
//   ⑩ 既有正确行为：GET 带 providerId、预设值原样渲染、非法输入不提交、接口 404 如实降级、
//      打开/关闭弹窗与行内操作都不影响父组件多选
//
// 只桩掉网络出口：@/api/client（modelSettings 走的统一 api()）与 @/api/ai（供应商 CRUD/刷新）。
// 真实链路（i18n、UI 组件、AIModelSettingsPanel、modelSettings 的 URL 构造）照常执行。
// jsdom 无排版引擎 ⇒ 不断言任何样式，只断言调用与 DOM。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// jsdom 未实现 scrollIntoView（供应商表单展开时会调用）→ 补桩
vi.hoisted(() => {
  const proto = (globalThis as unknown as { Element?: { prototype: Record<string, unknown> } }).Element?.prototype
  if (proto && typeof proto.scrollIntoView !== 'function') {
    proto.scrollIntoView = () => {}
  }
})

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  showToast: vi.fn(),
  getProviders: vi.fn(),
  getPresets: vi.fn(),
  getProviderModels: vi.fn(),
  fetchProviderModels: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  can: vi.fn(),
}))

vi.mock('@/api/client', () => ({ api: mocks.api }))
vi.mock('@/composables/useSonner', () => ({
  useSonner: () => ({ show: mocks.showToast, loading: vi.fn(), dismiss: vi.fn(), rateLimited: vi.fn() }),
}))
vi.mock('@/composables/useMenuAccess', () => ({
  useMenuAccess: () => ({ can: mocks.can, modeOf: () => 'ok', setOverrides: vi.fn(), resetOverrides: vi.fn() }),
}))
vi.mock('@/api/ai', () => ({
  getProviders: mocks.getProviders,
  getPresets: mocks.getPresets,
  createProvider: mocks.createProvider,
  updateProvider: mocks.updateProvider,
  deleteProvider: vi.fn(),
  testProvider: vi.fn(),
  getProviderModels: mocks.getProviderModels,
  fetchProviderModels: mocks.fetchProviderModels,
  getSettings: mocks.getSettings,
  saveSettings: mocks.saveSettings,
  testSearchConfig: vi.fn(),
}))

import { createApp, h, nextTick, ref, type Component } from 'vue'
import AIModelSettingsPanel from '../AIModelSettingsPanel.vue'
import AIProviderSettings from '../AIProviderSettings.vue'
import { ALIAS_MAX_LEN, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, RESTORE_PRESET_PATCH } from '@/api/modelSettings'
import { useI18n } from '@/composables/useI18n'

const { t, tf } = useI18n()

const PROVIDER_ID = '11111111-2222-3333-4444-555555555555'

/* ===================== 夹具 ===================== */

type Raw = Record<string, unknown>

/** 服务端 v3 条目：对话模型，已启用，预设值 200000/16384、识图 + reasoning_effort */
function chatOn(over: Raw = {}): Raw {
  return {
    model: 'gpt-4o-mini',
    contextWindow: 200000,
    maxOutput: 16384,
    supportsText: true,
    supportsImage: true,
    supportsVideo: false,
    supportsAudio: false,
    reasoningEnabled: true,
    reasoningProtocol: 'openai_reasoning_effort',
    enabled: true,
    alias: null,
    sortOrder: null,
    applicability: 'chat',
    isPreset: true,
    isOverridden: false,
    ...over,
  }
}
function chatOff(over: Raw = {}): Raw {
  return chatOn({ model: 'o3-mini', enabled: false, isPreset: false, contextWindow: 100000, ...over })
}
function nonChat(model: string, applicability: string, over: Raw = {}): Raw {
  return chatOn({ model, applicability, enabled: false, isPreset: true, contextWindow: null, maxOutput: null, ...over })
}

/** 默认 PUT 响应：把 patch 合并回该模型的原条目（模拟服务端整行落库后的回读） */
function installApi(items: Raw[], probe?: unknown) {
  mocks.api.mockImplementation(async (method: string, path: string, body: Raw) => {
    const p = String(path)
    if (method === 'PUT' && p === '/api/ai/model-settings') {
      const base = items.find((i) => i.model === body.model) ?? { model: body.model }
      const patch = (body.patch || {}) as Raw
      const merged: Raw = { ...base }
      for (const [k, v] of Object.entries(patch)) {
        if (v !== null) merged[k] = v
        else if (k === 'contextWindow' || k === 'maxOutput') merged[k] = null
      }
      merged.isOverridden = true
      return { ok: true, status: 200, data: { ok: true, item: merged } }
    }
    if (method === 'POST' && p === '/api/ai/model-settings/probe') {
      return { ok: true, status: 200, data: probe ?? {} }
    }
    if (method === 'GET' && p.startsWith('/api/ai/model-settings?')) {
      return { ok: true, status: 200, data: { items } }
    }
    return { ok: true, status: 200, data: {} }
  })
}

const putBodies = () =>
  mocks.api.mock.calls.filter((c) => c[0] === 'PUT').map((c) => c[2] as { model: string; patch: Raw })
const modelSettingCalls = () =>
  mocks.api.mock.calls.filter((c) => String(c[1] || '').startsWith('/api/ai/model-settings'))
/** 所有写请求（任何 PUT 端点）——"刷新零写入"这类断言只看它 */
const writeCalls = () => mocks.api.mock.calls.filter((c) => c[0] === 'PUT')
/** PUT /api/ai/model-settings/batch 的请求体（批量启用/停用走这条） */
const batchPayloads = () =>
  mocks.api.mock.calls
    .filter((c) => String(c[1]) === '/api/ai/model-settings/batch')
    .map((c) => c[2] as { providerId: string; items: Array<{ model: string; patch: Raw }> })

/**
 * 迷你服务端（带状态）：GET 返回 live；单条 PUT / batch 把 patch 真的合并进 live 再返回。
 * 批量操作成功后组件会重新拉取一次，所以 mock 必须"记得住"写入，才能验证界面与库一致。
 */
function installLiveApi(live: Raw[], opts: { batchFails?: boolean } = {}) {
  mocks.api.mockImplementation(async (method: string, path: string, body: Raw) => {
    const p = String(path)
    if (method === 'GET' && p.startsWith('/api/ai/model-settings?')) {
      return { ok: true, status: 200, data: { items: live } }
    }
    if (method === 'POST' && p === '/api/ai/model-settings/probe') {
      return { ok: true, status: 200, data: { ok: true, latencyMs: 5, supportsReasoningParam: 'unknown' } }
    }
    if (method === 'PUT' && p === '/api/ai/model-settings/batch') {
      if (opts.batchFails) return { ok: false, status: 500, error: 'batch boom' }
      const items = (body.items ?? []) as Array<{ model: string; patch: Raw }>
      const out: Raw[] = []
      for (const it of items) {
        const idx = live.findIndex((x) => x.model === it.model)
        if (idx < 0) continue
        const merged: Raw = { ...live[idx] }
        for (const [k, v] of Object.entries(it.patch)) {
          if (v !== null) merged[k] = v
        }
        merged.isOverridden = true
        live[idx] = merged
        out.push(merged)
      }
      return { ok: true, status: 200, data: { ok: true, updated: out.length, items: out } }
    }
    if (method === 'PUT' && p === '/api/ai/model-settings') {
      const idx = live.findIndex((x) => x.model === body.model)
      if (idx < 0) return { ok: true, status: 200, data: { ok: true, item: { model: body.model } } }
      const merged: Raw = { ...live[idx], ...(body.patch ?? {}) }
      merged.isOverridden = true
      live[idx] = merged
      return { ok: true, status: 200, data: { ok: true, item: merged } }
    }
    return { ok: true, status: 200, data: {} }
  })
}

async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await nextTick()
}

/** 面板挂载：可改 models / refreshSeq，并记录 emit 出来的启用集合 */
function mountPanel(opts: { models?: string[]; items?: Raw[]; probe?: unknown; notFound?: boolean } = {}) {
  if (opts.notFound) {
    // 如实降级场景：接口整体 404（契约未就绪/网络异常）
    mocks.api.mockResolvedValue({ ok: false, status: 404, error: 'Not Found' })
  } else {
    installApi(opts.items ?? [], opts.probe)
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const models = ref(opts.models ?? [])
  const refreshSeq = ref(0)
  const emitted: string[][] = []
  const app = createApp({
    render: () =>
      h(AIModelSettingsPanel as Component, {
        props: undefined,
        providerId: PROVIDER_ID,
        models: models.value,
        refreshSeq: refreshSeq.value,
        // emit('update:enabledModels') 的监听名是 onUpdate:enabledModels（含冒号）
        'onUpdate:enabledModels': (list: string[]) => {
          emitted.push(list)
          models.value = [...list]
        },
      }),
  })
  app.mount(host)
  return {
    setRefreshSeq: async (n: number) => {
      refreshSeq.value = n
      await flush(8)
    },
    emitted,
    unmount: () => {
      app.unmount()
      host.remove()
    },
  }
}

function mountComponent(component: Component) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(component)
  app.mount(host)
  return {
    unmount: () => {
      app.unmount()
      host.remove()
    },
  }
}

const chip = (model: string) => document.querySelector<HTMLElement>(`.aim-chip[data-model="${model}"]`)
const row = (model: string) => document.querySelector<HTMLElement>(`.aim-row[data-model="${model}"]`)
const rowAction = (model: string, action: string) =>
  document.querySelector<HTMLButtonElement>(`.aim-row[data-model="${model}"] [data-action="${action}"]`)
const buttonByAction = (action: string) => document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
const text = () => document.body.textContent || ''
const chipOn = (model: string) => !!chip(model)?.classList.contains('aim-chip--on')

function buttonByLabel(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === label)
  if (!found) throw new Error(`button not found: ${label}`)
  return found as HTMLButtonElement
}

async function setValue(el: HTMLInputElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}

function clickByTitle(title: string) {
  const el = document.querySelector<HTMLElement>(`[title="${title}"]`)
  if (!el) throw new Error(`element with title not found: ${title}`)
  el.click()
}

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

/* ===================== ① 单排胶囊 + 切换 enabled ===================== */

describe('模型库 — 单排胶囊与启用状态', () => {
  it('① 全部模型在一排胶囊里；已启用高亮，点击切换发 {enabled:false}', async () => {
    const m = mountPanel({ items: [chatOn(), chatOff()] })
    await flush()

    // GET 带 providerId；服务端预设值原样渲染
    const getCall = mocks.api.mock.calls.find((c) => c[0] === 'GET')
    expect(getCall?.[1]).toBe(`/api/ai/model-settings?providerId=${PROVIDER_ID}`)
    expect(text()).toContain('200000')

    const chips = document.querySelectorAll('.aim-chip')
    expect(chips).toHaveLength(2)
    expect(chipOn('gpt-4o-mini')).toBe(true)
    expect(chipOn('o3-mini')).toBe(false)

    chip('gpt-4o-mini')!.click()
    await flush()

    expect(putBodies()).toEqual([{ providerId: PROVIDER_ID, model: 'gpt-4o-mini', patch: { enabled: false } }])
    expect(chipOn('gpt-4o-mini')).toBe(false)
    // emit 回父组件：启用集合里只剩 o3-mini 之外 —— o3-mini 本来就没启用，所以是空集
    expect(m.emitted[m.emitted.length - 1]).toEqual([])

    m.unmount()
  })

  it('② 启用状态保存失败 → 乐观更新回滚并提示（不假装成功）', async () => {
    const m = mountPanel({ items: [chatOn()] })
    await flush()
    expect(chipOn('gpt-4o-mini')).toBe(true)

    mocks.api.mockImplementation(async (method: string, path: string) => {
      if (method === 'PUT' && String(path) === '/api/ai/model-settings') {
        return { ok: false, status: 500, error: 'boom' }
      }
      return { ok: true, status: 200, data: { items: [chatOn()] } }
    })

    chip('gpt-4o-mini')!.click()
    await flush()

    expect(chipOn('gpt-4o-mini')).toBe(true) // 已回滚
    expect(mocks.showToast).toHaveBeenCalledWith('boom', 'error')

    m.unmount()
  })

  it('③ 不适用对话分组默认折叠 + 默认不启用；展开后可手动启用', async () => {
    const m = mountPanel({ items: [chatOn(), nonChat('tts-1', 'audio'), nonChat('gpt-image-1', 'image')] })
    await flush()

    // 默认折叠：非对话胶囊不在 DOM 里，但分组头给出数量与原因
    expect(chip('tts-1')).toBeNull()
    const head = buttonByAction('toggle-nonchat')
    expect(head).toBeTruthy()
    expect(head!.textContent).toContain(t('ai_model_group_nonchat'))
    expect(head!.textContent).toContain('2')
    expect(text()).toContain(t('ai_model_app_audio'))
    // 默认不启用：加载过程中没有为它们发过任何启用请求
    expect(putBodies()).toEqual([])

    head!.click()
    await flush()
    expect(chip('tts-1')).toBeTruthy()
    expect(chip('gpt-image-1')).toBeTruthy()
    expect(chipOn('tts-1')).toBe(false)

    // 展开后可手动启用
    chip('tts-1')!.click()
    await flush()
    expect(putBodies()).toEqual([{ providerId: PROVIDER_ID, model: 'tts-1', patch: { enabled: true } }])
    expect(chipOn('tts-1')).toBe(true)

    m.unmount()
  })
})

/* ===================== ④ 建议条（刷新只读！） ===================== */

describe('模型库 — 刷新后一次性建议（刷新零写入）', () => {
  it('④ 刷新只读：零 PUT；文案写明「尚未启用」；三个动作只有被点击才写库；关闭后本会话不再出现', async () => {
    const before = [chatOn()]
    const after = [
      chatOn(),
      chatOff({ model: 'o3-mini', enabled: false }),
      nonChat('tts-1', 'audio'),
      nonChat('gpt-image-1', 'image'),
    ]
    mocks.api.mockResolvedValueOnce({ ok: true, status: 200, data: { items: before } })
    const m = mountPanel({ models: ['gpt-4o-mini'] })
    // 覆盖成"带状态的迷你服务端"：第 2 次 GET（刷新后）返回 live，且批量写入会真的改 live
    installLiveApi(after)
    await flush()

    // 刷新（父组件把 refreshSeq +1）—— 只更新"上游有哪些模型"，**一个写请求都不许发**
    await m.setRefreshSeq(1)

    expect(putBodies()).toEqual([])
    expect(mocks.api.mock.calls.filter((c) => c[0] === 'PUT')).toEqual([])

    // 建议条文案：N=3 个新模型，M=1 个适合对话（**尚未启用**），K=2 个音频/图像
    expect(text()).toContain(tf('ai_model_suggest_text', 'x', { n: 3, m: 1, k: 2 }))
    // 新模型一个都没被自动启用
    expect(chipOn('o3-mini')).toBe(false)
    expect(chipOn('tts-1')).toBe(false)

    // [全部启用] → 只有点了才写库（这批 3 个新模型全启用）
    buttonByAction('suggest-all')!.click()
    await flush()
    expect(batchPayloads()).toHaveLength(1)
    expect(
      batchPayloads()[0]
        .items.map((i) => i.model)
        .sort(),
    ).toEqual(['gpt-image-1', 'o3-mini', 'tts-1'])
    expect(batchPayloads()[0].items.every((i) => i.patch.enabled === true)).toBe(true)

    // [只启用对话模型] → 把新批次里两个非对话模型停用（对话那个已是 true ⇒ 跳过，不做无谓写入）
    mocks.api.mockClear()
    buttonByAction('suggest-chat')!.click()
    await flush()
    expect(batchPayloads()).toHaveLength(1)
    expect(
      batchPayloads()[0]
        .items.map((i) => i.model)
        .sort(),
    ).toEqual(['gpt-image-1', 'tts-1'])
    expect(batchPayloads()[0].items.every((i) => i.patch.enabled === false)).toBe(true)

    // [我自己选] → 零请求、收起、本会话不再提示
    mocks.api.mockClear()
    buttonByAction('suggest-manual')!.click()
    await flush()
    expect(writeCalls()).toEqual([])
    expect(buttonByAction('suggest-all')).toBeNull()

    mocks.api.mockClear()
    await m.setRefreshSeq(2)
    expect(buttonByAction('suggest-all')).toBeNull()
    expect(writeCalls()).toEqual([])

    m.unmount()
  })
})

/* ===================== ⑥ 能力自检三态 ===================== */

describe('模型库 — 能力自检', () => {
  it('⑤ ⚠️ 不支持该推理参数 → 一键改协议；已观测到上下文 → 一键回填', async () => {
    const m = mountPanel({
      items: [chatOn({ reasoningProtocol: 'inherit' })],
      probe: {
        ok: true,
        latencyMs: 123,
        protocolTried: 'openai_reasoning_effort',
        usedReasoningParam: true,
        supportsReasoningParam: false,
        suggestedProtocol: 'anthropic_thinking',
        observedContextWindow: 131072,
      },
    })
    await flush()

    rowAction('gpt-4o-mini', 'probe')!.click()
    await flush()

    // 自检只在用户点击时触发，且带 providerId/model
    const probeCall = mocks.api.mock.calls.find((c) => c[0] === 'POST')
    expect(probeCall?.[1]).toBe('/api/ai/model-settings/probe')
    expect(probeCall?.[2]).toEqual({ providerId: PROVIDER_ID, model: 'gpt-4o-mini' })

    // ⚠️ 警示态 + 耗时
    expect(row('gpt-4o-mini')!.querySelector('.aim-probe--warn')).toBeTruthy()
    expect(text()).toContain('123 ms')
    expect(text()).toContain(t('ai_model_probe_warn'))

    // 一键改协议
    mocks.api.mockClear()
    rowAction('gpt-4o-mini', 'apply-protocol')!.click()
    await flush()
    expect(putBodies()).toEqual([
      { providerId: PROVIDER_ID, model: 'gpt-4o-mini', patch: { reasoningProtocol: 'anthropic_thinking' } },
    ])

    // 一键回填上下文
    mocks.api.mockClear()
    rowAction('gpt-4o-mini', 'apply-context')!.click()
    await flush()
    expect(putBodies()).toEqual([{ providerId: PROVIDER_ID, model: 'gpt-4o-mini', patch: { contextWindow: 131072 } }])

    m.unmount()
  })

  it('⑥ ✅ 可用 / ❌ 不可用：失败时原样展示上游状态码与错误码，不吞', async () => {
    const m = mountPanel({
      items: [chatOn()],
      probe: { ok: true, latencyMs: 42, supportsReasoningParam: 'unknown' },
    })
    await flush()
    rowAction('gpt-4o-mini', 'probe')!.click()
    await flush()
    expect(row('gpt-4o-mini')!.querySelector('.aim-probe--ok')).toBeTruthy()
    expect(text()).toContain('42 ms')
    expect(text()).toContain(t('ai_model_probe_unknown'))

    // 换成失败响应（上游 400 + 错误码 + 文案）
    installApi([chatOn()], {
      ok: false,
      upstreamStatus: 400,
      upstreamErrorCode: 'invalid_request_error',
      upstreamMessage: 'model `gpt-4o-mini` does not exist',
    })
    rowAction('gpt-4o-mini', 'probe')!.click()
    await flush()

    const probe = row('gpt-4o-mini')!.querySelector('.aim-probe--fail')
    expect(probe).toBeTruthy()
    expect(probe!.textContent).toContain('HTTP 400')
    expect(probe!.textContent).toContain('invalid_request_error')
    expect(probe!.textContent).toContain('model `gpt-4o-mini` does not exist')

    m.unmount()
  })
})

/* ===================== ⑦ 别名 + 排序 ===================== */

describe('模型库 — 别名与拖拽排序', () => {
  it('⑦ 别名写成 {alias}，空串=清除；拖拽排序写 {sortOrder}', async () => {
    const m = mountPanel({ items: [chatOn(), chatOff(), chatOn({ model: 'gpt-4.1', contextWindow: 1000000 })] })
    await flush()

    // 别名
    rowAction('gpt-4o-mini', 'alias')!.click()
    await flush()
    const aliasInput = row('gpt-4o-mini')!.querySelector('.aim-alias-input') as HTMLInputElement
    expect(aliasInput).toBeTruthy()
    expect(aliasInput.maxLength).toBe(ALIAS_MAX_LEN)
    await setValue(aliasInput, '  小快灵  ')
    rowAction('gpt-4o-mini', 'alias-save')!.click()
    await flush()
    expect(putBodies()).toEqual([{ providerId: PROVIDER_ID, model: 'gpt-4o-mini', patch: { alias: '小快灵' } }])
    // 胶囊用别名显示
    expect(chip('gpt-4o-mini')!.textContent).toContain('小快灵')

    // 拖拽排序：把第一行拖到最后 → 三行顺序都变，按新位置写 sortOrder
    mocks.api.mockClear()
    const handle = row('gpt-4o-mini')!.querySelector('.aim-drag') as HTMLElement
    handle.dispatchEvent(new Event('dragstart'))
    row('gpt-4.1')!.dispatchEvent(new Event('drop'))
    await flush()

    expect(putBodies()).toEqual([
      { providerId: PROVIDER_ID, model: 'o3-mini', patch: { sortOrder: 0 } },
      { providerId: PROVIDER_ID, model: 'gpt-4.1', patch: { sortOrder: 1 } },
      { providerId: PROVIDER_ID, model: 'gpt-4o-mini', patch: { sortOrder: 2 } },
    ])

    m.unmount()
  })
})

/* ===================== ⑧ 逐字段来源 + 单项恢复 ===================== */

describe('模型库 — 配置弹窗逐字段来源', () => {
  it('⑧ 字段标记「来自预设 / 你刚改过」，单项恢复只提交该字段的 null', async () => {
    const m = mountPanel({ items: [chatOn({ isOverridden: true })] })
    await flush()

    rowAction('gpt-4o-mini', 'config')!.click()
    await flush()
    const form = document.querySelector('.aim-form') as HTMLElement
    expect(form).toBeTruthy()
    // 未改动的字段：来自预设
    expect(form.querySelectorAll('.aim-src--preset').length).toBeGreaterThan(0)
    expect(text()).toContain(t('ai_model_src_preset'))

    // 改了上下文窗口 → 该字段变成「你刚改过」（pending）
    const ctxInput = form.querySelectorAll('.aim-input')[0] as HTMLInputElement
    await setValue(ctxInput, '128000')
    const ctxHead = form.querySelector('[data-action="restore-contextWindow"]')!.closest('.aim-field-head')!
    expect(ctxHead.querySelector('.aim-src--pending')).toBeTruthy()

    // 单项恢复：只提交 contextWindow: null
    buttonByAction('restore-contextWindow')!.click()
    await flush()
    expect(putBodies()).toEqual([{ providerId: PROVIDER_ID, model: 'gpt-4o-mini', patch: { contextWindow: null } }])
    // 恢复后该字段回到「来自预设」，弹窗还在（其余未保存改动不丢）
    const after = document.querySelector('[data-action="restore-contextWindow"]')!.closest('.aim-field-head')!
    expect(after.querySelector('.aim-src--preset')).toBeTruthy()
    expect(document.querySelector('.aim-form')).toBeTruthy()

    m.unmount()
  })

  it('⑩ 非法输入不提交并就地提示；接口 404 时如实降级', async () => {
    const m = mountPanel({ items: [chatOn()] })
    await flush()
    rowAction('gpt-4o-mini', 'config')!.click()
    await flush()
    const ctx = document.querySelectorAll('.aim-form .aim-input')[0] as HTMLInputElement
    const expected = tf('ai_model_cfg_err_context', 'x', { min: CONTEXT_WINDOW_MIN, max: CONTEXT_WINDOW_MAX })
    for (const bad of ['0', '-5', String(CONTEXT_WINDOW_MIN - 1), String(CONTEXT_WINDOW_MAX + 1)]) {
      await setValue(ctx, bad)
      buttonByLabel(t('ai_model_cfg_save')).click()
      await flush()
      expect(putBodies()).toHaveLength(0)
      expect(text()).toContain(expected)
    }
    m.unmount()

    // 404 降级
    const m2 = mountPanel({ models: ['gpt-4o-mini'], notFound: true })
    await flush()
    expect(text()).toContain(t('ai_model_cfg_load_fail'))
    expect(document.querySelector('.aim-cfg-note--warn')).toBeTruthy()
    m2.unmount()
  })
})

/* ===================== ⑨ 搜索 / 筛选 ===================== */

describe('模型库 — 搜索与筛选', () => {
  it('⑨ 输入即过滤；只看已启用 / 只看对话模型生效', async () => {
    const m = mountPanel({
      items: [chatOn(), chatOff(), nonChat('tts-1', 'audio')],
    })
    await flush()

    // 搜索：命中 o3-mini
    await setValue(document.querySelector('.aim-search') as HTMLInputElement, 'o3')
    expect(chip('o3-mini')).toBeTruthy()
    expect(chip('gpt-4o-mini')).toBeNull()
    // 搜索时自动展开非对话组，但 tts-1 不匹配 → 不出现
    expect(chip('tts-1')).toBeNull()

    // 清空搜索 → 只看已启用
    await setValue(document.querySelector('.aim-search') as HTMLInputElement, '')
    buttonByAction('filter-enabled')!.click()
    await flush()
    expect(chip('gpt-4o-mini')).toBeTruthy()
    expect(chip('o3-mini')).toBeNull()

    // 只看对话模型：非对话分组整块消失
    buttonByAction('filter-enabled')!.click()
    buttonByAction('filter-chat')!.click()
    await flush()
    expect(buttonByAction('toggle-nonchat')).toBeNull()
    expect(chip('gpt-4o-mini')).toBeTruthy()

    m.unmount()
  })
})

/* ===================== 继承：接线与不丢多选 ===================== */

describe('AIProviderSettings — 模型库接线', () => {
  it('⑪ 点「编辑」即自动拉取；刷新后自动再拉取（并给出建议）；行内切换同步回父组件且不丢其他模型', async () => {
    mocks.getProviders.mockResolvedValue({ ok: true, status: 200, data: { items: [PROVIDER], count: 1 } })
    mocks.getPresets.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        items: [
          { provider: 'custom', label: 'Custom', family: 'custom', defaultBaseUrl: '', defaultModel: 'gpt-4o-mini' },
        ],
      },
    })
    mocks.getSettings.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        defaultProviderId: PROVIDER_ID,
        defaultModel: 'gpt-4o-mini',
        selectedModels: {},
        defaultMode: 'ask',
        thinkingEnabled: false,
        thinkingStrength: 'medium',
        memoryEnabled: false,
        customSystemPrompt: '',
        searchProvider: '',
        searchBaseUrl: '',
        searchHasKey: false,
      },
    })
    mocks.getProviderModels.mockResolvedValue({ ok: true, status: 200, data: { models: ['gpt-4o-mini', 'o3-mini'] } })
    installApi([chatOn(), chatOff()])

    const m = mountComponent(AIProviderSettings as Component)
    await flush()

    clickByTitle(t('ai_edit'))
    await flush()

    // 自动拉取
    expect(modelSettingCalls().filter((c) => c[0] === 'GET')).toHaveLength(1)
    expect(text()).toContain('200000')

    // 刷新模型列表 → 面板再次自动拉取
    const refreshBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === t('ai_refresh_models'),
    ) as HTMLButtonElement
    refreshBtn.click()
    await flush()
    expect(modelSettingCalls().filter((c) => c[0] === 'GET')).toHaveLength(2)

    // 父组件的已启用计数来自面板 emit
    expect(text()).toContain(tf('ai_models_selected_count', 'x', { n: 1 }) as string)

    // 行内停用其中一个 → 另一个（o3-mini 仍启用？它是 disabled）… 用胶囊启用 o3-mini 后停用 gpt-4o-mini
    chip('o3-mini')!.click()
    await flush()
    chip('gpt-4o-mini')!.click()
    await flush()
    expect(text()).toContain(tf('ai_models_selected_count', 'x', { n: 1 }) as string)
    expect(chipOn('o3-mini')).toBe(true)
    expect(chipOn('gpt-4o-mini')).toBe(false)

    m.unmount()
  })
})

/* ===================== 补充：软删语义 / 自检触发纪律 / 逐字段恢复边界 ===================== */

describe('模型库 — 停用即逻辑删（软删）语义', () => {
  it('⑫ 停用后配置/别名留在库里、再点恢复；文案不暗示"删除"', async () => {
    const m = mountPanel({ items: [chatOn({ isOverridden: true, alias: '小快灵', contextWindow: 128000 })] })
    await flush()

    chip('gpt-4o-mini')!.click() // 停用
    await flush()
    expect(putBodies()).toEqual([{ providerId: PROVIDER_ID, model: 'gpt-4o-mini', patch: { enabled: false } }])
    // 配置与自定义值仍在：别名、自定义上下文、来源标记一个都没少
    expect(chip('gpt-4o-mini')!.textContent).toContain('小快灵')
    expect(row('gpt-4o-mini')!.textContent).toContain('128000')
    expect(row('gpt-4o-mini')!.textContent).toContain(t('ai_model_cfg_badge_overridden'))

    // 再点一下 = 恢复启用（不是"重新添加"）
    chip('gpt-4o-mini')!.click()
    await flush()
    expect(putBodies()[1]).toEqual({
      providerId: PROVIDER_ID,
      model: 'gpt-4o-mini',
      patch: { enabled: true },
    })
    expect(chipOn('gpt-4o-mini')).toBe(true)

    // 停用按钮的 tooltip 明确"不会删除配置"，UI 不存在任何删除暗示
    expect(rowAction('gpt-4o-mini', 'toggle')!.getAttribute('title')).toBe(t('ai_model_disable'))
    expect(chip('gpt-4o-mini')!.getAttribute('title')).toContain(t('ai_model_chip_on_h').replace('{name}', '小快灵'))

    m.unmount()
  })

  it('⑬ 行内「清除自定义值」：没有自定义时禁用；点击只清能力参数（不含启用/别名/排序）', async () => {
    const m = mountPanel({ items: [chatOn({ isOverridden: false }), chatOff({ isOverridden: true })] })
    await flush()

    expect(rowAction('gpt-4o-mini', 'clear')!.disabled).toBe(true)
    const clearBtn = rowAction('o3-mini', 'clear')!
    expect(clearBtn.disabled).toBe(false)
    expect(clearBtn.getAttribute('title')).toBe(t('ai_model_clear_h'))

    clearBtn.click()
    await flush()
    expect(putBodies()).toEqual([{ providerId: PROVIDER_ID, model: 'o3-mini', patch: RESTORE_PRESET_PATCH }])
    expect('enabled' in putBodies()[0].patch).toBe(false)
    expect('alias' in putBodies()[0].patch).toBe(false)

    m.unmount()
  })
})

describe('模型库 — 自检触发纪律', () => {
  it('⑭ 绝不自动触发；调用中按钮 loading，tooltip 说明会产生一次极小上游请求', async () => {
    const m = mountPanel({ items: [chatOn()] })
    await flush()

    // 加载完成、什么都没点：一个 POST 都没有
    expect(mocks.api.mock.calls.some((c) => c[0] === 'POST')).toBe(false)
    const probeBtn = rowAction('gpt-4o-mini', 'probe')!
    expect(probeBtn.getAttribute('title')).toBe(t('ai_model_probe_h'))

    // 让自检请求悬挂：按钮进入 loading（disabled）
    const base = mocks.api.getMockImplementation()!
    let release: (v: unknown) => void = () => {}
    mocks.api.mockImplementation(async (method: string, path: string, body: unknown) => {
      if (method === 'POST') return new Promise((resolve) => (release = resolve))
      return base(method, path, body)
    })

    probeBtn.click()
    await flush()
    expect(rowAction('gpt-4o-mini', 'probe')!.disabled).toBe(true)

    release({ ok: true, status: 200, data: { ok: true, latencyMs: 11, supportsReasoningParam: true } })
    await flush()
    expect(rowAction('gpt-4o-mini', 'probe')!.disabled).toBe(false)
    expect(row('gpt-4o-mini')!.querySelector('.aim-probe--ok')).toBeTruthy()

    m.unmount()
  })

  it('⑮ 自检接口不可用（404）时如实展示接口错误，不伪造"可用"', async () => {
    const m = mountPanel({ items: [chatOn()] })
    await flush()

    const base = mocks.api.getMockImplementation()!
    mocks.api.mockImplementation(async (method: string, path: string, body: unknown) =>
      method === 'POST' ? { ok: false, status: 404, error: 'Not Found' } : base(method, path, body),
    )

    rowAction('gpt-4o-mini', 'probe')!.click()
    await flush()

    const probe = row('gpt-4o-mini')!.querySelector('.aim-probe--fail')
    expect(probe).toBeTruthy()
    expect(probe!.textContent).toContain('Not Found')

    m.unmount()
  })
})

describe('模型库 — 恢复与降级边界', () => {
  it('⑯ 整模型「恢复预设」只清能力参数覆盖（不含 enabled/alias/sortOrder）', async () => {
    const m = mountPanel({ items: [chatOn({ isOverridden: true, alias: '小快灵', sortOrder: 3 })] })
    await flush()

    rowAction('gpt-4o-mini', 'config')!.click()
    await flush()
    document.querySelector<HTMLButtonElement>('.aim-cfg-restore')!.click()
    await flush()

    const body = putBodies()[0]
    expect(body.patch).toEqual(RESTORE_PRESET_PATCH)
    expect('enabled' in body.patch).toBe(false)
    expect('alias' in body.patch).toBe(false)
    expect('sortOrder' in body.patch).toBe(false)
    // 恢复预设成功后弹窗收起（按服务端返回的最新值展示）
    expect(document.querySelector('.modal-backdrop')).toBeNull()

    m.unmount()
  })

  it('⑰ 别名超长不提交并就地提示（服务端上限 80）', async () => {
    const m = mountPanel({ items: [chatOn()] })
    await flush()

    rowAction('gpt-4o-mini', 'alias')!.click()
    await flush()
    const input = row('gpt-4o-mini')!.querySelector('.aim-alias-input') as HTMLInputElement
    // maxlength 只挡 UI 输入，逻辑层仍要拦（直接改 value 模拟粘超长文本）
    input.value = 'x'.repeat(ALIAS_MAX_LEN + 1)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()

    rowAction('gpt-4o-mini', 'alias-save')!.click()
    await flush()

    expect(putBodies()).toEqual([])
    expect(mocks.showToast).toHaveBeenCalledWith(tf('ai_model_alias_too_long', 'x', { max: ALIAS_MAX_LEN }), 'error')

    m.unmount()
  })

  it('⑱ 服务端未下发 enabled（旧契约）⇒ 一律按**未启用**渲染（不再本地推断），如实提示', async () => {
    // 契约 v2 形态：没有 enabled / alias / sortOrder / applicability
    const legacy: Raw = {
      model: 'gpt-4o-mini',
      contextWindow: 200000,
      maxOutput: 16384,
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      reasoningEnabled: true,
      reasoningProtocol: 'inherit',
      isPreset: true,
      isOverridden: false,
    }
    // 父组件"已选"里带着它，但服务端没给 enabled ⇒ 仍必须渲染成未启用（不猜"已启用"）
    const m = mountPanel({ items: [legacy], models: ['gpt-4o-mini'] })
    await flush()

    expect(text()).toContain(t('ai_model_v3_missing'))
    expect(chipOn('gpt-4o-mini')).toBe(false)
    // 面板自己的计数也如实写"已启用 0"（不再本地推断）
    expect(text()).toContain(tf('ai_model_lib_title', 'x', { n: 1, on: 0 }))

    m.unmount()
  })

  it('⑲ 搜索同时匹配显示别名', async () => {
    const m = mountPanel({ items: [chatOn({ alias: '小快灵' }), chatOff()] })
    await flush()

    await setValue(document.querySelector('.aim-search') as HTMLInputElement, '小快')
    expect(chip('gpt-4o-mini')).toBeTruthy()
    expect(chip('o3-mini')).toBeNull()
    // 行内也按别名过滤
    expect(text()).toContain('小快灵')

    m.unmount()
  })
})

/* ===================== ⑳-㉔ 刷新模型列表：三态提示（本轮缺陷修复） =====================
 * 用户实测：Base URL = http://127.0.0.1:3800/v1（服务端在 Docker 里 ⇒ 容器视角不可达），
 * 点「刷新模型列表」→ 界面弹「模型列表已刷新」却一个模型都没有。旧实现把上游失败吞成"200 + 空
 * 数组"，前端只能弹成功。现在服务端如实返回三态，前端也必须三态提示（0 个绝不报"已刷新"），
 * 并把结果**就近持久**显示（toast 一闪而过不足以发现问题）。 */

describe('AIProviderSettings — 刷新模型列表三态（不再假成功）', () => {
  const statusEl = () => document.querySelector<HTMLElement>('.ai-refresh-status')
  const statusText = () => statusEl()?.textContent || ''

  /** 挂载设置组件并点「编辑」进入编辑态（无新输入 key ⇒ 走 GET /providers/:id/models） */
  async function mountEditing() {
    mocks.getProviders.mockResolvedValue({ ok: true, status: 200, data: { items: [PROVIDER], count: 1 } })
    mocks.getPresets.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        items: [
          { provider: 'custom', label: 'Custom', family: 'custom', defaultBaseUrl: '', defaultModel: 'gpt-4o-mini' },
        ],
      },
    })
    mocks.getSettings.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        defaultProviderId: PROVIDER_ID,
        defaultModel: 'gpt-4o-mini',
        selectedModels: {},
        defaultMode: 'ask',
        thinkingEnabled: false,
        thinkingStrength: 'medium',
        memoryEnabled: false,
        customSystemPrompt: '',
        searchProvider: '',
        searchBaseUrl: '',
        searchHasKey: false,
      },
    })
    installApi([chatOn(), chatOff()])
    const m = mountComponent(AIProviderSettings as Component)
    await flush()
    clickByTitle(t('ai_edit'))
    await flush()
    const refreshBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === t('ai_refresh_models'),
    ) as HTMLButtonElement
    return { m, refreshBtn }
  }

  it('⑳ 成功且 N>0 → toast 报「新增 N 个」，就近状态显示总数', async () => {
    mocks.getProviderModels.mockResolvedValue({
      ok: true,
      status: 200,
      data: { models: ['a', 'b', 'c'], count: 3, added: 2, previousCount: 1, upstreamEmpty: false },
    })
    const { m, refreshBtn } = await mountEditing()
    refreshBtn.click()
    await flush()

    expect(mocks.showToast).toHaveBeenCalledWith(
      tf('ai_models_refreshed_n', '已刷新，新增 {added} 个模型（共 {n} 个）', { added: 2, n: 3 }),
      'success',
    )
    expect(statusEl(), '刷新结果要就近持久显示，不能只有 toast').toBeTruthy()
    expect(statusEl()!.className).toContain('ai-refresh-status--success')
    expect(statusText()).toContain('3')
    m.unmount()
  })

  it('㉑ 上游合法返回 0 个 → warning +「上游返回 0 个模型」，**绝不出现「已刷新」**', async () => {
    mocks.getProviderModels.mockResolvedValue({
      ok: true,
      status: 200,
      data: { models: [], count: 0, upstreamEmpty: true },
    })
    const { m, refreshBtn } = await mountEditing()
    refreshBtn.click()
    await flush()

    // 唯一一条 toast 必须是 warning 的"上游返回 0 个"，不能是成功
    expect(mocks.showToast).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith(
      tf('ai_models_refresh_empty', '上游返回 0 个模型，请检查该网关是否提供 /v1/models'),
      'warning',
    )
    // ✗ 旧缺陷：0 个时弹「模型列表已刷新」——它在 toast 与页面文本里都必须消失
    expect(mocks.showToast).not.toHaveBeenCalledWith(t('ai_models_refreshed'), 'success')
    expect(text()).not.toContain(t('ai_models_refreshed'))

    expect(statusEl()!.className).toContain('ai-refresh-status--empty')
    expect(statusText()).toContain('0')
    expect(statusText()).toContain('/v1/models')
    m.unmount()
  })

  it('㉒ 失败（容器+回环）→ error + 服务端建议**原样**展示 + 重试按钮', async () => {
    const serverMessage =
      '服务端运行在 Docker 容器中，127.0.0.1 指向容器自身（不是你的电脑），无法访问你机器上的网关；' +
      '请把 Base URL 改成 http://host.docker.internal:3800/v1（本机 Docker Desktop 可直接解析），' +
      '或改用宿主机的内网 IP，例如 http://192.168.1.10:3800/v1。'
    mocks.getProviderModels.mockResolvedValue({
      ok: false,
      status: 502,
      error: serverMessage,
      data: {
        error: serverMessage,
        code: 'ai_base_url_loopback_in_container',
        message: serverMessage,
        details: { host: '127.0.0.1', inContainer: true },
        provider: { id: PROVIDER_ID, name: 'My Provider', isDefault: true },
        models: ['gpt-4o-mini'],
        modelsUnchanged: true,
      },
    })
    const { m, refreshBtn } = await mountEditing()
    refreshBtn.click()
    await flush()

    // toast 与就近状态都展示服务端那句可直接照做的建议（原样，不换成通用模板）
    expect(mocks.showToast).toHaveBeenCalledWith(serverMessage, 'error')
    expect(mocks.showToast).not.toHaveBeenCalledWith(t('ai_models_refreshed'), 'success')
    expect(text()).not.toContain(t('ai_models_refreshed'))

    expect(statusEl()!.className).toContain('ai-refresh-status--error')
    expect(statusText()).toContain(serverMessage)
    expect(statusText(), '失败时说明"已保留原列表 N 个"（服务端不会覆盖）').toContain('1')
    // 可就地重试
    expect(document.querySelector('.ai-refresh-status-retry')).toBeTruthy()
    m.unmount()
  })

  it('㉓ 失败（上游结构非法）→ 映射成人话并按供应商名点名，不是原始 code', async () => {
    mocks.getProviderModels.mockResolvedValue({
      ok: false,
      status: 502,
      error: 'Upstream /models response has no "data" array',
      data: {
        code: 'ai_upstream_invalid_response',
        error: 'Upstream /models response has no "data" array',
        details: { upstreamStatus: 200, upstreamMessage: '{"object":"list"}' },
        provider: { id: PROVIDER_ID, name: 'My Provider', isDefault: true },
      },
    })
    const { m, refreshBtn } = await mountEditing()
    refreshBtn.click()
    await flush()

    const expected = tf(
      'ai_fail_upstream_invalid_response',
      '上游没有返回模型列表结构（{name}）：请确认 Base URL 指向 OpenAI 兼容网关，且该地址提供 /v1/models。',
      { name: 'My Provider' },
    )
    expect(mocks.showToast).toHaveBeenCalledWith(expected, 'error')
    expect(statusText()).toContain(expected)
    m.unmount()
  })

  it('㉔ 失败后点「重试」→ 复用同一次刷新流程（成功则转为成功态）', async () => {
    mocks.getProviderModels.mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: 'boom',
      data: { code: 'ai_upstream_unavailable', error: 'boom', models: [], modelsUnchanged: true },
    })
    const { m, refreshBtn } = await mountEditing()
    refreshBtn.click()
    await flush()
    expect(statusEl()!.className).toContain('ai-refresh-status--error')

    // 第二次（重试）成功
    mocks.getProviderModels.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { models: ['x', 'y'], count: 2, added: 2, previousCount: 0, upstreamEmpty: false },
    })
    mocks.showToast.mockClear()
    document.querySelector<HTMLButtonElement>('.ai-refresh-status-retry')!.click()
    await flush()

    expect(statusEl()!.className).toContain('ai-refresh-status--success')
    expect(mocks.showToast).toHaveBeenCalledWith(
      tf('ai_models_refreshed_n', '已刷新，新增 {added} 个模型（共 {n} 个）', { added: 2, n: 2 }),
      'success',
    )
    m.unmount()
  })
})

/* ===================== ㉕-㉚ 供应商为空：不再把用户带沟里 =====================
 * 用户实测：在「新增供应商」草稿态点「刷新模型列表」→ 弹裸英文 `Invalid provider`，且换成
 * 127.0.0.1:3800 / host.docker.internal:3800 表现一模一样（看着像网络问题）。
 * 根因：草稿态「供应商」下拉为空 ⇒ payload.provider='' ⇒ 服务端预设白名单 400，**根本没发上游请求**。
 * 两个防线：① 填了 Base URL/API Key 就自动纠偏成 Custom（主路径）；② provider 为空时按钮禁用 + 就近提示。 */

describe('AIProviderSettings — 供应商为空（草稿态）不再被带沟里', () => {
  const statusEl = () => document.querySelector<HTMLElement>('.ai-refresh-status')
  const statusText = () => statusEl()?.textContent || ''
  const inputByPh = (ph: string) => document.querySelector<HTMLInputElement>(`input[placeholder="${ph}"]`)
  const triggerText = () => document.querySelector('.custom-select-trigger-text')?.textContent || ''
  const refreshBtn = () =>
    Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === t('ai_refresh_models'),
    ) as HTMLButtonElement

  const SETTINGS = {
    defaultProviderId: PROVIDER_ID,
    defaultModel: 'gpt-4o-mini',
    selectedModels: {},
    defaultMode: 'ask',
    thinkingEnabled: false,
    thinkingStrength: 'medium',
    memoryEnabled: false,
    customSystemPrompt: '',
    searchProvider: '',
    searchBaseUrl: '',
    searchHasKey: false,
  }
  const PRESETS = [
    { provider: 'custom', label: 'Custom', family: 'custom', defaultBaseUrl: '', defaultModel: 'gpt-4o-mini' },
    {
      provider: 'longcat',
      label: 'LongCat',
      family: 'openai',
      defaultBaseUrl: 'https://api.longcat.chat/openai',
      defaultModel: 'LongCat-Flash-Chat',
    },
  ]

  function wire(providers: unknown[]) {
    mocks.getProviders.mockResolvedValue({ ok: true, status: 200, data: { items: providers, count: providers.length } })
    mocks.getPresets.mockResolvedValue({ ok: true, status: 200, data: { items: PRESETS } })
    mocks.getSettings.mockResolvedValue({ ok: true, status: 200, data: SETTINGS })
    installApi([chatOn(), chatOff()])
  }

  /** 草稿态（新增供应商）：列表为空，点「添加供应商」展开表单 */
  async function mountDraft() {
    mocks.fetchProviderModels.mockReset()
    wire([])
    const m = mountComponent(AIProviderSettings as Component)
    await flush()
    buttonByLabel(t('ai_add_provider')).click()
    await flush()
    return m
  }

  /** 编辑态：把已有供应商（可覆盖字段）拉进表单 */
  async function mountEditWith(overrides: Record<string, unknown> = {}) {
    mocks.fetchProviderModels.mockReset()
    wire([{ ...PROVIDER, ...overrides }])
    const m = mountComponent(AIProviderSettings as Component)
    await flush()
    clickByTitle(t('ai_edit'))
    await flush()
    return m
  }

  it('㉕ 草稿态填了 Base URL → 自动纠偏成 Custom（下拉如实显示），刷新 payload provider=custom', async () => {
    mocks.fetchProviderModels.mockResolvedValue({
      ok: true,
      status: 200,
      data: { models: ['local-1'], count: 1, upstreamEmpty: false, added: 1, previousCount: 0 },
    })
    const m = await mountDraft()

    // 起点：下拉是空占位
    expect(triggerText()).toContain(t('ai_select_provider'))

    // 用户只填了 Base URL（还没选供应商）—— 这正是被带沟里的那一步
    await setValue(inputByPh(t('ai_base_url_ph'))!, 'http://127.0.0.1:3800/v1')
    await flush()
    // 防线 ①：自动纠偏，并在下拉里如实显示 Custom
    expect(triggerText()).toContain('Custom')

    // 有 key 才能刷（草稿态）
    await setValue(inputByPh(t('ai_api_key_ph'))!, 'sk-local')
    await flush()
    const btn = refreshBtn()
    expect(btn.disabled).toBe(false)
    btn.click()
    await flush()

    expect(mocks.fetchProviderModels).toHaveBeenCalledTimes(1)
    const payload = mocks.fetchProviderModels.mock.calls[0][0] as { provider: string; baseUrl: string; apiKey: string }
    expect(payload.provider).toBe('custom') // ★ 以前这里是空串 ⇒ 服务端 400 Invalid provider
    expect(payload.baseUrl).toBe('http://127.0.0.1:3800/v1')
    expect(payload.apiKey).toBe('sk-local')
    m.unmount()
  })

  it('㉖ 用户显式选过的预设不被纠偏覆盖（编辑 LongCat 后改地址 → 仍是 longcat）', async () => {
    mocks.fetchProviderModels.mockResolvedValue({
      ok: true,
      status: 200,
      data: { models: ['x'], count: 1, upstreamEmpty: false },
    })
    const m = await mountEditWith({
      provider: 'longcat',
      name: 'LongCat 供应商',
      base_url: 'https://api.longcat.chat/openai',
    })

    expect(triggerText()).toContain('LongCat')
    // 改地址 + 重输 key（都会触发 watcher 的依赖变化）—— 不得被覆盖成 custom
    await setValue(inputByPh(t('ai_base_url_ph'))!, 'http://192.168.1.10:8000/v1')
    await setValue(inputByPh(t('ai_api_key_keep'))!, 'sk-longcat')
    await flush()
    expect(triggerText()).toContain('LongCat')

    refreshBtn().click()
    await flush()
    const payload = mocks.fetchProviderModels.mock.calls[0][0] as { provider: string }
    expect(payload.provider).toBe('longcat')
    m.unmount()
  })

  it('㉗ 草稿态什么都没填 → 刷新按钮禁用 + 就近提示「请先选择供应商…（Custom）」，点了也不发请求', async () => {
    const m = await mountDraft()
    const btn = refreshBtn()
    // 防线 ②：从源头不让点
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('title')).toBe(t('ai_refresh_need_provider'))
    expect(document.querySelector('.ai-refresh-need-provider')?.textContent).toContain('Custom')

    btn.click()
    await flush()
    expect(mocks.fetchProviderModels).not.toHaveBeenCalled()
    expect(mocks.getProviderModels).not.toHaveBeenCalled()
    m.unmount()
  })

  it('㉘ 服务端 INVALID_PROVIDER → 中文人话（服务端 message 优先），界面不再出现裸英文', async () => {
    const serverMessage = '请先选择供应商；自定义/本地网关请选 Custom'
    mocks.getProviderModels.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'Invalid provider',
      data: { error: 'Invalid provider', code: 'INVALID_PROVIDER', message: serverMessage, models: [] },
    })
    const m = await mountEditWith()
    refreshBtn().click()
    await flush()

    expect(mocks.showToast).toHaveBeenCalledWith(serverMessage, 'error')
    expect(text()).not.toContain('Invalid provider')
    expect(statusText()).toContain(serverMessage)
    m.unmount()
  })

  it('㉘b 服务端没带 message 时用映射表兜底（中文），仍不是裸码', async () => {
    mocks.getProviderModels.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'Invalid provider',
      data: { code: 'INVALID_PROVIDER', error: 'Invalid provider' },
    })
    const m = await mountEditWith()
    refreshBtn().click()
    await flush()

    expect(mocks.showToast).toHaveBeenCalledWith(
      tf('ai_fail_invalid_provider', '请先选择供应商；自定义/本地网关请选 Custom。'),
      'error',
    )
    expect(text()).not.toContain('Invalid provider')
    m.unmount()
  })

  it('㉙ INVALID_PROVIDER 失败态：模型列表一个都没少（含"已保留原列表 N 个"）+ 可就地重试', async () => {
    mocks.getProviderModels.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'Invalid provider',
      data: {
        code: 'INVALID_PROVIDER',
        message: '请先选择供应商；自定义/本地网关请选 Custom',
        models: ['gpt-4o-mini'],
        modelsUnchanged: true,
      },
    })
    const m = await mountEditWith()
    const chipsBefore = document.querySelectorAll('.aim-chip').length
    expect(chipsBefore).toBe(2)

    refreshBtn().click()
    await flush()

    // 失败不清列表：模型库胶囊数量与"已启用"计数都没变
    expect(document.querySelectorAll('.aim-chip')).toHaveLength(chipsBefore)
    expect(text()).toContain(tf('ai_models_selected_count', 'x', { n: 1 }))
    expect(statusEl()!.className).toContain('ai-refresh-status--error')
    expect(statusText()).toContain('1') // 已保留原列表 1 个模型
    expect(document.querySelector('.ai-refresh-status-retry')).toBeTruthy()
    m.unmount()
  })

  it('㉚ 同类入口（自检 probe）也不显示裸码：服务端 message 优先', async () => {
    const m = mountPanel({ items: [chatOn()] })
    await flush()
    const base = mocks.api.getMockImplementation()!
    mocks.api.mockImplementation(async (method: string, path: string, body: unknown) =>
      method === 'POST'
        ? {
            ok: false,
            status: 404,
            error: 'PROVIDER_NOT_FOUND',
            data: { error: 'PROVIDER_NOT_FOUND', message: '供应商不存在' },
          }
        : base(method, path, body),
    )

    rowAction('gpt-4o-mini', 'probe')!.click()
    await flush()

    const probe = row('gpt-4o-mini')!.querySelector('.aim-probe--fail')
    expect(probe).toBeTruthy()
    expect(probe!.textContent).toContain('供应商不存在')
    expect(probe!.textContent).not.toContain('PROVIDER_NOT_FOUND')
    m.unmount()
  })
})

/* ===================== 草稿态刷新后必须看得见模型（本轮缺陷） ===================== */

describe('AIProviderSettings — 草稿态刷新成功后模型可见（本轮缺陷：假成功但页面空白）', () => {
  const statusEl = () => document.querySelector<HTMLElement>('.ai-refresh-status')
  const statusText = () => statusEl()?.textContent || ''
  const inputByPh = (ph: string) => document.querySelector<HTMLInputElement>(`input[placeholder="${ph}"]`)
  const refreshBtn = () =>
    Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === t('ai_refresh_models'),
    ) as HTMLButtonElement
  const draftChips = () => document.querySelectorAll<HTMLButtonElement>('.ai-draft-chip')

  const SETTINGS = {
    defaultProviderId: PROVIDER_ID,
    defaultModel: 'gpt-4o-mini',
    selectedModels: {},
    defaultMode: 'ask',
    thinkingEnabled: false,
    thinkingStrength: 'medium',
    memoryEnabled: false,
    customSystemPrompt: '',
    searchProvider: '',
    searchBaseUrl: '',
    searchHasKey: false,
  }
  const PRESETS = [
    { provider: 'custom', label: 'Custom', family: 'custom', defaultBaseUrl: '', defaultModel: 'gpt-4o-mini' },
  ]

  function wire(providers: unknown[]) {
    mocks.getProviders.mockResolvedValue({ ok: true, status: 200, data: { items: providers, count: providers.length } })
    mocks.getPresets.mockResolvedValue({ ok: true, status: 200, data: { items: PRESETS } })
    mocks.getSettings.mockResolvedValue({ ok: true, status: 200, data: SETTINGS })
    installApi([chatOn(), chatOff()])
  }

  /** 草稿态（新增供应商）：填好 base/key 并刷新一次，返回刷新用的模型列表 */
  async function mountDraftAndRefresh(models: unknown[], extraData: Record<string, unknown> = {}) {
    mocks.fetchProviderModels.mockResolvedValue({
      ok: true,
      status: 200,
      data: { models, count: Array.isArray(models) ? models.length : 0, upstreamEmpty: false, ...extraData },
    })
    wire([])
    const m = mountComponent(AIProviderSettings as Component)
    await flush()
    buttonByLabel(t('ai_add_provider')).click()
    await flush()
    await setValue(inputByPh(t('ai_base_url_ph'))!, 'http://host.docker.internal:3800/v1')
    await setValue(inputByPh(t('ai_api_key_ph'))!, 'sk-local')
    await flush()
    refreshBtn().click()
    await flush()
    return m
  }

  it('㉛ 草稿态刷新 159 个 → 候选芯片立刻渲染，计数=刷新返回数量，默认不选中、点一下即选中', async () => {
    const models = Array.from({ length: 159 }, (_, i) => `m-${i + 1}`)
    const m = await mountDraftAndRefresh(models, { added: 159, previousCount: 0 })

    // ★ 本轮缺陷：以前这里一个芯片都没有（159 个模型只落在内存里、页面空白）
    expect(draftChips()).toHaveLength(159)
    expect(draftChips()[0].textContent).toContain('m-1')
    // 计数必须等于刷新真正返回的数量（不再出现"159 个"但页面空）
    expect(text()).toContain(tf('ai_models_upstream_count', 'x', { n: 159 }))
    // 草稿态语义 = 候选：默认一个都不选中
    expect(document.querySelectorAll('.ai-draft-chip.on')).toHaveLength(0)

    // 点一下即选中，再点一下取消
    draftChips()[0].click()
    await flush()
    expect(document.querySelectorAll('.ai-draft-chip.on')).toHaveLength(1)
    expect(text()).toContain(tf('ai_models_selected_count', 'x', { n: 1 }))
    draftChips()[0].click()
    await flush()
    expect(document.querySelectorAll('.ai-draft-chip.on')).toHaveLength(0)
    expect(text()).toContain(tf('ai_models_selected_count', 'x', { n: 0 }))

    m.unmount()
  })

  it('㉜ 草稿态**不调用** model-settings 接口；配置面板降级为"保存后可配置"说明 + 就近保存按钮', async () => {
    const m = await mountDraftAndRefresh(['local-1', 'local-2'])

    // 没有 providerId ⇒ 一次都不许打 model-settings（否则 404/空）
    expect(modelSettingCalls()).toHaveLength(0)

    // 降级说明 + 就近的「保存」主按钮
    const note = document.querySelector<HTMLElement>('.ai-draft-cfg')
    expect(note).toBeTruthy()
    expect(note!.textContent).toContain(t('ai_model_cfg_need_save'))
    const cta = document.querySelector<HTMLButtonElement>('[data-action="draft-save"]')
    expect(cta).toBeTruthy()
    expect((cta!.textContent || '').trim()).toBe(t('ai_save'))
    expect(cta!.disabled).toBe(false)

    // 候选芯片仍然可见（草稿态不等于"什么都不给看"）
    expect(draftChips()).toHaveLength(2)

    m.unmount()
  })

  it('㉝ 草稿态保存成功 → 选中集合写进 models、表单切成编辑态、自动拉取并渲染模型库（无缝接管）', async () => {
    const NEW_ID = 'feedface-0000-1111-2222-333344445555'
    const models = ['local-1', 'local-2', 'local-3']
    mocks.createProvider.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...PROVIDER, id: NEW_ID, models: ['local-2'] },
    })
    const m = await mountDraftAndRefresh(models)

    // 填名字 + 勾一个候选
    await setValue(inputByPh(t('ai_name_ph'))!, 'Local GW')
    await flush()
    draftChips()[1].click()
    await flush()
    expect(draftChips()[1].classList.contains('on')).toBe(true)

    buttonByLabel(t('ai_save')).click()
    await flush(8)

    // ① 草稿态的选中集合写进 models 落库
    expect(mocks.createProvider).toHaveBeenCalledTimes(1)
    const payload = mocks.createProvider.mock.calls[0][0] as { models: string[]; name: string }
    expect(payload.name).toBe('Local GW')
    expect(payload.models).toEqual(['local-2'])

    // ② 保存成功后自动重新拉取 model-settings，模型库无缝接管（草稿候选区退场）
    expect(modelSettingCalls().filter((c) => c[0] === 'GET')).toHaveLength(1)
    expect(document.querySelectorAll('.aim-chip').length).toBeGreaterThan(0)
    expect(draftChips()).toHaveLength(0)
    expect(document.querySelector('.aim-row[data-model="gpt-4o-mini"]')).toBeTruthy()
    // 表单仍在（切到编辑态），模型库就在原位
    expect(document.querySelector('.ai-form')).toBeTruthy()

    m.unmount()
  })

  it('㉞ 刷新返回不可识别形状（200 但 models 不是数组）→ 可见说明 + 重试，绝不空白、也不假成功', async () => {
    mocks.fetchProviderModels.mockResolvedValue({
      ok: true,
      status: 200,
      // 服务端报了 159 个，但响应里没有可识别的 models 列表
      data: { count: 159 },
    })
    wire([])
    const m = mountComponent(AIProviderSettings as Component)
    await flush()
    buttonByLabel(t('ai_add_provider')).click()
    await flush()
    await setValue(inputByPh(t('ai_base_url_ph'))!, 'http://host.docker.internal:3800/v1')
    await setValue(inputByPh(t('ai_api_key_ph'))!, 'sk-local')
    await flush()
    refreshBtn().click()
    await flush()

    // 必须给出可见说明（含服务端报的数量）+ 重试；页面不得留白
    expect(statusEl()).toBeTruthy()
    expect(statusText()).toContain(
      tf('ai_models_status_unreadable', 'x', { n: 159, reason: t('ai_models_unreadable_reason') }),
    )
    expect(statusEl()!.className).toContain('ai-refresh-status--error')
    expect(document.querySelector('.ai-refresh-status-retry')).toBeTruthy()
    // 不假成功：不能弹「已刷新」success
    expect(mocks.showToast).not.toHaveBeenCalledWith(expect.stringContaining('已刷新'), 'success')
    expect(draftChips()).toHaveLength(0)

    m.unmount()
  })

  it('㉟ 已保存供应商刷新不回归：不出现草稿候选区，仍走模型库，计数含上游数量', async () => {
    mocks.getProviderModels.mockResolvedValue({
      ok: true,
      status: 200,
      data: { models: ['gpt-4o-mini', 'o3-mini'], count: 2, upstreamEmpty: false, added: 1, previousCount: 1 },
    })
    wire([PROVIDER])
    const m = mountComponent(AIProviderSettings as Component)
    await flush()
    clickByTitle(t('ai_edit'))
    await flush()
    expect(document.querySelectorAll('.aim-chip')).toHaveLength(2)

    refreshBtn().click()
    await flush()

    expect(mocks.getProviderModels).toHaveBeenCalledTimes(1)
    expect(draftChips()).toHaveLength(0) // 草稿候选区只在未保存时出现
    expect(document.querySelectorAll('.aim-chip')).toHaveLength(2)
    // 编辑态 1 次 + 刷新后自动再拉 1 次
    expect(modelSettingCalls().filter((c) => c[0] === 'GET')).toHaveLength(2)
    expect(text()).toContain(tf('ai_models_upstream_count', 'x', { n: 2 }))
    expect(document.querySelector('.ai-draft-cfg')).toBeNull()

    m.unmount()
  })
})

/* ===================== 草稿态勾选即出配置卡片（本轮需求） ===================== */

describe('AIProviderSettings — 草稿态勾选即出配置卡片 + 保存时批量落库', () => {
  const inputByPh = (ph: string) => document.querySelector<HTMLInputElement>(`input[placeholder="${ph}"]`)
  const refreshBtn = () =>
    Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === t('ai_refresh_models'),
    ) as HTMLButtonElement
  const draftChip = (m: string) => document.querySelector<HTMLButtonElement>(`.ai-draft-chip[data-model="${m}"]`)
  const card = (m: string) => document.querySelector<HTMLElement>(`.aim-draft-card[data-model="${m}"]`)
  const cardInputs = (m: string) => card(m)!.querySelectorAll<HTMLInputElement>('.aim-input')
  const cardSwitches = (m: string) => card(m)!.querySelectorAll<HTMLElement>('[role="switch"]')
  const cardAction = (m: string, action: string) =>
    document.querySelector<HTMLButtonElement>(`.aim-draft-card[data-model="${m}"] [data-action="${action}"]`)
  /** 折叠概要行 → 点「配置」展开完整表单 */
  async function expandCard(m: string) {
    cardAction(m, 'draft-config')!.click()
    await flush()
  }
  const draftForms = () => document.querySelectorAll('.aim-draft-form')

  const resolveCalls = () =>
    mocks.api.mock.calls
      .filter((c) => String(c[1]) === '/api/ai/model-settings/resolve')
      .map((c) => c[2] as { models: string[] })
  const batchCalls = () =>
    mocks.api.mock.calls
      .filter((c) => String(c[1]) === '/api/ai/model-settings/batch')
      .map((c) => c[2] as { providerId: string; items: Array<{ model: string; patch: Record<string, unknown> }> })
  /** 草稿态**禁止**触碰的端点：GET/PUT /api/ai/model-settings（不含 /resolve、/batch） */
  const plainModelSettingsCalls = () =>
    mocks.api.mock.calls.filter((c) => {
      const p = String(c[1] || '')
      return p === '/api/ai/model-settings' || p.startsWith('/api/ai/model-settings?')
    })

  const SETTINGS = {
    defaultProviderId: PROVIDER_ID,
    defaultModel: 'gpt-4o-mini',
    selectedModels: {},
    defaultMode: 'ask',
    thinkingEnabled: false,
    thinkingStrength: 'medium',
    memoryEnabled: false,
    customSystemPrompt: '',
    searchProvider: '',
    searchBaseUrl: '',
    searchHasKey: false,
  }
  const PRESETS = [
    { provider: 'custom', label: 'Custom', family: 'custom', defaultBaseUrl: '', defaultModel: 'gpt-4o-mini' },
  ]

  /** resolve 返回该模型名的预设值（chatOn 夹具：上下文 200000 / 输出 16384 / 识图 on / reasoning_effort） */
  function draftPreset(model: string): Raw {
    return chatOn({ model, enabled: false, isPreset: true, isOverridden: false })
  }

  /** 只桩模型相关的三个出口：resolve（只读解析）/ batch（批量写）/ 兜底 —— 其余走各自 mock */
  function installDraftApi(opts: { resolveFails?: boolean; batchFails?: boolean } = {}) {
    mocks.api.mockImplementation(async (method: string, path: string, body: Raw) => {
      const p = String(path)
      if (method === 'POST' && p === '/api/ai/model-settings/resolve') {
        if (opts.resolveFails) return { ok: false, status: 404, error: 'Not Found' }
        const models = (body.models ?? []) as string[]
        return { ok: true, status: 200, data: { items: models.map((mm) => draftPreset(mm)) } }
      }
      if (method === 'PUT' && p === '/api/ai/model-settings/batch') {
        if (opts.batchFails) return { ok: false, status: 500, error: 'batch boom' }
        const items = (body.items ?? []) as unknown[]
        return { ok: true, status: 200, data: { ok: true, updated: items.length, items: [] } }
      }
      if (method === 'GET' && p.startsWith('/api/ai/model-settings?')) {
        return { ok: true, status: 200, data: { items: [] } }
      }
      if (method === 'PUT' && p === '/api/ai/model-settings') {
        return { ok: true, status: 200, data: { ok: true, item: {} } }
      }
      return { ok: true, status: 200, data: {} }
    })
  }

  /** 草稿态：打开「添加供应商」+ 填 base/key + 刷新出候选模型 */
  async function mountDraftWithCandidates(models: string[]) {
    mocks.fetchProviderModels.mockResolvedValue({
      ok: true,
      status: 200,
      data: { models, count: models.length, upstreamEmpty: false, added: models.length, previousCount: 0 },
    })
    mocks.getProviders.mockResolvedValue({ ok: true, status: 200, data: { items: [], count: 0 } })
    mocks.getPresets.mockResolvedValue({ ok: true, status: 200, data: { items: PRESETS } })
    mocks.getSettings.mockResolvedValue({ ok: true, status: 200, data: SETTINGS })
    installDraftApi()
    const m = mountComponent(AIProviderSettings as Component)
    await flush()
    buttonByLabel(t('ai_add_provider')).click()
    await flush()
    await setValue(inputByPh(t('ai_base_url_ph'))!, 'http://host.docker.internal:3800/v1')
    await setValue(inputByPh(t('ai_api_key_ph'))!, 'sk-local')
    await flush()
    refreshBtn().click()
    await flush()
    return m
  }

  it('㊱ 勾选 1 个候选 ⇒ resolve 批量调用一次（含该模型）且渲染**折叠概要行**（完整表单默认不出现）', async () => {
    const m = await mountDraftWithCandidates(['m-1', 'm-2', 'm-3'])
    expect(card('m-1')).toBeNull()

    draftChip('m-1')!.click()
    await flush()

    // 批量一次：把该模型名数组发过去（不是每个模型一次）
    expect(resolveCalls()).toHaveLength(1)
    expect(resolveCalls()[0].models).toEqual(['m-1'])

    const c = card('m-1')!
    expect(c).toBeTruthy()
    // 概要行（与已保存态模型库行同构），完整表单**默认收起**（不渲染）
    expect(c.querySelector('[data-draft-row]')).toBeTruthy()
    expect(c.querySelector('.aim-draft-form')).toBeNull()
    expect(draftForms()).toHaveLength(0)
    // 摘要复用已保存态同一套文案：上下文 / 输出 / 多模态 / 推理协议都要有，且不留空
    const sum = c.querySelector('[data-draft-sum]')!.textContent || ''
    expect(sum).toContain('200000')
    expect(sum).toContain('16384')
    expect(sum).toContain(t('ai_model_cfg_text', '文本'))
    expect(sum).toContain(t('ai_model_reasoning_protocol_openai_reasoning_effort'))
    // 徽标：resolve 无覆盖行 ⇒ 预设
    expect(c.textContent).toContain(t('ai_model_cfg_badge_preset'))
    // 右侧是图标操作（配置 / 清空 / 移除），不是文字按钮
    expect(cardAction('m-1', 'draft-config')).toBeTruthy()
    expect(cardAction('m-1', 'draft-clear')).toBeTruthy()
    expect(cardAction('m-1', 'draft-remove')).toBeTruthy()
    expect(cardAction('m-1', 'draft-clear')!.disabled).toBe(true) // 还没改过 ⇒ 清空不可点

    m.unmount()
  })

  it('㊲ 再勾选 1 个 ⇒ 只解析**新增**的那一个（增量，不是全量重拉）', async () => {
    const m = await mountDraftWithCandidates(['m-1', 'm-2', 'm-3'])
    draftChip('m-1')!.click()
    await flush()
    draftChip('m-2')!.click()
    await flush()

    expect(resolveCalls()).toHaveLength(2)
    expect(resolveCalls()[1].models).toEqual(['m-2'])
    expect(document.querySelectorAll('.aim-draft-card')).toHaveLength(2)

    draftChip('m-3')!.click()
    await flush()
    expect(resolveCalls()).toHaveLength(3)
    expect(resolveCalls()[2].models).toEqual(['m-3'])
    expect(document.querySelectorAll('.aim-draft-card')).toHaveLength(3)

    m.unmount()
  })

  it('㊳ 取消勾选 ⇒ 卡片消失；再勾回来 ⇒ 卡片回来且草稿里改过的值保留（不重置、不重复解析）', async () => {
    const m = await mountDraftWithCandidates(['m-1', 'm-2'])
    draftChip('m-1')!.click()
    await flush()
    await expandCard('m-1')
    await setValue(cardInputs('m-1')[0], '128000')
    cardSwitches('m-1')[1].click() // 识图：预设 on → 改成 off
    await flush()

    expect(cardInputs('m-1')[0].value).toBe('128000')
    expect(card('m-1')!.textContent).toContain(t('ai_model_src_pending')) // 你刚改过

    // 取消勾选 ⇒ 卡片消失（不是"删除配置"，草稿仍在）
    draftChip('m-1')!.click()
    await flush()
    expect(card('m-1')).toBeNull()

    // 再勾回来 ⇒ 卡片回来、值保留、且不重新解析（已解析过）
    const before = resolveCalls().length
    draftChip('m-1')!.click()
    await flush()
    expect(card('m-1')).toBeTruthy()
    expect(cardInputs('m-1')[0].value).toBe('128000')
    expect(card('m-1')!.textContent).toContain(t('ai_model_src_pending'))
    expect(resolveCalls()).toHaveLength(before)

    m.unmount()
  })

  it('㊴ 保存 ⇒ PUT /batch 只带**改过的字段**（未改的模型/字段一个都不发），providerId 正确', async () => {
    const NEW_ID = 'feedface-0000-1111-2222-333344445555'
    mocks.createProvider.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...PROVIDER, id: NEW_ID, models: ['m-1', 'm-2'] },
    })
    const m = await mountDraftWithCandidates(['m-1', 'm-2', 'm-3'])
    await setValue(inputByPh(t('ai_name_ph'))!, 'Local GW')

    draftChip('m-1')!.click() // 勾选但一个字段都不改
    await flush()
    draftChip('m-2')!.click() // 勾选并改两个字段
    await flush()
    await expandCard('m-2')
    await setValue(cardInputs('m-2')[0], '128000')
    cardSwitches('m-2')[1].click()
    await flush()
    // 取消再勾回来：改动必须保留（草稿 override map）
    draftChip('m-2')!.click()
    await flush()
    draftChip('m-2')!.click()
    await flush()

    buttonByLabel(t('ai_save')).click()
    await flush(8)

    const batches = batchCalls()
    expect(batches).toHaveLength(1)
    expect(batches[0].providerId).toBe(NEW_ID)
    expect(batches[0].items).toEqual([{ model: 'm-2', patch: { contextWindow: 128000, supportsImage: false } }])
    // 未改动的 m-1 / 未勾选的 m-3 都不出现（否则会把预设物化成"已自定义"）
    expect(batches[0].items.some((i) => i.model === 'm-1')).toBe(false)
    expect(batches[0].items.some((i) => i.model === 'm-3')).toBe(false)

    m.unmount()
  })

  it('㊵ batch 失败 ⇒ 显示「供应商已保存，但模型配置写入失败 + 重试」且不谎报成功；重试成功后才切模型库', async () => {
    const NEW_ID = 'feedface-0000-1111-2222-333344445556'
    mocks.createProvider.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...PROVIDER, id: NEW_ID, models: ['m-1'] },
    })
    const m = await mountDraftWithCandidates(['m-1'])
    await setValue(inputByPh(t('ai_name_ph'))!, 'Local GW')
    draftChip('m-1')!.click()
    await flush()
    await expandCard('m-1')
    await setValue(cardInputs('m-1')[0], '128000')

    installDraftApi({ batchFails: true })
    mocks.showToast.mockClear()
    buttonByLabel(t('ai_save')).click()
    await flush(8)

    // 如实告知：供应商已保存 + 配置写入失败（带原因）+ 可就地重试
    const banner = document.querySelector<HTMLElement>('.ai-draft-batch-fail')
    expect(banner).toBeTruthy()
    expect(banner!.textContent).toContain(tf('ai_draft_batch_fail', 'x', { reason: 'batch boom' }))
    expect(document.querySelector('[data-action="draft-batch-retry"]')).toBeTruthy()
    // 不谎报"配置已存"
    expect(mocks.showToast).not.toHaveBeenCalledWith(t('ai_draft_batch_ok'), 'success')
    // 仍在草稿态：卡片与改动都在，没切到模型库
    expect(card('m-1')).toBeTruthy()
    expect(cardInputs('m-1')[0].value).toBe('128000')
    expect(document.querySelector('.aim-chip')).toBeNull()

    // 重试（这次成功）⇒ 才切到模型库
    installDraftApi()
    ;(document.querySelector('[data-action="draft-batch-retry"]') as HTMLButtonElement).click()
    await flush(8)
    expect(mocks.showToast).toHaveBeenCalledWith(t('ai_draft_batch_ok'), 'success')
    expect(document.querySelector('.ai-draft-batch-fail')).toBeNull()
    expect(document.querySelectorAll('.aim-draft-card')).toHaveLength(0)

    m.unmount()
  })

  it('㊶ 草稿态**从不**调用 GET/PUT /api/ai/model-settings（只走 resolve；保存前不写 batch）', async () => {
    const m = await mountDraftWithCandidates(['m-1', 'm-2'])
    await setValue(inputByPh(t('ai_name_ph'))!, 'Local GW')
    draftChip('m-1')!.click()
    await flush()
    draftChip('m-2')!.click()
    await flush()
    await expandCard('m-1')
    await setValue(cardInputs('m-1')[0], '128000')
    await flush()

    expect(plainModelSettingsCalls()).toEqual([])
    expect(resolveCalls().length).toBeGreaterThan(0)
    expect(batchCalls()).toEqual([]) // 保存前一次都不写

    m.unmount()
  })

  it('㊼ 勾选 3 个 ⇒ 3 行概要且**默认全部收起**（不再把表单全摊开）', async () => {
    const m = await mountDraftWithCandidates(['m-1', 'm-2', 'm-3'])
    for (const name of ['m-1', 'm-2', 'm-3']) {
      draftChip(name)!.click()
      await flush()
    }

    expect(document.querySelectorAll('[data-draft-card]')).toHaveLength(3)
    expect(document.querySelectorAll('[data-draft-row]')).toHaveLength(3)
    // 展开态的完整表单数量为 0
    expect(draftForms()).toHaveLength(0)
    // 每行都有摘要与图标操作
    for (const name of ['m-1', 'm-2', 'm-3']) {
      expect(card(name)!.querySelector('[data-draft-sum]')!.textContent).toContain('200000')
      expect(cardAction(name, 'draft-config')).toBeTruthy()
    }

    m.unmount()
  })

  it('㊽ 点「配置」才展开完整表单（值=预设）；收起后「已自定义」徽标 + 摘要反映改过的值', async () => {
    const m = await mountDraftWithCandidates(['m-1'])
    draftChip('m-1')!.click()
    await flush()

    // 默认收起
    expect(card('m-1')!.querySelector('.aim-draft-form')).toBeNull()
    // 点「配置」⇒ 展开，字段值=预设
    await expandCard('m-1')
    const form = card('m-1')!.querySelector<HTMLElement>('.aim-draft-form')!
    expect(form).toBeTruthy()
    expect(cardInputs('m-1')).toHaveLength(3) // 上下文 / 最大输出 / 别名
    expect(cardInputs('m-1')[0].value).toBe('200000')
    expect(cardSwitches('m-1')).toHaveLength(5)
    expect(form.querySelectorAll('.custom-select-trigger')).toHaveLength(1)

    // 改上下文窗口 + 识图
    await setValue(cardInputs('m-1')[0], '128000')
    cardSwitches('m-1')[1].click()
    await flush()
    // 再点一次 ⇒ 收起（表单卸载）
    cardAction('m-1', 'draft-config')!.click()
    await flush()
    expect(card('m-1')!.querySelector('.aim-draft-form')).toBeNull()

    // 收起后：徽标变「已自定义」，摘要如实反映改过的值
    const row = card('m-1')!
    expect(row.textContent).toContain(t('ai_model_cfg_badge_overridden'))
    const sum = row.querySelector('[data-draft-sum]')!.textContent || ''
    expect(sum).toContain('128000')
    expect(sum).not.toContain('200000')
    // 「清空自定义值」现在可点了；点它 ⇒ 回到预设（摘要回到 200000、徽标回预设）
    expect(cardAction('m-1', 'draft-clear')!.disabled).toBe(false)
    cardAction('m-1', 'draft-clear')!.click()
    await flush()
    expect(card('m-1')!.querySelector('[data-draft-sum]')!.textContent).toContain('200000')
    expect(card('m-1')!.textContent).toContain(t('ai_model_cfg_badge_preset'))
    expect(cardAction('m-1', 'draft-clear')!.disabled).toBe(true)

    m.unmount()
  })

  it('㊾ 行内「移除」⇒ 父组件从已选里去掉（芯片取消勾选），草稿改动仍保留、勾回来即恢复', async () => {
    const m = await mountDraftWithCandidates(['m-1', 'm-2'])
    draftChip('m-1')!.click()
    await flush()
    await expandCard('m-1')
    await setValue(cardInputs('m-1')[0], '128000')
    await flush()
    expect(draftChip('m-1')!.classList.contains('on')).toBe(true)

    // 行内移除（图标操作）
    cardAction('m-1', 'draft-remove')!.click()
    await flush()
    expect(draftChip('m-1')!.classList.contains('on')).toBe(false) // 芯片取消选中
    expect(card('m-1')).toBeNull() // 行消失
    expect(putBodies()).toEqual([]) // 草稿态不写库

    // 再勾回来：行回来 + 改过的值还在（草稿 override map 保留）
    draftChip('m-1')!.click()
    await flush()
    expect(card('m-1')).toBeTruthy()
    expect(card('m-1')!.querySelector('[data-draft-sum]')!.textContent).toContain('128000')
    expect(card('m-1')!.textContent).toContain(t('ai_model_cfg_badge_overridden'))

    m.unmount()
  })

  it('㊿ 旧契约（无 enabled）下不会用"全未启用"回写父组件、清空它已保存的模型列表', async () => {
    const legacy: Raw = {
      model: 'gpt-4o-mini',
      contextWindow: 200000,
      maxOutput: 16384,
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      reasoningEnabled: true,
      reasoningProtocol: 'inherit',
      isPreset: true,
      isOverridden: false,
    }
    const m = mountPanel({ items: [legacy], models: ['gpt-4o-mini', 'kept-2'] })
    await flush()

    // 界面按"未启用"渲染（不猜），但**不**把这份"全未启用"回写父组件（否则会把已保存的列表清空）
    expect(chipOn('gpt-4o-mini')).toBe(false)
    expect(m.emitted).toEqual([])

    m.unmount()
  })
})

/* ===================== 刷新只读 + 批量操作（本轮紧急修复） ===================== */

describe('AIProviderSettings — 刷新零写入 + 批量启用/停用', () => {
  const SETTINGS = {
    defaultProviderId: PROVIDER_ID,
    defaultModel: 'gpt-4o-mini',
    selectedModels: {},
    defaultMode: 'ask',
    thinkingEnabled: false,
    thinkingStrength: 'medium',
    memoryEnabled: false,
    customSystemPrompt: '',
    searchProvider: '',
    searchBaseUrl: '',
    searchHasKey: false,
  }
  const PRESETS = [
    { provider: 'custom', label: 'Custom', family: 'custom', defaultBaseUrl: '', defaultModel: 'gpt-4o-mini' },
  ]
  const buttonByActionAny = (action: string) => document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)

  /** 打开一个已保存供应商的编辑态（带 live 状态的服务端） */
  async function mountSaved(live: Raw[], opts: { batchFails?: boolean } = {}) {
    installLiveApi(live, opts)
    mocks.getProviders.mockResolvedValue({
      ok: true,
      status: 200,
      data: { items: [{ ...PROVIDER, models: live.map((i) => i.model) }], count: 1 },
    })
    mocks.getPresets.mockResolvedValue({ ok: true, status: 200, data: { items: PRESETS } })
    mocks.getSettings.mockResolvedValue({ ok: true, status: 200, data: SETTINGS })
    const m = mountComponent(AIProviderSettings as Component)
    await flush()
    clickByTitle(t('ai_edit'))
    await flush()
    return m
  }

  const refreshBtn = () =>
    Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === t('ai_refresh_models'),
    ) as HTMLButtonElement

  it('㊷ 【关键】编辑已保存供应商刷新 169 个 ⇒ 刷新零 PUT、启用数不变、芯片不变成全选', async () => {
    const keep = ['keep-1', 'keep-2', 'keep-3']
    const fresh = Array.from({ length: 166 }, (_, i) => `up-${i + 1}`)
    const live: Raw[] = keep.map((m) => chatOn({ model: m, enabled: true }))
    // 上游返回 169 个：其中 3 个是已知的 keep-*，166 个是新模型（默认未启用）
    mocks.getProviderModels.mockResolvedValue({
      ok: true,
      status: 200,
      data: { models: [...keep, ...fresh], count: 169, upstreamEmpty: false, added: 166, previousCount: 3 },
    })
    const m = await mountSaved(live)
    expect(document.querySelectorAll('.aim-chip--on')).toHaveLength(3)

    // 服务端把刷新出的模型写进 provider.models（默认**未启用**）⇒ 面板重新拉取时能看到它们
    live.push(...fresh.map((n) => chatOn({ model: n, enabled: false })))
    mocks.api.mockClear()
    refreshBtn().click()
    await flush(8)

    // ★ 本轮核心：刷新必须是只读的 —— 一个写请求都没有
    expect(writeCalls()).toEqual([])
    expect(batchPayloads()).toEqual([])
    // 启用数仍是 3；169 个芯片里只有原来那 3 个是选中态（绝不全选）
    expect(text()).toContain(tf('ai_models_selected_count', 'x', { n: 3 }))
    expect(document.querySelectorAll('.aim-chip--on')).toHaveLength(3)
    expect(document.querySelectorAll('.aim-chip')).toHaveLength(169)
    // 建议条出现，并写明"尚未启用"（纯建议，点按钮才会写库）
    expect(buttonByActionAny('suggest-all')).toBeTruthy()
    expect(text()).toContain(tf('ai_model_suggest_text', 'x', { n: 166, m: 166, k: 0 }))

    m.unmount()
  })

  it('㊸ 工具栏 [只启用对话模型]：只写"需要变更"的那些（对话置 true、非对话置 false）', async () => {
    const live: Raw[] = [
      chatOn({ model: 'chat-off', enabled: false }),
      chatOn({ model: 'chat-on', enabled: true }),
      nonChat('tts-1', 'audio', { enabled: true }),
      nonChat('img-1', 'image', { enabled: false }),
    ]
    const m = await mountSaved(live)

    buttonByActionAny('bulk-chat-only')!.click()
    await flush(8)

    expect(batchPayloads()).toHaveLength(1)
    expect(
      batchPayloads()[0]
        .items.map((i) => ({ model: i.model, enabled: i.patch.enabled }))
        .sort((a, b) => String(a.model).localeCompare(String(b.model))),
    ).toEqual([
      { model: 'chat-off', enabled: true }, // 对话模型 → 启用
      { model: 'tts-1', enabled: false }, // 非对话且当前启用 → 停用
    ])
    // 已经是对的状态（chat-on / img-1）不做无谓写入

    m.unmount()
  })

  it('㊹ [全部启用] 超过 30 个 ⇒ 先二次确认（写明数量），确认后才发 /batch', async () => {
    const live: Raw[] = Array.from({ length: 40 }, (_, i) => chatOn({ model: `up-${i + 1}`, enabled: false }))
    const m = await mountSaved(live)

    buttonByActionAny('bulk-enable-all')!.click()
    await flush()
    // 未确认：一个写请求都没有
    expect(writeCalls()).toEqual([])
    const confirm = document.querySelector<HTMLElement>('.aim-bulk-confirm')!
    expect(confirm).toBeTruthy()
    expect(confirm.textContent).toContain(tf('ai_bulk_confirm_enable', 'x', { n: 40 }))
    expect(confirm.textContent).toContain('40')

    buttonByActionAny('bulk-confirm')!.click()
    await flush(8)
    expect(batchPayloads()).toHaveLength(1)
    expect(batchPayloads()[0].items).toHaveLength(40)
    expect(batchPayloads()[0].items.every((i) => i.patch.enabled === true)).toBe(true)
    expect(document.querySelectorAll('.aim-chip--on')).toHaveLength(40)

    m.unmount()
  })

  it('㊺ [全部停用]：确认框写明影响数量，确认后 /batch 把所有已启用模型置 false', async () => {
    const live: Raw[] = Array.from({ length: 5 }, (_, i) => chatOn({ model: `keep-${i + 1}`, enabled: true }))
    const m = await mountSaved(live)
    expect(document.querySelectorAll('.aim-chip--on')).toHaveLength(5)

    buttonByActionAny('bulk-disable-all')!.click()
    await flush()
    expect(writeCalls()).toEqual([]) // 未确认不写
    const confirm = document.querySelector<HTMLElement>('.aim-bulk-confirm')!
    // 整句断言（词典文案里明确写了"配置与自定义值不会丢，只是停用"），并核对影响数量
    expect(confirm.textContent).toContain(tf('ai_bulk_confirm_disable', 'x', { n: 5 }))
    expect(confirm.textContent).toContain('5')

    buttonByActionAny('bulk-confirm')!.click()
    await flush(8)
    expect(batchPayloads()).toHaveLength(1)
    expect(batchPayloads()[0].items).toHaveLength(5)
    expect(batchPayloads()[0].items.every((i) => i.patch.enabled === false)).toBe(true)
    expect(document.querySelectorAll('.aim-chip--on')).toHaveLength(0)

    m.unmount()
  })

  it('㊻ 批量失败 ⇒ 明确报错 + 重新拉取（界面与库一致），绝不谎报成功', async () => {
    const live: Raw[] = Array.from({ length: 5 }, (_, i) => chatOn({ model: `keep-${i + 1}`, enabled: true }))
    const m = await mountSaved(live, { batchFails: true })
    const getsBefore = modelSettingCalls().filter((c) => c[0] === 'GET').length

    buttonByActionAny('bulk-disable-all')!.click()
    await flush()
    buttonByActionAny('bulk-confirm')!.click()
    await flush(8)

    // 错误反馈（带原因 + 已写入条数）
    const result = document.querySelector<HTMLElement>('[data-action="bulk-result"]')!
    expect(result.className).toContain('aim-bulk-result--error')
    expect(result.textContent).toContain(tf('ai_bulk_fail', 'x', { n: 0, reason: 'batch boom' }))
    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining('batch boom'), 'error')
    // 不谎报成功
    expect(mocks.showToast).not.toHaveBeenCalledWith(expect.stringContaining('已更新'), 'success')
    // 重新拉取：GET 次数 +1，且界面回到"库里真实的 5 个已启用"
    expect(modelSettingCalls().filter((c) => c[0] === 'GET').length).toBe(getsBefore + 1)
    expect(document.querySelectorAll('.aim-chip--on')).toHaveLength(5)

    m.unmount()
  })
})

beforeEach(() => {
  mocks.api.mockReset()
  mocks.showToast.mockReset()
  mocks.getProviders.mockReset()
  mocks.getPresets.mockReset()
  mocks.getProviderModels.mockReset()
  mocks.fetchProviderModels.mockReset()
  mocks.createProvider.mockReset()
  mocks.updateProvider.mockReset()
  mocks.getSettings.mockReset()
  mocks.can.mockReset()
  mocks.can.mockReturnValue(true)
  try {
    sessionStorage.clear()
  } catch {
    /* ignore */
  }
})

afterEach(() => {
  document.body.innerHTML = ''
})
