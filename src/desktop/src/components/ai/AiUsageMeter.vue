<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { ContextUsage } from '@/api/ai'
import { Database, CheckCircle2, AlertTriangle } from 'lucide-vue-next'

/**
 * AiUsageMeter — 上下文用量统一展示（UI-E）。
 *
 * 能力（自 AiInspector 自绘环 / AiChatComposer 用量浮层 / AiCompressProgress 迁移合并）：
 *   1. token 用量环：三色档（<70% accent / 70–89% warning / ≥90% danger）
 *   2. 缓存命中率（供应商协议不支持时显示「未启用」而非 0%）
 *   3. 费用估算（token 数 × 硬编码单价表；TODO 对接后端费用接口）
 *   4. 上下文压缩进度条（能力迁自 AiCompressProgress，原文件已删除）
 *
 * variant：
 *   - 'full'    Inspector 完整态：环 + 总量/输入/输出统计 + 缓存 + 费用（+ compress 传入时追加压缩进度）
 *   - 'compact' Composer 触发点弹出面板紧凑态：环 + 输入/输出明细 + 缓存 + 费用
 *   - 'compress' 仅压缩进度分割线（AiChatPanel 消息流底部，替代 AiCompressProgress）
 */
const props = withDefaults(
  defineProps<{
    contextUsage?: ContextUsage | null
    /** 协议层是否支持 prompt cache（不支持时显示「未启用」而非 0%） */
    providerSupportsCache?: boolean
    /** 上下文压缩进度（useAiChat.compressProgress；null/未传则不渲染该区块） */
    compress?: {
      status: 'compressing' | 'done' | 'too_short' | 'failed'
      source: 'manual' | 'auto'
      removed?: number
      savedTokens?: number
      error?: string
    } | null
    variant?: 'full' | 'compact' | 'compress'
  }>(),
  {
    contextUsage: null,
    providerSupportsCache: undefined,
    compress: null,
    variant: 'full',
  },
)

const { t } = useI18n()

const isFull = computed(() => props.variant === 'full')
const isCompact = computed(() => props.variant === 'compact')
const isCompressOnly = computed(() => props.variant === 'compress')
const hasData = computed(() => !!props.contextUsage)

// ---- 用量环（三色档）----
const RING_SIZE = computed(() => (isCompact.value ? 48 : 64))
const RING_R = computed(() => (isCompact.value ? 20 : 26))
const ringC = computed(() => 2 * Math.PI * RING_R.value)
const ringCenter = computed(() => RING_SIZE.value / 2)

const usagePercent = computed(() => props.contextUsage?.percent ?? 0)
const ringDashOffset = computed(() => ringC.value * (1 - usagePercent.value / 100))
const ringLevel = computed(() => {
  const p = usagePercent.value
  if (p >= 90) return 'level-danger'
  if (p >= 70) return 'level-warn'
  return 'level-ok'
})
const ringLabel = computed(() => (hasData.value ? `${usagePercent.value}` : '–'))

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

// ---- 明细（compact：输入/输出两段；full：总量/输入/输出/思考）----
const totalTokens = computed(() => props.contextUsage?.totalTokens ?? 0)
const contextWindow = computed(() => props.contextUsage?.contextWindow ?? 0)
const promptTokens = computed(() => props.contextUsage?.promptTokens ?? 0)
const completionTokens = computed(() => props.contextUsage?.completionTokens ?? 0)
const cacheReadTokens = computed(() => props.contextUsage?.cacheReadTokens ?? 0)
const cacheWriteTokens = computed(() => props.contextUsage?.cacheWriteTokens ?? 0)
const thinkingTokens = computed(() => props.contextUsage?.thinkingTokens ?? 0)
const replyTokens = computed(() => props.contextUsage?.replyTokens ?? 0)
const cacheMissTokens = computed(() => Math.max(0, promptTokens.value - cacheReadTokens.value - cacheWriteTokens.value))

// ---- 缓存命中率（判定逻辑与 AiChatComposer/AiInspector 原实现一致）----
const cacheHitPercent = computed(() => {
  if (!props.contextUsage || !promptTokens.value) return 0
  return Math.min(100, Math.round((cacheReadTokens.value / promptTokens.value) * 100))
})
const cacheAvailable = computed(() => props.providerSupportsCache !== false)
const cacheHitRateText = computed(() => {
  if (!cacheAvailable.value) return t('ai_cache_not_enabled', '未启用')
  if (!hasData.value) return '–'
  return `${cacheHitPercent.value}%`
})

