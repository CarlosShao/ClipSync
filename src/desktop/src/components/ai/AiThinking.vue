<script setup lang="ts">
import { computed } from 'vue'
import { Brain, ChevronDown, ChevronRight } from 'lucide-vue-next'

const props = defineProps<{
  thinking: string
  isStreaming?: boolean
  expanded?: boolean
}>()
const emit = defineEmits<{ toggle: [] }>()

const charCount = computed(() => props.thinking?.length || 0)
const hasContent = computed(() => charCount.value > 0)
const summary = computed(() => {
  if (!hasContent.value) return props.isStreaming ? '思考中...' : '无思考过程'
  return props.isStreaming ? `思考中 (${charCount.value} 字)` : `已思考 ${charCount.value} 字`
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
