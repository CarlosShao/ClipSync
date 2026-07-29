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
    return t('ai_thinking_loading') || '正在思考'
  }
  if (props.isStreaming) {
    return t('ai_thinking_deep') || '深度思考'
  }
  const sec = elapsedSeconds.value
  const timeText = sec < 1
    ? (t('ai_thinking_less_than_sec') || '少于 1 秒')
    : (t('ai_thinking_sec') || '{n} 秒').replace('{n}', String(sec))
  return `${t('ai_thinking_deep_done') || '已深度思考'} ${timeText}`
})
</script>

<template>
  <!-- 阶段 1：loading 占位。未收到任何数据，只显示“正在思考”+ 扫光 -->
  <div v-if="!hasContent && isStreaming" class="ai-thinking-loading">
    <span class="ai-thinking-shimmer-bar"></span>
    <span class="ai-thinking-loading-text">{{ t('ai_thinking_loading') || '正在思考' }}</span>
  </div>

  <!-- 阶段 2/3：有内容后切换为深度思考折叠条 -->
  <div v-else-if="hasContent" class="ai-thinking">
    <button
      class="ai-thinking-toggle"
      :class="{ active: expanded, streaming: isStreaming }"
      @click="emit('toggle')"
    >
      <span class="ai-thinking-indicator" :class="{ pulse: isStreaming, done: !isStreaming }"></span>
      <CheckCircle2 v-if="!isStreaming" :size="12" class="ai-thinking-done-icon" />
      <span class="ai-thinking-label" :class="{ streaming: isStreaming }">{{ label }}</span>
      <ChevronDown v-if="expanded" :size="13" />
      <ChevronRight v-else :size="13" />
    </button>

    <div v-if="expanded" ref="contentRef" class="ai-thinking-content">
      <pre>{{ displayThinking }}</pre>
    </div>
  </div>
</template>

<style scoped>
/* ========== 阶段 1：loading 占位 ========== */
.ai-thinking-loading {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  margin-bottom: 6px;
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  overflow: hidden;
  max-width: 100%;
}

.ai-thinking-shimmer-bar {
  position: absolute;
  top: 0;
  left: 0;
  width: 40%;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--accent-bg) 50%,
    transparent 100%
  );
  animation: ai-thinking-shimmer-bar 1.6s linear infinite;
  pointer-events: none;
}

.ai-thinking-loading-text {
  position: relative;
  z-index: 1;
  font-size: 12px;
  font-weight: 600;
  background: linear-gradient(
    90deg,
    var(--text-secondary) 0%,
    var(--text-primary) 45%,
    var(--text-primary) 55%,
    var(--text-secondary) 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: ai-thinking-shimmer-text 1.6s linear infinite;
}

@keyframes ai-thinking-shimmer-bar {
  0% { transform: translateX(-150%); }
  100% { transform: translateX(250%); }
}

@keyframes ai-thinking-shimmer-text {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* ========== 阶段 2/3：深度思考折叠条 ========== */
.ai-thinking {
  display: inline-flex;
  flex-direction: column;
  margin-bottom: 6px;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  max-width: 100%;
}

.ai-thinking-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  transition: background 0.15s, color 0.15s;
  text-align: left;
  white-space: nowrap;
}
.ai-thinking-toggle:hover,
.ai-thinking-toggle.active {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.ai-thinking-indicator {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-tertiary);
}
.ai-thinking-indicator.pulse {
  background: var(--accent);
  box-shadow: 0 0 0 0 var(--accent);
  animation: ai-thinking-pulse 1.4s ease-in-out infinite;
}
.ai-thinking-indicator.done {
  display: none;
}
.ai-thinking-done-icon {
  flex-shrink: 0;
  color: var(--success, #16a34a);
}

.ai-thinking-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-thinking-label.streaming {
  background: linear-gradient(
    90deg,
    var(--text-secondary) 0%,
    var(--accent) 45%,
    var(--accent) 55%,
    var(--text-secondary) 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: ai-thinking-shimmer-text 1.6s linear infinite;
}

.ai-thinking-content {
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-secondary);
  border-top: 1px solid var(--border-subtle);
  max-height: 280px;
  overflow-y: auto;
}
.ai-thinking-content pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono, monospace);
}

@keyframes ai-thinking-pulse {
  0%, 100% {
    opacity: 0.4;
    box-shadow: 0 0 0 0 rgba(var(--accent-rgb, 99 102 241), 0.35);
  }
  50% {
    opacity: 1;
    box-shadow: 0 0 8px 3px rgba(var(--accent-rgb, 99 102 241), 0.15);
  }
}
</style>
