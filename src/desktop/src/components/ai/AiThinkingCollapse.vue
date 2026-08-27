<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { ChevronDown, ChevronRight, CheckCircle2, Loader2 } from 'lucide-vue-next'

/**
 * AiThinkingCollapse — 思考过程折叠面板（UI-D，合并原 AiThinking + AiWaiting）
 *
 * 三态：
 *   1. loading（isStreaming 且尚无思考文本）：spinner + 「正在思考中」扫光
 *   2. thinking live（有文本且 isStreaming）：spinner + 「深度思考 · Ns」扫光 + 打字机正文
 *   3. done（isStreaming=false）：check 图标 + 折叠摘要「深度思考 Ns」，正文可点击展开
 *
 * 计时只在 live 期间累计（历史消息无结束时刻，不做假计时）。
 * expanded 为受控 prop：正文显隐由父级管理，头部点击 emit('toggle')。
 */

const props = withDefaults(
  defineProps<{
    /** 流式思考文本（可为空：空 + isStreaming = loading 态） */
    thinking?: string
    /** 思考开始时间戳（ms） */
    thinkingStartedAt?: number
    /** 思考是否进行中（父级判定，含 thinkingActive 语义） */
    isStreaming?: boolean
    /** 正文展开态（受控） */
    expanded?: boolean
  }>(),
  {
    thinking: '',
    thinkingStartedAt: undefined,
    isStreaming: false,
    expanded: false,
  },
)
const emit = defineEmits<{ toggle: [] }>()
const { t } = useI18n()

const hasContent = computed(() => (props.thinking?.length || 0) > 0)
const live = computed(() => !!props.isStreaming)
const contentRef = ref<HTMLElement | null>(null)

// ==================== 计时（仅 live 期间累计） ====================
const elapsedSeconds = ref(0)
let timer: number | undefined

// ==================== 思考文本直接绑定 ====================
const displayThinking = computed(() => props.thinking || '')

// ==================== 单行跑马灯（live 且未展开时） ====================
// 取思考文本尾部（最新生成的内容），压平为单行，随流式持续刷新。
// 参考 ZCode/Cursor 的"思考中…"横排样式：占位一行、体感在飞速输出。
const TICKER_CHARS = 140
const tickerText = computed(() => {
  const raw = (props.thinking || '').replace(/\s+/g, ' ').trimEnd()
  if (!raw) return ''
  return raw.length > TICKER_CHARS ? raw.slice(-TICKER_CHARS) : raw
})
const showTicker = computed(() => live.value && hasContent.value && !props.expanded)

function startTimer() {
  if (timer) return
  timer = window.setInterval(() => {
    elapsedSeconds.value += 1
  }, 1000)
}

function stopTimer() {
  if (timer) {
    window.clearInterval(timer)
    timer = undefined
  }
}

onMounted(() => {
  if (live.value) startTimer()
})

onUnmounted(() => {
  stopTimer()
})

watch(
  () => props.thinkingStartedAt,
  () => {
    elapsedSeconds.value = 0
  },
)

watch(live, (v) => {
  if (v) startTimer()
  else {
    stopTimer()
  }
})

// ==================== 标题 ====================
// loading：「正在思考中」；live：「思考中」 + 右侧「· N 秒」；done：折叠摘要「深度思考 Ns」
const label = computed(() => {
  if (!hasContent.value) return t('ai_thinking_loading', '正在思考中')
  const sec = elapsedSeconds.value
  if (live.value) {
    return t('ai_thinking_progress', '思考中')
  }
  if (sec < 1) return t('ai_thinking_deep', '深度思考')
  return t('ai_process_thinking', '深度思考 {n}s').replace('{n}', String(sec))
})

// 头部右侧耗时（仅 live 时显示）
const timeText = computed(() => {
  if (!live.value) return ''
  const sec = elapsedSeconds.value
  if (sec < 1) return ''
  return `· ${t('ai_thinking_sec', '{n} 秒').replace('{n}', String(sec))}`
})
</script>

<template>
  <!-- 态 1：loading（首字前）—— spinner + 「正在思考中」扫光 -->
  <div v-if="!hasContent && live" class="ai-tc-loading">
    <Loader2 :size="15" class="ai-tc-spin" />
    <span class="ai-tc-shimmer" :data-text="label">{{ label }}</span>
  </div>

  <!-- 态 2/3：深度思考面板 -->
  <div v-else-if="hasContent" class="ai-tc">
    <button type="button" class="ai-tc-head" @click="emit('toggle')">
      <Loader2 v-if="live" :size="15" class="ai-tc-spin" />
      <CheckCircle2 v-else :size="15" class="ai-tc-done" />
      <span class="ai-tc-title" :class="{ paused: !live }" :data-text="label">{{ label }}</span>
      <span v-if="timeText" class="ai-tc-time">{{ timeText }}</span>
      <!-- 单行跑马灯：live 且未展开时，头部横排滚动展示最新思考内容（尾部对齐，超出部分从左侧裁剪） -->
      <span v-if="showTicker" class="ai-tc-ticker"><span class="ai-tc-ticker-text">{{ tickerText }}</span></span>
      <ChevronRight v-if="!expanded" :size="13" class="ai-tc-chev" />
      <ChevronDown v-else :size="13" class="ai-tc-chev" />
    </button>

    <div class="ai-tc-body" :class="{ collapsed: !expanded }">
      <pre ref="contentRef" class="ai-tc-md">{{ displayThinking }}</pre>
      <span v-if="live && displayThinking.length < (props.thinking?.length || 0)" class="ai-tc-caret"></span>
    </div>
  </div>