// ---- 费用估算 ----
// TODO(backend): 对接后端费用接口后替换（当前按 OpenAI 官方基准价硬编码估算，仅参考）
const PRICE_PER_MTOKEN = { input: 2.5, output: 10 } // USD / 百万 token
const estimatedCost = computed(() => {
  const c = props.contextUsage
  if (!c) return null
  const total =
    (c.promptTokens / 1_000_000) * PRICE_PER_MTOKEN.input + (c.completionTokens / 1_000_000) * PRICE_PER_MTOKEN.output
  if (total < 0.01) return '<$0.01'
  return '$' + total.toFixed(3)
})

// ---- 压缩进度（能力迁自 AiCompressProgress）----
const compressState = computed(() => props.compress)
const isCompressing = computed(() => compressState.value?.status === 'compressing')
const compressLabel = computed(() => {
  switch (compressState.value?.status) {
    case 'compressing':
      return t('ai_compress_compressing', '上下文压缩中')
    case 'done':
      return t('ai_compress_done', '压缩已完成')
    case 'too_short':
      return t('ai_compact_too_short', '当前对话历史太短，无需压缩')
    case 'failed':
      return t('ai_compress_failed', '压缩失败')
    default:
      return ''
  }
})
const compressDetail = computed(() => {
  if (compressState.value?.status !== 'done' || !compressState.value.removed) return ''
  return t('ai_compress_done_detail', {
    removed: compressState.value.removed,
    savedTokens: compressState.value.savedTokens ?? 0,
  })
})
</script>

