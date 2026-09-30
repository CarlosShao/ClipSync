<!-- Adapted from vue-bits Micro/LatticeLoader (commit 07c0f76, MIT + Commons Clause).
     本地库：D:\work\AI\component library\vue-bits\src\content\Micro\LatticeLoader\LatticeLoader.vue
     改动：
       ① 接 useReducedMotion —— reduce 命中时：晶格静止为「全亮态」字形（不靠 `html.reduce-motion *`
          那条 animation-duration:0.01ms 兜底，否则所有格子会停在 idle 关键帧 = 全暗、看不出在加载），
          并且不再启动/继续计时器（跳动的数字同样属于动效）
       ② 关键帧与类名由 ll-*/lattice-* 改为 fxl-*/fxl-*，避免全局注入时与其它组件撞名
       ③ `@media (prefers-reduced-motion: reduce)` 块保留上游行为（慢速呼吸） -->
<template>
  <span
    role="status"
    class="fxl-root group relative inline-flex items-center leading-none [font-family:inherit] [gap:calc(var(--fxl-font)*0.625)] [font-size:var(--fxl-font)]"
    :class="[className, { 'is-static': reduced }]"
    :data-status="status"
    :data-shape="shape"
    :data-glow="glow ? '' : undefined"
    :style="rootStyle"
  >
    <span class="grid shrink-0" aria-hidden="true">
      <span
        class="fxl-run [grid-area:1/1] grid [grid-template-columns:repeat(var(--fxl-n),var(--fxl-cell))] [gap:var(--fxl-gap)] [transition:opacity_200ms_ease] group-data-[status=done]:opacity-0 group-data-[status=error]:opacity-0 group-data-[status=done]:[&>span]:[animation-play-state:paused] group-data-[status=error]:[&>span]:[animation-play-state:paused]"
      >
        <span
          v-for="(unit, i) in pat.cells"
          :key="i"
          :class="cellClass(unit)"
          :data-hole="unit == null ? '' : undefined"
          :style="unit == null ? undefined : { animationDelay: `${Math.round(unit * d)}ms` }"
        />
      </span>
      <span
        class="fxl-mark [grid-area:1/1] grid [grid-template-columns:repeat(var(--fxl-n),var(--fxl-cell))] [gap:var(--fxl-gap)] origin-center opacity-0 [transform:scale(0.9)] [transition:opacity_160ms_var(--fxl-ease-out),transform_160ms_var(--fxl-ease-out)] group-data-[status=done]:opacity-100 group-data-[status=done]:[transform:none] group-data-[status=error]:opacity-100 group-data-[status=error]:[transform:none]"
      >
        <span
          v-for="(_, i) in pat.cells"
          :key="i"
          :class="[CELL, MARK_CELL_CLASS]"
          :data-on="marks[mark].includes(i) ? '' : undefined"
        />
      </span>
    </span>
    <span class="relative inline-block font-medium" aria-hidden="true">
      <span :class="TEXT_CLASS" :data-active="status === 'working' ? '' : undefined">{{ label }}</span>
      <span :class="TEXT_CLASS" :data-active="status === 'done' ? '' : undefined">{{ doneLabel }}</span>
      <span :class="TEXT_CLASS" :data-active="status === 'error' ? '' : undefined">{{ errorLabel }}</span>
    </span>
    <span
      v-if="showTimer && !reduced"
      ref="timerRef"
      class="opacity-60 font-mono tabular-nums [font-size:calc(var(--fxl-font)*0.875)]"
      aria-hidden="true"
    >
      0.0s
    </span>
    <span class="sr-only">{{ announce }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type CSSProperties } from 'vue'
import { useReducedMotion } from './useReducedMotion'

export type FxLatticeStatus = 'working' | 'done' | 'error'
export type FxLatticePatternName =
  'arrow' | 'dots' | 'orbit' | 'ripple' | 'snake' | 'spiral' | 'sweep' | 'spin' | 'rain' | 'pulse'
export type FxLatticeGrid = 3 | 4

export interface FxLatticePattern {
  cells: (number | null)[]
  loop?: number
  scale?: number
  lit?: 0.25 | 0.35 | 0.45 | 0.62
}

