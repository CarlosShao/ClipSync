<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAiChatUi } from '@/composables/useAiChatUi'
import { useResizablePanel } from '@/composables/useResizablePanel'
import type { ContextUsage } from '@/api/ai'
import { Gauge, Database, Bot, Brain, X } from 'lucide-vue-next'

/**
 * AI Shell 右侧 Inspector（UI-B）。
 * xl（≥1440）行内展开；lg（1100–1439）折叠为浮层（可呼出）；数据由 contextUsage 驱动（props 传入）。
 * 区块：token 用量环（自绘，参考 AiChatInput 用量环实现）/ 缓存命中 / 子代理总览（占位）/ 记忆速览（占位）。
 */
const props = defineProps<{
  contextUsage: ContextUsage | null
  /** 协议层是否支持 prompt cache（与 AiChatInput 判定一致：不支持时显示「未启用」而非 0%） */
  providerSupportsCache?: boolean
  memoryEnabled?: boolean
}>()

const emit = defineEmits<{
  'open-memory': []
}>()

const { t } = useI18n()
const { inspectorMode, closeInspector } = useAiChatUi()

// 行内形态宽度拖拽（右侧面板：拖左缘左移变宽 → 默认方向）
const { width, startDrag } = useResizablePanel({
  storageKey: 'ai-inspector-width',
  min: 240,
  max: 420,
  default: 300,
})

const isOverlay = computed(() => inspectorMode.value === 'overlay')

// === token 用量环（自绘单环 = 上下文占用百分比）===
const RING_R = 26
const RING_C = 2 * Math.PI * RING_R
const RING_SIZE = 64
const RING_CENTER = RING_SIZE / 2

const usagePercent = computed(() => props.contextUsage?.percent ?? 0)
const ringDashOffset = computed(() => RING_C * (1 - usagePercent.value / 100))
const ringLevel = computed(() => {
  const p = usagePercent.value
  if (p >= 90) return 'level-danger'
  if (p >= 70) return 'level-warn'
  return 'level-ok'
})
const ringLabel = computed(() => (props.contextUsage ? `${usagePercent.value}` : '–'))

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

// === 缓存命中（判定逻辑与 AiChatInput 一致）===
const cacheHitPercent = computed(() => {
  const c = props.contextUsage
  if (!c || !c.promptTokens) return 0
  const cached = c.cacheReadTokens || 0
  return Math.min(100, Math.round((cached / c.promptTokens) * 100))
})
const cacheAvailable = computed(() => props.providerSupportsCache !== false)
const cacheHitRateText = computed(() => {
  if (!cacheAvailable.value) return t('ai_cache_not_enabled') || '未启用'
  if (!props.contextUsage) return '–'
  return `${cacheHitPercent.value}%`
})
</script>

