<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { Marked } from 'marked'
import type { ChatMessage } from '@/api/ai'
import AiThinking from './AiThinking.vue'
import AiToolTimeline from './AiToolTimeline.vue'
import AiAgentRun from './AiAgentRun.vue'

const props = defineProps<{ message: ChatMessage; index: number; isStreaming: boolean }>()
const { t } = useI18n()

// GFM 已默认开启（表格、删除线、任务列表等）；breaks:false 保持标准 markdown 段落语义。
const marked = new Marked({ gfm: true, breaks: false })
const expandedThinking = ref(false)

// 当前消息是否处于“正在生成”状态（仅最后一条助手消息为 true）
const isStreamingNow = computed(() => props.isStreaming && props.index === 0)

// 思考是否正在流式生长：有 thinking 内容且 thinkingActive 仍为 true
const isThinkingStreaming = computed(() =>
  isStreamingNow.value &&
  (props.message.thinking?.length || 0) > 0 &&
  props.message.thinkingActive !== false,
)

// 思考是否已结束：有内容，但已经停止（工具开始 / 答案开始 / 流结束）
const isThinkingDone = computed(() =>
  (props.message.thinking?.length || 0) > 0 &&
  (!isStreamingNow.value || props.message.thinkingActive === false),
)

const hasAgentRuns = computed(() => (props.message.agentRuns?.length || 0) > 0)
const hasToolCalls = computed(() => (props.message.toolCalls?.length || 0) > 0)

// loading 占位：尚未收到任何有效阶段数据（无 thinking、无答案、无工具、无 agent 运行卡片）
const isLoading = computed(() =>
  isStreamingNow.value &&
  !isThinkingStreaming.value &&
  !isThinkingDone.value &&
  !hasAgentRuns.value &&
  !hasToolCalls.value &&
  (props.message.content?.trim().length || 0) === 0,
)

// 当主消息有全局 thinking 流正在展开时，暂时隐藏 agentRuns；否则立即展示 Agent 运行卡片
const visibleAgentRuns = computed(() => {
  if (isThinkingStreaming.value) return []
  return props.message.agentRuns || []
})

const visibleToolCalls = computed(() => {
  if (isThinkingStreaming.value) return []
  return props.message.toolCalls || []
})

// 是否显示思考组件（loading 占位 / 深度思考 / 已完成）
const showThinking = computed(() => isLoading.value || isThinkingStreaming.value || isThinkingDone.value)
// 传给 AiThinking 的 isStreaming：loading 占位和 thinking 流式阶段都扫光
const thinkingIsStreaming = computed(() => isLoading.value || isThinkingStreaming.value)

// 思考阶段强制展开，让用户看到 reasoning 流式生长；结束后保持展开便于回看
watch(isThinkingStreaming, (now, before) => {
  if (before && !now) expandedThinking.value = true
})

function compactBlankLines(content: string): string {
  if (!content) return ''
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

      <!-- 阶段 1/2/3：loading 占位 / 深度思考 / 思考完成 -->
      <AiThinking
        v-if="message.role === 'assistant' && showThinking"
        :thinking="message.thinking || ''"
        :thinking-started-at="message.thinkingStartedAt"
        :is-streaming="thinkingIsStreaming"
        :expanded="expandedThinking || isThinkingStreaming"
        @toggle="expandedThinking = !expandedThinking"
      />

      <!-- 工具调用日志：仅在思考结束后出现 -->
      <AiToolTimeline
        v-if="message.role === 'assistant' && visibleToolCalls.length"
        :tool-calls="visibleToolCalls"
        :tool-results="message.toolResults"
      />

      <!-- 多代理并行模式：子代理运行状态卡片，仅在思考结束后出现 -->
      <template v-if="message.role === 'assistant' && visibleAgentRuns.length">
        <AiAgentRun
          v-for="run in visibleAgentRuns"
          :key="run.id"
          :run="run"
          :is-streaming="isStreaming"
        />
      </template>

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
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 96%;
  min-width: 0;
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
  white-space: normal;
  word-break: break-word;
  /* #218：长表格/长代码/超长无空格内容在气泡内横向滚动，而非把布局撑破 */
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
}
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
