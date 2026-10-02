// @vitest-environment jsdom
// === 证据：设置 → AI → 供应商编辑 →「模型」区块的逐个配置 ===
// 需求：模型不再只能多选，还要能逐个配置
//   上下文窗口 / 最大输出 / 四路多模态能力（文本·识图·视频·音频）/ 推理开关 + 推理协议 + 三档映射，
// 并展示来源标记（预设 / 已自定义）与「恢复预设」。契约见 src/desktop/src/api/modelSettings.ts
// （GET/PUT /api/ai/model-settings，字段名由服务端冻结）。
//
// 面板级（AIModelSettingsPanel）：
//   ① 拉取后渲染出预设值（GET 的 URL 带 providerId；行内展示服务端返回的数值与"预设"标记）
//   ② 修改并提交 → 调 PUT，且 patch 只含改动字段、字段名与契约一致
//   ③ 恢复预设 → patch 全为 null（reasoningProtocol=inherit），与 RESTORE_PRESET_PATCH 一致
//   ④ 非法输入（0 / 负数 / 超上限）不提交并就地提示
//   ⑤ 接口未就绪（404）时如实提示"无法读取预设配置"，不用本地默认值冒充服务端预设
//   ⑥ 展开/关闭编辑弹窗与父组件新增模型都不会丢行（面板只读 props.models，不写回多选）
// 接线级（AIProviderSettings）：
//   ⑦ 点「编辑」即自动拉取模型配置；刷新模型列表成功后再次自动拉取（需求 3）
//   ⑧ 打开/关闭单个模型的配置弹窗，不会弄丢父组件的模型多选
//
// 只桩掉网络出口：@/api/client（modelSettings 走的统一 api()）与 @/api/ai（供应商 CRUD/刷新）。
// 真实链路（i18n、UI 组件、AIModelSettingsPanel、modelSettings 的 URL 构造）照常执行，
// 所以断言的对象就是真正会发出去的那个请求。jsdom 无排版引擎 ⇒ 不断言样式，只断言调用与 DOM。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// jsdom 未实现 scrollIntoView（供应商表单展开时会调用）→ 补桩，
// 否则抛未处理的 rejection 并污染测试结果。
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
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
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
import { RESTORE_PRESET_PATCH, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, LEVEL_VALUE_MAX_LEN } from '@/api/modelSettings'
import { useI18n } from '@/composables/useI18n'

const { t, tf } = useI18n()

const PROVIDER_ID = '11111111-2222-3333-4444-555555555555'

/* ===================== 共享夹具 ===================== */

/** 服务端返回的"预设"条目：上下文 200000 / 最大输出 16384 / 识图 + 推理（reasoning_effort） */
const PRESET_ITEM = {
  model: 'gpt-4o-mini',
  contextWindow: 200000,
  maxOutput: 16384,
  supportsText: true,
  supportsImage: true,
  supportsVideo: false,
  supportsAudio: false,
  reasoningEnabled: true,
  reasoningProtocol: 'openai_reasoning_effort',
  reasoningLevels: { low: 'low', medium: 'medium', high: 'high' },
  isPreset: true,
  isOverridden: false,
}

const GET_OK = { ok: true, status: 200, data: { items: [PRESET_ITEM] } }
const PUT_OK = {
  ok: true,
  status: 200,
  data: { ok: true, item: { ...PRESET_ITEM, isOverridden: true } },
}

/** 默认：GET 走真实预设，PUT 走成功响应 */
function mockApi() {
  mocks.api.mockImplementation(async (method: string) => (method === 'GET' ? GET_OK : PUT_OK))
}

const modelSettingCalls = () =>
  mocks.api.mock.calls.filter((c) => String(c[1] || '').startsWith('/api/ai/model-settings'))
const putCalls = () => mocks.api.mock.calls.filter((c) => c[0] === 'PUT')

