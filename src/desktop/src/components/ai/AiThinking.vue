<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { Brain, ChevronDown, ChevronRight } from 'lucide-vue-next'

/**
 * AiThinking — AI 思考过程面板
 *
 * 设计灵感来源于 Claude Code / OpenCode 等成熟 Agent Harness：
 *   1. 顶部状态栏：流式输出中显示左→右闪烁进度条 + 阶段文字（"正在连接模型"/"思考中"/"生成中"）
 *   2. 折叠内容区：有思考内容时渐进式释放（rAF 平滑追赶），无内容时仅显示状态栏
 *   3. 状态栏与内容分离：状态栏始终可见（有流式活动时），思考内容独立折叠
 */

const props = defineProps<{
  thinking: string
  thinkingStartedAt?: number
  isStreaming?: boolean
  expanded?: boolean
}>()
const emit = defineEmits<{ toggle: [] }>()
const { t } = useI18n()

const hasContent = computed(() => (props.thinking?.length || 0) > 0)
const contentRef = ref<HTMLElement | null>(null)

// ==================== 渐进式释放逻辑 ====================
// 基于时间均匀释放（每帧固定追加字数），让思考过程"生长"而非"跳变"。
const displayThinking = ref('')
let rafId: number | undefined
const CHARS_PER_FRAME = 6

function flushThinking() {
  const target = props.thinking || ''
  if (displayThinking.value.length >= target.length) {
    rafId = undefined
    return
  }
  displayThinking.value = target.slice(0, displayThinking.value.length + CHARS_PER_FRAME)
  if (props.isStreaming && contentRef.value) {
    contentRef.value.scrollTop = contentRef.value.scrollHeight
  }
  rafId = requestAnimationFrame(flushThinking)
}

function ensureFlush() {
  const target = props.thinking || ''
  if (target.length < displayThinking.value.length) displayThinking.value = ''
  if (displayThinking.value.length < target.length && rafId === undefined) {
    rafId = requestAnimationFrame(flushThinking)
  }
}

watch(
  () => props.thinking,
  () => {
    ensureFlush()
    if (props.isStreaming && contentRef.value) {
      contentRef.value.scrollTop = contentRef.value.scrollHeight
    }
  },
)

watch(
  () => props.thinkingStartedAt,
  () => {
    displayThinking.value = ''
    if (rafId !== undefined) {
      cancelAnimationFrame(rafId)
      rafId = undefined
    }
    ensureFlush()
  },
)

watch(
  () => props.expanded,
  (now) => {
    // 展开面板且内容已完整到达时：从头重播渐进动画
    if (now && props.thinking?.length && displayThinking.value.length >= props.thinking.length) {
      displayThinking.value = ''
      rafId = requestAnimationFrame(flushThinking)
    }
  },
)

// ==================== 计时器（思考耗时） ====================
const elapsedSeconds = ref(0)
let timer: number | undefined

function updateElapsed() {
  const start = props.thinkingStartedAt
  if (!start) {
    elapsedSeconds.value = 0
    return
  }
  elapsedSeconds.value = Math.max(0, Math.floor((Date.now() - start) / 1000))
}

function startTimer() {
  updateElapsed()
  if (timer) return
  timer = window.setInterval(updateElapsed, 1000)
}

function stopTimer() {
  if (timer) {
    window.clearInterval(timer)
    timer = undefined
  }
}

onMounted(() => {
  if (props.isStreaming) startTimer()
  else updateElapsed()
  ensureFlush()
})

onUnmounted(() => {
  stopTimer()
  if (rafId !== undefined) cancelAnimationFrame(rafId)
})

watch(() => props.isStreaming, (v) => {
  if (v) startTimer()
  else {
    stopTimer()
    ensureFlush()
  }
})

