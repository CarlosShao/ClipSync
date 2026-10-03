<script setup lang="ts">
/**
 * 带流光的文字（「AI 正在工作」这类占位文案的**统一实现**）。
 *
 * 流光节奏用**常规扫光速度**（约 1.8s 一轮，见 utils/aiShimmer.ts）。
 * ⚠️ 曾按"与左侧点阵同频"实现，用户实测否掉：点阵太快（648ms）⇒ 文字表面高频变化会被看成"整行字在闪"，
 *    流光必须是**一眼看得出的缓慢扫过**，不是高频闪烁。
 *
 * ⚠️ 血泪教训：**不要**用 background-clip: text + -webkit-text-fill-color: transparent 做流光 ✗
 *    —— 那套要求"背景必须完全覆盖文字"，任何相位/尺寸/容器不匹配，没被盖到的字就**直接消失** ✗
 *    （用户实测："字特么还会隐身"）。现在改为：文字完全不动，上面盖一层半透明柔光扫过 ⇒ 不可能吃掉字 ✓
 *
 * 减少动效：`html.reduce-motion` ∪ `prefers-reduced-motion`（useReducedMotion）命中时**只显示静态文字**
 * （不挂动画类）；另有 `@media (prefers-reduced-motion: reduce)` 兜底。
 * ⚠️ 不使用常驻 `will-change` / `fill-mode`（本项目曾因此黑屏）。
 */
import { computed } from 'vue'
import { useReducedMotion } from '@/components/fx/useReducedMotion'
import { SHIMMER_CYCLE_MS, SHIMMER_EASE } from '@/utils/aiShimmer'

const props = defineProps<{
  /** 占位文字（内容/大小/位置由调用方决定，本组件不改） */
  text: string
}>()

const reducedMotion = useReducedMotion()
const animate = computed(() => !reducedMotion.value)
const shimmerVars = computed(() => ({
  '--shimmer-cycle': `${SHIMMER_CYCLE_MS}ms`,
  '--shimmer-ease': SHIMMER_EASE,
}))
</script>

<template>
  <span class="shimmer-text" :class="{ 'shimmer-text--on': animate }" :style="shimmerVars" data-shimmer-text>{{ props.text }}</span>
</template>

<style scoped>
.shimmer-text {
  display: inline-block;
}
/* 光带一遍遍有节奏地划过文字表面（常规扫光速度 ~1.8s/轮，与点阵**刻意解耦**，见 utils/aiShimmer.ts） */
.shimmer-text--on {
  /* 与 InlineAiCard 同款：文字完全不动（正常颜色），只在其上盖一层柔光扫过。
     绝不再用 background-clip: text + text-fill-color: transparent（会让没被背景盖住的字消失）。 */
  position: relative;
  color: var(--text-secondary);
}
.shimmer-text--on::after {
  content: '';
  position: absolute;
  inset: -0.12em -0.3em;
  pointer-events: none;
  background-image: linear-gradient(
    100deg,
    transparent 38%,
    color-mix(in srgb, var(--accent) 45%, transparent) 50%,
    transparent 62%
  );
  background-size: 220% 100%;
  border-radius: 3px;
  animation: shimmer-sheen var(--shimmer-cycle, 1800ms) var(--shimmer-ease, ease-in-out) infinite;
}
@keyframes shimmer-sheen {
  from {
    background-position: 150% 0;
  }
  to {
    background-position: -50% 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .shimmer-text--on {
    animation: none;
    background-image: none;
    -webkit-text-fill-color: currentColor;
    color: inherit;
  }
}
</style>
