<!-- Adapted from vue-bits Animations/Magnet (commit 07c0f76, MIT + Commons Clause).
     本地库：D:\work\AI\component library\vue-bits\src\content\Animations\Magnet\Magnet.vue
     改动：
       ① 接 useReducedMotion —— reduce 命中时不挂任何指针监听，元素恒定居中（零开销）
       ② 指针事件按 rAF 合帧 + getBoundingClientRect 带 250ms 缓存：上游在每个 pointermove 里
          同步读 rect，高频移动时是持续的强制布局（本组件在全站多处使用，必须收口）
       ③ transform 直写 DOM，不走 ref 响应式：每帧一次 setState 换成一次 style 写入
       ④ 滚动/缩放会移动元素，监听时把 rect 缓存置为过期，下一帧重新测量
       ⑤ 上游 API 全部保留（transition 字符串仍可覆盖），样式类名改为 fx-magnet* -->
<template>
  <div ref="rootRef" :class="['fx-magnet', { 'is-active': active }, wrapperClassName]" v-bind="$attrs">
    <div
      ref="innerRef"
      :class="['fx-magnet-inner', innerClassName]"
      :style="{ transition: active ? activeTransition : inactiveTransition }"
    >
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useReducedMotion } from './useReducedMotion'

interface Props {
  /** 触发半径外扩量（px） */
  padding?: number
  disabled?: boolean
  magnetStrength?: number
  activeTransition?: string
  inactiveTransition?: string
  wrapperClassName?: string
  innerClassName?: string
}

const props = withDefaults(defineProps<Props>(), {
  padding: 100,
  disabled: false,
  magnetStrength: 2,
  activeTransition: 'transform 0.3s cubic-bezier(0.25, 0.8, 0.3, 1)',
  inactiveTransition: 'transform 0.5s cubic-bezier(0.25, 0.8, 0.3, 1)',
  wrapperClassName: '',
  innerClassName: '',
})

defineOptions({ inheritAttrs: false })

const reduced = useReducedMotion()
const rootRef = useTemplateRef<HTMLDivElement>('rootRef')
const innerRef = useTemplateRef<HTMLDivElement>('innerRef')
const active = ref(false)

let rafId: number | null = null
let rect: DOMRect | null = null
let rectAt = 0
const pointer = { x: 0, y: 0 }

function measure(force = false) {
  const now = performance.now()
  if (!force && rect && now - rectAt < 250) return rect
  const el = rootRef.value
  rect = el ? el.getBoundingClientRect() : null
  rectAt = now
  return rect
}

function writeTransform(x: number, y: number) {
  const el = innerRef.value
  if (el) el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`
}

function frame() {
  rafId = null
  if (reduced.value || props.disabled) return
  const r = measure()
  if (!r) return

  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const dx = pointer.x - cx
  const dy = pointer.y - cy

  if (Math.abs(dx) < r.width / 2 + props.padding && Math.abs(dy) < r.height / 2 + props.padding) {
    active.value = true
    writeTransform(dx / props.magnetStrength, dy / props.magnetStrength)
  } else if (active.value) {
    active.value = false
    writeTransform(0, 0)
  }
}

function onPointerMove(e: PointerEvent) {
  if (reduced.value || props.disabled) return
  pointer.x = e.clientX
  pointer.y = e.clientY
  if (rafId === null) rafId = requestAnimationFrame(frame)
}

// 页面滚动/缩放会让元素位移，缓存立即失效，下一帧重新测量
function invalidate() {
  rect = null
}

function reset() {
  active.value = false
  writeTransform(0, 0)
}

onMounted(() => {
  if (reduced.value) return
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('scroll', invalidate, { passive: true, capture: true })
  window.addEventListener('resize', invalidate, { passive: true })
})

onUnmounted(() => {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('scroll', invalidate, { capture: true })
  window.removeEventListener('resize', invalidate)
})

// 运行中开启「减少动画」：清掉位移并停手；关闭时重新接线
watch(reduced, (isReduced) => {
  if (isReduced) {
    reset()
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('scroll', invalidate, { capture: true })
    window.removeEventListener('resize', invalidate)
    return
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('scroll', invalidate, { passive: true, capture: true })
  window.addEventListener('resize', invalidate, { passive: true })
})

defineExpose({ reset })
</script>

<style scoped>
.fx-magnet {
  position: relative;
  display: inline-block;
}
.fx-magnet-inner {
  display: inline-block;
}
.fx-magnet.is-active .fx-magnet-inner {
  /* 只在真正跟随指针时提升为合成层，静止时不占显存 */
  will-change: transform;
}
</style>
