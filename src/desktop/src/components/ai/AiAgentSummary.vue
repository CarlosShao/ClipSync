<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { AgentRun } from '@/api/ai'
import { Loader2, CheckCircle2, XCircle, ChevronRight, ChevronDown, Users, Terminal, ListChecks } from 'lucide-vue-next'

const props = defineProps<{ runs: AgentRun[] }>()
const emit = defineEmits<{ open: [run: AgentRun] }>()
const { t } = useI18n()

// 展开态：每个 run 单独记录，点击卡片可就地展开/收起自身详情
const openMap = ref<Record<string, boolean>>({})
function toggleOpen(run: AgentRun) {
  openMap.value[run.id] = !openMap.value[run.id]
}

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
const doneCount = computed(() => props.runs.filter((r) => r.status === 'done').length)
const runCount = computed(() => props.runs.filter((r) => runActive(r)).length)
const failCount = computed(() => props.runs.filter((r) => r.status === 'failed').length)
</script>

<template>
  <div class="ai-agent-summary">
    <!-- 头部：标题 + 计数 + 打开详情抽屉 -->
    <div class="ai-agent-summary-head">
      <Users :size="14" class="ai-agent-summary-icon" />
      <span class="ai-agent-summary-title">{{ t('ai_subagents_dispatched', { n: dispatchedCount }) }}</span>
      <span class="ai-agent-summary-counts">
        <span v-if="runCount" class="cnt cnt-run">{{ runCount }} ⟳</span>
        <span v-if="doneCount" class="cnt cnt-done">{{ doneCount }} ✓</span>
        <span v-if="failCount" class="cnt cnt-fail">{{ failCount }} ✕</span>
      </span>
      <span class="ai-agent-summary-spacer" />
      <button
        v-if="runs[0]"
        class="ai-agent-summary-open"
        :title="t('ai_agent_open_detail', '打开详情')"
        @click="emit('open', runs[0])"
      >
        <Terminal :size="13" />
      </button>
    </div>

    <!-- 子代理并行网格：每张卡片独立区域，展开看详细任务 / 工具 -->
    <div class="ai-agent-grid">
      <div
        v-for="run in runs"
        :key="run.id"
        class="ai-agent-card"
        :class="['status-' + run.status, { 'is-open': openMap[run.id] }]"
      >
        <button class="ai-agent-card-head" @click="toggleOpen(run)">
          <span class="ai-agent-card-status">
            <Loader2 v-if="runActive(run)" :size="13" class="ai-agent-card-spin" />
            <CheckCircle2 v-else-if="run.status === 'done'" :size="13" class="ai-agent-card-ok" />
            <XCircle v-else-if="run.status === 'failed'" :size="13" class="ai-agent-card-err" />
          </span>
          <span class="ai-agent-card-name">{{ displayName(run) }}</span>
          <span class="ai-agent-card-stage" :class="'stage-' + run.status">{{ statusText(run) }}</span>
          <ChevronDown v-if="openMap[run.id]" :size="12" class="ai-agent-card-chev" />
          <ChevronRight v-else :size="12" class="ai-agent-card-chev" />
        </button>

        <div v-if="openMap[run.id]" class="ai-agent-card-detail">
          <div v-if="run.objective" class="ai-agent-card-task">
            <span class="ai-agent-card-task-label">{{ t('ai_agent_objective', '任务') }}</span>
            <span class="ai-agent-card-task-text">{{ run.objective }}</span>
          </div>
          <div v-if="run.tools && run.tools.length" class="ai-agent-card-tools">
            <span class="ai-agent-card-tools-label"><ListChecks :size="11" /> {{ t('ai_agent_tools', '工具') }}</span>
            <span class="ai-agent-card-tool" v-for="(tl, k) in run.tools" :key="k">{{ tl }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-agent-summary {
  display: flex;
  flex-direction: column;
  margin: 8px 0;
  border-radius: 12px;
  background: var(--bg-surface, #fff);
  border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.08));
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
  overflow: hidden;
  max-width: 100%;
}
.ai-agent-summary-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-primary, #0f172a);
  border-bottom: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.08));
  background: var(--bg-hover, rgba(15, 23, 42, 0.03));
}
.ai-agent-summary-icon {
  color: var(--accent, #475569);
  flex-shrink: 0;
}
.ai-agent-summary-title {
  white-space: nowrap;
}
.ai-agent-summary-counts {
  display: inline-flex;
  gap: 4px;
  font-size: 10px;
  font-weight: 600;
}
.ai-agent-summary-counts .cnt {
  padding: 1px 6px;
  border-radius: 999px;
  white-space: nowrap;
}
.cnt-run { color: var(--accent, #475569); background: var(--accent-bg, rgba(115, 115, 115, 0.12)); }
.cnt-done { color: var(--success, #16a34a); background: rgba(22, 163, 74, 0.1); }
.cnt-fail { color: var(--danger, #ef4444); background: rgba(239, 68, 68, 0.1); }
.ai-agent-summary-spacer { flex: 1; min-width: 4px; }
.ai-agent-summary-open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary, #94a3b8);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  flex-shrink: 0;
}
.ai-agent-summary-open:hover {
  background: var(--accent-bg, rgba(115, 115, 115, 0.12));
  color: var(--accent, #475569);
}

/* 并行卡片网格：子代理像参考图中的区块一样平铺 */
.ai-agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
  padding: 10px;
}
.ai-agent-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.1));
  border-radius: 10px;
  background: var(--bg-surface, #fff);
  overflow: hidden;
  transition: box-shadow 0.2s, border-color 0.2s;
}
.ai-agent-card:hover {
  box-shadow: 0 3px 12px rgba(15, 23, 42, 0.1);
}
/* 进行中的卡片高亮左侧 accent */
.ai-agent-card.status-working,
.ai-agent-card.status-planning,
.ai-agent-card.status-synthesis {
  border-left: 3px solid var(--accent, #475569);
}
.ai-agent-card.status-done {
  border-left: 3px solid var(--success, #16a34a);
}
.ai-agent-card.status-failed {
  border-left: 3px solid var(--danger, #ef4444);
}
.ai-agent-card-head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
}
.ai-agent-card-status {
  display: inline-flex;
  flex-shrink: 0;
}
.ai-agent-card-spin {
  color: var(--accent, #475569);
  animation: spin 1s linear infinite;
}
.ai-agent-card-ok { color: var(--success, #16a34a); }
.ai-agent-card-err { color: var(--danger, #ef4444); }
.ai-agent-card-name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  color: var(--text-primary, #0f172a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-agent-card-stage {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--text-tertiary, #94a3b8);
  background: var(--bg-hover, rgba(15, 23, 42, 0.05));
  white-space: nowrap;
}
.stage-working, .stage-planning, .stage-synthesis { color: var(--accent, #475569); background: var(--accent-bg, rgba(115, 115, 115, 0.12)); }
.stage-done { color: var(--success, #16a34a); background: rgba(22, 163, 74, 0.1); }
.stage-failed { color: var(--danger, #ef4444); background: rgba(239, 68, 68, 0.1); }
.ai-agent-card-chev {
  color: var(--text-tertiary, #94a3b8);
  flex-shrink: 0;
}
.ai-agent-card-detail {
  padding: 0 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px dashed var(--border-subtle, rgba(15, 23, 42, 0.1));
}
.ai-agent-card-task {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-secondary, #475569);
}
.ai-agent-card-task-label {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-tertiary, #94a3b8);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ai-agent-card-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.ai-agent-card-tools-label {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-tertiary, #94a3b8);
  margin-right: 2px;
}
.ai-agent-card-tool {
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 6px;
  color: var(--accent, #475569);
  background: var(--accent-bg, rgba(115, 115, 115, 0.1));
  white-space: nowrap;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