interface Props {
  label?: string
  doneLabel?: string
  errorLabel?: string
  /** 屏幕阅读器播报词。不传则用上游拼装（`label, in progress` / `done in x.x seconds`）——
      中文界面请显式传入本地化文案，避免 a11y 树里冒出英文尾巴 */
  announce?: string
  status?: FxLatticeStatus
  pattern?: FxLatticePatternName | FxLatticePattern
  grid?: FxLatticeGrid
  shape?: 'square' | 'round'
  color?: string
  doneColor?: string
  errorColor?: string
  cellSize?: number
  gap?: number
  fontSize?: number
  step?: number
  idleOpacity?: number
  glow?: boolean
  glowColor?: string
  showTimer?: boolean
  elapsed?: number
  className?: string
}

type ResolvedPattern = { cells: (number | null)[]; loop: number; scale: number; lit?: number }

const PATTERNS: Record<FxLatticePatternName, Partial<Record<FxLatticeGrid, ResolvedPattern>>> = {
  arrow: { 3: { cells: [1, 2, 3, 0, 1, 2, 1, 2, 3], loop: 7.2, scale: 1 } },
  dots: { 3: { cells: [0, 1, 2, 0, 1, 2, 0, 1, 2], loop: 3, scale: 2.4 } },
  ripple: { 3: { cells: [2, 1, 2, 1, 0, 1, 2, 1, 2], loop: 4.8, scale: 1.5 } },
  spiral: { 3: { cells: [0, 1, 2, 7, 8, 3, 6, 5, 4], loop: 9, scale: 1.2, lit: 0.35 } },
  orbit: {
    3: { cells: [0, 1, 2, 7, null, 3, 6, 5, 4], loop: 8, scale: 1.2 },
    4: { cells: [0, 1, 2, 3, 11, null, null, 4, 10, null, null, 5, 9, 8, 7, 6], loop: 6, scale: 1.2, lit: 0.45 },
  },
  snake: {
    3: { cells: [0, 1, 2, 5, 4, 3, 6, 7, 8], loop: 9, scale: 1, lit: 0.35 },
    4: { cells: [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11, 15, 14, 13, 12], loop: 16, scale: 1, lit: 0.25 },
  },
  sweep: { 4: { cells: [0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 5, 3, 4, 5, 6], loop: 5, scale: 1, lit: 0.45 } },
  spin: { 4: { cells: [0, 0, 1, 1, 0, 0, 1, 1, 3, 3, 2, 2, 3, 3, 2, 2], loop: 4, scale: 1.6, lit: 0.35 } },
  rain: { 4: { cells: [0, 2, 1, 3, 1, 3, 2, 4, 2, 4, 3, 5, 3, 5, 4, 6], loop: 4, scale: 1.2, lit: 0.35 } },
  pulse: { 4: { cells: [2, 1, 1, 2, 1, 0, 0, 1, 1, 0, 0, 1, 2, 1, 1, 2], loop: 2.4, scale: 2.5, lit: 0.45 } },
}
const DEFAULT_PATTERN: Record<FxLatticeGrid, FxLatticePatternName> = { 3: 'orbit', 4: 'sweep' }
const MARKS: Record<FxLatticeGrid, Record<'done' | 'error', number[]>> = {
  3: { done: [2, 3, 5, 7], error: [0, 2, 4, 6, 8] },
  4: { done: [7, 8, 10, 13], error: [0, 3, 5, 6, 9, 10, 12, 15] },
}

const resolvePattern = (pattern: FxLatticePatternName | FxLatticePattern, grid: FxLatticeGrid): ResolvedPattern => {
  if (typeof pattern === 'string') {
    const named = PATTERNS[pattern]
    return (named && named[grid]) || (PATTERNS[DEFAULT_PATTERN[grid]][grid] as ResolvedPattern)
  }
  const cells = Array.from({ length: grid * grid }, (_, i) => pattern.cells[i] ?? null)
  const max = Math.max(0, ...cells.filter((v): v is number => v != null))
  return { cells, loop: pattern.loop ?? max + 4.2, scale: pattern.scale ?? 1, lit: pattern.lit ?? 0.62 }
}

