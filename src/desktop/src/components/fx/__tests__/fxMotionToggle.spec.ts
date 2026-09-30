// @vitest-environment jsdom
// fx 动效层证据（设置→数据→「减少动画」必须真的关得掉动画）：
//   ① 模块顶层 useReducedMotion 依赖 matchMedia，jsdom 没有 → 必须在 import 前补齐
//   ② 逐个组件断言「开关关 = 动效真的停手」（不是只靠 CSS 兜底压时长）
//   ③ 断言 scoped class 能否落在「跨层级子组件根元素」上——剪切板把 .clip-stat / .clipboard-page
//      这类布局类直接挂在 fx 子组件根上，HomeView 的 .main-content > :not(...) 也依赖这条链，
//      一旦 Vue 不再透传 scopeId，页面高度会塌掉，这是必须在测试里钉死的隐式契约
/* eslint-disable vue/one-component-per-file -- 末尾 scopeId 探针用匿名 defineComponent 拼装，不属于可复用组件 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// jsdom 缺的宿主 API：matchMedia / ResizeObserver / rAF / canvas。
// vi.hoisted 保证这些补丁在组件模块（含 useReducedMotion 的顶层 matchMedia 调用）被 import 之前就位。
type PatchedWindow = Window &
  typeof globalThis & {
    matchMedia?: (query: string) => MediaQueryList
    ResizeObserver?: new () => { observe(): void; unobserve(): void; disconnect(): void }
    requestAnimationFrame?: (cb: FrameRequestCallback) => number
    cancelAnimationFrame?: (id: number) => void
  }

vi.hoisted(() => {
  const win = (globalThis as unknown as { window?: PatchedWindow }).window
  if (!win) return
  if (!win.matchMedia) {
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
  if (!win.ResizeObserver) {
    win.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  if (!win.requestAnimationFrame) {
    win.requestAnimationFrame = (cb: FrameRequestCallback) => win.setTimeout(() => cb(Date.now()), 16)
    win.cancelAnimationFrame = (id: number) => win.clearTimeout(id)
  }
  // jsdom 没有 canvas 实现，getContext 会抛 Not implemented 并刷屏；组件对 null ctx 已做兜底
  if (win.HTMLCanvasElement) {
    win.HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof win.HTMLCanvasElement.prototype.getContext
  }
})

import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import FxClickSpark from '../FxClickSpark.vue'
import FxSpotlightCard from '../FxSpotlightCard.vue'
import FxGlitchText from '../FxGlitchText.vue'
import FxMagnet from '../FxMagnet.vue'
import FxLatticeLoader from '../FxLatticeLoader.vue'
import { useReducedMotion } from '../useReducedMotion'

const ROOT = document.documentElement
// 模块级单例的 MutationObserver 是微任务回调，改完 class 要让它跑完
async function flushObservers() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function mount(comp: Component, props: Record<string, unknown> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(comp, props) })
  app.mount(host)
  return {
    host,
    el: host.firstElementChild as HTMLElement,
    unmount: () => {
      app.unmount()
      host.remove()
    },
  }
}

// jsdom 没有排版引擎，getBoundingClientRect 恒为 0；聚光/磁吸都据此做了「零尺寸不参与」的守卫，
// 测试里必须给出真实尺寸，否则断言会因为「元素尺寸为 0」而假通过
function stubRect(el: HTMLElement, width = 200, height = 80) {
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect
}

beforeEach(() => {
  ROOT.classList.remove('reduce-motion')
})

afterEach(() => {
  ROOT.classList.remove('reduce-motion')
  vi.restoreAllMocks()
})

describe('useReducedMotion — 双通道开关', () => {
  it('默认不减少动效', () => {
    expect(useReducedMotion().value).toBe(false)
  })

  it('html.reduce-motion 命中即 true，且能实时开关', async () => {
    const reduced = useReducedMotion()
    ROOT.classList.add('reduce-motion')
    await flushObservers()
    expect(reduced.value).toBe(true)

    ROOT.classList.remove('reduce-motion')
    await flushObservers()
    expect(reduced.value).toBe(false)
  })
})

describe('FxClickSpark', () => {
  it('默认挂载 canvas 并监听点击', () => {
    const m = mount(FxClickSpark)
    expect(m.host.querySelector('canvas')).toBeTruthy()
    m.unmount()
  })

  it('减少动效时不建 canvas（卸载即停止），关闭后恢复', async () => {
    const m = mount(FxClickSpark)
    expect(m.host.querySelector('canvas')).toBeTruthy()

    ROOT.classList.add('reduce-motion')
    await flushObservers()
    expect(m.host.querySelector('canvas')).toBeNull()

    ROOT.classList.remove('reduce-motion')
    await flushObservers()
    expect(m.host.querySelector('canvas')).toBeTruthy()
    m.unmount()
  })
})

describe('FxSpotlightCard', () => {
  it('默认跟随指针亮起', async () => {
    const m = mount(FxSpotlightCard, { class: 'host-card' })
    stubRect(m.el)
    expect(m.el.classList.contains('is-static')).toBe(false)

    m.el.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }))
    await nextTick()
    expect(m.el.classList.contains('is-on')).toBe(true)
    // 关键：调用方 class 必须落在组件根元素上（布局依赖它）
    expect(m.el.classList.contains('host-card')).toBe(true)
    m.unmount()
  })

  it('减少动效时不跟随指针，改为静态柔光', async () => {
    ROOT.classList.add('reduce-motion')
    await flushObservers()

    const m = mount(FxSpotlightCard)
    stubRect(m.el)
    expect(m.el.classList.contains('is-static')).toBe(true)

    m.el.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }))
    await nextTick()
    expect(m.el.classList.contains('is-on')).toBe(false)
    m.unmount()
  })
})

describe('FxGlitchText', () => {
  it('默认不生成静态态类，文字照常渲染', () => {
    const m = mount(FxGlitchText, { text: '加载失败' })
    expect(m.el.textContent?.trim()).toBe('加载失败')
    expect(m.el.classList.contains('is-static')).toBe(false)
    m.unmount()
  })

  it('减少动效时进入 is-static（伪元素不再生成切片）', async () => {
    ROOT.classList.add('reduce-motion')
    await flushObservers()

    const m = mount(FxGlitchText, { text: '加载失败' })
    expect(m.el.classList.contains('is-static')).toBe(true)
    expect(m.el.getAttribute('data-text')).toBe('加载失败')
    m.unmount()
  })
})

describe('FxMagnet', () => {
  it('默认挂 window 指针监听', () => {
    const spy = vi.spyOn(window, 'addEventListener')
    const m = mount(FxMagnet)
    expect(spy.mock.calls.some((c) => c[0] === 'pointermove')).toBe(true)
    m.unmount()
  })

  it('减少动效时一个指针监听都不挂', async () => {
    ROOT.classList.add('reduce-motion')
    await flushObservers()

    const spy = vi.spyOn(window, 'addEventListener')
    const m = mount(FxMagnet)
    expect(spy.mock.calls.some((c) => c[0] === 'pointermove')).toBe(false)
    m.unmount()
  })
})

describe('FxLatticeLoader', () => {
  it('减少动效时是静止全亮字形，且不启动计时器', async () => {
    ROOT.classList.add('reduce-motion')
    await flushObservers()

    const spy = vi.spyOn(globalThis, 'setInterval')
    const m = mount(FxLatticeLoader, { label: '分析中…', showTimer: true })
    expect(m.el.classList.contains('is-static')).toBe(true)
    expect(m.el.textContent).toContain('分析中…')
    expect(spy).not.toHaveBeenCalled()
    m.unmount()
  })

  it('默认状态下计时器照常跑', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval')
    const m = mount(FxLatticeLoader, { label: '分析中…', showTimer: true })
    expect(m.el.classList.contains('is-static')).toBe(false)
    expect(spy).toHaveBeenCalled()
    m.unmount()
  })
})

describe('scoped class 跨组件根元素透传（隐式布局契约）', () => {
  it('父级 scoped class 能落到「孙子组件」的根元素上', () => {
    const Leaf = defineComponent({
      name: 'Leaf',
      render: () => h('div', { class: 'leaf-root' }),
    })
    const Mid = defineComponent({
      name: 'Mid',
      render: () => h(Leaf, { class: 'mid-passed' }),
    })
    // 显式挂 scopeId，模拟 SFC <style scoped>
    Mid.__scopeId = 'data-v-mid'
    const Top = defineComponent({
      name: 'Top',
      render: () => h(Mid, { class: 'top-passed' }),
    })
    Top.__scopeId = 'data-v-top'

    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(Top) })
    app.mount(host)

    const root = host.firstElementChild as HTMLElement
    // 调用方 class 全部保留
    expect(root.classList.contains('top-passed')).toBe(true)
    expect(root.classList.contains('mid-passed')).toBe(true)
    expect(root.classList.contains('leaf-root')).toBe(true)
    // 两层 scopeId 都要落到同一个根元素上：剪切板/HomeView 的布局规则靠这条链命中
    expect(root.hasAttribute('data-v-mid')).toBe(true)
    expect(root.hasAttribute('data-v-top')).toBe(true)

    app.unmount()
    host.remove()
  })
})
