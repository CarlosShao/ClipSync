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
  // 破坏性工具确认门控：当前正在等待确认的工具名（用于“等待确认”态标注）
  confirmTool?: string | null
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

// ===== 破坏性工具确认门控 + 写操作结果标注 =====
const DESTRUCTIVE_TOOLS = new Set(['destroy_clips'])
function isDestructiveTool(name: string) {
  return DESTRUCTIVE_TOOLS.has(name)
}
function awaitingConfirm(id: string, name: string): boolean {
  return props.confirmTool === name && !isDone(id)
}
function stepAnnotation(name: string, content?: string): { text: string; ok: boolean } | null {
  if (!content) return null
  let parsed: any = null
  try {
    parsed = JSON.parse(content)
  } catch {
    parsed = content
  }
  const isObj = parsed && typeof parsed === 'object'
  if (isObj && 'error' in parsed) {
    const rejected = parsed.error === 'REJECTED_BY_USER'
    return { text: rejected ? (t('ai_rejected_by_user') || '已拒绝') : (t('ai_tool_result_error') || '失败'), ok: false }
  }
  if (isObj && parsed.success === false) {
    return { text: parsed.error || (t('ai_tool_result_error') || '失败'), ok: false }
  }
  const count = (k: unknown): number => (typeof k === 'number' ? k : 0)
  switch (name) {
    case 'write_clip':
      return { text: t('ai_result_apply') || '已写入剪贴板', ok: true }
    case 'tag_items':
      return { text: t('ai_result_tag_items', { count: isObj ? count(parsed.tags?.length) : 0 }), ok: true }
    case 'archive_items':
      return { text: t('ai_result_archive_items', { count: isObj ? count(parsed.archived) : 0 }), ok: true }
    case 'unarchive_items':
      return { text: t('ai_result_unarchive_items', { count: isObj ? count(parsed.unarchived ?? parsed.archived) : 0 }), ok: true }
    case 'batch_favorite':
      return { text: t('ai_result_favorite_items', { count: isObj ? count(parsed.updated ?? parsed.favorited ?? parsed.tagged) : 0 }), ok: true }
    case 'destroy_clips':
      return { text: t('ai_result_destroy_clips', { count: isObj ? count(parsed.permanentlyDeleted ?? parsed.deleted ?? parsed.destroyed) : 0 }), ok: true }
    case 'create_collection':
      return { text: t('ai_result_create_collection'), ok: true }
    case 'create_template':
      return { text: t('ai_result_create_template'), ok: true }
    case 'update_template':
      return { text: t('ai_result_update_template'), ok: true }
    case 'create_shared_link':
      return { text: t('ai_result_create_shared_link'), ok: true }
    default:
      return null
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
        :class="[
          step.done ? 'done' : 'running',
          { last: step.index === steps.length, confirm: awaitingConfirm(step.id, step.name), destructive: isDestructiveTool(step.name) },
        ]"
      >
      <div class="ai-tool-log-rail">
        <span class="ai-tool-log-node">
          <CheckCircle2 v-if="step.done" :size="12" class="ai-tool-log-done" />
          <span v-else class="ai-tool-log-num">{{ step.index }}</span>
        </span>
        <span class="ai-tool-log-connector" />
      </div>
      <div class="ai-tool-log-body">
        <button class="ai-tool-log-summary" @click="toggle(step.id)">
          <span class="ai-tool-log-icon">
            <Loader2 v-if="!step.done" :size="13" class="ai-tool-log-spin" />
          </span>
          <span class="ai-tool-log-text">
            <span class="ai-tool-log-action">{{ step.done ? (t('ai_tool_called') || '已调用') : (t('ai_tool_calling') || '调用') }}</span>
            <span class="ai-tool-log-name">{{ getToolName(step.name) }}</span>
            <span v-if="isDestructiveTool(step.name)" class="ai-tool-log-destructive">
              {{ t('ai_confirm_destructive') || '破坏性' }}
            </span>
          </span>
          <span v-if="agentName" class="ai-tool-log-source">{{ agentName }}</span>
          <span class="ai-tool-log-spacer" />
          <span
            class="ai-tool-log-status"
            :class="awaitingConfirm(step.id, step.name) ? 'confirm' : (step.done ? 'ok' : 'run')"
          >
            {{ awaitingConfirm(step.id, step.name)
                ? (t('ai_confirm_waiting') || '等待确认')
                : (step.done ? (t('ai_tool_done') || '完成') : (t('ai_tool_running') || '进行中')) }}
          </span>
          <ChevronDown v-if="expanded.has(step.id)" :size="13" class="ai-tool-log-chev" />
          <ChevronRight v-else :size="13" class="ai-tool-log-chev" />
        </button>

        <div v-if="stepAnnotation(step.name, step.result?.content)" class="ai-tool-log-annotation"
             :class="{ err: !stepAnnotation(step.name, step.result?.content)!.ok }">
          <span v-if="!stepAnnotation(step.name, step.result?.content)!.ok">!</span>
          {{ stepAnnotation(step.name, step.result?.content)!.text }}
        </div>

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
/* 时间线整体：卡片化容器 + 柔和阴影 */
.ai-tool-log {
  display: flex;
  flex-direction: column;
  margin: 8px 0;
  border-radius: 12px;
  overflow: hidden;
  background: var(--bg-surface, #fff);
  border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.08));
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
  max-width: 100%;
}

