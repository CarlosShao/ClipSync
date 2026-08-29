<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { AgentRun } from '@/api/ai'
import { Loader2, CheckCircle2, XCircle, Users } from 'lucide-vue-next'

/**
 * AiAgentCards — 子代理并行卡片网格（UI-D，合并原 AiAgentSummary）
 *
 * 紧凑网格 + 状态图标 + 耗时；点击卡片 emit('open', run)，
 * 由父级（AiMessage）打开 AiAgentDrawer 查看执行详情（抽屉链路不变）。
 */

const props = defineProps<{ runs: AgentRun[] }>()
const emit = defineEmits<{ open: [run: AgentRun] }>()
const { t } = useI18n()

const runActive = (run: AgentRun) =>
  run.status === 'planning' || run.status === 'working' || run.status === 'synthesis'

// 与 AiAgentRun 一致的友好别名：coordinator/synthesis 翻译，worker 保留角色名
function displayName(run: AgentRun): string {
  if (run.kind === 'coordinator') return t('ai_agent_coordinator_label', '任务规划')
  if (run.kind === 'synthesis') return t('ai_agent_synthesis_label', '整合答案')
  return run.name || t('ai_agent_worker_label', '子代理')
}

function statusText(run: AgentRun): string {
  switch (run.status) {
    case 'planning':
      return t('ai_agent_activity_planning', '正在规划任务')
    case 'working':
      return t('ai_agent_activity_working', '正在执行任务')
    case 'synthesis':
      return t('ai_agent_activity_synthesis', '正在整合答案')
    case 'done':
      return t('ai_agent_activity_done', '已完成')
    case 'failed':
      return t('ai_agent_activity_failed', '执行失败')
    default:
      return run.status
  }
}

// 耗时：已完成/失败的 run 才有 duration（ms）
function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return `${min}m ${String(sec % 60).padStart(2, '0')}s`
}
function durationText(run: AgentRun): string {
  return run.duration ? formatDuration(run.duration) : ''
}

const activeCount = computed(() => props.runs.filter((r) => runActive(r)).length)
const doneCount = computed(() => props.runs.filter((r) => r.status === 'done').length)
const failCount = computed(() => props.runs.filter((r) => r.status === 'failed').length)
</script>

<template>
  <div class="ai-agent-cards">
    <!-- 头部：派出计数 + 运行/完成/失败统计 -->
    <div class="ai-agent-cards-head">
      <Users :size="14" class="ai-agent-cards-icon" />
      <span class="ai-agent-cards-title">{{ t('ai_subagents_dispatched', '已派出 {n} 个子代理').replace('{n}', String(runs.length)) }}</span>
      <span class="ai-agent-cards-counts">
        <span v-if="activeCount" class="cnt cnt-run">{{ activeCount }} ⟳</span>
        <span v-if="doneCount" class="cnt cnt-done">{{ doneCount }} ✓</span>
        <span v-if="failCount" class="cnt cnt-fail">{{ failCount }} ✕</span>
      </span>
    </div>

    <!-- 并行卡片网格：点击整卡打开详情抽屉 -->
    <div class="ai-agent-cards-grid">
      <button
        v-for="run in runs"
        :key="run.id"
        type="button"
        class="ai-agent-cards-card"
        :class="['status-' + run.status]"
        :title="t('ai_subagent_view_detail', '查看执行详情')"
        @click="emit('open', run)"
      >
        <span class="ai-agent-cards-status">
          <Loader2 v-if="runActive(run)" :size="13" class="ai-agent-cards-spin" />
          <CheckCircle2 v-else-if="run.status === 'done'" :size="13" class="ai-agent-cards-ok" />
          <XCircle v-else-if="run.status === 'failed'" :size="13" class="ai-agent-cards-err" />
        </span>
        <span class="ai-agent-cards-name">{{ displayName(run) }}</span>
        <span class="ai-agent-cards-meta">
          <span class="ai-agent-cards-stage" :class="'stage-' + run.status">{{ statusText(run) }}</span>
          <span v-if="durationText(run)" class="ai-agent-cards-dur">{{ durationText(run) }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.ai-agent-cards {
  display: flex;
  flex-direction: column;
  margin: 8px 0;
  border-radius: var(--radius-md, 10px);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle, var(--border-default));
  box-shadow: var(--shadow-sm, 0 1px 2px rgb(0 0 0 / 0.05));
  overflow: hidden;
  max-width: 100%;
}
.ai-agent-cards-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-subtle, var(--border-default));
  background: var(--bg-hover);
}
.ai-agent-cards-icon {
  color: var(--accent);
  flex-shrink: 0;
}
.ai-agent-cards-title {
  white-space: nowrap;
}
.ai-agent-cards-counts {
  display: inline-flex;
  gap: 4px;
  font-size: 10px;
  font-weight: 600;
  margin-left: auto;
}
.ai-agent-cards-counts .cnt {
  padding: 1px 6px;
  border-radius: 999px;
  white-space: nowrap;
}
.cnt-run {
  color: var(--accent);
  background: rgba(var(--accent-rgb), 0.12);
}
.cnt-done {
  color: var(--success);
  background: var(--success-bg);
}
.cnt-fail {
  color: var(--danger);
  background: var(--danger-bg);
}

/* 并行卡片网格 */
.ai-agent-cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
  padding: 10px;
}
.ai-agent-cards-card {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle, var(--border-default));
  border-left-width: 3px;
  border-radius: var(--radius-md, 10px);
  background: var(--bg-surface);
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition:
    box-shadow 0.2s,
    border-color 0.2s,
    background 0.15s;
}
.ai-agent-cards-card:hover {
  background: var(--bg-hover);
  box-shadow: var(--shadow-sm, 0 1px 2px rgb(0 0 0 / 0.05));
}
/* 状态左缘：active=accent / done=success / failed=danger */
.ai-agent-cards-card.status-working,
.ai-agent-cards-card.status-planning,
.ai-agent-cards-card.status-synthesis {
  border-left-color: var(--accent);
}
.ai-agent-cards-card.status-done {
  border-left-color: var(--success);
}
.ai-agent-cards-card.status-failed {
  border-left-color: var(--danger);
}
.ai-agent-cards-status {
  display: inline-flex;
  flex-shrink: 0;
}
.ai-agent-cards-spin {
  color: var(--accent);
  animation: ai-agent-cards-rotate 1s linear infinite;
}
.ai-agent-cards-ok {
  color: var(--success);
}
.ai-agent-cards-err {
  color: var(--danger);
}
.ai-agent-cards-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-agent-cards-meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}
.ai-agent-cards-stage {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--text-tertiary);
  background: var(--bg-hover);
  white-space: nowrap;
}
.stage-working,
.stage-planning,
.stage-synthesis {
  color: var(--accent);
  background: rgba(var(--accent-rgb), 0.12);
}
.stage-done {
  color: var(--success);
  background: var(--success-bg);
}
.stage-failed {
  color: var(--danger);
  background: var(--danger-bg);
}
.ai-agent-cards-dur {
  font-size: 10px;
  font-weight: 500;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
@keyframes ai-agent-cards-rotate {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-agent-cards-spin {
    animation: none;
  }
}

/* 键盘可达性：focus-visible 高亮（--accent token） */
.ai-agent-cards-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
