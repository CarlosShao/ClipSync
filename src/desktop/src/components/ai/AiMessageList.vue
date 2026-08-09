<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { ChatMessage } from '@/api/ai'
import AiMessage from './AiMessage.vue'

const props = defineProps<{ messages: ChatMessage[]; isStreaming: boolean }>()
const emit = defineEmits<{ reedit: [content: string] }>()
const { t } = useI18n()

const scrollRef = ref<HTMLElement | null>(null)
const userScrolledUp = ref(false)

function isNearBottom(el: HTMLElement) {
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

watch(() => props.messages.length, () => scrollToBottom())
watch(() => (props.messages[props.messages.length - 1]?.content || ''), () => scrollToBottom())
watch(() => (props.messages[props.messages.length - 1]?.thinking || ''), () => scrollToBottom())
watch(() => props.messages, () => scrollToBottom(true))

// 定位到指定消息（#231 历史搜索）
const locateMarkId = ref<string | null>(null)
function scrollToPos(pos: number, highlightText?: string) {
  nextTick(() => {
    const el = scrollRef.value
    if (!el) return
    let targetIndex = -1
    if (highlightText) {
      const idx = props.messages.findIndex((m) => m.content && m.content.includes(highlightText))
      targetIndex = idx
    }
    if (targetIndex < 0) {
      const ratio = props.messages.length ? Math.min(0.9, Math.max(0.05, (pos - 1) / Math.max(1, props.messages.length))) : 0
      el.scrollTop = Math.round(ratio * (el.scrollHeight - el.clientHeight))
      return
    }
    const child = el.children[targetIndex] as HTMLElement | undefined
    if (child) {
      el.scrollTop = child.offsetTop - el.clientHeight / 2
      locateMarkId.value = String(targetIndex)
      setTimeout(() => {
        if (locateMarkId.value === String(targetIndex)) locateMarkId.value = null
      }, 2000)
    }
  })
}
function isLocateMarked(index: number): boolean {
  return locateMarkId.value === String(index)
}

// 判断消息是否是最新消息（最后一条 assistant 消息）
function isLatestMessage(index: number): boolean {
  // 找到最后一条 assistant 消息的索引
  let lastAssistantIdx = -1
  for (let i = props.messages.length - 1; i >= 0; i--) {
    if (props.messages[i].role === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }
  return index === lastAssistantIdx
}

// 判断消息是否是当前流式消息
function isStreamingMessage(index: number): boolean {
  return props.isStreaming && isLatestMessage(index)
}

defineExpose({ scrollToPos })
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
      :index="i"
      :is-streaming="isStreamingMessage(i)"
      :is-latest="isLatestMessage(i)"
      :class="isLocateMarked(i) ? 'ai-msg-locate-mark' : undefined"
      @reedit="(c: string) => emit('reedit', c)"
    />
  </div>
</template>

<style scoped>
.ai-msg-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--border-default) transparent;
}
.ai-msg-list::-webkit-scrollbar {
  width: 6px;
}
.ai-msg-list::-webkit-scrollbar-thumb {
  background: var(--border-default);
  border-radius: 3px;
}
.ai-msg-list::-webkit-scrollbar-track {
  background: transparent;
}
.ai-msg-empty {
  margin: auto;
  color: var(--text-tertiary);
  font-size: 13px;
  text-align: center;
  padding: 24px;
}
/* 历史搜索定位高亮闪烁（#231） */
.ai-msg-locate-mark {
  animation: ai-msg-locate-flash 2s ease;
}
@keyframes ai-msg-locate-flash {
  0%, 60% { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 8px; background: var(--accent-bg); }
  100% { outline: transparent; }
}
</style>
