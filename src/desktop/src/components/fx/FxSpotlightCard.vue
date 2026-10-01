<!-- Adapted from vue-bits Components/SpotlightCard (commit 07c0f76, MIT + Commons Clause).
     本地库：D:\work\AI\component library\vue-bits\src\content\Components\SpotlightCard\SpotlightCard.vue
     改动：
       ① 去掉上游写死的 `rounded-3xl border p-8` 落地页外观：容器外观完全由调用方 class 决定
          （上游若照搬，会把卡片自身的 border/padding 叠成双份）
       ② 接 useReducedMotion —— reduce 命中时不监听 pointermove，光斑固定为静态柔光
       ③ 光斑坐标与颜色走 CSS 变量 + rAF 合帧直写 DOM：pointermove 频率高，
          走 ref 响应式会每次事件触发一次组件重渲染，这里零重渲染
       ④ 光斑放在 z-index:-1 + isolation:isolate 的「自身 background 之上、内容之下」夹层，
          因此调用方不需要额外包一层内容容器，slot 子元素保持原 flex/block 布局
       ⑤ 颜色由调用方传入（DOM 侧可直接用 color-mix(var(--accent) …)） -->
<template>
  <div
    ref="rootRef"
    :class="['fx-spotlight', { 'is-on': active, 'is-static': reduced }, className]"
    :style="{ '--fx-spot-color': spotlightColor, '--fx-spot-r': `${radius}px` }"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
    @pointercancel="onPointerLeave"
  >
    <span ref="glowRef" class="fx-spotlight-glow" aria-hidden="true" />
    <slot />
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, useTemplateRef } from 'vue'
import { useReducedMotion } from './useReducedMotion'

interface Props {
  /** 光斑颜色，建议传带透明度的颜色（如 color-mix(in srgb, var(--accent) 14%, transparent)） */
  spotlightColor?: string
  /** 光斑半径（px） */
  radius?: number
  className?: string
}

withDefaults(defineProps<Props>(), {
  spotlightColor: 'color-mix(in srgb, var(--accent) 12%, transparent)',
  radius: 180,
  className: '',
})

const reduced = useReducedMotion()
const rootRef = useTemplateRef<HTMLDivElement>('rootRef')
const glowRef = useTemplateRef<HTMLSpanElement>('glowRef')
const active = ref(false)

let rafId: number | null = null
let px = 0
let py = 0

function apply() {
  rafId = null
  const el = glowRef.value
  if (!el) return
  el.style.setProperty('--fx-spot-x', `${px}px`)
  el.style.setProperty('--fx-spot-y', `${py}px`)
}

function onPointerMove(e: PointerEvent) {
  if (reduced.value) return
  const root = rootRef.value
  if (!root) return

  const rect = root.getBoundingClientRect()
  if (!rect.width || !rect.height) return

  px = e.clientX - rect.left
  py = e.clientY - rect.top
  if (!active.value) active.value = true
  // rAF 合帧：指针事件可能高于刷新率，直写 DOM 但每帧最多一次
  if (rafId === null) rafId = requestAnimationFrame(apply)
}

function onPointerLeave() {
  active.value = false
}

onUnmounted(() => {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
})
</script>

<style scoped>
.fx-spotlight {
  position: relative;
  /* isolate：把 z-index:-1 的光斑关在本组件内 —— 它叠在自身 background 之上、
     内容之下；不 isolate 的话负 z-index 会逃到祖先层叠上下文背后而完全不可见 */
  isolation: isolate;
  overflow: hidden;
}
.fx-spotlight-glow {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  opacity: 0;
  transition: opacity 260ms var(--ease, cubic-bezier(0.25, 0.8, 0.3, 1)); /* --ease 只在 clearline 主题里定义，必须带兜底 */
  background: radial-gradient(
    circle var(--fx-spot-r, 180px) at var(--fx-spot-x, 50%) var(--fx-spot-y, 30%),
    var(--fx-spot-color, transparent),
    transparent 72%
  );
}
.fx-spotlight.is-on .fx-spotlight-glow {
  opacity: 1;
}
/* 减少动画：不跟随指针，保留一处静态柔光作为层次提示 */
.fx-spotlight.is-static .fx-spotlight-glow {
  opacity: 0.45;
  transition: none;
}
</style>
