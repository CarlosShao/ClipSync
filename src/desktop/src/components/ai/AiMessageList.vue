<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { ChatMessage } from '@/api/ai'
import AiMessage from './AiMessage.vue'
import AiErrorBar from './AiErrorBar.vue'
import AiDuplicateNotice from './AiDuplicateNotice.vue'
import FxConversationRuler from '@/components/fx/FxConversationRuler.vue'
import { useReducedMotion } from '@/components/fx/useReducedMotion'

/**
 * UI-C：顶部区域挂载原子状态组件（错误条 / 图片重复横幅）。
 * error / duplicateNotice 均为可选 props——AiChatPanel 等宿主未传入时不渲染，
 * 新 Shell（UI-B）接入时传入即可，不产生重复展示。
 * 注：破坏性工具确认 Modal 由宿主 AiChatPanel 统一管理（Teleport 全屏弹层），
 * 本列表不挂载旧版 AiConfirmCard，避免双弹层。
 */
const props = defineProps<{
  messages: ChatMessage[]
  isStreaming: boolean
  confirmTool?: string | null
  error?: string
  duplicateNotice?: { createdAt?: string } | null
}>()
const emit = defineEmits<{
  reedit: [content: string, message: import('@/api/ai').ChatMessage]
  'dismiss-duplicate': []
}>()
const { t, tf } = useI18n()

const scrollRef = ref<HTMLElement | null>(null)
const userScrolledUp = ref(false)
// 刻度尺：当前"读到哪"的刻度。按滚动进度等比映射 —— 消息高度不等，等比只是定位近似，
// 好处是不必在 scroll 事件里逐条测量 DOM。跳转仍用真实消息下标（见 jumpTo）。
const activeIndex = ref(-1)
const reduced = useReducedMotion()
// 刻度尺按"轮"分组：一个刻度 = 一轮完整对话（我发出的消息 + 它的回答），
// 不是一个消息一个刻度。map[i] = 第 i 条消息属于哪一轮，供"点刻度跳到该轮首条消息"用。
const rulerData = computed(() => {
  const turns: { question?: string; answer?: string }[] = []
  const map: number[] = []
  for (const m of props.messages) {
    const isUser = m.role === 'user'
    if (isUser || turns.length === 0) {
      turns.push({ question: isUser ? m.content || '' : '', answer: isUser ? '' : m.content || '' })
    } else {
      // 回答方 / 工具消息：并入当前轮（概要展示时会压平空白，多段也能看）
      const cur = turns[turns.length - 1]
      const text = m.content || ''
      cur.answer = cur.answer ? `${cur.answer}\n${text}` : text
    }
    map.push(turns.length - 1)
  }
  return { turns, map }
})
const rulerTurns = computed(() => rulerData.value.turns)
let scrollRafId: number | null = null

function isNearBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120
}

function scrollToBottom(force = false) {
  if (scrollRafId !== null) return
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null
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
  const span = el.scrollHeight - el.clientHeight
  activeIndex.value =
    span <= 0 ? props.messages.length - 1 : Math.round((el.scrollTop / span) * (props.messages.length - 1))
}

/** 点刻度跳到该轮的第一条消息（reduce-motion 命中时不走平滑滚动） */
function jumpTo(turnIndex: number) {
  const el = scrollRef.value?.querySelector(`[data-turn-index="${turnIndex}"]`) as HTMLElement | null
  el?.scrollIntoView({ behavior: reduced.value ? 'auto' : 'smooth', block: 'start' })
}

watch(
  () => props.messages.length,
  () => scrollToBottom(true),
)
watch(
  () => [
    props.messages[props.messages.length - 1]?.content,
    props.messages[props.messages.length - 1]?.thinking,
    props.messages[props.messages.length - 1]?.toolCalls?.length,
  ],
  () => scrollToBottom(),
)

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
      const ratio = props.messages.length
        ? Math.min(0.9, Math.max(0.05, (pos - 1) / Math.max(1, props.messages.length)))
        : 0
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

/**
 * C4①：消息列表 key 必须是稳定 id，不能用数组下标。
 * 用下标时截断/插入消息会让 Vue 复用错误的组件实例，出现"思考面板/工具卡状态错位"。
 * 优先级：后端 id → createdAt+role → 退化为下标（仅兜底，理论上不会走到）。
 */
function messageKey(m: ChatMessage, i: number): string {
  if (m.id) return m.id
  if (m.createdAt) return `${m.role}-${m.createdAt}`
  return `${m.role}-idx-${i}`
}

defineExpose({ scrollToPos })
</script>

<template>
  <div class="ai-msg-list-wrap">
    <div ref="scrollRef" class="ai-msg-list" @scroll="onScroll">
    <!-- 顶部原子状态区（UI-C）：错误条 / 图片重复横幅；破坏性工具确认 Modal 由 AiChatPanel 统一管理 -->
    <AiErrorBar v-if="error" :message="error" />
    <AiDuplicateNotice v-if="duplicateNotice" :notice="duplicateNotice" @dismiss="emit('dismiss-duplicate')" />
    <div v-if="messages.length === 0" class="ai-msg-empty">
      {{ t('ai_chat_empty') }}
    </div>
    <AiMessage
      v-for="(m, i) in messages"
      :key="messageKey(m, i)"
      :message="m"
      :index="i"
      :data-turn-index="rulerData.map[i]"
      :is-streaming="isStreamingMessage(i)"
      :is-latest="isLatestMessage(i)"
      :confirm-tool="confirmTool ?? null"
      :class="isLocateMarked(i) ? 'ai-msg-locate-mark' : undefined"
      @reedit="(c: string, m: import('@/api/ai').ChatMessage) => emit('reedit', c, m)"
    />
    </div>
    <!-- 右侧竖直刻度尺（方案 A）：每条消息一个刻度，鼠标靠近时刻度伸长，点击跳转 -->
    <FxConversationRuler
      :turns="rulerTurns"
      :active-index="activeIndex"
      :question-label="tf('ai_ruler_question', '我')"
      :answer-label="tf('ai_ruler_answer', 'AI')"
      @jump="jumpTo"
    />
  </div>
</template>

<style scoped>
/* 刻度尺要绝对定位在对话区右缘、但不随内容滚动 ⇒ 必须有一个 position: relative 的外层，
   滚动仍由内层的 .ai-msg-list 负责（保持它原来的 flex/滚动行为不变）。 */
.ai-msg-list-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
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
  0%,
  60% {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: 8px;
    background: var(--accent-bg);
  }
  100% {
    outline: transparent;
  }
}
</style>
