<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { ChatMessage } from '@/api/ai'
import AiMessage from './AiMessage.vue'

const props = defineProps<{ messages: ChatMessage[]; isStreaming: boolean }>()
const { t } = useI18n()

const scrollRef = ref<HTMLElement | null>(null)
const userScrolledUp = ref(false)

function isNearBottom(el: HTMLElement) {
  // 距离底部 80px 内视为“已在底部”
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

function scrollToBottom(force = false) {
  nextTick(() => {
    const el = scrollRef.value
    if (!el) return
    if (!force && userScrolledUp.value && !isNearBottom(el)) return
    el.scrollTop = el.scrollHeight
    if (isNearBottom(el)) userScrolledUp.value = false
  })
}

function onScroll() {
  const el = scrollRef.value
  if (!el) return
  userScrolledUp.value = !isNearBottom(el)
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
// 切换对话（messages 引用整体被替换）时强制滚到底部，确保打开历史对话看到最新消息，
// 而不是停留在旧位置导致“上一条记录滚不上去/看不到”。
watch(
  () => props.messages,
  () => scrollToBottom(true),
)
</script>

<template>
  <div ref="scrollRef" class="ai-msg-list" @scroll="onScroll">
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
  overscroll-behavior: contain;
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
