<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { ChatMessage } from '@/api/ai'
import AiMessage from './AiMessage.vue'

const props = defineProps<{ messages: ChatMessage[]; isStreaming: boolean }>()
const { t } = useI18n()

const scrollRef = ref<HTMLElement | null>(null)

function scrollToBottom() {
  nextTick(() => {
    const el = scrollRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

watch(
  () => props.messages.length,
  () => scrollToBottom(),
)
watch(
  () => (props.messages[props.messages.length - 1]?.content || ''),
  () => scrollToBottom(),
)
watch(
  () => (props.messages[props.messages.length - 1]?.thinking || ''),
  () => scrollToBottom(),
)
</script>

<template>
  <div ref="scrollRef" class="ai-msg-list">
    <div v-if="messages.length === 0" class="ai-msg-empty">
      {{ t('ai_chat_empty') }}
    </div>
    <AiMessage
      v-for="(m, i) in messages"
      :key="i"
      :message="m"
      :index="messages.length - 1 - i"
      :is-streaming="isStreaming"
    />
  </div>
</template>

<style scoped>
.ai-msg-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-msg-empty {
  margin: auto;
  color: var(--text-tertiary);
  font-size: 13px;
  text-align: center;
  padding: 24px;
}
</style>
