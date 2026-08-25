<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { Brain, Wrench, Bot, ChevronRight, Timer } from 'lucide-vue-next'
import type { ChatMessage } from '@/api/ai'

/**
 * AiProcessChips — 折叠态过程 chips 行（UI-C）
 *
 * 统一「过程折叠」结构的折叠入口：任务耗时 / 思考 Ns / 工具 N 次 / 子代理 N 个。
 * 点击整行 emit('toggle')，由父级控制折叠状态并联动 ThinkingCollapse 插入位。
 */
const props = defineProps<{
  message: ChatMessage
  /** 思考耗时（秒），由 AiMessage 的计时逻辑派生 */
  thinkingSecs?: number
  /** 任务总耗时文本，如 "3m 59s" */
  taskDurationText?: string
  /** 展开标记（用于箭头方向指示，折叠态默认 false） */
  expanded?: boolean
}>()
const emit = defineEmits<{ toggle: [] }>()
const { t } = useI18n()

const secs = computed(() => props.thinkingSecs ?? 0)
const taskDuration = computed(() => props.taskDurationText || '')
const toolCount = computed(() => {
  const calls = props.message.toolCalls?.length || 0
  if (calls) return calls
  return props.message.toolResults?.length || 0
})
const agentCount = computed(() => props.message.agentRuns?.length || 0)
const hasAny = computed(() => secs.value > 0 || toolCount.value > 0 || agentCount.value > 0 || !!taskDuration.value)
</script>

<template>
  <button v-if="hasAny" type="button" class="ai-process-chips" @click="emit('toggle')">
    <!-- 任务总耗时（放在最前面，最显眼位置） -->
    <span v-if="taskDuration" class="ai-chip ai-chip-duration">
      <Timer :size="11" />
      <span>{{ t('ai_process_duration', '任务耗时') }} {{ taskDuration }}</span>
    </span>
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
/* 行内 flow 风格 - 折叠态统计 */
.ai-process-chips {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px;
  border: none;
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  transition: background 0.1s ease;
  font-size: 11px;
  color: var(--text-tertiary);
}

.ai-process-chips:hover {
  background: var(--bg-hover);
}

.ai-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--text-tertiary);
  white-space: nowrap;
  font-weight: 400;
}

/* 任务耗时 chip：稍微突出一点 */
.ai-chip-duration {
  color: var(--text-secondary);
  font-weight: 500;
}

.ai-chip svg {
  color: var(--text-tertiary);
  flex-shrink: 0;
  width: 10px;
  height: 10px;
}

.ai-chip-duration svg {
  color: var(--accent);
  width: 11px;
  height: 11px;
}

.ai-chip-chev {
  color: var(--text-tertiary);
  margin-left: 2px;
  flex-shrink: 0;
  transition: transform 0.15s ease;
  width: 10px;
  height: 10px;
}

.ai-chip-chev.open {
  transform: rotate(90deg);
}

/* 键盘可达性 */
.ai-process-chips:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
  border-radius: 3px;
}
</style>
