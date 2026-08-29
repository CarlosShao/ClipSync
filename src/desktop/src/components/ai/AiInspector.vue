<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAiChatUi } from '@/composables/useAiChatUi'
import { useResizablePanel } from '@/composables/useResizablePanel'
import type { AgentRun, ContextUsage } from '@/api/ai'
import AiUsageMeter from './AiUsageMeter.vue'
import AiMemoryPanel from './AiMemoryPanel.vue'
import { Gauge, Bot, Brain, X, Loader2, CircleCheck, CircleX, CircleDot } from 'lucide-vue-next'

/**
 * AI Shell 右侧 Inspector（UI-B；UI-E 接入内容组件）。
 * xl（≥1440）行内展开；lg（1100–1439）折叠为浮层（可呼出）；数据由 contextUsage 驱动（props 传入）。
 * 区块：token 用量/缓存命中/费用（AiUsageMeter full 态，UI-E）/ 子代理总览（C4④ 接线
 *       真实 agentRuns，不再是占位）/ 记忆速览（AiMemoryPanel peek 态，UI-E）。
 */
const props = defineProps<{
  contextUsage: ContextUsage | null
  /** 协议层是否支持 prompt cache（与 AiChatComposer 判定一致：不支持时显示「未启用」而非 0%） */
  providerSupportsCache?: boolean
  memoryEnabled?: boolean
  /** 当前消息流的子代理运行列表（C4④：由 AiChatPanel 从最后一条 assistant 消息聚合传入） */
  agentRuns?: AgentRun[]
}>()

const AGENT_ICONS = {
  pending: CircleDot,
  running: Loader2,
  done: CircleCheck,
  failed: CircleX,
} as const

/** 子代理总览：只取有名字的运行，按 pending/running/done/failed 归并状态 */
const agentSummary = computed(() =>
  (props.agentRuns || [])
    .filter((r) => r && (r.name || r.objective))
    .map((r) => ({
      id: r.id,
      name: r.name || r.objective || '',
      status: r.status,
      objective: r.objective,
      toolCount: r.toolCalls?.length || 0,
      duration: r.duration,
    })),
)
const hasAgents = computed(() => agentSummary.value.length > 0)

function statusClass(status: string): string {
  return `is-${status || 'pending'}`
}
function statusText(status: string): string {
  const key = `ai_agent_status_${status || 'pending'}`
  const map: Record<string, string> = {
    pending: '排队中',
    running: '运行中',
    done: '已完成',
    failed: '失败',
  }
  return tf(key, map[status] || status || '排队中')
}
function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const emit = defineEmits<{
  'open-memory': []
}>()

const { t, tf } = useI18n()
const { inspectorMode, closeInspector } = useAiChatUi()

// 行内形态宽度拖拽（右侧面板：拖左缘左移变宽 → 默认方向）
const { width, startDrag } = useResizablePanel({
  storageKey: 'ai-inspector-width',
  min: 240,
  max: 420,
  default: 300,
})

const isOverlay = computed(() => inspectorMode.value === 'overlay')
</script>