// ==================== 阶段文字（Claude Code 风格） ====================
// 流式输出期间根据已处时长显示不同阶段文字，让用户感知 AI 正在工作
const phaseText = computed(() => {
  if (!props.isStreaming) {
    // 已完成：显示耗时
    if (!hasContent.value) return t('ai_no_thinking') || '无思考过程'
    const sec = elapsedSeconds.value
    const timeText = sec < 1 ? t('ai_thinking_less_than_sec') : t('ai_thinking_sec').replace('{n}', String(sec))
    return `${t('ai_thinking_done')} ${timeText}`
  }

  // 流式进行中：根据已处时长切换阶段文字
  if (!hasContent.value) {
    // 还未收到任何思考内容：显示阶段指示
    return t('ai_thinking_progress') || '思考中'
  }
  // 有思考内容在流动中
  const sec = elapsedSeconds.value
  const timeText = sec < 1 ? t('ai_thinking_less_than_sec') : t('ai_thinking_sec').replace('{n}', String(sec))
  return `${t('ai_thinking_progress')} ${timeText}`
})

// 折叠按钮摘要
const summary = computed(() => {
  if (props.isStreaming && !hasContent.value) return phaseText.value
  if (!hasContent.value) return t('ai_no_thinking') || '无思考过程'
  return phaseText.value
})
</script>

<template>
  <!-- 有流式活动或有思考内容时渲染整个组件 -->
  <div v-if="hasContent || isStreaming" class="ai-thinking">

    <!-- ===== 顶部状态栏（流式期间可见） ===== -->
    <div v-if="isStreaming" class="ai-thinking-statusbar">
      <div class="ai-thinking-shimmer"></div>
      <span class="ai-thinking-status-text">
        <Brain :size="12" class="ai-thinking-status-icon" />
        {{ phaseText }}
      </span>
    </div>

    <!-- ===== 折叠按钮（始终可见） ===== -->
    <button class="ai-thinking-toggle" :class="{ active: expanded }" @click="emit('toggle')">
      <Brain :size="13" />
      <span class="ai-thinking-label">{{ summary }}</span>
      <ChevronDown v-if="expanded" :size="13" />
      <ChevronRight v-else :size="13" />
    </button>

    <!-- ===== 折叠内容区（仅展开时渲染） ===== -->
    <div v-if="expanded" ref="contentRef" class="ai-thinking-content">
      <pre>{{ displayThinking }}</pre>
    </div>
  </div>
</template>

<style scoped>
.ai-thinking {
  margin-bottom: 6px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-surface);
}

/* ===== 顶部状态栏（流式输出期间可见） ===== */
.ai-thinking-statusbar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  background: var(--bg-hover);
  overflow: hidden;
  border-bottom: 1px solid var(--border-subtle);
  min-height: 28px;
}

/* 左→右闪烁进度条：叠加在状态栏背景上 */
.ai-thinking-shimmer {
  position: absolute;
  top: 0;
  left: 0;
  width: 40%;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--accent-bg) 50%,
    transparent 100%
  );
  animation: ai-thinking-shimmer-slide 1.8s ease-in-out infinite;
  pointer-events: none;
  opacity: 0.7;
}

@keyframes ai-thinking-shimmer-slide {
  0% {
    transform: translateX(-120%);
    opacity: 0;
  }
  10% {
    opacity: 0.7;
  }
  90% {
    opacity: 0.7;
  }
  100% {
    transform: translateX(350%);
    opacity: 0;
  }
}

.ai-thinking-status-text {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 500;
  color: var(--accent);
  z-index: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-thinking-status-icon {
  flex-shrink: 0;
  animation: ai-thinking-pulse 2s ease-in-out infinite;
}

@keyframes ai-thinking-pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

/* ===== 折叠按钮 ===== */
.ai-thinking-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  background: var(--bg-surface);
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  transition: background 0.15s, color 0.15s;
  text-align: left;
}
.ai-thinking-toggle:hover,
.ai-thinking-toggle.active {
  background: var(--accent-bg);
  color: var(--accent);
}
.ai-thinking-label {
  flex: 1;
}

/* ===== 折叠内容区 ===== */
.ai-thinking-content {
  padding: 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  border-top: 1px solid var(--border-subtle);
  max-height: 280px;
  overflow-y: auto;
}
.ai-thinking-content pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono, monospace);
}
</style>
