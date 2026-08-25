<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { ToolCall, ToolResult } from '@/api/ai'
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, Terminal, FileText, Database, Search } from 'lucide-vue-next'

/**
 * AiToolTimeline — 工具调用时间线
 * 
 * 行内 flow 风格，参考 MiniMax Code / Trae Work：
 *   <> 已调用 获取剪贴板元数据 完成
 *   <> 已调用 读取剪贴板元数据 完成
 */

type TimelineToolCall = ToolCall & { pendingConfirm?: boolean }

const props = defineProps<{
  toolCalls?: TimelineToolCall[]
  toolResults?: ToolResult[]
  agentName?: string
  confirmTool?: string | null
}>()
const { t } = useI18n()

const expanded = ref<Set<string>>(new Set())

function getToolName(name: string) {
  const key = 'ai_tool_' + name
  const val = t(key)
  if (val && val !== key) return val
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

const DANGER_RE = /(delete|remove|drop|truncate|wipe|purge|unlink|rmdir|clear|overwrite|destroy|reset)/i
const WRITE_RE = /(save|create|update|insert|write|add|set|rename|move|toggle|favorite|organize|execute|batch|send|upload|patch|put|post|delete|remove|modify|edit)/i

const isDangerous = (name: string) => DANGER_RE.test(name)
const isWrite = (name: string) => !isDangerous(name) && WRITE_RE.test(name)

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

const DESTRUCTIVE_TOOLS = new Set(['destroy_clips'])
function isDestructiveTool(name: string) {
  return DESTRUCTIVE_TOOLS.has(name)
}

function awaitingConfirm(id: string, name: string): boolean {
  return props.confirmTool === name && !isDone(id)
}

function getToolIcon(name: string) {
  // 根据工具类型选择图标
  if (name.includes('terminal') || name.includes('execute') || name.includes('batch')) {
    return Terminal
  }
  if (name.includes('search') || name.includes('get_')) {
    return Search
  }
  if (name.includes('write') || name.includes('create') || name.includes('update')) {
    return FileText
  }
  return Database
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

const steps = computed(() => {
  return (props.toolCalls || []).map((tc, i) => ({
    ...tc,
    index: i + 1,
    done: isDone(tc.id),
    result: getResult(tc.id),
    dangerous: isDangerous(tc.name),
    write: isWrite(tc.name),
  }))
})
</script>

<template>
  <!-- 行内 flow 风格：工具调用列表 -->
  <div v-if="steps.length > 0" class="ai-tools-flow">
    <template v-for="step in steps" :key="step.id">
      <!-- 行内工具调用条目 -->
      <div class="ai-tool-item" :class="{ done: step.done, running: !step.done, error: step.result && stepAnnotation(step.name, step.result.content)?.ok === false }">
        <button class="ai-tool-row" @click="toggle(step.id)">
          <!-- 状态图标 -->
          <span class="ai-tool-state">
            <CheckCircle2 v-if="step.done" :size="12" class="state-done" />
            <Loader2 v-else :size="12" class="state-running" />
          </span>
          
          <!-- 工具标识 -->
          <span class="ai-tool-bracket"><component :is="getToolIcon(step.name)" :size="11" /></span>
          
          <!-- 文字描述 -->
          <span class="ai-tool-text">
            <span class="ai-tool-action">{{ step.done ? '已调用' : '调用' }}</span>
            <span class="ai-tool-name">{{ getToolName(step.name) }}</span>
            <span v-if="isDestructiveTool(step.name)" class="ai-tool-tag destructive">危险</span>
            <span v-else-if="step.write" class="ai-tool-tag write">写</span>
          </span>
          
          <!-- 状态文字 -->
          <span class="ai-tool-status" :class="{ done: step.done, confirm: awaitingConfirm(step.id, step.name) }">
            {{ awaitingConfirm(step.id, step.name) ? '等待确认' : (step.done ? '完成' : '进行中') }}
          </span>
          
          <!-- 展开箭头 -->
          <ChevronDown v-if="expanded.has(step.id)" :size="11" class="ai-tool-chev" />
          <ChevronRight v-else :size="11" class="ai-tool-chev" />
        </button>
        
        <!-- 结果摘要行 -->
        <div v-if="stepAnnotation(step.name, step.result?.content)" class="ai-tool-result-line"
             :class="{ error: !stepAnnotation(step.name, step.result?.content)!.ok }">
          <span class="ai-tool-result-icon">{{ stepAnnotation(step.name, step.result?.content)!.ok ? '✓' : '!' }}</span>
          <span>{{ stepAnnotation(step.name, step.result?.content)!.text }}</span>
        </div>
        
        <!-- 展开详情 -->
        <div v-if="expanded.has(step.id)" class="ai-tool-detail">
          <div v-if="step.arguments && step.arguments !== '{}'" class="ai-tool-detail-section">
            <div class="ai-tool-detail-label">参数</div>
            <pre>{{ formatArgs(step.arguments) }}</pre>
          </div>
          <div v-if="step.result" class="ai-tool-detail-section">
            <div class="ai-tool-detail-label">结果</div>
            <pre>{{ formatResult(step.result.content) }}</pre>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ============ 行内 flow 风格 ============ */
.ai-tools-flow {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 2px 0;
  padding: 0;
  border: none;
  background: transparent;
}

.ai-tool-item {
  display: block;
  animation: fade-in 0.2s ease-out;
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 行按钮 */
.ai-tool-row {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 2px 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-secondary);
  text-align: left;
  border-radius: 4px;
  transition: background 0.12s ease;
}

.ai-tool-row:hover {
  background: var(--bg-hover);
}

/* 状态图标 */
.ai-tool-state {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.state-done {
  color: var(--success);
}

.state-running {
  color: var(--accent);
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 工具标识括号 */
.ai-tool-bracket {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--text-tertiary);
}

/* 文字描述 */
.ai-tool-text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
}

.ai-tool-action {
  color: var(--text-tertiary);
  font-weight: 400;
  font-size: 11.5px;
}

.ai-tool-name {
  color: var(--text-primary);
  font-weight: 500;
  font-size: 12px;
}

/* 标签 */
.ai-tool-tag {
  font-size: 10px;
  font-weight: 500;
  padding: 0 4px;
  border-radius: 3px;
  line-height: 14px;
}

.ai-tool-tag.write {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.ai-tool-tag.destructive {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
}

/* 状态 */
.ai-tool-status {
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 400;
  margin-left: auto;
  flex-shrink: 0;
}

.ai-tool-status.done {
  color: var(--success);
}

.ai-tool-status.confirm {
  color: #f59e0b;
}

/* 展开箭头 */
.ai-tool-chev {
  color: var(--text-tertiary);
  flex-shrink: 0;
  margin-left: 2px;
  width: 10px;
  height: 10px;
}

/* 结果摘要行 */
.ai-tool-result-line {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px 1px 22px;
  font-size: 11.5px;
  color: var(--success);
  line-height: 1.4;
}

.ai-tool-result-line.error {
  color: #ef4444;
}

.ai-tool-result-icon {
  font-weight: 600;
}

/* 展开详情 */
.ai-tool-detail {
  padding: 4px 4px 4px 22px;
  animation: detail-in 0.15s ease-out;
}

@keyframes detail-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: translateY(0); }
}

.ai-tool-detail-section {
  margin-bottom: 4px;
}

.ai-tool-detail-section:last-child {
  margin-bottom: 0;
}

.ai-tool-detail-label {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-tertiary);
  margin-bottom: 2px;
}

.ai-tool-detail-section pre {
  margin: 0;
  padding: 6px 8px;
  background: var(--bg-hover);
  border-radius: 4px;
  font-size: 11px;
  font-family: var(--font-family-mono, ui-monospace, monospace);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow-y: auto;
  color: var(--text-secondary);
  line-height: 1.5;
}

.ai-tool-detail-section pre::-webkit-scrollbar {
  width: 4px;
}

.ai-tool-detail-section pre::-webkit-scrollbar-thumb {
  background: var(--border-subtle, var(--border-default));
  border-radius: 2px;
}

/* 错误态 */
.ai-tool-item.error .ai-tool-name {
  color: #ef4444;
}

/* 键盘可达性 */
.ai-tool-row:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .state-running,
  .ai-tool-item,
  .ai-tool-detail {
    animation: none;
  }
}
</style>
