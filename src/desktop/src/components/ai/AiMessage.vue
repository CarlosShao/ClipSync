<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { Marked } from 'marked'
import type { ChatMessage } from '@/api/ai'
import AiThinking from './AiThinking.vue'
import AiToolTimeline from './AiToolTimeline.vue'

const props = defineProps<{ message: ChatMessage; index: number; isStreaming: boolean }>()
const { t } = useI18n()

const marked = new Marked()
const expandedThinking = ref(false)

// 当前消息是否处于“正在生成”状态（仅最后一条助手消息为 true）
const isStreamingNow = computed(() => props.isStreaming && props.index === 0)
// 思考面板在生成期间强制展开：让用户看到思考过程流式“生长”，而不是生成完后一次性“蹦出来”。
// 生成结束后保持展开便于回看，用户仍可手动折叠。
watch(isStreamingNow, (now, before) => {
  if (before && !now) expandedThinking.value = true
})

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
        :thinking-started-at="message.thinkingStartedAt"
        :is-streaming="isStreamingNow"
        :expanded="expandedThinking || isStreamingNow"
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
  /* 关键：markdown 渲染走 v-html，marked 在 </p> 与 <p> 之间留有换行文本节点；
     若用 pre-wrap 会把那些换行渲染成真实空行，造成“大量空行”。这里用 normal 让 HTML 正常折叠。 */
  white-space: normal;
  word-break: break-word;
}
/* 用户原始文本（非 markdown）才需要保留其自身换行 */
.ai-msg.user .ai-msg-content {
  white-space: pre-wrap;
}
.ai-msg-content :deep(h1),
.ai-msg-content :deep(h2),
.ai-msg-content :deep(h3),
.ai-msg-content :deep(h4) {
  margin: 5px 0 2px;
  font-weight: 600;
}
.ai-msg-content :deep(h1) { font-size: 15px; }
.ai-msg-content :deep(h2) { font-size: 14px; }
.ai-msg-content :deep(h3) { font-size: 13px; }
.ai-msg-content :deep(p) { margin: 1px 0; }
.ai-msg-content :deep(ul),
.ai-msg-content :deep(ol) {
  padding-left: 18px;
  margin: 2px 0;
}
.ai-msg-content :deep(li) { margin: 1px 0; }
/* 松散列表（loose list）里每个 item 被包成 <li><p>…</p></li>，
   内层 <p> 的 margin 会额外撑出空白，这里清零 */
.ai-msg-content :deep(li > p) { margin: 0; }
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
