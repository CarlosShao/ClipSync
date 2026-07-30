<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { AgentRun } from '@/api/ai'
import { Loader2, CheckCircle2, XCircle, ChevronRight } from 'lucide-vue-next'

const props = defineProps<{ runs: AgentRun[] }>()
const emit = defineEmits<{ open: [run: AgentRun] }>()
const { t } = useI18n()

// 与 AiAgentRun 保持一致的友好别名
function displayName(run: AgentRun): string {
  if (run.kind === 'coordinator') return t('ai_agent_coordinator_label') || '任务规划'
  if (run.kind === 'synthesis') return t('ai_agent_synthesis_label') || '整合答案'
  return run.name || (t('ai_agent_worker_label') || '子代理')
}

function statusText(run: AgentRun): string {
  switch (run.status) {
    case 'planning':
      return t('ai_agent_activity_planning')
    case 'working':
      return t('ai_agent_activity_working')
    case 'synthesis':
      return t('ai_agent_activity_synthesis')
    case 'done':
      return t('ai_agent_activity_done')
    case 'failed':
      return t('ai_agent_activity_failed')
    default:
      return run.status
  }
}

const runActive = (run: AgentRun) =>
  run.status === 'planning' || run.status === 'working' || run.status === 'synthesis'

const dispatchedCount = computed(() => props.runs.length)
</script>

<template>
  <div class="ai-agent-summary">
    <div class="ai-agent-summary-head">
      {{ t('ai_subagents_dispatched', { n: dispatchedCount }) }}
    </div>
    <button
      v-for="run in runs"
      :key="run.id"
      class="ai-agent-summary-row"
      :class="['status-' + run.status]"
      @click="emit('open', run)"
    >
      <Loader2 v-if="runActive(run)" :size="13" class="ai-agent-summary-spin" />
      <CheckCircle2 v-else-if="run.status === 'done'" :size="13" class="ai-agent-summary-ok" />
      <XCircle v-else-if="run.status === 'failed'" :size="13" class="ai-agent-summary-err" />
      <span class="ai-agent-summary-name">{{ displayName(run) }}</span>
      <span class="ai-agent-summary-status">{{ statusText(run) }}</span>
      <ChevronRight :size="13" class="ai-agent-summary-chev" />
    </button>
  </div>
</template>

<style scoped>
.ai-agent-summary {
  display: flex;
  flex-direction: column;
  margin-bottom: 6px;
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  overflow: hidden;
  max-width: 100%;
}
.ai-agent-summary-head {
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-hover);
}
.ai-agent-summary-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  text-align: left;
  transition: background 0.15s, color 0.15s;
}
.ai-agent-summary-row:last-child {
  border-bottom: none;
}
.ai-agent-summary-row:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.ai-agent-summary-spin {
  flex-shrink: 0;
  color: var(--accent);
  animation: spin 1s linear infinite;
}
.ai-agent-summary-ok {
  flex-shrink: 0;
  color: var(--success, #16a34a);
}
.ai-agent-summary-err {
  flex-shrink: 0;
  color: var(--danger, #ef4444);
}
.ai-agent-summary-name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-agent-summary-status {
  color: var(--text-tertiary);
  white-space: nowrap;
}
.ai-agent-summary-chev {
  flex-shrink: 0;
  color: var(--text-tertiary);
}
.status-failed .ai-agent-summary-status {
  color: var(--danger, #ef4444);
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
