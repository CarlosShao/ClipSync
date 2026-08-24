<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { Brain, Wrench, Bot, ChevronRight } from 'lucide-vue-next'
import type { ChatMessage } from '@/api/ai'

/**
 * AiProcessChips — 折叠态过程 chips 行（UI-C）
 *
 * 统一「过程折叠」结构的折叠入口：思考 Ns / 工具 N 次 / 子代理 N 个。
 * 数据全部从消息对象只读派生（不新增协议字段）：
 *   - 思考耗时由父级 AiMessage 传入（含 thinkingActive 结束时刻判定）；
 *   - 工具次数优先 toolCalls，缺失时从 toolResults 兜底（与展开态时间线一致）；
 *   - 子代理数取 agentRuns。
 * 点击整行 emit('toggle')，由父级控制折叠状态并联动 ThinkingCollapse 插入位。
 */
const props = defineProps<{
  message: ChatMessage
  /** 思考耗时（秒），由 AiMessage 的计时逻辑派生 */
  thinkingSecs?: number
  /** 展开标记（用于箭头方向指示，折叠态默认 false） */
  expanded?: boolean
}>()
const emit = defineEmits<{ toggle: [] }>()
const { t } = useI18n()

const secs = computed(() => props.thinkingSecs ?? 0)
const toolCount = computed(() => {
  const calls = props.message.toolCalls?.length || 0
  if (calls) return calls
  return props.message.toolResults?.length || 0
})
const agentCount = computed(() => props.message.agentRuns?.length || 0)
const hasAny = computed(() => secs.value > 0 || toolCount.value > 0 || agentCount.value > 0)
</script>

<template>
  <button v-if="hasAny" type="button" class="ai-process-chips" @click="emit('toggle')">
    <span v-if="secs > 0" class="ai-chip">
      <Brain :size="11" />
      <span>{{ t('ai_process_thinking', { n: secs }) }}</span>
    </span>
    <span v-if="toolCount > 0" class="ai-chip">
      <Wrench :size="11" />
      <span>{{ t('ai_process_tools', { n: toolCount }) }}</span>
    </span>
    <span v-if="agentCount > 0" class="ai-chip">
      <Bot :size="11" />
      <span>{{ t('ai_process_agents', { n: agentCount }) }}</span>
    </span>
    <ChevronRight :size="13" class="ai-chip-chev" :class="{ open: expanded }" />
  </button>
</template>

<style scoped>
.ai-process-chips {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md, 8px);
  background: transparent;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}

.ai-process-chips:hover {
  background: var(--bg-hover);
  border-color: var(--accent);
}

.ai-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-secondary);
  background: var(--bg-hover);
  border-radius: 999px;
  padding: 1px 8px;
  white-space: nowrap;
}

.ai-chip svg {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.ai-chip-chev {
  color: var(--text-tertiary);
  margin-left: 2px;
  flex-shrink: 0;
  transition: transform 0.15s ease;
}

.ai-chip-chev.open {
  transform: rotate(90deg);
}
</style>