const CELL =
  'h-[var(--fxl-cell)] w-[var(--fxl-cell)] [border-radius:max(1px,calc(var(--fxl-cell)*0.25))] [background:var(--fxl-color)] group-data-[shape=round]:rounded-full'
const HOLE_CLASS = `${CELL} [opacity:calc(var(--fxl-idle)*0.47)]`
const LIT: Record<number, string> = {
  62: 'animate-[fxl-on_var(--fxl-cycle)_infinite]',
  45: 'animate-[fxl-on-45_var(--fxl-cycle)_infinite]',
  35: 'animate-[fxl-on-35_var(--fxl-cycle)_infinite]',
  25: 'animate-[fxl-on-25_var(--fxl-cycle)_infinite]',
}
const LIT_CLASS =
  '[opacity:var(--fxl-idle)] [animation-timing-function:var(--fxl-ease-in-out)] group-data-[glow]:[box-shadow:0_0_calc(var(--fxl-cell)*1.2)_calc(var(--fxl-cell)*0.12)_var(--fxl-glow)]'
const MARK_CELL_CLASS =
  '[opacity:var(--fxl-idle)] [transition:opacity_200ms_ease,background-color_200ms_ease] data-[on]:[background:var(--fxl-mark)] data-[on]:[opacity:var(--fxl-peak)] group-data-[glow]:data-[on]:[box-shadow:0_0_calc(var(--fxl-cell)*1.2)_calc(var(--fxl-cell)*0.12)_var(--fxl-mark-glow)]'
const TEXT_CLASS =
  'fxl-text absolute top-0 left-0 whitespace-nowrap opacity-0 [filter:blur(2px)] [transition:opacity_200ms_ease,filter_200ms_ease] data-[active]:static data-[active]:opacity-100 data-[active]:[filter:blur(0)]'

const fmt = (ds: number) =>
  ds < 600 ? `${(ds / 10).toFixed(1)}s` : `${Math.floor(ds / 600)}m ${((ds % 600) / 10).toFixed(1)}s`
const spoken = (ds: number) =>
  ds < 600
    ? `${(ds / 10).toFixed(1)} seconds`
    : `${Math.floor(ds / 600)} minutes ${((ds % 600) / 10).toFixed(1)} seconds`

const props = withDefaults(defineProps<Props>(), {
  label: 'Thinking',
  doneLabel: 'Done in',
  errorLabel: 'Failed after',
  announce: '',
  status: 'working',
  pattern: 'orbit',
  grid: 3,
  shape: 'round',
  color: 'currentColor',
  doneColor: '#22c55e',
  errorColor: '#ef4444',
  cellSize: 6,
  gap: 2,
  fontSize: 14,
  step: 90,
  idleOpacity: 0.15,
  glow: false,
  glowColor: '',
  showTimer: true,
  elapsed: undefined,
  className: '',
})

const reduced = useReducedMotion()
const n = computed<FxLatticeGrid>(() => (props.grid === 4 ? 4 : 3))
const pat = computed(() => resolvePattern(props.pattern, n.value))
const marks = computed(() => MARKS[n.value])
const d = computed(() => props.step * pat.value.scale)
const cycle = computed(() => Math.round(pat.value.loop * d.value))

let lastMark: 'done' | 'error' = 'done'
const mark = computed(() => {
  if (props.status !== 'working') lastMark = props.status
  return lastMark
})

const timerRef = ref<HTMLSpanElement | null>(null)
let ds = 0
let clock: ReturnType<typeof setInterval> | undefined
const announce = ref(`${props.label}, in progress`)

const paint = (next: number) => {
  ds = next
  if (timerRef.value) timerRef.value.textContent = fmt(next)
}

