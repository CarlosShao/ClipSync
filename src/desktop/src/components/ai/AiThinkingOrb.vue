<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { ThinkingOrb, type ThinkingOrbState } from './orbs-js/thinking-orb.js'

/**
 * AiThinkingOrb — ThinkingOrb 的 Vue 封装（一比一移植 orbs.jakubantalik.com）
 * 9 种状态：working/searching/solving/listening/connecting/weaving/composing/breathing/shaping
 *
 * 用法：
 *   <AiThinkingOrb state="composing" :size="38" />
 *   - state 变化时自动 setState（不重建 canvas）
 *   - 监听主题变化自动 setTheme（dark 白粒子 / light 黑粒子）
 *   - 组件卸载自动 destroy（清理 RAF + IntersectionObserver）
 */

const props = withDefaults(
  defineProps<{
    state?: ThinkingOrbState
    size?: number
    speed?: number
    paused?: boolean
  }>(),
  {
    state: 'working',
    size: 64,
    speed: 1,
    paused: false,
  },
)

const cv = ref<HTMLCanvasElement | null>(null)
let orb: ThinkingOrb | null = null

function detectDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

onMounted(() => {
  if (!cv.value) return
  orb = new ThinkingOrb(cv.value, {
    state: props.state,
    size: props.size,
    speed: props.speed,
    paused: props.paused,
  })
})

watch(
() => props.state,
(s) => {
  orb?.setState(s)
},
)

watch(
  () => props.size,
  (s) => {
    // size 变化需要重建（canvas 尺寸 + 配置档）
    if (!cv.value) return
    orb?.destroy()
    orb = new ThinkingOrb(cv.value, {
      state: props.state,
      size: s,
      speed: props.speed,
      paused: props.paused,
    })
  },
)

// 主题联动：dark → 白粒子，light → 黑粒子
const themeMq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
if (themeMq) {
  themeMq.addEventListener('change', (e) => {
    orb?.setTheme(e.matches)
  })
}

onBeforeUnmount(() => {
  orb?.destroy()
  orb = null
})
</script>

<template>
  <canvas
    ref="cv"
    :width="size"
    :height="size"
    :style="{ width: size + 'px', height: size + 'px' }"
  />
</template>
