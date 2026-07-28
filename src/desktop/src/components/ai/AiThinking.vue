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
})

onUnmounted(stopTimer)

watch(() => props.isStreaming, (v) => {
  if (v) startTimer()
  else stopTimer()
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
    <div v-if="expanded" class="ai-thinking-content">
      <pre>{{ thinking }}</pre>
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
