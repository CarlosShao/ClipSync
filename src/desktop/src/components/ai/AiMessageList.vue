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

// 定位到指定消息（#231 历史搜索）：按对话内位置索引滚动到该条消息并高亮。
// 通过内容匹配（pos 是数据库里的序号，前端 messages 可能已被过滤），
// 找不到时尝试滚到中间位置。
const locateMarkId = ref<string | null>(null)
function scrollToPos(pos: number, highlightText?: string) {
  nextTick(() => {
    const el = scrollRef.value
    if (!el) return
    // 优先按文本定位（前端消息可能被过滤/重组）
    let targetIndex = -1
    if (highlightText) {
      const idx = props.messages.findIndex((m) => m.content && m.content.includes(highlightText))
      targetIndex = idx
    }
    if (targetIndex < 0) {
      // 退化为按位置估算：pos 是 DB 里升序序号，前端消息通常也是升序
      const ratio = props.messages.length ? Math.min(0.9, Math.max(0.05, (pos - 1) / Math.max(1, props.messages.length))) : 0
      el.scrollTop = Math.round(ratio * (el.scrollHeight - el.clientHeight))
      return
    }
    const child = el.children[targetIndex] as HTMLElement | undefined
    if (child) {
      el.scrollTop = child.offsetTop - el.clientHeight / 2
      // 高亮闪烁
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
      :index="messages.length - 1 - i"
      :is-streaming="isStreaming"
      :class="isLocateMarked(i) ? 'ai-msg-locate-mark' : undefined"
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
  /* 明确显示滚动条，避免 WebView 默认隐藏导致用户以为无法滚动 */
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