const syncClock = () => {
  clearInterval(clock)
  clock = undefined
  // 减少动画：跳动的数字同样属于动效，直接不启动
  if (reduced.value) return
  if (props.elapsed != null) {
    paint(Math.round(props.elapsed * 10))
    return
  }
  if (props.status !== 'working') return
  const startedAt = performance.now()
  paint(0)
  clock = setInterval(() => paint(Math.floor((performance.now() - startedAt) / 100)), 100)
}
const syncAnnounce = () => {
  if (props.announce) {
    announce.value = props.announce
    return
  }
  announce.value =
    props.status === 'working'
      ? `${props.label}, in progress`
      : `${props.status === 'done' ? props.doneLabel : props.errorLabel}${props.showTimer ? ` ${spoken(ds)}` : ''}`
}

onMounted(() => {
  syncClock()
  syncAnnounce()
})
watch(
  () => [props.status, props.elapsed, props.announce, reduced.value] as const,
  () => {
    syncClock()
    syncAnnounce()
  },
  { flush: 'post' },
)
onUnmounted(() => clearInterval(clock))

const LIT_CELL = `${CELL} ${LIT_CLASS}`
const cellClass = (unit: number | null) =>
  unit == null ? HOLE_CLASS : `${LIT_CELL} ${LIT[Math.round((pat.value.lit ?? 0.62) * 100)] || LIT[62]}`

const rootStyle = computed(
  () =>
    ({
      '--fxl-n': n.value,
      '--fxl-cell': `${props.cellSize}px`,
      '--fxl-gap': `${props.gap}px`,
      '--fxl-font': `${props.fontSize}px`,
      '--fxl-color': props.color,
      '--fxl-mark': props.status === 'error' ? props.errorColor : props.doneColor,
      '--fxl-idle': props.idleOpacity,
      '--fxl-glow': props.glowColor || props.color,
      '--fxl-mark-glow': props.glowColor || (props.status === 'error' ? props.errorColor : props.doneColor),
      '--fxl-cycle': `${cycle.value}ms`,
      '--fxl-peak': 1,
      '--fxl-ease-out': 'cubic-bezier(0.23, 1, 0.32, 1)',
      '--fxl-ease-in-out': 'cubic-bezier(0.77, 0, 0.175, 1)',
    }) as CSSProperties,
)
</script>

<style>
@keyframes fxl-on {
  0%,
  100% {
    opacity: var(--fxl-idle);
  }
  18%,
  42% {
    opacity: var(--fxl-peak);
  }
  62% {
    opacity: var(--fxl-idle);
  }
}
@keyframes fxl-on-45 {
  0%,
  100% {
    opacity: var(--fxl-idle);
  }
  13%,
  31% {
    opacity: var(--fxl-peak);
  }
  45% {
    opacity: var(--fxl-idle);
  }
}
@keyframes fxl-on-35 {
  0%,
  100% {
    opacity: var(--fxl-idle);
  }
  10%,
  24% {
    opacity: var(--fxl-peak);
  }
  35% {
    opacity: var(--fxl-idle);
  }
}
@keyframes fxl-on-25 {
  0%,
  100% {
    opacity: var(--fxl-idle);
  }
  7%,
  17% {
    opacity: var(--fxl-peak);
  }
  25% {
    opacity: var(--fxl-idle);
  }
}

/* 减少动画（设置开关）：晶格停在「全亮」静止字形。
   不能只靠 globals.css 的 html.reduce-motion * 兜底 —— 那条会把 animation-duration 压成 0.01ms，
   所有格子会停在 fxl-on 的 idle 关键帧（= 全暗），加载态就彻底看不见了。 */
.fxl-root.is-static .fxl-run > span {
  animation: none !important;
}
.fxl-root.is-static .fxl-run > span:not([data-hole]) {
  opacity: var(--fxl-peak);
}
.fxl-root.is-static .fxl-text {
  filter: none !important;
}
.fxl-root.is-static [data-on] {
  opacity: var(--fxl-peak);
}

@media (prefers-reduced-motion: reduce) {
  .fxl-run {
    --fxl-peak: 0.7;
  }
  .fxl-run > span {
    animation-delay: 0ms !important;
    animation-duration: 1400ms !important;
  }
  .fxl-mark {
    transform: none !important;
  }
  .fxl-text {
    filter: none !important;
  }
}
</style>