async function flush(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await nextTick()
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

/* ===================== 面板：逐个模型配置 ===================== */

function mountPanel(opts: { providerId?: string; models?: string[] } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const providerId = ref(opts.providerId ?? PROVIDER_ID)
  const models = ref(opts.models ?? ['gpt-4o-mini'])
  const app = createApp({
    render: () => h(AIModelSettingsPanel as Component, { providerId: providerId.value, models: models.value }),
  })
  app.mount(host)
  return {
    setModels: async (next: string[]) => {
      models.value = next
      await flush()
    },
    unmount: () => {
      app.unmount()
      host.remove()
    },
  }
}

function openEditor(index = 0) {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.aim-cfg-edit')
  expect(buttons.length).toBeGreaterThan(index)
  buttons[index].click()
}

/** 弹窗内的数字输入框顺序：上下文窗口 / 最大输出 / 低 / 中 / 高 */
const modalInputs = () => document.querySelectorAll<HTMLInputElement>('.aim-form .aim-input')
const modalSwitches = () => document.querySelectorAll<HTMLElement>('.aim-form [role="switch"]')

describe('AIModelSettingsPanel — 模型逐个配置', () => {
  it('① 拉取后渲染出预设值（GET 带 providerId，行内展示服务端数值与来源标记）', async () => {
    const m = mountPanel()
    await flush()

    const getCall = mocks.api.mock.calls.find((c) => c[0] === 'GET')
    expect(getCall).toBeTruthy()
    expect(getCall?.[1]).toBe(`/api/ai/model-settings?providerId=${PROVIDER_ID}`)

    const text = document.body.textContent || ''
    // 服务端下发的预设默认值原样展示（上下文 200000 / 最大输出 16384），不是本地硬编码
    expect(text).toContain('200000')
    expect(text).toContain('16384')
    // 来源标记：isPreset=true & isOverridden=false → 「预设」
    expect(text).toContain(t('ai_model_cfg_badge_preset'))
    // 推理协议按契约枚举渲染（openai_reasoning_effort）
    expect(text).toContain(t('ai_model_reasoning_protocol_openai_reasoning_effort'))

    m.unmount()
  })

  it('② 修改后提交 → 调 PUT，patch 只含改动字段且字段名与契约一致', async () => {
    const m = mountPanel()
    await flush()

    openEditor(0)
    await flush()
    const inputs = modalInputs()
    expect(inputs.length).toBe(5)

    // 改上下文窗口；识图开关从预设的 true 翻成 false；推理协议换成 Anthropic thinking
    await setValue(inputs[0], '128000')
    modalSwitches()[1].click()
    await flush()
    const trigger = document.querySelector('.aim-form .custom-select-trigger') as HTMLButtonElement
    trigger.click()
    await flush()
    const option = Array.from(document.querySelectorAll('.custom-select-option')).find((o) =>
      (o.textContent || '').includes('Anthropic thinking'),
    )
    expect(option).toBeTruthy()
    const optionEl = option as HTMLElement
    optionEl.click()
    await flush()

    buttonByLabel(t('ai_model_cfg_save')).click()
    await flush()

    const calls = putCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toBe('/api/ai/model-settings')
    expect(calls[0][2]).toEqual({
      providerId: PROVIDER_ID,
      model: 'gpt-4o-mini',
      patch: {
        contextWindow: 128000,
        supportsImage: false,
        reasoningProtocol: 'anthropic_thinking',
      },
    })
    expect(mocks.showToast).toHaveBeenCalledWith(t('ai_model_cfg_saved'), 'success')

    m.unmount()
  })

  it('③ 恢复预设 → 提交全 null 的 patch（reasoningProtocol 用 inherit），与 RESTORE_PRESET_PATCH 一致', async () => {
    const m = mountPanel()
    await flush()

    openEditor(0)
    await flush()
    const restoreBtn = document.querySelector('.aim-cfg-restore') as HTMLButtonElement
    expect(restoreBtn).toBeTruthy()
    restoreBtn.click()
    await flush()

    const calls = putCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][2].patch).toEqual(RESTORE_PRESET_PATCH)
    expect(calls[0][2].patch).toEqual({
      contextWindow: null,
      maxOutput: null,
      supportsText: null,
      supportsImage: null,
      supportsVideo: null,
      supportsAudio: null,
      reasoningEnabled: null,
      reasoningProtocol: 'inherit',
      reasoningLevels: null,
    })
    expect(mocks.showToast).toHaveBeenCalledWith(t('ai_model_cfg_restored'), 'success')

    m.unmount()
  })

  it('④ 非法输入（0 / 负数 / 低于下限 / 超上限、档位取值超长）不提交并就地提示', async () => {
    const m = mountPanel()
    await flush()

    openEditor(0)
    await flush()
    const ctx = modalInputs()[0]
    // 边界与服务端硬校验同源（1024..2000000），所以本地就能拦住"服务端必定 400"的输入
    const expectedError = tf('ai_model_cfg_err_context', 'x', {
      min: CONTEXT_WINDOW_MIN,
      max: CONTEXT_WINDOW_MAX,
    })

    for (const bad of ['0', '-5', String(CONTEXT_WINDOW_MIN - 1), String(CONTEXT_WINDOW_MAX + 1)]) {
      await setValue(ctx, bad)
      buttonByLabel(t('ai_model_cfg_save')).click()
      await flush()

      expect(putCalls()).toHaveLength(0)
      expect(document.body.textContent || '').toContain(expectedError)
    }

    // 三档映射取值超长（服务端只收 ≤64 的短串）同样就地拦下
    await setValue(ctx, '')
    await setValue(modalInputs()[2], 'x'.repeat(LEVEL_VALUE_MAX_LEN + 1))
    buttonByLabel(t('ai_model_cfg_save')).click()
    await flush()

    expect(putCalls()).toHaveLength(0)
    expect(document.body.textContent || '').toContain(
      tf('ai_model_cfg_err_level', 'x', { level: t('ai_model_cfg_level_low', '低'), max: LEVEL_VALUE_MAX_LEN }),
    )

    m.unmount()
  })

  it('⑤ 接口未就绪（404）时如实提示，不用本地默认值冒充服务端预设', async () => {
    mocks.api.mockResolvedValue({ ok: false, status: 404, error: 'Not Found' })
    const m = mountPanel()
    await flush()

    const text = document.body.textContent || ''
    expect(text).toContain(t('ai_model_cfg_load_fail'))
    expect(document.querySelector('.aim-cfg-note--warn')).not.toBeNull()
    // 降级不影响本地面板可用：模型行仍在，只是标记为"无预设"
    expect(document.querySelectorAll('.aim-cfg-row')).toHaveLength(1)
    expect(text).toContain(t('ai_model_cfg_badge_none'))

    m.unmount()
  })

  it('⑥ 展开/关闭编辑弹窗与父组件新增模型都不会丢行（面板只读，不写回多选）', async () => {
    const m = mountPanel({ models: ['gpt-4o-mini', 'o3-mini'] })
    await flush()
    expect(document.querySelectorAll('.aim-cfg-row')).toHaveLength(2)

    openEditor(0)
    await flush()
    expect(document.querySelector('.modal-backdrop')).not.toBeNull()
    buttonByLabel(t('cancel_btn', '取消')).click()
    await flush()

    // 关闭弹窗后：两行仍在，且没有发出任何写请求（关闭动作不重置任何东西）
    expect(document.querySelectorAll('.aim-cfg-row')).toHaveLength(2)
    expect(document.querySelector('.modal-backdrop')).toBeNull()
    expect(putCalls()).toHaveLength(0)
    expect(document.body.textContent || '').toContain('o3-mini')

    // 父组件追加一个模型 → 面板跟着多一行，已有两行的配置不受影响
    await m.setModels(['gpt-4o-mini', 'o3-mini', 'gpt-4.1'])
    expect(document.querySelectorAll('.aim-cfg-row')).toHaveLength(3)
    expect(document.body.textContent || '').toContain('gpt-4.1')

    m.unmount()
  })
})

