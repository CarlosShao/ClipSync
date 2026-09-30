<!-- Adapted from vue-bits Animations/ClickSpark (commit 07c0f76, MIT + Commons Clause).
     本地库：D:\work\AI\component library\vue-bits\src\content\Animations\ClickSpark\ClickSpark.vue
     改动：
       ① 接 useReducedMotion —— reduce 命中时不建 canvas、不挂 ResizeObserver，只渲染 slot（零开销）
       ② canvas 按 devicePixelRatio 缩放（上限 2x）：上游按 CSS 像素 1:1 建 canvas，高分屏上粒子发虚
       ③ rAF 按需启停：上游在 onMounted 后永久空转（每帧 clearRect），这里只在存在活跃粒子时跑帧
       ④ 容器尺寸交由调用方 class 决定，不再写死 w-full/h-full，方便直接当页面根元素用
       ⑤ 颜色由调用方传入 rgba（DOM 侧可传 color-mix，canvas 内解析不了 var()） -->
<template>
  <div ref="containerRef" :class="['fx-click-spark', className]" @click="handleClick">
    <canvas v-if="!reduced" ref="canvasRef" class="fx-click-spark-canvas" />
    <slot />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, useTemplateRef, watch } from 'vue'
import { useReducedMotion } from './useReducedMotion'

interface Spark {
  x: number
  y: number
  angle: number
  startTime: number
}

interface Props {
  sparkColor?: string
  sparkSize?: number
  sparkRadius?: number
  sparkCount?: number
  duration?: number
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'
  extraScale?: number
  className?: string
}

const props = withDefaults(defineProps<Props>(), {
  sparkColor: 'rgba(140, 140, 140, 0.85)',
  sparkSize: 8,
  sparkRadius: 16,
  sparkCount: 8,
  duration: 420,
  easing: 'ease-out',
  extraScale: 1,
  className: '',
})

const reduced = useReducedMotion()
const containerRef = useTemplateRef<HTMLDivElement>('containerRef')
const canvasRef = useTemplateRef<HTMLCanvasElement>('canvasRef')

let sparks: Spark[] = []
let animationId: number | null = null
let resizeObserver: ResizeObserver | null = null
let ctx: CanvasRenderingContext2D | null = null
let dpr = 1

function ease(t: number): number {
  switch (props.easing) {
    case 'linear':
      return t
    case 'ease-in':
      return t * t
    case 'ease-in-out':
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    default:
      return t * (2 - t)
  }
}

function resizeCanvas() {
  const canvas = canvasRef.value
  const wrap = containerRef.value
  if (!canvas || !wrap) return

  const rect = wrap.getBoundingClientRect()
  if (!rect.width || !rect.height) return

  const nextDpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.round(rect.width * nextDpr)
  const h = Math.round(rect.height * nextDpr)
  dpr = nextDpr
  if (canvas.width === w && canvas.height === h) return

  canvas.width = w
  canvas.height = h
  canvas.style.width = `${rect.width}px`
  canvas.style.height = `${rect.height}px`
}

function draw(timestamp: number) {
  const canvas = canvasRef.value
  if (!canvas || !ctx) {
    animationId = null
    return
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.lineCap = 'round'
  ctx.lineWidth = 1.6
  ctx.strokeStyle = props.sparkColor

  sparks = sparks.filter((spark) => {
    const elapsed = timestamp - spark.startTime
    if (elapsed >= props.duration) return false

    const eased = ease(Math.max(0, elapsed / props.duration))
    const distance = eased * props.sparkRadius * props.extraScale
    const lineLength = props.sparkSize * (1 - eased)

    const cos = Math.cos(spark.angle)
    const sin = Math.sin(spark.angle)
    const c = ctx as CanvasRenderingContext2D
    c.beginPath()
    c.moveTo(spark.x + distance * cos, spark.y + distance * sin)
    c.lineTo(spark.x + (distance + lineLength) * cos, spark.y + (distance + lineLength) * sin)
    c.stroke()
    return true
  })

  // 无活跃粒子即停帧：上游版本会永远空转，页面常驻时白白吃一帧回调
  animationId = sparks.length ? requestAnimationFrame(draw) : null
}

function handleClick(e: MouseEvent) {
  if (reduced.value) return
  const canvas = canvasRef.value
  if (!canvas) return

  const rect = canvas.getBoundingClientRect()
  if (!rect.width || !rect.height) return

  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const now = performance.now()
  for (let i = 0; i < props.sparkCount; i++) {
    sparks.push({ x, y, angle: (2 * Math.PI * i) / props.sparkCount, startTime: now })
  }
  if (animationId === null) animationId = requestAnimationFrame(draw)
}

function start() {
  if (reduced.value) return
  resizeCanvas()
  ctx = canvasRef.value?.getContext('2d') ?? null
  if (containerRef.value && !resizeObserver) {
    resizeObserver = new ResizeObserver(() => resizeCanvas())
    resizeObserver.observe(containerRef.value)
  }
}

function stop() {
  if (animationId !== null) {
    cancelAnimationFrame(animationId)
    animationId = null
  }
  sparks = []
  const canvas = canvasRef.value
  if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
}

onMounted(start)

// 运行中切换「减少动画」：立刻停帧并丢弃在飞粒子。
// flush: 'post' 确保 canvas 已按 v-if 结果挂载/卸载后再取 context。
watch(
  reduced,
  (isReduced) => {
    if (isReduced) stop()
    start()
  },
  { flush: 'post' },
)

onUnmounted(() => {
  stop()
  resizeObserver?.disconnect()
  resizeObserver = null
  ctx = null
})
</script>

<style scoped>
.fx-click-spark {
  position: relative;
  width: 100%;
  height: 100%;
  /* 作为 flex 子项时允许收缩：本组件常被用作整页外包装，父级可能还有横幅等同级兄弟 */
  min-height: 0;
}
.fx-click-spark-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  /* = --z-sticky + 1：盖过列表行与 sticky 表头，但不盖下拉/弹层（--z-dropdown=50） */
  z-index: 11;
}
</style>
