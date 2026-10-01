<!-- 对话刻度尺（方案 A）：AI 对话区**右侧**的竖直刻度，每条消息一个刻度。
     算法复用 fx/fxProximity.ts（vue-bits LineSidebar 的邻近内核）：指令按"指针到刻度的距离
     → smooth 衰减 → rAF 指数平滑"逐帧往每个刻度写 --fx-prox（0..1），这里把 --fx-prox 映射成
     刻度长度/不透明度 —— 靠近指针的刻度会"长出来"。

     交互（按用户要求，对齐参考实现的体验）：
       · 鼠标划过刻度 → **逐格高亮**（移到哪一格，哪一格就是当前格），并在刻度左侧弹出该条
         消息的**概要预览**；移开后回到"滚动位置"对应的高亮。
       · 点击刻度 → 跳到那条消息（宿主负责滚动）。
       · 键盘：Tab 到刻度时同样高亮 + 出预览，Enter 跳转。

     无障碍/命中：容器 pointer-events: none、只有刻度 auto —— 不挡对话区的滚动与文字选中；
     刻度视觉高 2px，命中区用 box-shadow 撑到 12px。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { vFxProximity } from './fxProximity'

export interface RulerItem {
  role?: string
  text: string
}

const props = withDefaults(
  defineProps<{
    /** 消息概要（与消息一一对应；长度不限，展示时截断） */
    items: RulerItem[]
    /** 当前"读到哪里"的刻度下标（宿主按滚动位置算） */
    activeIndex?: number
    /** 最多画多少个刻度（超出则等距采样，避免刻度细到点不中） */
    maxTicks?: number
    /** 刻度旁的可读标签，用于 aria/title */
    label?: string
  }>(),
  { activeIndex: -1, maxTicks: 40, label: '' },
)

const emit = defineEmits<{ jump: [index: number] }>()

/** 超过 maxTicks 时等距采样：刻度 i → 原始消息下标 */
const tickIndexes = computed(() => {
  const n = Math.max(0, props.items.length)
  if (n <= props.maxTicks) return Array.from({ length: n }, (_, i) => i)
  return Array.from({ length: props.maxTicks }, (_, i) => Math.round((i * (n - 1)) / (props.maxTicks - 1)))
})

/** 鼠标/键盘停在哪个刻度上（-1 = 没停）：优先于滚动位置 */
const hoverIndex = ref(-1)
const hoverTop = ref(0)

/** 高亮格：悬停优先，否则用宿主给的滚动位置 */
const highlightIndex = computed(() => (hoverIndex.value >= 0 ? hoverIndex.value : props.activeIndex))

/** 悬停格在采样后的位置（用来判断哪根刻度该高亮） */
const activeTick = computed(() => nearestTick(highlightIndex.value))

function nearestTick(messageIndex: number): number {
  if (messageIndex < 0) return -1
  let best = -1
  let bestGap = Infinity
  tickIndexes.value.forEach((mi, ti) => {
    const gap = Math.abs(mi - messageIndex)
    if (gap < bestGap) {
      bestGap = gap
      best = ti
    }
  })
  return best
}

const hoverItem = computed<RulerItem | null>(() =>
  hoverIndex.value >= 0 ? (props.items[hoverIndex.value] ?? null) : null,
)
/** 预览文本：压掉换行、截断（弹层固定三行，避免长消息把卡片撑高） */
const hoverText = computed(() => (hoverItem.value?.text || '').replace(/\s+/g, ' ').trim().slice(0, 160))

function enterTick(messageIndex: number, e: Event) {
  const el = e.currentTarget as HTMLElement | null
  hoverIndex.value = messageIndex
  hoverTop.value = el ? el.offsetTop + el.offsetHeight / 2 : 0
}

function clearHover() {
  hoverIndex.value = -1
}
</script>

<template>
  <nav
    v-if="items.length >= 3"
    class="fx-ruler"
    v-fx-proximity="{ selector: '.fx-ruler-tick', radius: 80 }"
    :aria-label="label"
    @mouseleave="clearHover"
  >
    <button
      v-for="(mi, ti) in tickIndexes"
      :key="mi"
      type="button"
      class="fx-ruler-tick"
      :class="{ 'is-active': ti === activeTick }"
      :title="label ? `${label} ${mi + 1}` : undefined"
      :aria-label="label ? `${label} ${mi + 1}` : undefined"
      @mouseenter="enterTick(mi, $event)"
      @focus="enterTick(mi, $event)"
      @click="emit('jump', mi)"
    />

    <!-- 概要预览：贴在刻度左侧、与悬停的刻度垂直居中对齐；纯展示，不参与交互 -->
    <div v-if="hoverItem" class="fx-ruler-preview" :style="{ top: `${hoverTop}px` }" aria-hidden="true">
      <span class="fx-ruler-preview-text">{{ hoverText }}</span>
    </div>
  </nav>
</template>

<style scoped>
.fx-ruler {
  position: absolute;
  top: 12px;
  right: 2px;
  bottom: 12px;
  z-index: 4;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-end;
  gap: 3px;
  padding: 0 4px;
  /* 只有刻度本身可点，容器不挡对话区的滚动/选中 */
  pointer-events: none;
}
.fx-ruler-tick {
  pointer-events: auto;
  flex: none;
  height: 2px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 1px;
  cursor: pointer;
  background: var(--text-tertiary);
  opacity: calc(0.4 + var(--fx-prox, 0) * 0.5);
  /* 宽度与不透明度都由指令逐帧写入的 --fx-prox 驱动；刻意不加 transition：
     已是逐帧平滑，再叠 CSS 过渡会二次滞后（与 .ai-nav-conv 同理） */
  width: calc(7px + var(--fx-prox, 0) * 13px);
  /* 命中区放大到 12px 高，不改变视觉高度（刻度线本身 2px） */
  box-shadow: 0 0 0 5px transparent;
}
.fx-ruler-tick:hover {
  background-color: var(--text-secondary);
}
.fx-ruler-tick.is-active {
  width: 14px;
  opacity: 1;
  background: var(--accent);
}
.fx-ruler-tick:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 概要预览卡：与参考实现一致 —— 悬停即出该条消息的摘要，移开消失 */
.fx-ruler-preview {
  position: absolute;
  right: calc(100% + 10px);
  transform: translateY(-50%);
  width: 240px;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-card);
  pointer-events: none;
  text-align: left;
}
.fx-ruler-preview-text {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  word-break: break-word;
}
</style>