/* ===================== 接线：供应商编辑面板 ===================== */

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

function clickByTitle(title: string) {
  const el = document.querySelector(`[title="${title}"]`) as HTMLElement | null
  if (!el) throw new Error(`element with title not found: ${title}`)
  el.click()
}

describe('AIProviderSettings — 模型配置面板接线', () => {
  it('⑦ 点「编辑」即自动拉取模型配置；刷新模型列表成功后再次自动拉取', async () => {
    const m = mountComponent(AIProviderSettings as Component)
    await flush()

    // 列表已渲染，编辑入口在卡片操作区
    clickByTitle(t('ai_edit'))
    await flush()

    const first = modelSettingCalls()
    expect(first).toHaveLength(1)
    expect(first[0][0]).toBe('GET')
    expect(first[0][1]).toBe(`/api/ai/model-settings?providerId=${PROVIDER_ID}`)
    // 面板把预设值渲染出来了（服务端默认值，不是本地硬编码）
    expect(document.body.textContent || '').toContain('200000')

    // 刷新模型列表（编辑态用库里已存的 key 走 GET /api/ai/providers/:id/models）
    const refreshBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === t('ai_refresh_models'),
    ) as HTMLButtonElement
    expect(refreshBtn).toBeTruthy()
    refreshBtn.click()
    await flush()

    expect(mocks.getProviderModels).toHaveBeenCalledWith(PROVIDER_ID)
    // 需求 3：刷新后自动再次拉取（共 2 次 GET），不需要用户手动点
    expect(modelSettingCalls()).toHaveLength(2)

    m.unmount()
  })

  it('⑧ 打开/关闭单个模型的配置弹窗不会弄丢已选模型', async () => {
    const m = mountComponent(AIProviderSettings as Component)
    await flush()
    clickByTitle(t('ai_edit'))
    await flush()

    // 已选模型标签：1 个（gpt-4o-mini）
    expect(document.querySelectorAll('.ai-model-tag--selected')).toHaveLength(1)

    // 打开配置弹窗 → 只点弹窗页脚的「取消」（表单自己的取消按钮是 resetForm，语义不同）
    const editButtons = document.querySelectorAll<HTMLButtonElement>('.aim-cfg-edit')
    expect(editButtons.length).toBe(1)
    editButtons[0].click()
    await flush()
    expect(document.querySelector('.modal-backdrop')).not.toBeNull()

    const cancelBtn = document.querySelector('.modal-panel .modal-footer button') as HTMLButtonElement | null
    expect(cancelBtn).toBeTruthy()
    expect((cancelBtn?.textContent || '').trim()).toBe(t('cancel_btn'))
    cancelBtn?.click()
    await flush()

    // 关闭弹窗后：供应商表单仍在、已选模型标签数量不变、模型配置行仍在
    expect(document.querySelector('.ai-form')).not.toBeNull()
    expect(document.querySelectorAll('.ai-model-tag--selected')).toHaveLength(1)
    expect(document.querySelector('.aim-cfg-row')).not.toBeNull()

    m.unmount()
  })
})

beforeEach(() => {
  mocks.api.mockReset()
  mocks.showToast.mockReset()
  mocks.getProviders.mockReset()
  mocks.getPresets.mockReset()
  mocks.getProviderModels.mockReset()
  mocks.getSettings.mockReset()
  mocks.can.mockReset()

  mocks.can.mockReturnValue(true)
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
  mocks.getProviderModels.mockResolvedValue({
    ok: true,
    status: 200,
    data: { models: ['gpt-4o-mini', 'gpt-4.1'] },
  })
  mockApi()
})

afterEach(() => {
  document.body.innerHTML = ''
})