<template>
  <div class="ai-insp" :class="{ 'ai-insp--overlay': isOverlay }" :style="isOverlay ? {} : { width: width + 'px' }">
    <!-- 行内形态：左缘拖拽把手 -->
    <div v-if="!isOverlay" class="ai-insp-resize" :title="tf('ai_resize_hint', '拖拽调整宽度')" @mousedown="startDrag" />

    <div class="ai-insp-head">
      <span class="ai-insp-title">{{ t('ai_inspector_title', 'Inspector') }}</span>
      <button class="ai-insp-close" :title="t('close_btn')" @click="closeInspector()">
        <X :size="15" />
      </button>
    </div>

    <div class="ai-insp-body">
      <!-- token 用量 + 缓存命中 + 费用估算（UI-E：自绘环区块替换为 AiUsageMeter） -->
      <section class="ai-insp-section">
        <h4 class="ai-insp-sec-title">
          <Gauge :size="13" />
          {{ t('ai_context_usage_title', '上下文用量') }}
        </h4>
        <AiUsageMeter variant="full" :context-usage="contextUsage" :provider-supports-cache="providerSupportsCache" />
      </section>

      <!-- 子代理总览（C4④：接线真实 agentRuns，无数据时给出诚实空态） -->
      <section class="ai-insp-section">
        <h4 class="ai-insp-sec-title">
          <Bot :size="13" />
          {{ t('ai_subagents_title', '子代理') }}
        </h4>
        <div v-if="hasAgents" class="ai-insp-agents">
          <div v-for="a in agentSummary" :key="a.id" class="ai-insp-agent" :class="statusClass(a.status)">
            <component :is="AGENT_ICONS[(a.status as keyof typeof AGENT_ICONS)] || CircleDot" :size="12" class="ai-insp-agent-icon" />
            <div class="ai-insp-agent-body">
              <span class="ai-insp-agent-name">{{ a.name }}</span>
              <span v-if="a.objective && a.objective !== a.name" class="ai-insp-agent-obj">{{ a.objective }}</span>
              <span class="ai-insp-agent-meta">
                {{ statusText(a.status) }}
                <template v-if="a.toolCount"> · {{ tf('ai_agent_tools_count', `${a.toolCount} 次工具调用`, { n: a.toolCount }) }}</template>
                <template v-if="formatDuration(a.duration)"> · {{ formatDuration(a.duration) }}</template>
              </span>
            </div>
          </div>
        </div>
        <div v-else class="ai-insp-placeholder">
          {{ t('ai_subagents_empty', '暂无运行中的子代理') }}
        </div>
      </section>

      <!-- 记忆速览（UI-E：占位替换为 AiMemoryPanel peek 态，点击进入管理弹层） -->
      <section class="ai-insp-section">
        <h4 class="ai-insp-sec-title">
          <Brain :size="13" />
          {{ t('ai_memory', '记忆') }}
        </h4>
        <AiMemoryPanel variant="peek" :memory-enabled="memoryEnabled" @open-manage="emit('open-memory')" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.ai-insp {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-surface);
  border-left: 1px solid var(--border-default);
  overflow: hidden;
}
.ai-insp--overlay {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: calc(var(--z-rail) + 1);
  width: 300px;
  max-width: calc(100% - 48px);
  box-shadow: var(--shadow-lg);
  animation: ai-insp-in 0.18s ease-out;
}

@keyframes ai-insp-in {
  from {
    opacity: 0;
    transform: translateX(12px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* 行内形态左缘把手 */
.ai-insp-resize {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: var(--z-sticky);
  background: transparent;
  transition: opacity 0.12s;
}
.ai-insp-resize:hover {
  background: var(--accent);
  opacity: 0.4;
}

.ai-insp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.ai-insp-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ai-insp-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    color 0.12s,
    background-color 0.12s;
}
.ai-insp-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.ai-insp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ai-insp-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ai-insp-sec-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-secondary);
}

/* 用量环 / 缓存命中 / 记忆速览样式已随区块迁入 AiUsageMeter.vue 与 AiMemoryPanel.vue（UI-E） */

/* 子代理总览列表（C4④） */
.ai-insp-agents {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-insp-agent {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 7px 9px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
}
.ai-insp-agent-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--text-tertiary);
}
.ai-insp-agent.is-running .ai-insp-agent-icon {
  color: var(--accent);
  animation: ai-insp-spin 1s linear infinite;
}
.ai-insp-agent.is-done .ai-insp-agent-icon {
  color: var(--success);
}
.ai-insp-agent.is-failed .ai-insp-agent-icon {
  color: var(--danger);
}
.ai-insp-agent-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ai-insp-agent-name {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-insp-agent-obj {
  font-size: var(--text-2xs);
  color: var(--text-secondary);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ai-insp-agent-meta {
  font-size: var(--text-2xs);
  color: var(--text-tertiary);
}
@keyframes ai-insp-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .ai-insp-agent.is-running .ai-insp-agent-icon {
    animation: none;
  }
}

/* 占位区块 */
.ai-insp-placeholder {
  padding: 12px 10px;
  font-size: var(--text-sm);
  color: var(--text-tertiary);
  text-align: center;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
}

/* 尊重系统「减少动态效果」设置 */
@media (prefers-reduced-motion: reduce) {
  .ai-insp--overlay {
    animation: none;
  }
}

/* 键盘可达性：focus-visible 高亮（--accent token） */
.ai-insp-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
