<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { Marked } from 'marked'
import { sanitizeHtml } from '@/utils/html'
import type { AgentRun } from '@/api/ai'
import AiThinkingCollapse from './AiThinkingCollapse.vue'
import AiToolTimeline from './AiToolTimeline.vue'
import { Loader2, CheckCircle2, XCircle } from 'lucide-vue-next'

const props = defineProps<{ run: AgentRun; isStreaming: boolean }>()
const { t } = useI18n()

const marked = new Marked({ gfm: true, breaks: false })
const expandedThinking = ref(false)

// 该卡片自身是否处于“进行中”（仅此卡片还活着且状态为 planning/working/synthesis 时）
const runActive = computed(
  () => props.run.status === 'planning' || props.run.status === 'working' || props.run.status === 'synthesis',
)
const isStreamingNow = computed(() => props.isStreaming && runActive.value)

const statusText = computed(() => {
  switch (props.run.status) {
    case 'planning':
      return t('ai_agent_planning')
    case 'working':
      return t('ai_agent_working')
    case 'synthesis':
      return t('ai_agent_synthesis')
    case 'done':
      return t('ai_agent_done')
    case 'failed':
      return t('ai_agent_failed')
    default:
      return props.run.status
  }
})

// 卡片标题：按 kind 翻译成用户友好的中文，避免“协调器”这类看不懂的名字。
// coordinator → 任务规划；synthesis → 整合答案；worker 尽量保留后端给的角色名。
const displayName = computed(() => {
  if (props.run.kind === 'coordinator') return t('ai_agent_coordinator_label', '任务规划')
  if (props.run.kind === 'synthesis') return t('ai_agent_synthesis_label', '整合答案')
  return props.run.name || t('ai_agent_worker_label', '子代理')
})

function compactBlankLines(content: string): string {
  if (!content) return ''
  return content.replace(/\n{3,}/g, '\n\n').trim()
}

function renderMarkdown(content: string): string {
  const compacted = compactBlankLines(content)
  if (!compacted) return ''
  try {
    return sanitizeHtml(marked.parse(compacted) as string)
  } catch {
    return sanitizeHtml(compacted)
  }
}

const hasThinking = computed(() => (props.run.thinking?.length || 0) > 0)
const hasContent = computed(() => (props.run.content?.trim().length || 0) > 0)
</script>

<template>
  <div class="ai-agent-run" :class="['status-' + run.status, { 'is-active': runActive }]">
    <div class="ai-agent-run-head">
      <Loader2 v-if="runActive" :size="13" class="ai-agent-run-spin" />
      <CheckCircle2 v-else-if="run.status === 'done'" :size="13" class="ai-agent-run-ok" />
      <XCircle v-else-if="run.status === 'failed'" :size="13" class="ai-agent-run-err" />
      <span class="ai-agent-run-name">{{ displayName }}</span>
      <span class="ai-agent-run-status">{{ statusText }}</span>
      <span v-if="run.error" class="ai-agent-run-err-text" :title="run.error">{{ run.error }}</span>
    </div>

    <AiThinkingCollapse
      v-if="hasThinking"
      :thinking="run.thinking || ''"
      :thinking-started-at="run.thinkingStartedAt"
      :is-streaming="isStreamingNow && run.thinkingActive !== false"
      :expanded="expandedThinking || isStreamingNow"
      @toggle="expandedThinking = !expandedThinking"
    />

    <AiToolTimeline
      v-if="run.toolCalls && run.toolCalls.length"
      :tool-calls="run.toolCalls"
      :tool-results="run.toolResults"
      :agent-name="displayName"
    />

    <div v-if="hasContent" class="ai-agent-run-content markdown-body" v-html="renderMarkdown(run.content || '')"></div>
  </div>
</template>

<style scoped>
.ai-agent-run {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  margin-bottom: 6px;
  max-width: 100%;
  overflow: hidden;
}
.ai-agent-run.status-failed {
  border-color: var(--danger);
}
.ai-agent-run-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}
.ai-agent-run-spin {
  color: var(--accent);
  animation: spin 1s linear infinite;
}
.ai-agent-run-ok {
  color: var(--success);
}
.ai-agent-run-err {
  color: var(--danger);
}
.ai-agent-run-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-agent-run-status {
  color: var(--text-tertiary);
  font-weight: 400;
}
.ai-agent-run-err-text {
  color: var(--danger);
  font-weight: 400;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 50%;
}
.ai-agent-run-content {
  padding: 0 12px 8px;
  font-size: 12px;
  line-height: 1.5;
  white-space: normal;
  word-break: break-word;
  color: var(--text-secondary);
}
.ai-agent-run-content :deep(h1),
.ai-agent-run-content :deep(h2),
.ai-agent-run-content :deep(h3),
.ai-agent-run-content :deep(h4) {
  margin: 4px 0 2px;
  font-weight: 600;
}
.ai-agent-run-content :deep(h1) {
  font-size: 13px;
}
.ai-agent-run-content :deep(h2) {
  font-size: 13px;
}
.ai-agent-run-content :deep(h3) {
  font-size: 12px;
}
.ai-agent-run-content :deep(p) {
  margin: 1px 0;
}
.ai-agent-run-content :deep(ul),
.ai-agent-run-content :deep(ol) {
  padding-left: 18px;
  margin: 2px 0;
}
.ai-agent-run-content :deep(li) {
  margin: 1px 0;
}
.ai-agent-run-content :deep(li > p) {
  margin: 0;
}
.ai-agent-run-content :deep(code) {
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}
.ai-agent-run-content :deep(pre) {
  background: var(--bg-hover);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 8px;
  overflow-x: auto;
  margin: 4px 0;
}
.ai-agent-run-content :deep(pre code) {
  background: none;
  padding: 0;
}
.ai-agent-run-content :deep(strong) {
  font-weight: 600;
}
.ai-agent-run-content :deep(blockquote) {
  border-left: 3px solid var(--accent);
  padding-left: 8px;
  margin: 4px 0;
  color: var(--text-secondary);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
