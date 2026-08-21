<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import AiThinkingOrb from './AiThinkingOrb.vue'

/**
 * AiThinking — AI 思考过程面板（按 agent-workflow-ui skill 基准改造）
 *
 * 结构：
 *   [ThinkingOrb(composing 繁忙丝带 / breathing 完成圆环)] 深度思考(shimmer)
 *   思考过程 markdown（逐字打字机出现，点击标题展开/收起）
 *
 * 三阶段：
 *   阶段1 运行中：orb=composing，思考内容逐字出现，标题 shimmer 流动
 *   阶段2 完成：orb→breathing，标题 shimmer 停止（paused class）
 *   阶段3 进入下一阶段：thinking 组件不消失不收起，始终可点击展开
 */

const props = defineProps<{
  thinking: string
  thinkingStartedAt?: number
  isStreaming?: boolean
  expanded?: boolean
}>()
const emit = defineEmits<{ toggle: [] }>()
const { t } = useI18n()

const hasContent = computed(() => (props.thinking?.length || 0) > 0)
const contentRef = ref<HTMLElement | null>(null)

// ==================== 渐进式释放逻辑 ====================
const displayThinking = ref('')
let rafId: number | undefined
const CHARS_PER_FRAME = 6

function flushThinking() {
  const target = props.thinking || ''
  if (displayThinking.value.length >= target.length) {
    rafId = undefined
    return
  }
  displayThinking.value = target.slice(0, displayThinking.value.length + CHARS_PER_FRAME)
  if (props.isStreaming && contentRef.value) {
    contentRef.value.scrollTop = contentRef.value.scrollHeight
  }
  rafId = requestAnimationFrame(flushThinking)
}

function ensureFlush() {
  const target = props.thinking || ''
  if (target.length < displayThinking.value.length) displayThinking.value = ''
  if (displayThinking.value.length < target.length && rafId === undefined) {
    rafId = requestAnimationFrame(flushThinking)
  }
}

watch(
  () => props.thinking,
  () => {
    ensureFlush()
    if (props.isStreaming && contentRef.value) {
      contentRef.value.scrollTop = contentRef.value.scrollHeight
    }
  },
)

watch(
  () => props.thinkingStartedAt,
  () => {
    displayThinking.value = ''
    if (rafId !== undefined) {
      cancelAnimationFrame(rafId)
      rafId = undefined
    }
    ensureFlush()
  },
)

watch(
  () => props.expanded,
  (now) => {
    if (now && props.thinking?.length && displayThinking.value.length >= props.thinking.length) {
      displayThinking.value = ''
      rafId = requestAnimationFrame(flushThinking)
    }
  },
)

// ==================== 计时器（思考耗时） ====================
const elapsedSeconds = ref(0)
let timer: number | undefined

function updateElapsed() {
  const start = props.thinkingStartedAt
  if (!start) {
    elapsedSeconds.value = 0
    return
  }
  elapsedSeconds.value = Math.max(0, Math.floor((Date.now() - start) / 1000))
}

function startTimer() {
  updateElapsed()
  if (timer) return
  timer = window.setInterval(updateElapsed, 1000)
}

function stopTimer() {
  if (timer) {
    window.clearInterval(timer)
    timer = undefined
  }
}

onMounted(() => {
  if (props.isStreaming) startTimer()
  else updateElapsed()
  ensureFlush()
})

onUnmounted(() => {
  stopTimer()
  if (rafId !== undefined) cancelAnimationFrame(rafId)
})

watch(() => props.isStreaming, (v) => {
  if (v) startTimer()
  else {
    stopTimer()
    ensureFlush()
  }
})

// ==================== 标题 ====================
// 进行中：「深度思考」；完成：`深度思考 · {n}s`（保持可点击入口形态，不做"已思考 Xs"摘要）
const label = computed(() => {
  if (!hasContent.value) {
    return t('ai_thinking_loading', '正在思考中')
  }
  const sec = elapsedSeconds.value
  if (sec < 1) return t('ai_thinking_deep', '深度思考')
  return `${t('ai_thinking_deep', '深度思考')} · ${t('ai_thinking_sec', '{n} 秒').replace('{n}', String(sec))}`
})

// 耗时（头部右侧）
const timeText = computed(() => {
  const sec = elapsedSeconds.value
  if (sec < 1) return ''
  return t('ai_thinking_sec', '{n} 秒').replace('{n}', String(sec))
})
</script>

