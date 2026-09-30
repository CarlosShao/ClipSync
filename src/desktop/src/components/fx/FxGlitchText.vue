<!-- Adapted from vue-bits TextAnimations/GlitchText (commit 07c0f76, MIT + Commons Clause).
     本地库：D:\work\AI\component library\vue-bits\src\content\TextAnimations\GlitchText\GlitchText.vue
     改动：
       ① 去掉落地页写死外观（text-white / font-black / text-[clamp(2rem,10vw,8rem)] / cursor-pointer /
          select-none / mx-auto / bg-[#0b0b0b]）：字号字色跟随宿主，伪元素底色改由 glitchBg 传入
       ② Tailwind 任意值类（before:[animation:…] + clip-path 关键帧）换成 scoped 原生 CSS：
          上游写法在宿主里会和既有排版规则抢 layer，且 clip-path 关键帧是全局注入，改名 fx-glitch-clip 防撞
       ③ 偏离量与阴影色全部参数化：上游 ±10px / 红青硬编码只适合超大标题，本项目标题是 14-16px
       ④ 接 useReducedMotion —— reduce 命中时加 is-static，直接不生成两片伪元素（而非留一个冻结的假象） -->
<template>
  <span
    :class="['fx-glitch', { 'is-static': reduced, 'is-hover-only': enableOnHover }, className]"
    :data-text="text"
    :style="styleVars"
  >
    {{ text }}
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useReducedMotion } from './useReducedMotion'

interface Props {
  text: string
  /** 上游语义：伪元素时长 = speed*2 / speed*3（秒） */
  speed?: number
  enableShadows?: boolean
  enableOnHover?: boolean
  /** 两片伪元素的水平偏离量（px） */
  offset?: number
  /** 伪元素底色：必须与所在容器底色一致，才能切出「错位切片」而不是重影 */
  glitchBg?: string
  shadowColorA?: string
  shadowColorB?: string
  className?: string
}

const props = withDefaults(defineProps<Props>(), {
  speed: 0.5,
  enableShadows: true,
  enableOnHover: false,
  offset: 2,
  glitchBg: 'var(--bg-base, transparent)',
  shadowColorA: 'rgba(255, 45, 85, 0.65)',
  shadowColorB: 'rgba(0, 210, 255, 0.6)',
  className: '',
})

const reduced = useReducedMotion()

const styleVars = computed(() => ({
  '--fx-glitch-dur-a': `${props.speed * 2}s`,
  '--fx-glitch-dur-b': `${props.speed * 3}s`,
  '--fx-glitch-off': `${props.offset}px`,
  '--fx-glitch-bg': props.glitchBg,
  '--fx-glitch-shadow-a': props.enableShadows ? `var(--fx-glitch-shadow-a-color) ${-props.offset * 2}px 0` : 'none',
  '--fx-glitch-shadow-b': props.enableShadows ? `var(--fx-glitch-shadow-b-color) ${props.offset * 2}px 0` : 'none',
  '--fx-glitch-shadow-a-color': props.shadowColorA,
  '--fx-glitch-shadow-b-color': props.shadowColorB,
}))
</script>

<style scoped>
.fx-glitch {
  position: relative;
  display: inline-block;
  white-space: nowrap;
}
.fx-glitch::before,
.fx-glitch::after {
  content: attr(data-text);
  position: absolute;
  top: 0;
  overflow: hidden;
  pointer-events: none;
  background: var(--fx-glitch-bg, transparent);
}
.fx-glitch::before {
  left: calc(var(--fx-glitch-off, 2px) * -1);
  text-shadow: var(--fx-glitch-shadow-a, none);
  animation: fx-glitch-clip var(--fx-glitch-dur-a, 2s) infinite linear alternate-reverse;
}
.fx-glitch::after {
  left: var(--fx-glitch-off, 2px);
  text-shadow: var(--fx-glitch-shadow-b, none);
  animation: fx-glitch-clip var(--fx-glitch-dur-b, 3s) infinite linear alternate-reverse;
}
/* hover 触发模式：默认不生成切片，悬停才亮 */
.fx-glitch.is-hover-only::before,
.fx-glitch.is-hover-only::after {
  content: none;
  opacity: 0;
  animation: none;
}
.fx-glitch.is-hover-only:hover::before,
.fx-glitch.is-hover-only:hover::after {
  content: attr(data-text);
  opacity: 1;
}
.fx-glitch.is-hover-only:hover::before {
  animation: fx-glitch-clip var(--fx-glitch-dur-a, 2s) infinite linear alternate-reverse;
}
.fx-glitch.is-hover-only:hover::after {
  animation: fx-glitch-clip var(--fx-glitch-dur-b, 3s) infinite linear alternate-reverse;
}
/* 减少动画（设置开关 / 系统偏好）：不生成切片，直接回到干净文字 */
.fx-glitch.is-static::before,
.fx-glitch.is-static::after {
  content: none;
  animation: none;
}

@keyframes fx-glitch-clip {
  0% {
    clip-path: inset(20% 0 50% 0);
  }
  10% {
    clip-path: inset(15% 0 55% 0);
  }
  20% {
    clip-path: inset(30% 0 40% 0);
  }
  30% {
    clip-path: inset(10% 0 60% 0);
  }
  40% {
    clip-path: inset(25% 0 35% 0);
  }
  50% {
    clip-path: inset(20% 0 50% 0);
  }
  60% {
    clip-path: inset(15% 0 55% 0);
  }
  70% {
    clip-path: inset(30% 0 40% 0);
  }
  80% {
    clip-path: inset(10% 0 60% 0);
  }
  90% {
    clip-path: inset(25% 0 35% 0);
  }
  100% {
    clip-path: inset(30% 0 40% 0);
  }
}
</style>
