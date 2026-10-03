<script setup lang="ts">
/**
 * 带流光的文字（「AI 正在工作」这类占位文案的**统一实现**）。
 *
 * 流光节奏用**常规扫光速度**（约 1.8s 一轮，见 utils/aiShimmer.ts）。
 * ⚠️ 曾按"与左侧点阵同频"实现，用户实测否掉：点阵太快（648ms）⇒ 文字表面高频变化会被看成"整行字在闪"，
 *    流光必须是**一眼看得出的缓慢扫过**，不是高频闪烁。
 *
 * ⚠️ 血泪教训：渐变底色**必须**用真实文字色 token（--shimmer-base = --text-secondary），\n *    **不能**用 currentColor —— 本元素 color 是 transparent（文字靠渐变上色），\n *    currentColor 会解析成 transparent ⇒ 只有光带可见、其余文字全部隐身（用户实测）。
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
  /* ⚠️ 这里**绝不能**用 currentColor：本元素 `color` 是 transparent（文字交给渐变上色），
     currentColor 会解析成 transparent ⇒ 渐变变成「透明→透明→accent→透明」⇒
     只有光带可见、其余文字全部隐身（用户实测："字特么还会隐身"）。
     所以底色必须用**真实的文字颜色 token**，光带只是在底色上更亮的一小段。 */
  --shimmer-base: var(--text-secondary);
  color: var(--shimmer-base);
  background-image: linear-gradient(
    100deg,
    var(--shimmer-base) 0%,
    var(--shimmer-base) 42%,
    color-mix(in srgb, var(--accent) 55%, var(--shimmer-base)) 50%,
    var(--shimmer-base) 58%,
    var(--shimmer-base) 100%
  );
  background-size: 200% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  animation: shimmer-sweep var(--shimmer-cycle, 1800ms) var(--shimmer-ease, ease-in-out) infinite;
}
/* 位置始终留在 0%~100%：配合 background-size:200%，文字**任何相位都被背景完全覆盖**，
   不会出现"背景没盖到 ⇒ 字隐身"的空隙（旧写法 130% → -30% 正是这个坑）。 */
@keyframes shimmer-sweep {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: 0% 0;
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