<template>
  <!-- 阶段 1：加载态（无 thinking 内容时）—— orb + 「正在思考中」 -->
  <div v-if="!hasContent && isStreaming" class="ai-think-loading">
    <AiThinkingOrb class="ai-think-orb" state="composing" :size="16" :speed="1.4" />
    <span class="ai-think-loading-text">{{ t('ai_thinking_loading', '正在思考中') }}</span>
  </div>

  <!-- 阶段 2/3：深度思考面板 -->
  <div v-else-if="hasContent" class="ai-think">
    <div class="ai-think-head" @click="emit('toggle')">
      <!-- 左 orb：进行中=composing 繁忙丝带；完成=breathing 圆环 -->
      <AiThinkingOrb
        class="ai-think-orb"
        :state="isStreaming ? 'composing' : 'breathing'"
        :size="24"
      />
      <span
        class="ai-think-title"
        :class="{ paused: !isStreaming }"
        :data-text="label"
      >{{ label }}</span>
      <span v-if="timeText && isStreaming" class="ai-think-time">{{ timeText }}</span>
      <ChevronRight v-if="!expanded" :size="13" class="ai-think-chev" />
      <ChevronDown v-else :size="13" class="ai-think-chev" />
    </div>

    <!-- 思考内容：markdown 样式（左竖线 + 浅底 + 等宽），默认展开 -->
    <div class="ai-think-body" :class="{ collapsed: !expanded }">
      <pre ref="contentRef" class="ai-think-md">{{ displayThinking }}</pre>
      <span class="ai-think-caret" v-if="isStreaming && displayThinking.length < (props.thinking?.length || 0)"></span>
    </div>
  </div>
</template>

<style scoped>
/* ============ 阶段 1：加载态（无思考内容时） ============ */
.ai-think-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 28px;
  padding: 0 2px;
  margin: 4px 0;
  user-select: none;
}
.ai-think-orb {
  flex-shrink: 0;
  display: block;
}
.ai-think-loading-text {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-secondary, #52525b);
}

/* ============ 阶段 2/3：深度思考面板 ============ */
.ai-think {
  margin: 8px 0 0;
  overflow: hidden;
}
.ai-think-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 2px;
  cursor: pointer;
  user-select: none;
}
.ai-think-title {
  position: relative;
  display: inline-block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary, #52525b);
}
/* 字内笔画间 shimmer：与 demo 原版一致
   （transparent 基色 + mix-blend-mode: screen/multiply → 文字永不消失，只有高光带在字内流动）
   ⚠️ 必须用 background-image 而不是 background 简写——简写会清掉 background-clip:text */
.ai-think-title::after {
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
  animation: ai-think-shimmer 2.5s ease-in-out infinite;
  mix-blend-mode: screen;
}
html.light .ai-think-title::after {
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
/* 思考完成 → shimmer 停止（明确"思考完毕"反馈） */
.ai-think-title.paused::after {
  animation: none;
  background-position: 100% 0;
}
@keyframes ai-think-shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -20% 0;
  }
}
.ai-think-time {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-tertiary, #94a3b8);
  font-variant-numeric: tabular-nums;
}
.ai-think-chev {
  color: var(--text-tertiary, #94a3b8);
  margin-left: auto;
  flex-shrink: 0;
}

/* 思考内容：markdown 样式（左竖线 + 浅底 + 等宽）
   不要 max-height 截断：思考可能上千字，外层消息容器自带滚动；截断会让用户看不到结尾 */
.ai-think-body {
  transition: opacity 0.25s ease;
  max-height: none;
  opacity: 1;
  padding-top: 8px;
  padding-left: 4px;
}
.ai-think-body.collapsed {
  opacity: 0;
  max-height: 0;
  overflow: hidden;
  padding-top: 0;
  padding-left: 0;
  transition: max-height 0.3s ease-in-out, opacity 0.25s ease, padding 0.2s ease;
  padding-top: 0;
}
.ai-think-md {
  font-size: 12.5px;
  color: var(--text-secondary, #52525b);
  line-height: 1.7;
  border-left: 2px solid var(--border-neutral-l1, rgba(115,115,115,0.25));
  padding: 4px 0 4px 12px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  background: transparent;
}
/* 思考中打字机光标 */
.ai-think-caret {
  display: inline-block;
  width: 2px;
  height: 1.1em;
  background: var(--text-secondary, #52525b);
  vertical-align: text-bottom;
  margin-left: 1px;
  animation: ai-think-blink 1s step-end infinite;
}
@keyframes ai-think-blink {
  50% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-think-title::after,
  .ai-think-caret {
    animation: none;
  }
}
</style>
