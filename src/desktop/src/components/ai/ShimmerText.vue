<script setup lang="ts">
/**
 * 带流光的文字（「AI 正在工作」这类占位文案的**统一实现**）。
 *
 * 与左侧粒子点阵（fx/FxLatticeLoader）**同频同缓动**：周期/缓动都取自 utils/aiShimmer.ts
 * （那边写明了从点阵源码推导的算式，并由测试解析源码钉住）。
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
  <span class="shimmer-text" :class="{ 'shimmer-text--on': animate }" :style="shimmerVars" data-shimmer-text>{{
    props.text
  }}</span>
</template>

<style scoped>
.shimmer-text {
  display: inline-block;
}
/* 光带一遍遍有节奏地划过文字表面（周期与点阵一致，见 utils/aiShimmer.ts） */
.shimmer-text--on {
  background-image: linear-gradient(
    100deg,
    currentColor 0%,
    currentColor 38%,
    var(--accent) 50%,
    currentColor 62%,
    currentColor 100%
  );
  background-size: 260% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  animation: shimmer-sweep var(--shimmer-cycle, 648ms) var(--shimmer-ease, ease-in-out) infinite;
}
@keyframes shimmer-sweep {
  from {
    background-position: 130% 0;
  }
  to {
    background-position: -30% 0;
  }
}
/* 兜底：系统偏好减少动效 → 静态文字（JS 侧 useReducedMotion 已经会摘掉 --on，这里再保一层） */
@media (prefers-reduced-motion: reduce) {
  .shimmer-text--on {
    animation: none;
    background-image: none;
    -webkit-text-fill-color: currentColor;
    color: inherit;
  }
}
</style>
