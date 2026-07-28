<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ToolCall, ToolResult } from '@/api/ai'
import { Wrench, ChevronDown, ChevronRight, CheckCircle2, Loader2 } from 'lucide-vue-next'

const props = defineProps<{
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
}>()

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
  <div v-if="steps.length > 0" class="ai-tool-timeline">
    <div class="ai-tool-timeline-header">
      <Wrench :size="13" />
      <span>Agent 工作流</span>
      <span class="ai-tool-timeline-count">{{ steps.length }} 步</span>
    </div>
    <div class="ai-tool-timeline-body">
      <div v-for="step in steps" :key="step.id" class="ai-tool-step" :class="{ done: step.done }">
        <div class="ai-tool-step-dot">
          <CheckCircle2 v-if="step.done" :size="14" />
          <Loader2 v-else :size="14" class="ai-tool-spin" />
        </div>
        <div class="ai-tool-step-main">
          <button class="ai-tool-step-title" @click="toggle(step.id)">
            <span>{{ getToolName(step.name) }}</span>
            <ChevronDown v-if="expanded.has(step.id)" :size="13" />
            <ChevronRight v-else :size="13" />
          </button>
          <div v-if="expanded.has(step.id)" class="ai-tool-step-detail">
            <div class="ai-tool-step-section">
              <div class="ai-tool-step-section-title">参数</div>
              <pre>{{ formatArgs(step.arguments) }}</pre>
            </div>
            <div v-if="step.result" class="ai-tool-step-section">
              <div class="ai-tool-step-section-title">结果</div>
              <pre>{{ formatResult(step.result.content) }}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-tool-timeline {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
  margin-bottom: 6px;
  background: var(--bg-surface);
}
.ai-tool-timeline-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--accent-bg);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}
.ai-tool-timeline-count {
  margin-left: auto;
  font-weight: 400;
  opacity: 0.8;
}
.ai-tool-timeline-body {
  padding: 8px 10px;
}
.ai-tool-step {
  display: flex;
  gap: 10px;
  padding: 6px 0;
}
.ai-tool-step:not(:last-child) {
  border-bottom: 1px solid var(--border-subtle);
}
.ai-tool-step-dot {
  width: 18px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 2px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.ai-tool-step.done .ai-tool-step-dot {
  color: var(--success, #16a34a);
}
.ai-tool-spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.ai-tool-step-main {
  flex: 1;
  min-width: 0;
}
.ai-tool-step-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}
.ai-tool-step-title:hover {
  color: var(--accent);
}
.ai-tool-step-detail {
  margin-top: 6px;
}
.ai-tool-step-section {
  margin-bottom: 6px;
}
.ai-tool-step-section-title {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-bottom: 2px;
}
.ai-tool-step-section pre {
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
</style>
