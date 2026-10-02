// @vitest-environment jsdom
// 证据：设置 → 关于 ClipSync →「发送反馈」不再是 GitHub Issues 外链，而是真的走
// POST /api/feedback（契约见 src/server/src/routes/feedback.js）。
//   ① 表单合法 → 调用 api('POST','/api/feedback', payload) 且字段与请求体一一对应
//   ② 标题 / 描述为空 → 不调用接口，给出错误提示
//   ③ 提交成功 → 关闭弹窗并重置表单（再次打开是干净表单）
//   ④ 提交在途 → 按钮进入 loading/disabled，不会发出第二次请求
//
// 只桩掉网络出口 api()：@/api/feedback 的真实常量（白名单 / 长度上限）与 submitFeedback
// 全链路照常执行，所以断言的对象就是真正会发出去的那个请求。
// jsdom 没有排版引擎，因此不断言任何样式，只断言调用参数与 DOM 结构。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// useReducedMotion 在模块顶层就调用 window.matchMedia（jsdom 未实现）→ 必须在 import 组件前补齐
type PatchedWindow = Window & { matchMedia?: (query: string) => MediaQueryList }
vi.hoisted(() => {
  const win = (globalThis as unknown as { window?: PatchedWindow }).window
  if (win && !win.matchMedia) {
    win.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    })) as unknown as (query: string) => MediaQueryList
  }
})

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('@/api/client', () => ({ api: mocks.api }))
vi.mock('@/composables/useSonner', () => ({
  useSonner: () => ({ show: mocks.showToast, loading: vi.fn(), dismiss: vi.fn(), rateLimited: vi.fn() }),
}))
// 当前登录用户邮箱 → 联系方式默认值（不断言 store 本身，只用于"默认带出"这一条）
vi.mock('@/stores/configStore', () => ({
  useConfigStore: () => ({ user: { email: 'painter@example.com' }, serverUrl: 'http://localhost:3001' }),
}))

import { createApp, h, nextTick, ref, type Component } from 'vue'
import FeedbackDialog from '../FeedbackDialog.vue'
import { FEEDBACK_CONTENT_MAX, FEEDBACK_TITLE_MAX } from '@/api/feedback'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()

const OK_RESPONSE = {
  ok: true,
  status: 200,
  data: { ok: true, id: 'ticket-1', status: 'open', createdAt: '2026-01-01T00:00:00.000Z', emailSent: true },
}

/** 等待 v-model 链路（useVModel 被动代理 → 父级 reactive）与提交 promise 落地 */
async function flush() {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function mountDialog() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const open = ref(true)
  let closeCount = 0
  const app = createApp({
    render: () =>
      h(FeedbackDialog as Component, {
        open: open.value,
        onClose: () => {
          closeCount += 1
          open.value = false
        },
      }),
  })
  app.mount(host)
  return {
    reopen: async () => {
      open.value = true
      await flush()
    },
    closeCount: () => closeCount,
    unmount: () => {
      app.unmount()
      host.remove()
    },
  }
}

const titleInput = () => document.getElementById('fb-title-input') as HTMLInputElement
const contentInput = () => document.getElementById('fb-content-input') as HTMLTextAreaElement
const overlay = () => document.querySelector('.fb-overlay')

async function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}

function buttonByLabel(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === label)
  if (!found) throw new Error(`button not found: ${label}`)
  return found as HTMLButtonElement
}

beforeEach(() => {
  mocks.api.mockReset()
  mocks.showToast.mockReset()
  mocks.api.mockResolvedValue(OK_RESPONSE)
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('FeedbackDialog — 应用内反馈工单', () => {
  it('① 表单合法时调用 api 且 payload 与服务端契约字段一致', async () => {
    const m = mountDialog()
    await flush()

    await setValue(titleInput(), '  导出 PDF 没有反应  ')
    await setValue(contentInput(), '点击导出后没有任何提示，重试也没用')
    // 本地字数上限与服务端上限同源（不出现"本地能填、服务端 400"）
    expect(titleInput().maxLength).toBe(FEEDBACK_TITLE_MAX)
    expect(contentInput().maxLength).toBe(FEEDBACK_CONTENT_MAX)
    buttonByLabel(t('fb_submit')).click()
    await flush()

    expect(mocks.api).toHaveBeenCalledTimes(1)
    const [method, path, payload] = mocks.api.mock.calls[0]
    expect(method).toBe('POST')
    expect(path).toBe('/api/feedback')
    expect(payload).toEqual({
      title: '导出 PDF 没有反应', // 已 trim
      category: 'feature', // 默认分类（服务端白名单值）
      content: '点击导出后没有任何提示，重试也没用',
      contact: 'painter@example.com', // 默认带出当前登录用户邮箱
      appVersion: '', // jsdom 无 Tauri → 空串，不编造
      platform: expect.any(String),
    })
    // 客户端版本/平台是附带信息，必须存在且为字符串（服务端按可选字段落库）
    expect(typeof payload.appVersion).toBe('string')
    expect(['windows', 'macos', 'linux']).toContain(payload.platform)

    m.unmount()
  })

  it('② 标题为空时不调用接口并提示', async () => {
    const m = mountDialog()
    await flush()

    await setValue(contentInput(), '只有描述，没有标题')
    buttonByLabel(t('fb_submit')).click()
    await flush()

    expect(mocks.api).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith(t('fb_title_required'), 'error')

    m.unmount()
  })

  it('② 详细描述为空时不调用接口并提示', async () => {
    const m = mountDialog()
    await flush()

    await setValue(titleInput(), '只有标题')
    buttonByLabel(t('fb_submit')).click()
    await flush()

    expect(mocks.api).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith(t('fb_desc_required'), 'error')

    m.unmount()
  })

  it('③ 提交成功后关闭弹窗并重置表单', async () => {
    const m = mountDialog()
    await flush()

    await setValue(titleInput(), '界面配色建议')
    await setValue(contentInput(), '深色主题下侧边栏对比度偏低')
    buttonByLabel(t('fb_submit')).click()
    await flush()

    expect(mocks.api).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith(t('fb_sent'), 'success')
    expect(m.closeCount()).toBe(1)
    expect(overlay()).toBeNull()

    // 再次打开 → 干净表单（标题/描述已重置，联系方式回到默认邮箱）
    await m.reopen()
    expect(titleInput().value).toBe('')
    expect(contentInput().value).toBe('')
    expect(document.querySelector('.fb-overlay')).not.toBeNull()

    m.unmount()
  })

  it('④ 提交在途时按钮进入 loading/disabled，不会重复提交', async () => {
    let resolveRequest: ((value: unknown) => void) | undefined
    mocks.api.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      }),
    )

    const m = mountDialog()
    await flush()
    await setValue(titleInput(), '导入失败')
    await setValue(contentInput(), '选择大文件后一直卡在 0%')

    buttonByLabel(t('fb_submit')).click()
    await flush()

    // 在途态：按钮文案切换为"提交中…"且被禁用（这就是防重复提交的可见证据）
    const pending = buttonByLabel(t('fb_submitting'))
    expect(pending.disabled).toBe(true)
    pending.click()
    await flush()
    expect(mocks.api).toHaveBeenCalledTimes(1)

    resolveRequest?.(OK_RESPONSE)
    await flush()
    expect(m.closeCount()).toBe(1)

    m.unmount()
  })
})
