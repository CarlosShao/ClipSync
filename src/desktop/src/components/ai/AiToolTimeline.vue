<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { ToolCall, ToolResult } from '@/api/ai'
import { ChevronDown, ChevronRight, CheckCircle2, Loader2 } from 'lucide-vue-next'

const props = defineProps<{
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
}>()
const { t } = useI18n()

const expanded = ref<Set<string>>(new Set())

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

function getToolName(name: string) {
  return TOOL_NAMES[name] || name
}

function getResult(id: string): ToolResult | undefined {
  return props.toolResults?.find((r) => r.tool_call_id === id)
}

function isDone(id: string) {
  return !!getResult(id)
}

function toggle(id: string) {
  if (expanded.value.has(id)) {
    expanded.value.delete(id)
  } else {
    expanded.value.add(id)
  }
}

function formatArgs(args: string): string {
  try {
    const parsed = JSON.parse(args || '{}')
    return JSON.stringify(parsed, null, 2)
  } catch {
    return args || '{}'
  }
}

function formatResult(content: string): string {
  try {
    const parsed = JSON.parse(content)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return content
  }
}

const steps = computed(() => {
  return (props.toolCalls || []).map((tc) => ({
    ...tc,
    done: isDone(tc.id),
    result: getResult(tc.id)
  }))
})
</script>

<template>
  <div v-if="steps.length > 0" class="ai-tool-log">
    <div
      v-for="step in steps"
      :key="step.id"
      class="ai-tool-log-line"
      :class="{ done: step.done }"
    >
      <button class="ai-tool-log-summary" @click="toggle(step.id)">
        <Loader2 v-if="!step.done" :size="12" class="ai-tool-log-spin" />
        <CheckCircle2 v-else :size="12" class="ai-tool-log-done" />
        <span class="ai-tool-log-text">
          {{ step.done ? (t('ai_tool_called') || '已调用') : (t('ai_tool_calling') || '调用') }}
          {{ getToolName(step.name) }}
        </span>
        <ChevronDown v-if="expanded.has(step.id)" :size="13" />
        <ChevronRight v-else :size="13" />
      </button>

      <div v-if="expanded.has(step.id)" class="ai-tool-log-detail">
        <div class="ai-tool-log-section">
          <div class="ai-tool-log-section-title">{{ t('ai_tool_args') || '参数' }}</div>
          <pre>{{ formatArgs(step.arguments) }}</pre>
        </div>
        <div v-if="step.result" class="ai-tool-log-section">
          <div class="ai-tool-log-section-title">{{ t('ai_tool_result') || '结果' }}</div>
          <pre>{{ formatResult(step.result.content) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-tool-log {
  display: flex;
  flex-direction: column;
  margin-bottom: 6px;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  max-width: 100%;
}

.ai-tool-log-line {
  border-bottom: 1px solid var(--border-subtle);
}
.ai-tool-log-line:last-child {
  border-bottom: none;
}

.ai-tool-log-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-align: left;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.ai-tool-log-summary:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.ai-tool-log-spin {
  flex-shrink: 0;
  color: var(--accent);
  animation: spin 1s linear infinite;
}
.ai-tool-log-done {
  flex-shrink: 0;
  color: var(--success, #16a34a);
}
.ai-tool-log-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-tool-log-detail {
  padding: 8px 12px;
  border-top: 1px solid var(--border-subtle);
}
.ai-tool-log-section {
  margin-bottom: 6px;
}
.ai-tool-log-section:last-child {
  margin-bottom: 0;
}
.ai-tool-log-section-title {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-bottom: 2px;
}
.ai-tool-log-section pre {
  margin: 0;
  padding: 6px 8px;
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow-y: auto;
  color: var(--text-secondary);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