<template>
  <!-- compress 独立形态：分割线样式（AiChatPanel 底部，替代 AiCompressProgress） -->
  <div v-if="isCompressOnly && compressState" class="ai-um-compress" :class="`ai-um-compress--${compressState.status}`">
    <span class="ai-um-compress-line" />
    <span class="ai-um-compress-center">
      <template v-if="isCompressing">
        <span class="ai-um-compress-dot" />
        <span class="ai-um-compress-text ai-um-compress-text--pulse">{{ compressLabel }}</span>
      </template>
      <template v-else-if="compressState.status === 'done'">
        <CheckCircle2 :size="14" class="ai-um-compress-icon ai-um-compress-icon--ok" />
        <span class="ai-um-compress-text">{{ compressLabel }}</span>
        <span v-if="compressDetail" class="ai-um-compress-detail">{{ compressDetail }}</span>
      </template>
      <template v-else>
        <AlertTriangle
          :size="13"
          class="ai-um-compress-icon"
          :class="compressState.status === 'failed' ? 'ai-um-compress-icon--err' : 'ai-um-compress-icon--warn'"
        />
        <span class="ai-um-compress-text">{{ compressLabel }}</span>
      </template>
    </span>
    <span class="ai-um-compress-line" />
  </div>

  <!-- full / compact 形态 -->
  <div v-else-if="!isCompressOnly" class="ai-um" :class="`ai-um--${variant}`">
    <!-- 无数据空态 -->
    <div v-if="!hasData" class="ai-um-empty">
      {{ t('ai_context_usage_none', '暂无数据，发起一次对话后将显示上下文用量') }}
    </div>

    <template v-else>
      <!-- 环 + 核心统计 -->
      <div class="ai-um-ring-row">
        <svg
          class="ai-um-ring"
          :class="ringLevel"
          :width="RING_SIZE"
          :height="RING_SIZE"
          :viewBox="`0 0 ${RING_SIZE} ${RING_SIZE}`"
          role="img"
          :aria-label="t('ai_context_usage_title', '上下文用量')"
        >
          <circle class="ring-track" :cx="ringCenter" :cy="ringCenter" :r="RING_R" />
          <circle
            class="ring-progress"
            :cx="ringCenter"
            :cy="ringCenter"
            :r="RING_R"
            :stroke-dasharray="ringC"
            :stroke-dashoffset="ringDashOffset"
          />
          <text class="ring-label" :x="ringCenter" :y="ringCenter" dominant-baseline="central">
            {{ ringLabel }}
            <tspan class="ring-label-pct" font-size="0.6em">%</tspan>
          </text>
        </svg>

        <!-- full：总量/输入/输出/思考；compact：仅总计 + 命中 -->
        <dl v-if="isFull" class="ai-um-stats">
          <div class="ai-um-stat">
            <dt>{{ t('ai_usage_total', '总量') }}</dt>
            <dd>{{ formatTokens(totalTokens) }} / {{ formatTokens(contextWindow) }}</dd>
          </div>
          <div class="ai-um-stat">
            <dt>{{ t('ai_usage_prompt', '输入') }}</dt>
            <dd>{{ formatTokens(promptTokens) }}</dd>
          </div>
          <div class="ai-um-stat">
            <dt>{{ t('ai_usage_completion', '输出') }}</dt>
            <dd>{{ formatTokens(completionTokens) }}</dd>
          </div>
          <div v-if="thinkingTokens" class="ai-um-stat">
            <dt>{{ t('ai_usage_thinking', '思考') }}</dt>
            <dd>{{ formatTokens(thinkingTokens) }}</dd>
          </div>
        </dl>
        <dl v-else class="ai-um-stats">
          <div class="ai-um-stat">
            <dt>{{ t('ai_token_usage_total', '总计') }}</dt>
            <dd>{{ formatTokens(totalTokens) }}</dd>
          </div>
          <div class="ai-um-stat">
            <dt>{{ t('ai_token_usage_hit_rate', '缓存命中率') }}</dt>
            <dd>{{ cacheHitRateText }}</dd>
          </div>
        </dl>
      </div>

      <!-- compact：输入/输出明细（迁自 Composer 用量浮层） -->
      <div v-if="isCompact" class="ai-um-section">
        <div class="ai-um-section-title">
          <span class="dot dot--input" />
          <span>{{ t('ai_token_usage_input', '输入') }}</span>
          <span class="ai-um-section-val">{{ formatTokens(promptTokens) }}</span>
        </div>
        <div class="ai-um-detail-row">
          <span class="dot dot--hit" />
          <span>{{ t('ai_token_usage_cache_hit', '缓存命中') }}</span>
          <span>{{ formatTokens(cacheReadTokens) }}</span>
        </div>
        <div class="ai-um-detail-row">
          <span class="dot dot--miss" />
          <span>{{ t('ai_token_usage_cache_miss', '缓存未命中') }}</span>
          <span>{{ formatTokens(cacheMissTokens) }}</span>
        </div>
        <div class="ai-um-detail-row">
          <span class="dot dot--write" />
          <span>{{ t('ai_token_usage_cache_write', '缓存写入') }}</span>
          <span>{{ formatTokens(cacheWriteTokens) }}</span>
        </div>
      </div>
      <div v-if="isCompact" class="ai-um-section">
        <div class="ai-um-section-title">
          <span class="dot dot--output" />
          <span>{{ t('ai_token_usage_output', '输出') }}</span>
          <span class="ai-um-section-val">{{ formatTokens(completionTokens) }}</span>
        </div>
        <div class="ai-um-detail-row">
          <span class="dot dot--thinking" />
          <span>{{ t('ai_token_usage_thinking', '思考过程') }}</span>
          <span>{{ formatTokens(thinkingTokens) }}</span>
        </div>
        <div class="ai-um-detail-row">
          <span class="dot dot--reply" />
          <span>{{ t('ai_token_usage_reply', '回复内容') }}</span>
          <span>{{ formatTokens(replyTokens) }}</span>
        </div>
      </div>

      <!-- 缓存命中率（full 态展示条形；compact 已在明细中给数值，这里仅条形） -->
      <div v-if="cacheAvailable" class="ai-um-cache">
        <div class="ai-um-cache-head">
          <span class="ai-um-cache-title">
            <Database :size="12" />
            {{ t('ai_cache_hit_title', '缓存命中') }}
          </span>
          <span class="ai-um-cache-val">{{ cacheHitRateText }}</span>
        </div>
        <div class="ai-um-bar">
          <div class="ai-um-bar-fill" :style="{ transform: `scaleX(${cacheHitPercent / 100})` }" />
        </div>
      </div>
      <div v-else-if="isFull" class="ai-um-cache-hint">
        {{ t('ai_cache_not_supported_hint', '当前供应商协议不支持 prompt 缓存') }}
      </div>

      <!-- 费用估算 -->
      <div v-if="estimatedCost" class="ai-um-cost">
        <span>{{ t('ai_estimated_cost', '预估费用') }}</span>
        <span class="ai-um-cost-val">{{ estimatedCost }}</span>
      </div>

      <!-- full 态 + 传入 compress：内联压缩进度 -->
      <div
        v-if="isFull && compressState"
        class="ai-um-compress ai-um-compress--inline"
        :class="`ai-um-compress--${compressState.status}`"
      >
        <span class="ai-um-compress-center">
          <template v-if="isCompressing">
            <span class="ai-um-compress-dot" />
            <span class="ai-um-compress-text ai-um-compress-text--pulse">{{ compressLabel }}</span>
          </template>
          <template v-else-if="compressState.status === 'done'">
            <CheckCircle2 :size="13" class="ai-um-compress-icon ai-um-compress-icon--ok" />
            <span class="ai-um-compress-text">{{ compressLabel }}</span>
            <span v-if="compressDetail" class="ai-um-compress-detail">{{ compressDetail }}</span>
          </template>
          <template v-else>
            <AlertTriangle
              :size="12"
              class="ai-um-compress-icon"
              :class="compressState.status === 'failed' ? 'ai-um-compress-icon--err' : 'ai-um-compress-icon--warn'"
            />
            <span class="ai-um-compress-text">{{ compressLabel }}</span>
          </template>
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ai-um {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.ai-um-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 0 4px;
  font-size: var(--text-sm);
  color: var(--text-tertiary);
  text-align: center;
}

