<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { Brain, ChevronDown, ChevronRight } from 'lucide-vue-next'

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

// 渐进式显示：上游可能一次性下发整段思考（导致“卡一下然后全蹦出”），
// 这里用 rAF 把 displayThinking 平滑追上真实 thinking，让思考过程“生长”而非“跳变”。
const displayThinking = ref('')
let rafId: number | undefined

function flushThinking() {
  const target = props.thinking || ''
  if (displayThinking.value.length >= target.length) {
    rafId = undefined
    return
  }
  // 剩余越多，单帧补得越多（约 5 帧内追上），既平滑又不拖沓
  const remain = target.length - displayThinking.value.length
  const step = Math.max(1, Math.ceil(remain / 5))
  displayThinking.value = target.slice(0, displayThinking.value.length + step)
  if (props.isStreaming && contentRef.value) {
    contentRef.value.scrollTop = contentRef.value.scrollHeight
  }
  rafId = requestAnimationFrame(flushThinking)
}

function ensureFlush() {
  const target = props.thinking || ''
  // 新会话/重置：真实思考变短，清空显示
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

const summary = computed(() => {
  if (!hasContent.value) {
    return props.isStreaming ? `${t('ai_thinking_progress')}...` : t('ai_no_thinking') || '无思考过程'
  }
  const sec = elapsedSeconds.value
  const timeText = sec < 1 ? t('ai_thinking_less_than_sec') : t('ai_thinking_sec').replace('{n}', String(sec))
  return props.isStreaming
    ? `${t('ai_thinking_progress')} (${timeText})`
    : `${t('ai_thinking_done')} ${timeText}`
})
</script>

<template>
  <div v-if="hasContent || isStreaming" class="ai-thinking">
    <button class="ai-thinking-toggle" :class="{ active: expanded }" @click="emit('toggle')">
      <Brain :size="13" />
      <span class="ai-thinking-label">{{ summary }}</span>
      <ChevronDown v-if="expanded" :size="13" />
      <ChevronRight v-else :size="13" />
    </button>
    <div v-if="expanded" ref="contentRef" class="ai-thinking-content">
      <pre>{{ displayThinking }}</pre>
    </div>
  </div>
</template>

<style scoped>
.ai-thinking {
  margin-bottom: 6px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-surface);
}
.ai-thinking-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  background: var(--bg-hover);
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  transition: background 0.15s;
  text-align: left;
}
.ai-thinking-toggle:hover,
.ai-thinking-toggle.active {
  background: var(--accent-bg);
  color: var(--accent);
}
.ai-thinking-label {
  flex: 1;
}
.ai-thinking-content {
  padding: 10px;
  font-size: 12px;
  line-height: 1.5;
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
</style>
