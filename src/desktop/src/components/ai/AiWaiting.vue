<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import AiThinkingOrb from './AiThinkingOrb.vue'

/**
 * AiWaiting — 等待加载态（首字到达之前）
 * 对应 skill 第三章：用户消息上屏后立即出现，无边框无背景无阴影，
 * 结构 = 左侧 20px composing orb（繁忙丝带）+ 右侧「正在思考中」5 字 + 字内笔画 shimmer
 * 收到首字后由父级淡出移除，不做打勾反馈。
 */

const { t } = useI18n()
const titleText = computed(() => t('ai_waiting', '正在思考中'))
</script>

<template>
  <div class="ai-waiting">
    <AiThinkingOrb class="ai-waiting-orb" state="composing" :size="16" :speed="1.4" />
    <span class="ai-waiting-title" :data-text="titleText">{{ titleText }}</span>
  </div>
</template>

<style scoped>
.ai-waiting {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 28px;
  padding: 0 2px;
  user-select: none;
}
.ai-waiting-orb {
  flex-shrink: 0;
  display: block;
}
.ai-waiting-title {
  position: relative;
  display: inline-block;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-secondary, #52525b);
}
/* 字内笔画间 shimmer：与 demo 原版一致
   （transparent 基色 + mix-blend-mode: screen/multiply → 文字永不消失，只有高光带在字内流动）
   ⚠️ 必须用 background-image 而不是 background 简写——简写会清掉 background-clip:text */
.ai-waiting-title::after {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    transparent 35%,
    rgba(255, 255, 255, 0.85) 50%,
    transparent 65%,
    transparent 100%
  );
  background-size: 220% 100%;
  background-position: 100% 0;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  animation: ai-waiting-shimmer 2.5s ease-in-out infinite;
  mix-blend-mode: screen;
}
html.light .ai-waiting-title::after {
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    transparent 35%,
    rgba(24, 24, 27, 0.85) 50%,
    transparent 65%,
    transparent 100%
  );
  background-size: 220% 100%;
  mix-blend-mode: multiply;
}
@keyframes ai-waiting-shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -20% 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-waiting-title::after {
    animation: none;
    background-position: 100% 0;
  }
}
</style>
