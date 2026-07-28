<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { Marked } from 'marked'
import type { ChatMessage } from '@/api/ai'
import { ChevronDown, ChevronRight, Brain } from 'lucide-vue-next'

const props = defineProps<{ messages: ChatMessage[]; isStreaming: boolean }>()
const { t } = useI18n()

const scrollRef = ref<HTMLElement | null>(null)
const marked = new Marked()
const expandedThinking = ref<Set<number>>(new Set())

function scrollToBottom() {
  nextTick(() => {
    const el = scrollRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

watch(
  () => props.messages.length,
  () => scrollToBottom(),
)
watch(
  () => (props.messages[props.messages.length - 1]?.content || ''),
  () => scrollToBottom(),
)

function renderMarkdown(content: string): string {
  if (!content) return ''
  try {
    return marked.parse(content) as string
  } catch {
    return content
  }
}

function toggleThinking(index: number) {
  if (expandedThinking.value.has(index)) {
    expandedThinking.value.delete(index)
  } else {
    expandedThinking.value.add(index)
  }
}

function formatToolResult(content: string): string {
  try {
    const parsed = JSON.parse(content)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return content
  }
}

const TOOL_NAMES: Record<string, string> = {
  get_clipboard_stats: '获取统计数据',
  search_clips: '搜索剪贴板',
  get_clip_details: '获取详情',
  get_recent_clips: '获取最近记录',
  analyze_clip_usage: '分析使用模式',
  create_workflow: '创建工作流',
  execute_workflow_step: '执行工作流步骤',
  batch_favorite: '批量收藏',
  batch_delete: '批量删除',
  organize_by_type: '按类型整理'
}

function getToolName(name: string): string {
  return TOOL_NAMES[name] || name
}

function getToolDescription(name: string): string {
  const descriptions: Record<string, string> = {
    get_clipboard_stats: '获取剪贴板统计数据',
    search_clips: '搜索剪贴板内容',
    get_clip_details: '获取条目详细信息',
    get_recent_clips: '获取最近记录',
    analyze_clip_usage: '分析使用模式',
    create_workflow: '创建工作流',
    execute_workflow_step: '执行工作流步骤',
    batch_favorite: '批量收藏条目',
    batch_delete: '批量删除条目',
    organize_by_type: '按类型整理内容'
  }
  return descriptions[name] || ''
}

function hasToolResult(m: any, index: number): boolean {
  return m.toolResults && m.toolResults.length > index
}
</script>

<template>
  <div ref="scrollRef" class="ai-msg-list">
    <div v-if="messages.length === 0" class="ai-msg-empty">
      {{ t('ai_chat_empty') }}
    </div>

    <div v-for="(m, i) in messages" :key="i" class="ai-msg" :class="m.role">
      <div class="ai-msg-bubble">
        <div class="ai-msg-role">{{ m.role === 'user' ? t('ai_you') : t('ai_assistant') }}</div>
        
        <!-- Thinking 过程展示 -->
        <div v-if="m.thinking && m.role === 'assistant'" class="ai-thinking">
          <button class="ai-thinking-toggle" @click="toggleThinking(i)">
            <Brain :size="14" />
            <span>思考过程</span>
            <ChevronDown v-if="expandedThinking.has(i)" :size="14" />
            <ChevronRight v-else :size="14" />
          </button>
          <div v-if="expandedThinking.has(i)" class="ai-thinking-content">
            {{ m.thinking }}
          </div>
        </div>

        <!-- 工具调用展示 - 工作流模式 -->
        <div v-if="m.toolCalls && m.toolCalls.length > 0" class="ai-workflow">
          <div class="ai-workflow-header">
            <span class="ai-workflow-title">工作流步骤</span>
            <span class="ai-workflow-step">{{ m.toolCalls.length }} 个步骤</span>
          </div>
          <div v-for="(tc, j) in m.toolCalls" :key="j" class="ai-workflow-step">
            <div class="ai-workflow-step-num">{{ j + 1 }}</div>
            <div class="ai-workflow-step-content">
              <div class="ai-workflow-step-name">{{ getToolName(tc.name) }}</div>
              <div class="ai-workflow-step-desc">{{ getToolDescription(tc.name) }}</div>
              <div v-if="hasToolResult(m, j)" class="ai-workflow-step-result">
                <span class="ai-workflow-step-status">✓ 完成</span>
              </div>
              <div v-else class="ai-workflow-step-status">⏳ 执行中...</div>
            </div>
          </div>
        </div>

        <!-- 工具结果展示 -->
        <div v-if="m.toolResults && m.toolResults.length > 0" class="ai-tool-results">
          <div v-for="(tr, j) in m.toolResults" :key="j" class="ai-tool-result">
            <div class="ai-tool-result-header">工具结果</div>
            <pre class="ai-tool-result-content">{{ formatToolResult(tr.content) }}</pre>
          </div>
        </div>

        <!-- 普通内容 -->
        <div v-if="m.role === 'assistant'" class="ai-msg-content markdown-body" v-html="renderMarkdown(m.content)"></div>
        <div v-else class="ai-msg-content">{{ m.content }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-msg-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ai-msg-empty {
  margin: auto;
  color: var(--text-tertiary);
  font-size: 13px;
  text-align: center;
  padding: 24px;
}
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
  max-width: 92%;
  padding: 10px 14px;
  border-radius: var(--radius-lg, 12px);
  font-size: 13px;
  line-height: 1.6;
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
  margin-bottom: 6px;
}
.ai-msg-content {
  white-space: pre-wrap;
  word-break: break-word;
}
/* Markdown 样式 - 紧凑 */
.ai-msg-content :deep(h1),
.ai-msg-content :deep(h2),
.ai-msg-content :deep(h3),
.ai-msg-content :deep(h4) {
  margin: 8px 0 4px;
  font-weight: 600;
}
.ai-msg-content :deep(h1) { font-size: 16px; }
.ai-msg-content :deep(h2) { font-size: 15px; }
.ai-msg-content :deep(h3) { font-size: 14px; }
.ai-msg-content :deep(p) { margin: 4px 0; }
.ai-msg-content :deep(ul),
.ai-msg-content :deep(ol) {
  padding-left: 18px;
  margin: 4px 0;
}
.ai-msg-content :deep(li) { margin: 2px 0; }
.ai-msg-content :deep(code) {
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
.ai-msg-content :deep(pre) {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 10px;
  overflow-x: auto;
  margin: 6px 0;
}
.ai-msg-content :deep(pre code) {
  background: none;
  padding: 0;
}
.ai-msg-content :deep(strong) { font-weight: 600; }
.ai-msg-content :deep(a) { color: var(--accent); }
.ai-msg-content :deep(blockquote) {
  border-left: 3px solid var(--accent);
  padding-left: 10px;
  margin: 6px 0;
  color: var(--text-secondary);
}
.ai-msg-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 6px 0;
  font-size: 12px;
}
.ai-msg-content :deep(th),
.ai-msg-content :deep(td) {
  padding: 6px 10px;
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

/* Thinking 过程样式 */
.ai-thinking {
  margin-bottom: 6px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
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
}
.ai-thinking-toggle:hover {
  background: var(--bg-active);
}
.ai-thinking-content {
  padding: 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border-top: 1px solid var(--border-subtle);
  white-space: pre-wrap;
  max-height: 250px;
  overflow-y: auto;
}

/* 工作流样式 - 紧凑 */
.ai-workflow {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
  margin-bottom: 6px;
}
.ai-workflow-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: var(--accent-bg);
  border-bottom: 1px solid var(--border-subtle);
}
.ai-workflow-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}
.ai-workflow-step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-subtle);
}
.ai-workflow-step:last-child {
  border-bottom: none;
}
.ai-workflow-step-num {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--accent-bg);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
}
.ai-workflow-step-content {
  flex: 1;
}
.ai-workflow-step-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 2px;
}
.ai-workflow-step-desc {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 2px;
}
.ai-workflow-step-status {
  font-size: 11px;
  color: var(--success, #16a34a);
}

/* 工具结果样式 */
.ai-tool-results {
  margin-bottom: 6px;
}
.ai-tool-result {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
  margin-bottom: 4px;
}
.ai-tool-result-header {
  padding: 5px 10px;
  background: var(--success-bg, #dcfce7);
  font-size: 11px;
  font-weight: 600;
  color: var(--success, #16a34a);
}
.ai-tool-result-content {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-surface);
  font-family: var(--font-mono, monospace);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  max-height: 180px;
  overflow-y: auto;
}
</style>
