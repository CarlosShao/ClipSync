<!-- 对话刻度尺（方案 A，第二轮修正）：AI 对话区**右侧**的竖直刻度。
     一个刻度 = **一轮完整对话**（我发出的消息 + 它的回答算一轮），不是一个消息一个刻度。

     交互规则（按用户明确要求）：
       · 只有**鼠标真正停住的那一根**刻度有动效 —— 不做"邻近刻度跟着动"（已移除 v-fx-proximity，
         用户明确不要这种效果：其它刻度必须一动不动）。
       · 长度层级：普通 < 滑动选中 < 点击/当前位置选中（被选中的那轮永远最长）。
       · 滑动选中即弹出该轮**概要卡**：发送方消息概要 + 回答方消息概要。
       · 点击刻度 → 跳到该轮第一条消息（宿主负责滚动）。
       · 键盘 focus 与滑动选中同效，Enter 跳转。

     无障碍/命中：容器 pointer-events: none、只有刻度 auto —— 不挡对话区的滚动与文字选中；
     刻度视觉高 2px，命中区用 box-shadow 撑到 12px。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'

export interface RulerTurn {
  /** 发送方（我）的概要 */
  question?: string
  /** 回答方的概要 */
  answer?: string
}

const props = withDefaults(
  defineProps<{
    turns: RulerTurn[]
    /** 当前所在（或点击选中）的那一轮下标 —— 这一根最长 */
    activeIndex?: number
    label?: string
    questionLabel?: string
    answerLabel?: string
  }>(),
  { activeIndex: -1, label: '', questionLabel: '', answerLabel: '' },
)

const emit = defineEmits<{ jump: [turnIndex: number] }>()

const hoverIndex = ref(-1)
const hoverTop = ref(0)

const hoverTurn = computed<RulerTurn | null>(() =>
  hoverIndex.value >= 0 ? (props.turns[hoverIndex.value] ?? null) : null,
)

/** 概要文本：压平空白 + 截断（卡片行数固定，避免长消息把卡片撑高） */
const clip = (s: string | undefined, max: number) => (s || '').replace(/\s+/g, ' ').trim().slice(0, max)
const hoverQuestion = computed(() => clip(hoverTurn.value?.question, 120))
const hoverAnswer = computed(() => clip(hoverTurn.value?.answer, 180))

function enterTick(turnIndex: number, e: Event) {
  const el = e.currentTarget as HTMLElement | null
  hoverIndex.value = turnIndex
  hoverTop.value = el ? el.offsetTop + el.offsetHeight / 2 : 0
}
function clearHover() {
  hoverIndex.value = -1
}
</script>

<template>
  <nav
    v-if="turns.length >= 2"
    class="fx-ruler"
    :aria-label="label"
    @mouseleave="clearHover"
  >
    <button
      v-for="(turn, ti) in turns"
      :key="ti"
      type="button"
      class="fx-ruler-tick"
      :class="{ 'is-hover': ti === hoverIndex, 'is-active': ti === activeIndex }"
      :title="label ? `${label} ${ti + 1}` : undefined"
      :aria-label="label ? `${label} ${ti + 1}` : undefined"
      @mouseenter="enterTick(ti, $event)"
      @focus="enterTick(ti, $event)"
      @click="emit('jump', ti)"
    />

    <!-- 该轮概要：左贴刻度、垂直居中；同时给出发送方与回答方 -->
    <div v-if="hoverTurn" class="fx-ruler-preview" :style="{ top: `${hoverTop}px` }" aria-hidden="true">
      <div v-if="hoverQuestion" class="fx-ruler-preview-row">
        <span class="fx-ruler-preview-role">{{ questionLabel }}</span>
        <span class="fx-ruler-preview-text">{{ hoverQuestion }}</span>
      </div>
      <div v-if="hoverAnswer" class="fx-ruler-preview-row">
        <span class="fx-ruler-preview-role">{{ answerLabel }}</span>
        <span class="fx-ruler-preview-text">{{ hoverAnswer }}</span>
      </div>
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
  gap: 4px;
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
  opacity: 0.45;
  /* 只有"被滑动到"和"被选中"两态会变长；宽度过渡到是有意的 —— 单根刻度的状态切换，
     不存在逐帧邻近计算，纯 CSS 过渡最省（也不再有邻居跟着动的问题）。 */
  width: 7px;
  transition:
    width 140ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 140ms ease,
    background-color 140ms ease;
  /* 命中区放大到 12px 高，不改变视觉高度（刻度线本身 2px） */
  box-shadow: 0 0 0 5px transparent;
}
.fx-ruler-tick.is-hover {
  width: 14px;
  opacity: 0.9;
  background: var(--text-secondary);
}
/* 被点击/当前所在的一轮：最长且最高亮（永远比滑动选中的那根长） */
.fx-ruler-tick.is-active {
  width: 22px;
  opacity: 1;
  background: var(--accent);
}
.fx-ruler-tick:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 概要卡：一问一答两行 */
.fx-ruler-preview {
  position: absolute;
  right: calc(100% + 10px);
  transform: translateY(-50%);
  width: 268px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-card);
  pointer-events: none;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.fx-ruler-preview-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.fx-ruler-preview-role {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-tertiary);
}
.fx-ruler-preview-text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-secondary);
  word-break: break-word;
}
</style>
