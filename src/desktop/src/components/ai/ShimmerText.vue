<!-- 「AI 正在工作」占位文字的流光（**统一实现**）。

     技术路线（两轮踩坑后的最终解）：
       ① 只用 background-clip:text + text-fill-color:transparent ✗ —— 光确实只在笔画上，
          但它要求"背景完整覆盖文字"，任何相位/尺寸不匹配，没被盖到的字就直接消失（用户实测两次 ✗）；
       ② 只用一层半透明覆盖层 ✗ —— 文字安全了，但光变成了**文字外面的一个方块**（用户实测 ✗）；
       ③ **两层**（现在）✓：
          · 底层 = 文字本身，正常颜色、**永远可见**；
          · 上层 = 同一份文字，透明字色 + background-clip:text ⇒ 光带**只落在笔画上**。
          即使上层出了任何问题，底层文字依然在 ⇒ **物理上不可能隐身**；
          因为裁到了字形 ⇒ **光不会出现在缝隙或文字之外**。

     节奏：常规扫光 ~1.8s/轮，与左侧点阵**刻意解耦**（点阵 648ms 太快，会看成字在闪）。
     减少动效：不渲染上层（v-if）⇒ 静态文字；另有 prefers-reduced-motion 兜底。
     ⚠️ 不使用常驻 will-change / fill-mode（本项目曾因此黑屏）。 -->
<script setup lang="ts">
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
  <span class="shimmer-text" :style="shimmerVars" data-shimmer-text>
    <!-- 底层：普通文字，任何情况下都存在 -->
    <span class="shimmer-text__base">{{ props.text }}</span>
    <!-- 上层：同一份文字，裁到字形后只有光带可见（减少动效时不渲染） -->
    <span v-if="animate" class="shimmer-text__sheen" aria-hidden="true">{{ props.text }}</span>
  </span>
</template>

<style scoped>
.shimmer-text {
  position: relative;
  display: inline-block;
  color: var(--text-secondary);
}
.shimmer-text__base {
  position: relative;
  display: inline-block;
}
/* 上层：background-clip:text 让它**只作用于笔画**；字色透明只影响这一层，
   底层文字永远在 ⇒ 不会出现"字隐身"（这正是前两轮踩过的两个坑）。 */
.shimmer-text__sheen {
  position: absolute;
  inset: 0;
  display: inline-block;
  pointer-events: none;
  background-image: linear-gradient(
    100deg,
    transparent 40%,
    color-mix(in srgb, var(--accent) 80%, var(--text-secondary)) 50%,
    transparent 60%
  );
  background-size: 220% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
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
/* 兜底：系统偏好减少动效 ⇒ 不显示上层（即便 JS 没摘干净） */
@media (prefers-reduced-motion: reduce) {
  .shimmer-text__sheen {
    display: none;
  }
}
</style>
