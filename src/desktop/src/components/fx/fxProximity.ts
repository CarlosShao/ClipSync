/**
 * v-fx-proximity —— 光标邻近位移（「Line Sidebar」内核）。
 *
 * 来源：vue-bits Components/LineSidebar
 *   本地库：D:\work\AI\component library\vue-bits\src\content\Components\LineSidebar\LineSidebar.vue
 *   内核（上游 FxLineSidebar 的 handlePointerMove / runFrame）：
 *     每个条目按  |指针 Y − 条目中心 Y|  求距离，落在 proximityRadius 内得
 *     target = falloff(1 − distance / radius) ∈ [0,1]（falloff: linear / smooth p²(3−2p) / sharp p³），
 *     再由一条 rAF 指数平滑循环（k = 1 − exp(−dt / tau)，tau = smoothing/1000）逐帧把
 *     平滑后的 --effect 写回元素，CSS 侧用它驱动位移与刻度缩放。
 *
 * 为什么不是直接搬那个组件：上游只接受 `items: string[]`（纯文本、无 slot），而 AI 侧栏的会话行是
 * 富内容（标题 + 时间 + 置顶/更多按钮 + 选中态）——替换会丢功能。因此只取邻近位移内核做成指令，
 * 作用在现有行上：行内容和交互完全不动。
 *
 * 本地化调整：
 *   ① 位移幅度由调用方 CSS 决定（这里只写 --fx-prox），AI 侧栏用 6px 而非上游 30px ——
 *      侧栏很窄，30px 会顶到文字换行
 *   ② reduce-motion 走 fx/useReducedMotion 双通道：命中则不挂任何监听；中途打开开关时
 *      立刻拆监听 + 取消 rAF + 清掉每个元素的变量，避免"关了开关还在动"
 *   ③ 只监听 pointermove/pointerleave，不碰键盘与点击
 */
import { watch, type Directive } from 'vue'
import { useReducedMotion } from './useReducedMotion'

interface ProximityOptions {
  /** 参与位移的子元素选择器，默认取容器的直接子元素 */
  selector?: string
  /** 邻近半径（px），上游默认 100 */
  radius?: number
  /** 平滑时间常数（ms），上游默认 100 */
  smoothing?: number
}

interface ProxEl extends HTMLElement {
  __fxProxCleanup?: () => void
}

/** smooth falloff（上游 falloff='smooth'）：p²(3−2p) */
const smoothFalloff = (p: number) => p * p * (3 - 2 * p)

export const vFxProximity: Directive<ProxEl, ProximityOptions | undefined> = {
  mounted(el, binding) {
    const reduced = useReducedMotion()
    if (reduced.value) return

    const selector = binding.value?.selector
    const radius = binding.value?.radius ?? 100
    const tau = Math.max(binding.value?.smoothing ?? 100, 1) / 1000

    const itemsOf = (): HTMLElement[] =>
      (selector ? Array.from(el.querySelectorAll<HTMLElement>(selector)) : Array.from(el.children)) as HTMLElement[]

    const current = new Map<HTMLElement, number>()
    const targets = new Map<HTMLElement, number>()
    let raf: number | null = null
    let last = 0

    const runFrame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      const k = 1 - Math.exp(-dt / tau)
      let moving = false
      for (const item of itemsOf()) {
        const target = targets.get(item) ?? 0
        const cur = current.get(item) ?? 0
        const next = cur + (target - cur) * k
        const settled = Math.abs(target - next) < 0.0015
        const value = settled ? target : next
        current.set(item, value)
        item.style.setProperty('--fx-prox', value.toFixed(4))
        if (!settled) moving = true
      }
      raf = moving ? requestAnimationFrame(runFrame) : null
    }

    const startLoop = () => {
      if (raf != null) return
      last = performance.now()
      raf = requestAnimationFrame(runFrame)
    }

    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      const pointerY = e.clientY - rect.top
      for (const item of itemsOf()) {
        const center = item.offsetTop + item.offsetHeight / 2
        const distance = Math.abs(pointerY - center)
        targets.set(item, smoothFalloff(Math.max(0, 1 - distance / radius)))
      }
      startLoop()
    }

    const onLeave = () => {
      for (const item of itemsOf()) targets.set(item, 0)
      startLoop()
    }

    const clearAll = () => {
      if (raf != null) {
        cancelAnimationFrame(raf)
        raf = null
      }
      for (const item of itemsOf()) {
        item.style.removeProperty('--fx-prox')
        current.delete(item)
        targets.delete(item)
      }
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)

    // 中途打开「减少动效」→ 立刻停手（只读一次的话开关打开后侧栏还会继续晃）
    const stopWatch = watch(reduced, (isReduced) => {
      if (!isReduced) return
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      clearAll()
    })

    el.__fxProxCleanup = () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      stopWatch()
      clearAll()
    }
  },

  unmounted(el) {
    el.__fxProxCleanup?.()
    delete el.__fxProxCleanup
  },
}
