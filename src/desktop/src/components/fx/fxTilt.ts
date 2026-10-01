/**
 * v-fx-tilt —— 卡片跟随光标的 3D 倾斜（TiltedCard 的那层"跟着动"）。
 *
 * 为什么做成独立指令而不是塞进 fx/SpotlightCard：
 *   ① SpotlightCard 是 vendored 的上游组件（改动会与上游偏离，且它内部已有 rAF 写 CSS 变量的
 *      逻辑，再插手容易打架）；② 倾斜对"任何卡片"都成立，做成指令后可自由挂在光斑卡、统计卡、
 *      数据卡上，也能单用。
 *
 * 实现要点：
 *   · 指针相对卡片中心的归一化偏移 (-0.5 ~ 0.5) → rotateY / rotateX，透视写在 transform 里
 *     （perspective(900px)），因此**不需要**父级配合，也不需要 transform-style；
 *   · 每帧 rAF 直写 transform（pointermove 频率高，走响应式会每事件重渲染）；
 *   · 卡片自身给 200ms 的 transform 过渡 ⇒ 跟随带一点柔和的滞后，松手/移开时平滑归位；
 *   · reduce-motion（应用内开关 ∪ 系统偏好）命中时不挂任何监听，也不设 transform；
 *   · **不写 will-change** —— 桌面端曾因永久图层提示（will-change + fill-mode）用一会儿黑屏。
 */
import { watch, type Directive } from 'vue'
import { useReducedMotion } from './useReducedMotion'

interface TiltEl extends HTMLElement {
  __fxTiltCleanup?: () => void
}

export const vFxTilt: Directive<TiltEl, number | undefined> = {
  mounted(el, binding) {
    const reduced = useReducedMotion()
    if (reduced.value) return

    // 参数即最大角度（deg）；默认 6° —— 再大就会"翻卡片"而不是"轻微立体"
    const max = typeof binding.value === 'number' ? binding.value : 6
    el.style.transition = 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)'

    let raf: number | null = null
    let nx = 0
    let ny = 0

    const apply = () => {
      raf = null
      el.style.transform = `perspective(900px) rotateY(${(nx * max).toFixed(2)}deg) rotateX(${(-ny * max).toFixed(2)}deg)`
    }

    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      nx = (e.clientX - rect.left) / rect.width - 0.5
      ny = (e.clientY - rect.top) / rect.height - 0.5
      if (raf === null) raf = requestAnimationFrame(apply)
    }

    const reset = () => {
      if (raf !== null) {
        cancelAnimationFrame(raf)
        raf = null
      }
      nx = 0
      ny = 0
      el.style.transform = ''
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', reset)
    el.addEventListener('pointercancel', reset)

    const stopWatch = watch(reduced, (isReduced) => {
      if (!isReduced) return
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', reset)
      el.removeEventListener('pointercancel', reset)
      el.style.transition = ''
      reset()
    })

    el.__fxTiltCleanup = () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', reset)
      el.removeEventListener('pointercancel', reset)
      stopWatch()
      el.style.transition = ''
      reset()
    }
  },

  unmounted(el) {
    el.__fxTiltCleanup?.()
    delete el.__fxTiltCleanup
  },
}
