<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { Marked } from 'marked'
import type { ChatMessage } from '@/api/ai'
import AiThinking from './AiThinking.vue'
import AiToolTimeline from './AiToolTimeline.vue'

const props = defineProps<{ message: ChatMessage; index: number; isStreaming: boolean }>()
const { t } = useI18n()

const marked = new Marked()
const expandedThinking = ref(false)

function compactBlankLines(content: string): string {
  if (!content) return ''
  // 把 3 个及以上连续换行压缩为 2 个，消除无意义大段空白
  return content.replace(/\n{3,}/g, '\n\n').trim()
}

function renderMarkdown(content: string): string {
  const compacted = compactBlankLines(content)
  if (!compacted) return ''
  try {
    return marked.parse(compacted) as string
  } catch {
    return compacted
  }
}

function roleLabel() {
  return props.message.role === 'user' ? t('ai_you') : t('ai_assistant')
}
</script>

<template>
  <div class="ai-msg" :class="message.role">
    <div class="ai-msg-bubble">
      <div class="ai-msg-role">{{ roleLabel() }}</div>

      <AiThinking
        v-if="message.role === 'assistant'"
        :thinking="message.thinking || ''"
        :is-streaming="isStreaming && index === 0"
        :expanded="expandedThinking"
        @toggle="expandedThinking = !expandedThinking"
      />

      <AiToolTimeline
        v-if="message.role === 'assistant'"
        :tool-calls="message.toolCalls"
        :tool-results="message.toolResults"
      />

      <div v-if="message.role === 'assistant'" class="ai-msg-content markdown-body" v-html="renderMarkdown(message.content)"></div>
      <div v-else class="ai-msg-content">{{ compactBlankLines(message.content) }}</div>
    </div>
  </div>
</template>

<style scoped>
.ai-msg {
  display: flex;
}
.ai-msg.user {
  justify-content: flex-end;
}
.ai-msg.assistant {
  justify-content: flex-start;
}
.ai-msg-bubble {
  max-width: 96%;
  padding: 10px 12px;
  border-radius: var(--radius-lg, 12px);
  font-size: 13px;
  line-height: 1.55;
}
.ai-msg.user .ai-msg-bubble {
  background: var(--accent-bg);
  color: var(--accent);
  border-bottom-right-radius: 4px;
}
.ai-msg.assistant .ai-msg-bubble {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-bottom-left-radius: 4px;
}
.ai-msg-role {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.6;
  margin-bottom: 4px;
}
.ai-msg-content {
  white-space: pre-wrap;
  word-break: break-word;
}
.ai-msg-content :deep(h1),
.ai-msg-content :deep(h2),
.ai-msg-content :deep(h3),
.ai-msg-content :deep(h4) {
  margin: 6px 0 3px;
  font-weight: 600;
}
.ai-msg-content :deep(h1) { font-size: 15px; }
.ai-msg-content :deep(h2) { font-size: 14px; }
.ai-msg-content :deep(h3) { font-size: 13px; }
.ai-msg-content :deep(p) { margin: 2px 0; }
.ai-msg-content :deep(ul),
.ai-msg-content :deep(ol) {
  padding-left: 16px;
  margin: 2px 0;
}
.ai-msg-content :deep(li) { margin: 1px 0; }
.ai-msg-content :deep(code) {
  background: rgba(0,0,0,0.06);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
.ai-msg-content :deep(pre) {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 8px;
  overflow-x: auto;
  margin: 4px 0;
}
.ai-msg-content :deep(pre code) {
  background: none;
  padding: 0;
}
.ai-msg-content :deep(strong) { font-weight: 600; }
.ai-msg-content :deep(a) { color: var(--accent); }
.ai-msg-content :deep(blockquote) {
  border-left: 3px solid var(--accent);
  padding-left: 8px;
  margin: 4px 0;
  color: var(--text-secondary);
}
.ai-msg-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 4px 0;
  font-size: 12px;
}
.ai-msg-content :deep(th),
.ai-msg-content :deep(td) {
  padding: 4px 8px;
  border: 1px solid var(--border-subtle);
  text-align: left;
}
.ai-msg-content :deep(th) {
  background: var(--bg-surface);
  font-weight: 600;
}
.ai-msg-content :deep(tr:nth-child(2n)) {
  background: var(--bg-surface);
}
</style>
