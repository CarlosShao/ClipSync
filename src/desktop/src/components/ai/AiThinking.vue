<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { ChevronDown, ChevronRight, CheckCircle2 } from 'lucide-vue-next'

/**
 * AiThinking — AI 思考过程面板
 *
 * 阶段 1（loading 占位）：尚未收到任何数据时，显示“正在思考”轻量提示条，
 *                        文字带从左到右扫光动画。
 * 阶段 2（深度思考）：收到 thinking 内容后，切换为深色折叠条；
 *                    “深度思考”四字同样带扫光，点击展开看 reasoning。
 * 阶段 3（完成）：思考结束 → 对勾 + “已深度思考(N秒)”。
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

// ==================== 折叠按钮文案 ====================
const label = computed(() => {
  if (!hasContent.value) {
    return t('ai_thinking_loading', '正在思考')
  }
  if (props.isStreaming) {
    return t('ai_thinking_deep', '深度思考')
  }
  const sec = elapsedSeconds.value
  const timeText = sec < 1
    ? t('ai_thinking_less_than_sec', '少于 1 秒')
    : t('ai_thinking_sec', '{n} 秒').replace('{n}', String(sec))
  return `${t('ai_thinking_deep_done', '已深度思考')} ${timeText}`
})
// 头部右侧的耗时文案（思考中显示实时秒数，结束后显示总耗时）
const timeText = computed(() => {
  const sec = elapsedSeconds.value
  if (sec < 1) return t('ai_thinking_less_than_sec', '少于 1 秒')
  return t('ai_thinking_sec', '{n} 秒').replace('{n}', String(sec))
})
</script>

<template>
  <!-- 阶段 1：loading 占位。未收到任何数据，只显示“正在思考”在文字表面的扫光 -->
  <div v-if="!hasContent && isStreaming" class="ai-thinking-card ai-thinking-card--loading">
    <span class="ai-thinking-spinner" />
    <span class="ai-thinking-loading-text">{{ t('ai_thinking_loading', '正在思考') }}</span>
  </div>

  <!-- 阶段 2/3：有内容后切换为深度思考卡片 -->
  <div v-else-if="hasContent" class="ai-thinking-card" :class="{ streaming: isStreaming }">
    <button
      class="ai-thinking-head"
      :class="{ active: expanded }"
      @click="emit('toggle')"
    >
      <span class="ai-thinking-brain">
        <CheckCircle2 v-if="!isStreaming" :size="13" class="ai-thinking-done-icon" />
        <span v-else class="ai-thinking-pulse-dot" />
      </span>
      <span class="ai-thinking-title">{{ t('ai_thinking_deep', '深度思考') }}</span>
      <span class="ai-thinking-time">{{ timeText }}</span>
      <span class="ai-thinking-spacer" />
      <ChevronDown v-if="expanded" :size="14" class="ai-thinking-chev" />
      <ChevronRight v-else :size="14" class="ai-thinking-chev" />
    </button>

    <div v-if="expanded" ref="contentRef" class="ai-thinking-body">
      <pre class="ai-thinking-pre">{{ displayThinking }}</pre>
    </div>
  </div>
</template>

<style scoped>
/* ============ 通用卡片 ============ */
.ai-thinking-card {
  display: flex;
  flex-direction: column;
  margin: 8px 0;
  border-radius: 12px;
  background: var(--bg-surface, #fff);
  border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.08));
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04);
  overflow: hidden;
  max-width: 100%;
  transition: box-shadow 0.2s ease, border-color 0.2s ease;
}
.ai-thinking-card:hover {
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.1);
}
/* 思考中卡片左侧加一道 accent 竖条，呼应“进行中的工作流” */
.ai-thinking-card.streaming {
  border-left: 3px solid var(--accent, #6366f1);
}

/* ============ loading 卡片 ============ */
.ai-thinking-card--loading {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
}
.ai-thinking-spinner {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--border-default, #e2e8f0);
  border-top-color: var(--accent, #6366f1);
  animation: ai-think-spin 0.8s linear infinite;
  flex-shrink: 0;
}
.ai-thinking-loading-text {
  position: relative;
  font-size: 13px;
  font-weight: 600;
  display: inline-block;
  background: linear-gradient(
    90deg,
    var(--text-tertiary, #94a3b8) 0%,
    var(--text-tertiary, #94a3b8) 20%,
    var(--text-primary, #0f172a) 45%,
    var(--accent, #6366f1) 50%,
    var(--text-primary, #0f172a) 55%,
    var(--text-tertiary, #94a3b8) 80%,
    var(--text-tertiary, #94a3b8) 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: ai-thinking-shimmer-text 1.6s linear infinite;
}

/* ============ 头部 ============ */
.ai-thinking-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary, #475569);
  text-align: left;
  width: 100%;
  transition: background 0.15s ease, color 0.15s ease;
}
.ai-thinking-head:hover,
.ai-thinking-head.active {
  background: var(--bg-hover, rgba(99, 102, 241, 0.06));
  color: var(--text-primary, #0f172a);
}
.ai-thinking-brain {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: rgba(99, 102, 241, 0.12);
  color: var(--accent, #6366f1);
  flex-shrink: 0;
}
.ai-thinking-pulse-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent, #6366f1);
  box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.5);
  animation: ai-thinking-pulse 1.4s ease-in-out infinite;
}
.ai-thinking-done-icon {
  color: var(--success, #16a34a);
}
.ai-thinking-title {
  white-space: nowrap;
}
.ai-thinking-time {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-tertiary, #94a3b8);
  white-space: nowrap;
}
.ai-thinking-spacer {
  flex: 1;
  min-width: 8px;
}
.ai-thinking-chev {
  color: var(--text-tertiary, #94a3b8);
  flex-shrink: 0;
}

/* ============ 内容区 ============ */
.ai-thinking-body {
  position: relative;
  padding: 4px 14px 14px 16px;
  border-top: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.06));
  max-height: 320px;
  overflow-y: auto;
}
/* 左侧 accent 竖条，强调“思考过程”的层次感 */
.ai-thinking-body::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 4px;
  bottom: 14px;
  width: 2px;
  border-radius: 2px;
  background: linear-gradient(180deg, rgba(99, 102, 241, 0.35), rgba(99, 102, 241, 0.08));
}
.ai-thinking-pre {
  margin: 0;
  padding: 8px 0 0 10px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary, #475569);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

@keyframes ai-thinking-shimmer-text {
  0% { background-position: 180% 0; }
  100% { background-position: -180% 0; }
}
@keyframes ai-think-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
@keyframes ai-thinking-pulse {
  0%, 100% { opacity: 0.5; box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4); }
  50% { opacity: 1; box-shadow: 0 0 0 5px rgba(99, 102, 241, 0); }
}
</style>
