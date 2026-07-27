<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { ChatMessage } from '@/api/ai'

const props = defineProps<{ messages: ChatMessage[]; isStreaming: boolean }>()
const { t } = useI18n()

const scrollRef = ref<HTMLElement | null>(null)

function scrollToBottom() {
  nextTick(() => {
    const el = scrollRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

// 新消息或正在流式输出时自动滚到底部
watch(
  () => props.messages.length,
  () => scrollToBottom(),
)
watch(
  () => (props.messages[props.messages.length - 1]?.content || ''),
  () => scrollToBottom(),
)
</script>

<template>
  <div ref="scrollRef" class="ai-msg-list">
    <div v-if="messages.length === 0" class="ai-msg-empty">
      {{ t('ai_chat_empty') }}
    </div>

    <div v-for="(m, i) in messages" :key="i" class="ai-msg" :class="m.role">
      <div class="ai-msg-bubble">
        <div class="ai-msg-role">{{ m.role === 'user' ? t('ai_you') : t('ai_assistant') }}</div>
        <div class="ai-msg-content">{{ m.content || (isStreaming && i === messages.length - 1 ? '…' : '') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-msg-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ai-msg-empty {
  margin: auto;
  color: var(--text-tertiary);
  font-size: 13px;
  text-align: center;
  padding: 24px;
}
.ai-msg {
  display: flex;
}
.ai-msg.user {
  justify-content: flex-end;
}
.ai-msg.assistant {
  justify-content: flex-start;
}
.ai-msg-bubble {
  max-width: 88%;
  padding: 10px 12px;
  border-radius: var(--radius-lg, 12px);
  font-size: 13px;
  line-height: 1.55;
}
.ai-msg.user .ai-msg-bubble {
  background: var(--accent-bg);
  color: var(--accent);
  border-bottom-right-radius: 4px;
}
.ai-msg.assistant .ai-msg-bubble {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-bottom-left-radius: 4px;
}
.ai-msg-role {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.7;
  margin-bottom: 4px;
}
.ai-msg-content {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
