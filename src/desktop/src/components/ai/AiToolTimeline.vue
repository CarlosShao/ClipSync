<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { ToolCall, ToolResult } from '@/api/ai'
import { ChevronDown, ChevronRight, CheckCircle2, Loader2 } from 'lucide-vue-next'

const props = defineProps<{
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  // 该时间线归属的代理名（子代理卡片内传入，用于把工具调用明确标注为“属于哪个子代理”）
  agentName?: string
}>()
const { t } = useI18n()

const expanded = ref<Set<string>>(new Set())

// 完整 i18n 工具名映射：优先 ai_tool_<name> 键；缺失时把 snake_case 人性化显示作为兜底。
function getToolName(name: string) {
  const key = 'ai_tool_' + name
  const val = t(key)
  if (val && val !== key) return val
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
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

// 按数组顺序编号（即工具调用被后端派发的先后顺序），形成可视化时间线。
const steps = computed(() => {
  return (props.toolCalls || []).map((tc, i) => ({
    ...tc,
    index: i + 1,
    done: isDone(tc.id),
    result: getResult(tc.id),
  }))
})
</script>

<template>
  <div v-if="steps.length > 0" class="ai-tool-log">
    <div
      v-for="step in steps"
      :key="step.id"
      class="ai-tool-log-line"
      :class="{ done: step.done, last: step.index === steps.length }"
    >
      <div class="ai-tool-log-rail">
        <span class="ai-tool-log-node">{{ step.index }}</span>
        <span class="ai-tool-log-connector" />
      </div>
      <div class="ai-tool-log-body">
        <button class="ai-tool-log-summary" @click="toggle(step.id)">
          <Loader2 v-if="!step.done" :size="12" class="ai-tool-log-spin" />
          <CheckCircle2 v-else :size="12" class="ai-tool-log-done" />
          <span class="ai-tool-log-text">
            {{ step.done ? (t('ai_tool_called') || '已调用') : (t('ai_tool_calling') || '调用') }}
            {{ getToolName(step.name) }}
          </span>
          <span v-if="agentName" class="ai-tool-log-source">{{ agentName }}</span>
          <span class="ai-tool-log-spacer" />
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
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--border-subtle);
  /* 新工具调用到达时淡入，强化“按顺序逐个出现”的时序感 */
  animation: ai-tool-line-in 0.25s ease-out;
}
.ai-tool-log-line:last-child {
  border-bottom: none;
}

.ai-tool-log-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 26px;
  flex-shrink: 0;
  padding-top: 9px;
}
.ai-tool-log-node {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--bg-hover);
  border: 1px solid var(--border-subtle);
  font-size: 10px;
  font-weight: 700;
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.ai-tool-log-line.done .ai-tool-log-node {
  background: var(--success, #16a34a);
  border-color: var(--success, #16a34a);
  color: #fff;
}
.ai-tool-log-connector {
  flex: 1;
  width: 1px;
  background: var(--border-subtle);
  margin: 3px 0;
}
.ai-tool-log-line.last .ai-tool-log-connector {
  display: none;
}

.ai-tool-log-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.ai-tool-log-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 12px 7px 8px;
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
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-tool-log-source {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-bg);
  border-radius: 999px;
  padding: 1px 7px;
  white-space: nowrap;
}
.ai-tool-log-spacer {
  flex: 1;
  min-width: 4px;
}

.ai-tool-log-detail {
  padding: 0 12px 8px 0;
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
@keyframes ai-tool-line-in {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: none; }
}
</style>
