// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp, h } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SHIMMER_CYCLE_MS, SHIMMER_EASE } from '@/utils/aiShimmer'
import ShimmerText from '@/components/ai/ShimmerText.vue'

/**
 * 「AI 正在工作」占位文字的流光 —— 回归测试。
 *
 * 这个特性连续踩了三个坑，这里逐条钉住（都是用户实测出来的）：
 *   ① 模板漏插值 ⇒ 渲染出字面量 props.text }}，配合渐变着色看起来像"字在闪"；
 *   ② 渐变底色用 currentColor ⇒ 此时它解析为 transparent ⇒ 只有光带可见、其余字全隐身；
 *   ③ 只用一层半透明覆盖层 ⇒ 文字安全了，但光变成了"文字外面的一个方块"。
 * 最终方案是**两层**：底层文字（正常颜色、永远可见）+ 上层同一份文字（裁到字形，只承载光带）。
 */

const SRC_ROOT = resolve(__dirname, '../../')
const readSrc = (rel: string) => readFileSync(resolve(SRC_ROOT, rel), 'utf8')
const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')

function mountShimmer(text = 'Working…') {
  const host = document.createElement('div')
  const app = createApp({ render: () => h(ShimmerText, { text }) })
  app.mount(host)
  return { host, app }
}

// jsdom 没有 matchMedia：useReducedMotion 依赖它（系统偏好通道）
if (!('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

beforeEach(() => {
  document.documentElement.classList.remove('reduce-motion')
})

describe('「AI 正在工作」占位文字流光', () => {
  it('① 两层结构：底层文字永远在，上层只承载光带（并带周期变量）', () => {
    const { host, app } = mountShimmer()
    const root = host.querySelector<HTMLElement>('[data-shimmer-text]')
    expect(root, '应渲染 ShimmerText').toBeTruthy()
    expect(root!.style.getPropertyValue('--shimmer-cycle')).toBe(`${SHIMMER_CYCLE_MS}ms`)
    expect(root!.style.getPropertyValue('--shimmer-ease')).toBe(SHIMMER_EASE)
    expect(root!.querySelector('.shimmer-text__base'), '必须有底层文字层').toBeTruthy()
    const sheen = root!.querySelector('.shimmer-text__sheen')
    expect(sheen, '必须有裁到字形的柔光层').toBeTruthy()
    expect(sheen!.getAttribute('aria-hidden'), '装饰层必须对辅助技术隐藏').toBe('true')
    app.unmount()
  })

  it('② 文字内容原样渲染（底层不得出现模板残留）', () => {
    const { host, app } = mountShimmer()
    const base = host.querySelector<HTMLElement>('.shimmer-text__base')
    expect(base, '应渲染底层文字').toBeTruthy()
    expect(base!.textContent).toBe('Working…')
    expect(base!.textContent).not.toContain('props.text')
    expect(base!.textContent).not.toContain('}}')
    app.unmount()
  })

  it('③ 减少动效（应用内开关）⇒ 不渲染柔光层，只剩静态文字', () => {
    document.documentElement.classList.add('reduce-motion')
    const { host, app } = mountShimmer()
    expect(host.querySelector('.shimmer-text__base'), '静态态仍要有文字').toBeTruthy()
    expect(host.querySelector('.shimmer-text__sheen'), '减少动效时不应有柔光层').toBeNull()
    app.unmount()
  })

  it('④ 危险技术只允许出现在装饰层：底层文字不得透明；InlineAiCard 一律不得使用', () => {
    const card = stripCss(readSrc('components/ai/InlineAiCard.vue'))
    expect(card, 'InlineAiCard 不得使用 -webkit-text-fill-color: transparent').not.toMatch(
      /-webkit-text-fill-color:\s*transparent/,
    )
    expect(card, 'InlineAiCard 不得自行使用 background-clip: text').not.toMatch(/background-clip:\s*text/)
    const st = stripCss(readSrc('components/ai/ShimmerText.vue'))
    const baseBlock = st.slice(st.indexOf('.shimmer-text__base'), st.indexOf('.shimmer-text__sheen'))
    expect(baseBlock, '底层文字不得声明 text-fill-color: transparent').not.toMatch(
      /-webkit-text-fill-color:\s*transparent/,
    )
    expect(st, '底层文字必须显式给出颜色').toContain('color: var(--text-secondary)')
  })

  it('⑤ 流光节奏：常规扫光速度，且与点阵刻意解耦', () => {
    const lattice = stripCss(readSrc('components/fx/FxLatticeLoader.vue'))
    const ripple = lattice.match(/ripple:\s*\{\s*3:\s*\{[^}]*loop:\s*([\d.]+),\s*scale:\s*([\d.]+)/)
    const step = lattice.match(/step:\s*(\d+),/)
    if (ripple && step) {
      const cycle = Math.round(Number(ripple[1]) * Number(step[1]) * Number(ripple[2]))
      expect(SHIMMER_CYCLE_MS, '流光不应再与点阵同频').not.toBe(cycle)
    }
    expect(SHIMMER_CYCLE_MS).toBeGreaterThanOrEqual(1200)
    expect(SHIMMER_CYCLE_MS).toBeLessThanOrEqual(2600)
  })

  it('⑥ 不使用常驻 will-change / animation-fill-mode（黑屏事故的防线）', () => {
    for (const rel of ['components/ai/ShimmerText.vue', 'components/ai/InlineAiCard.vue']) {
      const src = stripCss(readSrc(rel))
      expect(src, rel + ' 不应声明 will-change').not.toContain('will-change:')
      expect(src, rel + ' 不应声明 animation-fill-mode').not.toContain('animation-fill-mode:')
    }
  })
})
