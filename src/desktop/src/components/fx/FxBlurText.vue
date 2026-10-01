<!-- Adapted from vue-bits TextAnimations/BlurText (MIT + Commons Clause).
     本地库：D:\work\AI\component library\vue-bits\src\content\TextAnimations\BlurText\BlurText.vue
     上游内核：把文本切成词，每个词一段 keyframes
       { filter: blur(10px), opacity: 0, y: -50 } → { blur(5px), y: ±5 } → { blur(0), y: 0 }
     逐词错峰播放（delay 默认 200ms/词），由 useInView 触发一次。

     本地改动（关键：要能用于**流式**输出）：
       ① 上游是"整串文本变化 → 全部词重播一遍"。AI 打字/流式场景下这会导致每次收到新 chunk
          整段文字重新模糊一遍（观感就是抖）。这里改为**只让新出现的词播放**：
          词 span 以索引为 key，Vue 只会为新增的词创建 DOM 节点，而已完成的动画不会重播。
       ② 错峰取 min(i, 8) * 40ms —— 与前缀词的位置绑定，是稳定值，不会因后续 chunk 改动
          已渲染词的内联样式（改 animation-delay 有可能让已结束的动画重算）。
       ③ 幅度收敛：blur 10px→6px、y 位移 50px→4px（正文段落用 10px/50px 会晃得厉害）。
       ④ reduce-motion 走 fx/useReducedMotion 双通道，命中则整段以静态文本呈现（不挂动画）。
       ⑤ 不吃 inView：流式内容本身就在可见区域内逐词出现，再叠一层视口触发只会延迟。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { useReducedMotion } from './useReducedMotion'

const props = withDefaults(
  defineProps<{
    text: string
    /** 每词错峰（ms），仅作用于前 8 个词 */
    stagger?: number
  }>(),
  { text: '', stagger: 40 },
)

const reduced = useReducedMotion()

/** 按空白切分为"词 + 空白"序列，渲染时保留原始空白以避免粘连 */
const words = computed(() => props.text.split(/(\s+)/).filter((s) => s.length > 0))
</script>

<template>
  <span class="fx-blur-text" :class="{ 'is-static': reduced }">
    <span
      v-for="(w, i) in words"
      :key="i"
      class="fx-blur-word"
      :style="{ animationDelay: `${Math.min(i, 8) * props.stagger}ms` }"
      >{{ w }}</span
    >
  </span>
</template>

<style scoped>
.fx-blur-word {
  /* inline-block 让 filter/transform 生效；换行仍发生在词之间的空白处 */
  display: inline-block;
  /* 基线即最终态 + **不加 fill-mode**：动画播完元素自然回到基线，不会长期停在
     "动画中"状态（用 both/forwards 会让每个词一直被视为有活动动画，图层不回收）。
     也**刻意不加 will-change** —— 一个词一个图层，长摘要几百个词会把 WebView2 的
     合成层吃爆（表现为用一会儿黑屏）。这两个坑都是实测桌面端黑屏后定位到的。 */
  opacity: 1;
  filter: none;
  transform: none;
  animation: fx-blur-in 0.42s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes fx-blur-in {
  from {
    opacity: 0;
    filter: blur(6px);
    transform: translateY(4px);
  }
  60% {
    opacity: 0.85;
    filter: blur(2px);
    transform: translateY(1px);
  }
  to {
    opacity: 1;
    filter: blur(0);
    transform: none;
  }
}
/* 关掉动画时（应用内开关或系统偏好）直接给最终态 */
.fx-blur-text.is-static .fx-blur-word {
  animation: none;
  opacity: 1;
  filter: none;
  transform: none;
}
</style>
