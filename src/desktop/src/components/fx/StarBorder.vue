<!-- Adapted from vue-bits Animations/StarBorder (commit 07c0f76, MIT + Commons Clause).
     本地库：D:\work\AI\component library\vue-bits\src\content\Animations\StarBorder\StarBorder.vue
     改动：① 内层去掉落地页写死的暗色底/内边距/边框样式，改为透传 slot 自带外观
           ② 圆角参数化（borderRadius prop，默认 var(--radius-md)），不再写死 20px
           ③ 亮度增强（浏览器 1:1 复现实测：上游 70% 透明度 + 纯色 10% 淡出在 1-2px
              边缘缝里物理上不可见）：opacity 95% + 亮核加宽（4% 实心、12% 淡出）。
              光色对比度由调用方控制，建议 color-mix(var(--primary) 70%, white)。 -->
<template>
  <component
    :is="as"
    :class="['relative inline-block overflow-hidden !bg-transparent !border-none', customClass]"
    v-bind="restAttrs"
    :style="componentStyle"
  >
    <div
      class="right-[-250%] bottom-[-11px] z-0 absolute opacity-95 rounded-full w-[300%] h-[50%] animate-star-movement-bottom"
      :style="{
        background: `radial-gradient(circle, ${color} 0%, ${color} 4%, transparent 12%)`,
        animationDuration: speed,
      }"
    ></div>

    <div
      class="top-[-10px] left-[-250%] z-0 absolute opacity-95 rounded-full w-[300%] h-[50%] animate-star-movement-top"
      :style="{
        background: `radial-gradient(circle, ${color} 0%, ${color} 4%, transparent 12%)`,
        animationDuration: speed,
      }"
    ></div>

    <div class="z-10 relative">
      <slot />
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed, useAttrs } from 'vue'

interface StarBorderProps {
  as?: string
  customClass?: string
  color?: string
  speed?: string
  thickness?: number
  borderRadius?: string
}

const props = withDefaults(defineProps<StarBorderProps>(), {
  as: 'button',
  customClass: '',
  color: 'white',
  speed: '6s',
  thickness: 1,
  borderRadius: 'var(--radius-md)',
})

const restAttrs = useAttrs()

const componentStyle = computed(() => {
  const base = {
    padding: `${props.thickness}px 0`,
    borderRadius: props.borderRadius,
  }
  const userStyle = (restAttrs.style as Record<string, string>) || {}
  return { ...base, ...userStyle }
})
</script>

<style scoped>
@keyframes star-movement-bottom {
  0% {
    transform: translate(0%, 0%);
  }

  100% {
    transform: translate(-100%, 0%);
  }
}

@keyframes star-movement-top {
  0% {
    transform: translate(0%, 0%);
  }

  100% {
    transform: translate(100%, 0%);
  }
}

.animate-star-movement-bottom {
  animation: star-movement-bottom linear infinite alternate;
}

.animate-star-movement-top {
  animation: star-movement-top linear infinite alternate;
}
</style>
