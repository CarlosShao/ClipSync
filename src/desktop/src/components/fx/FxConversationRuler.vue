<!-- 对话刻度尺（方案 A）：AI 对话区**右侧**的竖直刻度，每条消息一个刻度。
     算法完全复用 fx/fxProximity.ts（vue-bits LineSidebar 的邻近内核）：
     指令按"指针到刻度的距离 → smooth 衰减 → rAF 指数平滑"逐帧往每个刻度写 --fx-prox（0..1），
     这里只负责把 --fx-prox 映射成刻度长度/不透明度 —— 靠近指针的刻度会"长出来"。

     与上游 LineSidebar 的关系：刻度线（上游用 ::after 画的 tick，宽度按 --effect 缩放）
     就是这里刻度的同源做法；上游是"条目 + 刻度"，我们需要的是"整段对话的定位尺"，
     所以抽成独立组件，只保留刻度与邻近缩放。

     交互：点击刻度跳到对应消息（宿主负责滚动，本组件只 emit index）。
     无障碍：容器 role="navigation" + 每个刻度带 title/aria-label，键盘可 Tab 到并 Enter 跳转。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { vFxProximity } from './fxProximity'

const props = withDefaults(
  defineProps<{
    /** 消息总数 */
    count: number
    /** 当前"读到哪里"的刻度下标（宿主按滚动位置算） */
    activeIndex?: number
    /** 最多画多少个刻度（超出则等距采样，避免刻度细到点不中） */
    maxTicks?: number
    /** 刻度旁的可读标签，用于 aria/title，如 t('ai_jump_msg') */
    label?: string
  }>(),
  { activeIndex: -1, maxTicks: 40, label: '' },
)

const emit = defineEmits<{ jump: [index: number] }>()

/** 超过 maxTicks 时等距采样：刻度 i → 原始消息下标 */
const tickIndexes = computed(() => {
  const n = Math.max(0, props.count)
  if (n <= props.maxTicks) return Array.from({ length: n }, (_, i) => i)
  return Array.from({ length: props.maxTicks }, (_, i) => Math.round((i * (n - 1)) / (props.maxTicks - 1)))
})

/** 当前刻度在采样后的位置（用于高亮） */
const activeTick = computed(() => {
  if (props.activeIndex < 0) return -1
  let best = -1
  let bestGap = Infinity
  tickIndexes.value.forEach((mi, ti) => {
    const gap = Math.abs(mi - props.activeIndex)
    if (gap < bestGap) {
      bestGap = gap
      best = ti
    }
  })
  return best
})
</script>

<template>
  <nav
    v-if="count >= 3"
    class="fx-ruler"
    v-fx-proximity="{ selector: '.fx-ruler-tick', radius: 80 }"
    :aria-label="label"
  >
    <button
      v-for="(mi, ti) in tickIndexes"
      :key="mi"
      type="button"
      class="fx-ruler-tick"
      :class="{ 'is-active': ti === activeTick }"
      :title="label ? `${label} ${mi + 1}` : undefined"
      :aria-label="label ? `${label} ${mi + 1}` : undefined"
      @click="emit('jump', mi)"
    />
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
  width: 7px;
  height: 2px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 1px;
  cursor: pointer;
  background: var(--text-tertiary);
  opacity: calc(0.4 + var(--fx-prox, 0) * 0.5);
  /* 宽度与不透明度都由指令逐帧写入的 --fx-prox 驱动；刻意不加 transition：
     已经是逐帧平滑，再叠 CSS 过渡会二次滞后（与 .ai-nav-conv 同理） */
  width: calc(7px + var(--fx-prox, 0) * 13px);
  /* 命中区放大到 12px 高，不改变视觉高度（刻度线本身 2px） */
  box-shadow: 0 0 0 5px transparent;
  background-clip: content-box;
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
</style>