/* 环 + 统计行 */
.ai-um-ring-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.ai-um-ring {
  flex-shrink: 0;
}
.ai-um-ring .ring-track {
  fill: none;
  stroke: var(--border-default);
  stroke-width: 5;
}
.ai-um-ring .ring-progress {
  fill: none;
  stroke: currentColor;
  stroke-width: 5;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: center;
  transition: stroke-dashoffset 0.3s ease;
}
.ai-um-ring .ring-label {
  font-size: 13px;
  font-weight: 600;
  fill: var(--text-primary);
  text-anchor: middle;
}
.ai-um-ring .ring-label-pct {
  fill: var(--text-tertiary);
}
.ai-um-ring.level-ok {
  color: var(--accent);
}
.ai-um-ring.level-warn {
  color: var(--warning);
}
.ai-um-ring.level-danger {
  color: var(--danger);
}

.ai-um-stats {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.ai-um-stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.ai-um-stat dt {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
}
.ai-um-stat dd {
  margin: 0;
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

/* 明细段（compact） */
.ai-um-section {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ai-um-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
}
.ai-um-section-val {
  margin-left: auto;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.ai-um-detail-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 14px;
  font-size: var(--text-xs);
  color: var(--text-secondary);
}
.ai-um-detail-row span:last-child {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  flex-shrink: 0;
}
.dot--input {
  background: var(--info);
}
.dot--output {
  background: var(--accent);
}
.dot--hit {
  background: var(--success);
}
.dot--miss {
  background: var(--danger);
}
.dot--write {
  background: var(--warning);
}
.dot--thinking {
  background: var(--warning);
}
.dot--reply {
  background: var(--accent);
}

/* 缓存命中率 */
.ai-um-cache {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ai-um-cache-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ai-um-cache-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--text-xs);
  color: var(--text-secondary);
}
.ai-um-cache-val {
  font-size: var(--text-sm);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--success);
}
.ai-um-cache-hint {
  font-size: var(--text-2xs);
  color: var(--text-tertiary);
}
.ai-um-bar {
  height: 4px;
  border-radius: 999px;
  background: var(--bg-hover);
  overflow: hidden;
}
.ai-um-bar-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--success);
  transform-origin: left center;
  transform: scaleX(0);
  transition: transform 0.3s ease;
}

/* 费用估算 */
.ai-um-cost {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 4px;
  border-top: 1px solid var(--border-subtle);
  font-size: var(--text-xs);
  color: var(--text-tertiary);
}
.ai-um-cost-val {
  font-weight: 600;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

/* 压缩进度（能力迁自 AiCompressProgress；动画仅 opacity/transform） */
.ai-um-compress {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
  font-size: var(--text-sm);
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.ai-um-compress--inline {
  padding: 4px 0 0;
  border-top: 1px solid var(--border-subtle);
}
.ai-um-compress-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--border-default) 50%, transparent);
}
.ai-um-compress-center {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  max-width: 100%;
}
.ai-um-compress-dot {
  flex-shrink: 0;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  animation: ai-um-pulse 1.3s ease-in-out infinite;
}
.ai-um-compress-icon {
  flex-shrink: 0;
}
.ai-um-compress-icon--ok {
  color: var(--success);
}
.ai-um-compress-icon--warn {
  color: var(--text-tertiary);
}
.ai-um-compress-icon--err {
  color: var(--danger);
}
.ai-um-compress-text {
  font-weight: 600;
  color: var(--text-secondary);
}
.ai-um-compress-text--pulse {
  animation: ai-um-pulse 1.6s ease-in-out infinite;
}
.ai-um-compress-detail {
  font-weight: 400;
  color: var(--text-tertiary);
}
@keyframes ai-um-pulse {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-um-compress-dot,
  .ai-um-compress-text--pulse {
    animation: none;
  }
}
</style>