</template>

<style scoped>
/* ============ 态 1：loading（首字前） ============ */
.ai-tc-loading {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  margin: 1px 0;
  padding: 0;
  user-select: none;
  font-size: 11.5px;
  color: var(--text-tertiary);
}
.ai-tc-spin {
  flex-shrink: 0;
  color: var(--text-tertiary);
  animation: ai-tc-rotate 1s linear infinite;
  width: 11px;
  height: 11px;
}
/* 扫光标题 */
.ai-tc-shimmer {
  position: relative;
  display: inline-block;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text-tertiary);
}
.ai-tc-shimmer::after {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    transparent 30%,
    color-mix(in srgb, var(--accent) 60%, transparent) 50%,
    transparent 70%,
    transparent 100%
  );
  background-size: 200% 100%;
  background-position: 100% 0;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  animation: ai-tc-sweep 2s ease-in-out infinite;
  mix-blend-mode: screen;
}
html.light .ai-tc-shimmer::after {
  mix-blend-mode: multiply;
}
@keyframes ai-tc-sweep {
  0% { background-position: 100% 0; }
  100% { background-position: -50% 0; }
}

/* ============ 态 2/3：深度思考面板（行内 flow 风格） ============ */
.ai-tc {
  margin: 1px 0;
  overflow: hidden;
}
.ai-tc-head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 1px 2px;
  border: none;
  background: transparent;
  cursor: pointer;
  user-select: none;
  text-align: left;
  font: inherit;
  font-size: 11.5px;
  color: var(--text-secondary);
  border-radius: 3px;
  transition: background 0.1s ease;
}
.ai-tc-head:hover {
  background: var(--bg-hover);
}
.ai-tc-done {
  flex-shrink: 0;
  color: var(--success);
  width: 11px;
  height: 11px;
}
.ai-tc-title {
  position: relative;
  display: inline-block;
  flex-shrink: 0; /* 不被右侧跑马灯挤压：否则"思考中"会被挤窄换行 */
  white-space: nowrap;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text-secondary);
}
.ai-tc-title::after {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    transparent 30%,
    color-mix(in srgb, var(--accent) 60%, transparent) 50%,
    transparent 70%,
    transparent 100%
  );
  background-size: 200% 100%;
  background-position: 100% 0;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  animation: ai-tc-sweep 2s ease-in-out infinite;
  mix-blend-mode: screen;
}
html.light .ai-tc-title::after {
  mix-blend-mode: multiply;
}
/* 思考完成 → 扫光停止 */
.ai-tc-title.paused::after {
  animation: none;
  background-position: 100% 0;
}
.ai-tc-time {
  flex-shrink: 0; /* 不被跑马灯挤压：否则"· N 秒"的"秒"会换行 */
  white-space: nowrap;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  margin-left: 2px;
}
/* 单行跑马灯：flex-end 让尾部（最新内容）始终贴右可见，超出宽度从左侧裁剪；
   左侧渐隐遮罩让截断看起来是有意的淡出而不是生硬切断 */
.ai-tc-ticker {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  display: flex;
  justify-content: flex-end;
  margin-left: 8px;
  -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 28px);
  mask-image: linear-gradient(90deg, transparent 0, #000 28px);
}
.ai-tc-ticker-text {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-tertiary);
}
.ai-tc-chev {
  color: var(--text-tertiary);
  margin-left: auto;
  flex-shrink: 0;
  width: 10px;
  height: 10px;
}

/* 思考正文：行内 flow 风格 */
.ai-tc-body {
  max-height: none;
  opacity: 1;
  padding: 2px 0 2px 16px;
  position: relative;
}
.ai-tc-body.collapsed {
  opacity: 0;
  max-height: 0;
  overflow: hidden;
  padding-top: 0;
  padding-bottom: 0;
  padding-left: 0;
  transition:
    max-height 0.2s ease-in-out,
    opacity 0.15s ease,
    padding 0.15s ease;
}
.ai-tc-md {
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.55;
  padding: 0;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  background: transparent;
}
/* 打字机光标 */
.ai-tc-caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--text-secondary);
  vertical-align: text-bottom;
  margin-left: 1px;
  animation: ai-tc-blink 0.8s step-end infinite;
}
@keyframes ai-tc-blink {
  50% { opacity: 0; }
}
@keyframes ai-tc-rotate {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .ai-tc-shimmer::after,
  .ai-tc-title::after,
  .ai-tc-caret,
  .ai-tc-spin {
    animation: none;
  }
}

/* 键盘可达性 */
.ai-tc-head:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
  border-radius: 3px;
}
</style>