<template>
  <div class="ai-insp" :class="{ 'ai-insp--overlay': isOverlay }" :style="isOverlay ? {} : { width: width + 'px' }">
    <!-- 行内形态：左缘拖拽把手 -->
    <div v-if="!isOverlay" class="ai-insp-resize" title="拖拽调整宽度" @mousedown="startDrag" />

    <div class="ai-insp-head">
      <span class="ai-insp-title">{{ t('ai_inspector_title') || 'Inspector' }}</span>
      <button class="ai-insp-close" :title="t('close_btn')" @click="closeInspector()">
        <X :size="15" />
      </button>
    </div>

    <div class="ai-insp-body">
      <!-- token 用量环 -->
      <section class="ai-insp-section">
        <h4 class="ai-insp-sec-title">
          <Gauge :size="13" />
          {{ t('ai_context_usage_title') || '上下文用量' }}
        </h4>
        <div class="ai-insp-ring-row">
          <svg
            class="ai-insp-ring"
            :class="ringLevel"
            :width="RING_SIZE"
            :height="RING_SIZE"
            :viewBox="`0 0 ${RING_SIZE} ${RING_SIZE}`"
            role="img"
            :aria-label="t('ai_context_usage_title') || '上下文用量'"
          >
            <circle class="ring-track" :cx="RING_CENTER" :cy="RING_CENTER" :r="RING_R" />
            <circle
              class="ring-progress"
              :cx="RING_CENTER"
              :cy="RING_CENTER"
              :r="RING_R"
              :stroke-dasharray="RING_C"
              :stroke-dashoffset="ringDashOffset"
            />
            <text class="ring-label" :x="RING_CENTER" :y="RING_CENTER" dominant-baseline="central">
              {{ ringLabel }}
              <tspan class="ring-label-pct" font-size="0.6em">%</tspan>
            </text>
          </svg>
          <dl class="ai-insp-stats">
            <div class="ai-insp-stat">
              <dt>{{ t('ai_usage_total') || '总量' }}</dt>
              <dd>
                {{ contextUsage ? formatTokens(contextUsage.totalTokens) : '–' }} /
                {{ contextUsage ? formatTokens(contextUsage.contextWindow) : '–' }}
              </dd>
            </div>
            <div class="ai-insp-stat">
              <dt>{{ t('ai_usage_prompt') || '输入' }}</dt>
              <dd>{{ contextUsage?.promptTokens != null ? formatTokens(contextUsage.promptTokens) : '–' }}</dd>
            </div>
            <div class="ai-insp-stat">
              <dt>{{ t('ai_usage_completion') || '输出' }}</dt>
              <dd>{{ contextUsage?.completionTokens != null ? formatTokens(contextUsage.completionTokens) : '–' }}</dd>
            </div>
            <div v-if="contextUsage?.thinkingTokens" class="ai-insp-stat">
              <dt>{{ t('ai_usage_thinking') || '思考' }}</dt>
              <dd>{{ formatTokens(contextUsage.thinkingTokens) }}</dd>
            </div>
          </dl>
        </div>
      </section>

      <!-- 缓存命中 -->
      <section class="ai-insp-section">
        <h4 class="ai-insp-sec-title">
          <Database :size="13" />
          {{ t('ai_cache_hit_title') || '缓存命中' }}
        </h4>
        <div class="ai-insp-stat-row">
          <span class="ai-insp-stat-value">{{ cacheHitRateText }}</span>
          <span class="ai-insp-stat-hint">
            {{
              cacheAvailable
                ? t('ai_cache_hit_hint') || '命中越高越省 token 成本'
                : t('ai_cache_not_supported_hint') || '当前供应商协议不支持 prompt 缓存'
            }}
          </span>
        </div>
        <div v-if="cacheAvailable && contextUsage" class="ai-insp-bar">
          <div class="ai-insp-bar-fill" :style="{ transform: `scaleX(${cacheHitPercent / 100})` }" />
        </div>
      </section>

      <!-- 子代理总览（占位：内容由后续包填充） -->
      <section class="ai-insp-section">
        <h4 class="ai-insp-sec-title">
          <Bot :size="13" />
          {{ t('ai_subagents_title') || '子代理' }}
        </h4>
        <div class="ai-insp-placeholder">
          {{ t('ai_subagents_empty') || '暂无运行中的子代理' }}
        </div>
      </section>

      <!-- 记忆速览（占位：内容由后续包填充） -->
      <section class="ai-insp-section">
        <h4 class="ai-insp-sec-title">
          <Brain :size="13" />
          {{ t('ai_memory') || '记忆' }}
        </h4>
        <div class="ai-insp-placeholder ai-insp-placeholder--action" @click="emit('open-memory')">
          <span>
            {{ memoryEnabled ? t('ai_memory_on') || '长程记忆已开启' : t('ai_memory_off') || '长程记忆已关闭' }}
          </span>
          <span class="ai-insp-placeholder-link">{{ t('ai_memory_manage') || '管理记忆' }}</span>
        </div>
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

/* 用量环 */
.ai-insp-ring-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.ai-insp-ring {
  flex-shrink: 0;
}
.ai-insp-ring .ring-track {
  fill: none;
  stroke: var(--border-default);
  stroke-width: 5;
}
.ai-insp-ring .ring-progress {
  fill: none;
  stroke: currentColor;
  stroke-width: 5;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: center;
  transition: stroke-dashoffset 0.3s ease;
}
.ai-insp-ring .ring-label {
  font-size: 13px;
  font-weight: 600;
  fill: var(--text-primary);
  text-anchor: middle;
}
.ai-insp-ring .ring-label-pct {
  fill: var(--text-tertiary);
}
.ai-insp-ring.level-ok {
  color: var(--accent);
}
.ai-insp-ring.level-warn {
  color: var(--warning);
}
.ai-insp-ring.level-danger {
  color: var(--danger);
}

.ai-insp-stats {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.ai-insp-stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.ai-insp-stat dt {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
}
.ai-insp-stat dd {
  margin: 0;
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

/* 缓存命中 */
.ai-insp-stat-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.ai-insp-stat-value {
  font-size: var(--text-base);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}
.ai-insp-stat-hint {
  font-size: var(--text-2xs);
  color: var(--text-tertiary);
  text-align: right;
}
.ai-insp-bar {
  height: 4px;
  border-radius: 999px;
  background: var(--bg-hover);
  overflow: hidden;
}
.ai-insp-bar-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transform-origin: left center;
  transform: scaleX(0);
  transition: transform 0.3s ease;
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
.ai-insp-placeholder--action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s;
}
.ai-insp-placeholder--action:hover {
  border-color: var(--accent);
}
.ai-insp-placeholder-link {
  flex-shrink: 0;
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--accent);
}

/* 尊重系统「减少动态效果」设置 */
@media (prefers-reduced-motion: reduce) {
  .ai-insp--overlay {
    animation: none;
  }
}
</style>