.ai-tool-log-line {
  display: flex;
  align-items: stretch;
  /* 新工具调用到达时淡入，强化“按顺序逐个出现”的时序感 */
  animation: ai-tool-line-in 0.25s ease-out;
}

.ai-tool-log-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 30px;
  flex-shrink: 0;
  padding-top: 11px;
}
.ai-tool-log-node {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bg-hover, rgba(15, 23, 42, 0.05));
  border: 1.5px solid var(--border-subtle, rgba(15, 23, 42, 0.15));
  font-size: 10px;
  font-weight: 700;
  color: var(--text-tertiary, #94a3b8);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  z-index: 1;
}
.ai-tool-log-line.done .ai-tool-log-node {
  background: var(--success, #16a34a);
  border-color: var(--success, #16a34a);
  color: #fff;
}
/* 等待确认（破坏性门控）节点用琥珀色，破坏性工具左缘标红 */
.ai-tool-log-line.confirm .ai-tool-log-node {
  background: rgba(245, 158, 11, 0.85);
  border-color: rgba(245, 158, 11, 0.85);
  color: #fff;
}
.ai-tool-log-line.destructive .ai-tool-log-body {
  border-left: 2px solid rgba(239, 68, 68, 0.45);
  padding-left: 6px;
}
.ai-tool-log-connector {
  flex: 1;
  width: 2px;
  background: linear-gradient(180deg, var(--border-subtle, rgba(15, 23, 42, 0.15)), rgba(15, 23, 42, 0.05));
  margin: 3px 0;
  border-radius: 2px;
}
.ai-tool-log-line.last .ai-tool-log-connector {
  display: none;
}

.ai-tool-log-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 6px 0;
}

.ai-tool-log-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px 6px 6px;
  background: transparent;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary, #475569);
  text-align: left;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.ai-tool-log-summary:hover {
  background: var(--bg-hover, rgba(115, 115, 115, 0.06));
}

.ai-tool-log-icon {
  display: inline-flex;
  width: 16px;
  justify-content: center;
}
.ai-tool-log-spin {
  color: var(--accent, #475569);
  animation: spin 1s linear infinite;
}
.ai-tool-log-done {
  color: var(--success, #16a34a);
}
.ai-tool-log-text {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.ai-tool-log-action {
  color: var(--text-tertiary, #94a3b8);
  font-weight: 500;
  flex-shrink: 0;
}
.ai-tool-log-name {
  font-weight: 600;
  color: var(--text-primary, #0f172a);
}
.ai-tool-log-source {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent, #475569);
  background: var(--accent-bg, rgba(115, 115, 115, 0.12));
  border-radius: 999px;
  padding: 1px 7px;
  white-space: nowrap;
}
.ai-tool-log-destructive {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--danger, #ef4444);
  background: color-mix(in srgb, var(--danger, #ef4444) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger, #ef4444) 30%, transparent);
  border-radius: 999px;
  padding: 0 6px;
  white-space: nowrap;
}
.ai-tool-log-status {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
}
.ai-tool-log-status.run {
  color: var(--accent, #475569);
  background: var(--accent-bg, rgba(115, 115, 115, 0.12));
}
.ai-tool-log-status.ok {
  color: var(--success, #16a34a);
  background: rgba(22, 163, 74, 0.1);
}
.ai-tool-log-status.confirm {
  color: #d97706;
  background: rgba(245, 158, 11, 0.12);
}
.ai-tool-log-annotation {
  margin: 2px 12px 6px 38px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  font-style: italic;
  color: var(--success, #16a34a);
  background: rgba(22, 163, 74, 0.08);
}
.ai-tool-log-annotation.err {
  color: #FF6B45;
  background: rgba(255, 107, 69, 0.08);
}
.ai-tool-log-spacer {
  flex: 1;
  min-width: 4px;
}
.ai-tool-log-chev {
  color: var(--text-tertiary, #94a3b8);
  flex-shrink: 0;
}

.ai-tool-log-detail {
  padding: 0 12px 8px 6px;
}
.ai-tool-log-section {
  margin-bottom: 6px;
}
.ai-tool-log-section:last-child {
  margin-bottom: 0;
}
.ai-tool-log-section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary, #94a3b8);
  margin-bottom: 2px;
}
.ai-tool-log-section pre {
  margin: 0;
  padding: 7px 9px;
  background: var(--bg-hover, rgba(15, 23, 42, 0.04));
  border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.08));
  border-radius: 8px;
  font-size: 11px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 180px;
  overflow-y: auto;
  color: var(--text-secondary, #475569);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
@keyframes ai-tool-line-in {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: none; }
}
</style>
