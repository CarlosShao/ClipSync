<!-- 页面标题区（每个菜单页共用）：eyebrow / 大标题 / 副标题 + 一条错峰的入场动画。
     来源：不依赖 vue-bits 具体组件，但节奏与手法取自其 TextAnimations 一档
     （SplitText 的"逐字错峰上浮 + blur 收敛"、ShinyText/GradientText 的"先亮后定"思路），
     刻意只取克制的那一档：不翻牌、不粒子、不常驻循环 —— 高级感来自"节奏"，不是特效数量。

     为什么是"一次性 + 不用 will-change + 不用 fill-mode"：
       fx 层此前出过桌面端用一会儿黑屏的事故，根因就是永久图层提示（will-change）与
       动画播完后仍停留的 fill-mode（both/forwards）。这里全部避开：
       每个字符/副标题只在挂载时播一次，delay 期间用 `backwards` 保持起始态，
       播完元素自然回到基线，不留活动动画。
     reduce-motion 命中（应用内开关 ∪ 系统偏好）时整块静态呈现。

     用法：
       <FxPageHeader eyebrow="Clipboard Stream" :title="t('nav_clipboard')" :subtitle="…" />
     继承原有的 .page-eyebrow / .page-title / .page-sub 类，视觉与接入前完全一致。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { useReducedMotion } from './useReducedMotion'

const props = withDefaults(
  defineProps<{
    eyebrow?: string
    title: string
    subtitle?: string
  }>(),
  { eyebrow: '', subtitle: '' },
)

const reduced = useReducedMotion()
// 标题按**字符**切分：中文标题没有空格，按"词"切会整块一刀不动、毫无错峰感
const chars = computed(() => Array.from(props.title))
</script>

<template>
  <div class="fx-page-head" :class="{ 'is-static': reduced }">
    <div v-if="eyebrow" class="page-eyebrow fx-ph-eyebrow">{{ eyebrow }}</div>
    <div class="page-title page-title--big fx-ph-title">
      <span v-for="(ch, i) in chars" :key="i" class="fx-ph-char" :style="{ animationDelay: `${60 + i * 34}ms` }">{{
        ch
      }}</span>
    </div>
    <div v-if="subtitle" class="page-sub fx-ph-sub">{{ subtitle }}</div>
  </div>
</template>

<style scoped>
.fx-ph-eyebrow {
  animation: fx-ph-fade 0.42s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.fx-ph-char {
  /* inline-block 才能吃 transform/filter；行内换行不受影响（标题是单行） */
  display: inline-block;
  animation: fx-ph-rise 0.5s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.fx-ph-sub {
  animation: fx-ph-fade-up 0.46s cubic-bezier(0.22, 1, 0.36, 1) 0.26s backwards;
}
@keyframes fx-ph-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes fx-ph-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
    filter: blur(5px);
  }
  to {
    opacity: 1;
    transform: none;
    filter: none;
  }
}
@keyframes fx-ph-fade-up {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* 关掉动画：直接静态最终态 */
.fx-page-head.is-static .fx-ph-eyebrow,
.fx-page-head.is-static .fx-ph-char,
.fx-page-head.is-static .fx-ph-sub {
  animation: none;
}
</style>
