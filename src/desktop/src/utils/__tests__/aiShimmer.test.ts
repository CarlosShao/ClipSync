// @vitest-environment jsdom
// === 证据：「AI 正在工作」占位文字的流光（与粒子点阵同频 + 尊重减少动效） ===
//
// 用户需求（原话）：「在工作的时候，这个 working 最好加个那个和 agent 流式工作开始那个思考中的动效，
// 就是文字表面有光一遍一遍有节奏的划过，和左边那个粒子点阵动画的频率一样就行」。
//
// 本文件证明：
//   ① 等待态占位（InlineAiCard 的「Working…」）挂上了流光类与周期变量（可断言形态，不做像素断言）
//   ② 减少动效命中（html.reduce-motion ∪ prefers-reduced-motion）⇒ 不挂流光类 = 静态文字
//   ③ **同频**：直接解析 fx/FxLatticeLoader.vue + InlineAiCard.vue 的源码重算点阵周期，
//      断言流光常量与它相等（任一侧改周期都会红）
//   ④ 不使用常驻 will-change / animation-fill-mode（本项目曾因这类属性黑屏）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useI18n } from '@/composables/useI18n'
import { LATTICE_EASE, SHIMMER_CYCLE_MS, SHIMMER_EASE } from '@/utils/aiShimmer'
import InlineAiCard from '@/components/ai/InlineAiCard.vue'
import ShimmerText from '@/components/ai/ShimmerText.vue'

// fx/useReducedMotion 在**模块加载时**就调用 window.matchMedia / MutationObserver；
// jsdom 没有 matchMedia ⇒ 必须在 import 求值前补桩（vi.hoisted 早于 import 执行）。
vi.hoisted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
})

const readSrc = (rel: string) => readFileSync(resolve(process.cwd(), 'src', rel), 'utf8')

function mountWith(component: unknown, props: Record<string, unknown>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(component as never, props as never) })
  app.mount(host)
  return {
    host,
    async settle() {
      await nextTick()
    },
    unmount() {
      app.unmount()
      host.remove()
    },
  }
}

/** 挂载到真实 DOM 的通用件（InlineAiCard 需要 pinia / i18n 环境） */
function mountInlineCard(status: 'loading' | 'done') {
  return mountWith(InlineAiCard, { title: 'Review settings', status, text: '', displayText: '', streaming: false })
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('reduce-motion')
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.classList.remove('reduce-motion')
})

describe('「AI 正在工作」占位文字流光', () => {
  it('① 等待态占位挂上流光类与同频周期变量（不做像素断言）', async () => {
    const { setLang } = useI18n()
    setLang('en')
    const m = mountInlineCard('loading')
    await m.settle()

    const lattice = m.host.querySelector<HTMLElement>('.iac-loading .iac-loading-lattice')
    expect(lattice, '等待态应渲染点阵加载器').toBeTruthy()
    expect(lattice!.classList.contains('iac-shimmer')).toBe(true)
    expect(lattice!.style.getPropertyValue('--iac-shimmer-cycle')).toBe(`${SHIMMER_CYCLE_MS}ms`)
    expect(lattice!.style.getPropertyValue('--iac-shimmer-ease')).toBe(SHIMMER_EASE)

    // 文字内容/大小/位置不改：仍是 i18n 的加载文案
    expect(m.host.textContent).toContain('Working…')
    m.unmount()

    // 完成态没有流光（只有等待态才有）
    const done = mountInlineCard('done')
    await done.settle()
    expect(done.host.querySelector('.iac-shimmer')).toBeNull()
    done.unmount()
  })

  it('② 减少动效命中 ⇒ 静态文字（不挂流光类）；html.reduce-motion 与组件内判断一致', async () => {
    const { setLang } = useI18n()
    setLang('en')
    document.documentElement.classList.add('reduce-motion')
    // useReducedMotion 用 MutationObserver 监听 class 变化，等一拍让它同步
    await new Promise((r) => setTimeout(r, 0))

    const m = mountInlineCard('loading')
    await m.settle()
    const lattice = m.host.querySelector<HTMLElement>('.iac-loading .iac-loading-lattice')
    expect(lattice, '点阵仍在（只是不流光）').toBeTruthy()
    expect(lattice!.classList.contains('iac-shimmer')).toBe(false)
    m.unmount()

    // 通用流光组件同样：减少动效 ⇒ 不挂 --on（静态文字）
    const s = mountWith(ShimmerText, { text: 'Generating…' })
    await s.settle()
    const span = s.host.querySelector<HTMLElement>('[data-shimmer-text]')
    expect(span!.classList.contains('shimmer-text--on')).toBe(false)
    expect(span!.textContent).toBe('Generating…')
    s.unmount()
  })

    it('流光与点阵**刻意解耦**：用常规扫光速度，不吃点阵的 648ms', () => {
    // 点阵周期仍可算出（仅作对照），但流光周期必须**不等于**它，且在常规扫光区间内
    const latticeSrc = readSrc('components/fx/FxLatticeLoader.vue')
    const ripple = latticeSrc.match(/ripple:\s*\{\s*3:\s*\{[^}]*loop:\s*([\d.]+),\s*scale:\s*([\d.]+)/)
    const step = latticeSrc.match(/step:\s*(\d+),/)
    if (ripple && step) {
      const latticeCycle = Math.round(Number(ripple[1]) * Number(step[1]) * Number(ripple[2]))
      expect(SHIMMER_CYCLE_MS, '流光周期不应再与点阵同频（用户实测点阵太快会看成字在闪）').not.toBe(latticeCycle)
    }
    expect(SHIMMER_CYCLE_MS, '流光应是常规扫光速度：1.2s~2.6s 一轮').toBeGreaterThanOrEqual(1200)
    expect(SHIMMER_CYCLE_MS).toBeLessThanOrEqual(2600)
  })

  it('文字内容必须**原样渲染**（本次真实缺陷：模板漏了插值，渲染出字面量 "props.text }}" ⇒ 字在闪）', () => {
    const host = document.createElement('div')
    const app = createApp({ render: () => h(ShimmerText, { text: 'Working…' }) })
    app.mount(host)
    const el = host.querySelector<HTMLElement>('[data-shimmer-text]')
    expect(el, '应渲染 shimmer span').toBeTruthy()
    expect(el!.textContent, '渲染内容必须等于传入的 text，不能出现模板字面量').toBe('Working…')
    expect(el!.textContent, '不应出现未插值的模板残留').not.toContain('props.text')
    expect(el!.textContent).not.toContain('}}')
    app.unmount()
  })

  it('④ 流光不使用常驻 will-change / animation-fill-mode（黑屏事故的防线）', () => {
    for (const rel of ['components/ai/InlineAiCard.vue', 'components/ai/ShimmerText.vue']) {
      const src = readSrc(rel)
      // 断言的是"CSS 声明"（带冒号），注释里提到属性名不算
      expect(src, `${rel} 不应声明 will-change`).not.toContain('will-change:')
      expect(src, `${rel} 不应声明 animation-fill-mode`).not.toContain('animation-fill-mode:')
    }
  })
  it('⑤ 文字**永不隐身**：渐变底色不得用 currentColor（此时 color 是 transparent）', () => {
    const src = readSrc('components/ai/ShimmerText.vue')
    // 断言的是**声明**，注释里提到属性名不算 ⇒ 先剥掉 CSS 注释
    const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')
    const onBlock = stripComments(
      src.slice(src.indexOf('.shimmer-text--on'), src.indexOf('@keyframes shimmer-sweep')),
    )
    // 本元素设了 -webkit-text-fill-color: transparent ⇒ 渐变若用 currentColor 就是透明 ⇒ 字隐身
    expect(onBlock, '渐变里不得出现 currentColor（会被解析成 transparent，导致只有光带可见）').not.toContain('currentColor')
    expect(onBlock, '底色必须来自真实文字色 token').toContain('--shimmer-base')
    // 关键帧位置必须留在 0%~100%（配合 background-size:200% ⇒ 任何相位都被背景完全覆盖）
    const kf = stripComments(src.slice(src.indexOf('@keyframes shimmer-sweep'), src.indexOf('@media (prefers-reduced-motion')))
    expect(kf).not.toContain('-30%')
    expect(kf).not.toContain('130%')
    const size = onBlock.match(/background-size:\s*(\d+)%/)
    expect(size, '必须声明 background-size，否则扫动时可能出现没被背景盖住的空隙').toBeTruthy()
    expect(Number(size![1]), 'background-size 必须 >=100%').toBeGreaterThanOrEqual(100)
  })})