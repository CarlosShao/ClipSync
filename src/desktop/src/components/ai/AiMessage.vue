<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { Marked } from 'marked'
import { sanitizeHtml } from '@/utils/html'
import { ChevronRight, ChevronDown, Copy, Pencil, ListChecks, Languages, AlignLeft, HelpCircle, Sparkles, CheckCircle2, Loader2, XCircle, Terminal, Brain, Wrench, Bot } from 'lucide-vue-next'
import type { ChatMessage, AgentRun } from '@/api/ai'

const props = defineProps<{ message: ChatMessage; index: number; isStreaming: boolean; isLatest: boolean }>()
const emit = defineEmits<{ reedit: [content: string] }>()
const { t } = useI18n()

// 用户消息操作
async function copyUserContent() {
  const text = stripUserInputMarkers(stripViewContext(props.message.content || '')).trim()
  if (!text) return
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
    throw new Error('clipboard API unavailable')
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    } catch {
      try { window.prompt('复制下面文本到剪贴板：', text) } catch { /* ignore */ }
    }
  }
}
function reeditUserContent() {
  const text = stripUserInputMarkers(stripViewContext(props.message.content || '')).trim()
  if (!text) return
  emit('reedit', text)
}

// 上下文标记剥离
const VIEW_CTX_OPEN = '\u2404VIEWCTX\u2404'
const VIEW_CTX_CLOSE = '\u2404/VIEWCTX\u2404'
const USER_INPUT_OPEN = '\u2404USERINPUT\u2404'
const USER_INPUT_CLOSE = '\u2404/USERINPUT\u2404'
function stripViewContext(content: string): string {
  if (!content || !content.includes(VIEW_CTX_OPEN)) return content
  const start = content.indexOf(VIEW_CTX_OPEN)
  const end = content.indexOf(VIEW_CTX_CLOSE)
  if (start >= 0 && end > start) return content.slice(0, start) + content.slice(end + VIEW_CTX_CLOSE.length)
  return content
}
function stripUserInputMarkers(content: string): string {
  if (!content) return content
  let out = content
  while (out.includes(USER_INPUT_OPEN) && out.includes(USER_INPUT_CLOSE)) {
    const s = out.indexOf(USER_INPUT_OPEN)
    const e = out.indexOf(USER_INPUT_CLOSE, s)
    if (s < 0 || e < 0) break
    out = out.slice(0, s) + out.slice(s + USER_INPUT_OPEN.length, e) + out.slice(e + USER_INPUT_CLOSE.length)
  }
  return out
}

// Markdown 渲染
const marked = new Marked({ gfm: true, breaks: false })
function compactBlankLines(content: string): string {
  if (!content) return ''
  return content.replace(/\n{3,}/g, '\n\n').trim()
}
function renderMarkdown(content: string): string {
  const compacted = compactBlankLines(content)
  if (!compacted) return ''
  try { return sanitizeHtml(marked.parse(compacted) as string) } catch { return sanitizeHtml(compacted) }
}

// 状态计算
const expandedThinking = ref(false)
const collapsed = ref(false)
const isStreamingNow = computed(() => props.isStreaming)

const hasAgentRuns = computed(() => (props.message.agentRuns?.length || 0) > 0)
const hasToolCalls = computed(() => (props.message.toolCalls?.length || 0) > 0)
const hasThinking = computed(() => (props.message.thinking?.length || 0) > 0)
const hasProcess = computed(() => hasThinking.value || hasToolCalls.value || hasAgentRuns.value)

function runActive(run: AgentRun): boolean {
  return run.status === 'planning' || run.status === 'working' || run.status === 'synthesis'
}

// 折叠逻辑
if (props.index === 0) { collapsed.value = false } else { collapsed.value = true }
watch(isStreamingNow, (now) => { if (now) collapsed.value = false })

// 思考计时
const thinkingEndedAt = ref<number | null>(null)
watch(() => [props.message.thinkingStartedAt, props.message.thinkingActive], () => {
  if (props.message.thinkingStartedAt && props.message.thinkingActive === false && thinkingEndedAt.value === null) {
    thinkingEndedAt.value = Date.now()
  }
})
const thinkingSecs = computed(() => {
  const s = props.message.thinkingStartedAt
  if (!s) return 0
  const end = thinkingEndedAt.value ?? (props.message.thinkingActive !== false ? Date.now() : s)
  return Math.max(0, Math.floor((end - s) / 1000))
})

// 流式内容
const streamingContent = computed(() => {
  const content = props.message.content || ''
  if (!isStreamingNow.value || props.message.role !== 'assistant') return content
  return content
})

// 可见工具/代理
const visibleAgentRuns = computed(() => {
  if (isThinkingStreaming.value) return []
  return props.message.agentRuns || []
})
const visibleToolCalls = computed(() => {
  return props.message.toolCalls || []
})
const isThinkingStreaming = computed(() => isStreamingNow.value && (props.message.thinking?.length || 0) > 0 && props.message.thinkingActive !== false)
// 流式开始但还没收到任何数据（思考/内容/工具）
const isLoadingState = computed(() => isStreamingNow.value && !hasThinking.value && !props.message.content && !props.message.toolCalls?.length)

// 快捷指令
const QUICK_ACTIONS_KIND_META: Record<string, { icon: any; i18nKey: string }> = {
  quick_action_summarize: { icon: ListChecks, i18nKey: 'ai_quick_applied_summarize' },
  quick_action_translate: { icon: Languages, i18nKey: 'ai_quick_applied_translate' },
  quick_action_format: { icon: AlignLeft, i18nKey: 'ai_quick_applied_format' },
  quick_action_explain: { icon: HelpCircle, i18nKey: 'ai_quick_applied_explain' },
  quick_action_optimize: { icon: Sparkles, i18nKey: 'ai_quick_applied_optimize' },
}
const quickActionKind = computed(() => {
  const kind = props.message.systemMeta?.kind
  return kind && kind.startsWith('quick_action_') ? kind : null
})
const quickActionMeta = computed(() => (quickActionKind.value ? QUICK_ACTIONS_KIND_META[quickActionKind.value] : null))
const quickActionIcon = computed(() => quickActionMeta.value?.icon ?? null)
const quickActionLabel = computed(() => (quickActionMeta.value ? t(quickActionMeta.value.i18nKey) : ''))

function roleLabel() {
  return props.message.role === 'user' ? t('ai_you') : t('ai_assistant')
}

// 格式化耗时
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remain = sec % 60
  return `${min}m ${remain}s`
}
</script>

<template>
  <div class="ai-msg" :class="message.role">
    <!-- 用户消息 -->
    <template v-if="message.role === 'user'">
      <div class="ai-msg-bubble">
        <div class="ai-msg-user-body">
          <div v-if="message.images?.length" class="ai-msg-images">
            <img v-for="(img, i) in message.images" :key="i" :src="img.data" :alt="img.mime" />
          </div>
          <div class="ai-msg-content">{{ compactBlankLines(stripUserInputMarkers(stripViewContext(message.content))) }}</div>
        </div>
      </div>
      <div class="ai-msg-actions ai-msg-actions--user">
        <button class="ai-msg-action-btn" :title="t('ai_copy')" @click.stop="copyUserContent"><Copy :size="13" /></button>
        <button class="ai-msg-action-btn" :title="t('ai_reedit')" @click.stop="reeditUserContent"><Pencil :size="13" /></button>
      </div>
    </template>

    <!-- System 消息 -->
    <template v-else-if="message.role === 'system'">
      <!-- 视图上下文：隐藏 -->
      <div v-if="message.systemMeta?.kind === 'view_context'" class="ai-msg-system-hidden"></div>
      <!-- 快捷指令 -->
      <div v-else-if="quickActionKind" class="ai-msg-system-card ai-msg-system-card--quick-action">
        <component :is="quickActionIcon" v-if="quickActionIcon" class="ai-msg-system-icon-svg" />
        <span>{{ quickActionLabel }}</span>
      </div>
      <!-- compact 命令结果 -->
      <div v-else-if="message.systemMeta?.kind?.startsWith('compact_')" class="ai-msg-system-card" :class="`ai-msg-system-card--${message.systemMeta?.kind}`">
        <template v-if="message.systemMeta?.kind === 'compact_loading'">
          <span class="ai-msg-system-icon">⟳</span><span>{{ t('ai_compact_loading') || '正在压缩上下文…' }}</span>
        </template>
        <template v-else-if="message.systemMeta?.kind === 'compact_success'">
          <span class="ai-msg-system-icon">✓</span>
          <span>{{ t('ai_compact_success', { removed: message.systemMeta.removed ?? 0, savedTokens: message.systemMeta.savedTokens ?? 0 }) }}</span>
        </template>
        <template v-else-if="message.systemMeta?.kind === 'compact_too_short'">
          <span class="ai-msg-system-icon">·</span><span>{{ t('ai_compact_too_short') }}</span>
        </template>
        <template v-else>
          <span class="ai-msg-system-icon">✕</span><span>{{ message.content }}</span>
        </template>
      </div>
      <div v-else class="ai-msg-content">{{ compactBlankLines(message.content) }}</div>
    </template>

    <!-- 助手消息 - Trae 时间线风格 -->
    <template v-else>
      <div class="ai-msg-bubble">
        <!-- 折叠态 -->
        <div v-if="hasProcess && collapsed" class="ai-process-collapsed" @click="collapsed = false">
          <span class="ai-process-collapsed-label">{{ t('ai_process_collapsed') }}</span>
          <span class="ai-process-chip">{{ thinkingSecs > 0 ? `思考 ${thinkingSecs}s` : '处理完成' }}</span>
          <ChevronRight :size="13" class="ai-process-collapsed-chev" />
        </div>

        <!-- 展开态：垂直时间线 -->
        <template v-else>
          <div class="ai-timeline">
            <!-- 垂直线 -->
            <div class="ai-timeline-line"></div>

            <!-- 思考中加载状态（流式开始但还没收到数据时） -->
            <div v-if="isLoadingState" class="ai-timeline-node ai-timeline-node--loading">
              <div class="ai-timeline-node-icon ai-timeline-node-icon--loading">
                <span class="ai-timeline-loading-pulse"></span>
              </div>
              <div class="ai-timeline-node-content">
                <div class="ai-timeline-node-head ai-timeline-node-head--static">
                  <span class="ai-timeline-node-title">思考中...</span>
                </div>
              </div>
            </div>

            <!-- 思考过程节点 -->
            <div v-if="hasThinking" class="ai-timeline-node">
              <div class="ai-timeline-node-icon ai-timeline-node-icon--thinking" :class="{ 'is-streaming': isThinkingStreaming }">
                <Brain v-if="!isThinkingStreaming" :size="12" />
                <span v-else class="ai-timeline-pulse"></span>
              </div>
              <div class="ai-timeline-node-content">
                <button class="ai-timeline-node-head" @click="expandedThinking = !expandedThinking">
                  <span class="ai-timeline-node-title">思考过程</span>
                  <span v-if="thinkingSecs > 0" class="ai-timeline-node-time">{{ thinkingSecs }}s</span>
                  <ChevronRight v-if="!expandedThinking" :size="12" class="ai-timeline-node-chev" />
                  <ChevronDown v-else :size="12" class="ai-timeline-node-chev" />
                </button>
                <div v-if="expandedThinking" class="ai-timeline-node-body">
                  <pre class="ai-timeline-pre">{{ message.thinking }}</pre>
                </div>
              </div>
            </div>

            <!-- 工具调用节点 -->
            <div v-for="(tc, i) in visibleToolCalls" :key="`tc-${i}`" class="ai-timeline-node">
              <div class="ai-timeline-node-icon ai-timeline-node-icon--tool">
                <Wrench :size="12" />
              </div>
              <div class="ai-timeline-node-content">
                <div class="ai-timeline-node-head ai-timeline-node-head--static">
                  <span class="ai-timeline-node-title">{{ tc.name }}</span>
                  <span class="ai-timeline-node-badge">tool</span>
                </div>
              </div>
            </div>

            <!-- 子代理节点 -->
            <div v-for="run in visibleAgentRuns" :key="run.id" class="ai-timeline-node">
              <div class="ai-timeline-node-icon" :class="{
                'ai-timeline-node-icon--done': run.status === 'done',
                'ai-timeline-node-icon--working': runActive(run),
                'ai-timeline-node-icon--failed': run.status === 'failed'
              }">
                <CheckCircle2 v-if="run.status === 'done'" :size="12" />
                <Loader2 v-else-if="runActive(run)" :size="12" class="ai-timeline-spin" />
                <XCircle v-else-if="run.status === 'failed'" :size="12" />
                <Bot v-else :size="12" />
              </div>
              <div class="ai-timeline-node-content">
                <div class="ai-timeline-node-head ai-timeline-node-head--static">
                  <span class="ai-timeline-node-title">{{ run.name }}</span>
                  <span v-if="run.objective" class="ai-timeline-node-objective">{{ run.objective }}</span>
                  <span v-if="run.duration" class="ai-timeline-node-time">{{ formatDuration(run.duration) }}</span>
                  <span class="ai-timeline-node-badge" :class="`badge-${run.status}`">{{ run.status }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 主要内容输出 -->
          <div v-if="message.content" class="ai-msg-content markdown-body">
            <span v-html="renderMarkdown(streamingContent)"></span>
            <span v-if="isStreamingNow" class="ai-stream-caret"></span>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ============ 消息容器 ============ */
.ai-msg {
  display: flex;
  position: relative;
}
.ai-msg.user {
  justify-content: flex-end;
}
.ai-msg.assistant {
  justify-content: flex-start;
}
.ai-msg.system {
  justify-content: center;
  margin: 4px 0;
}

/* ============ 气泡 ============ */
.ai-msg-bubble {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 96%;
  min-width: 0;
  padding: 12px 16px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.6;
  gap: 8px;
}
.ai-msg.user .ai-msg-bubble {
  background: var(--bg-brand, #4B3FE3);
  color: var(--text-onbrand, #fff);
  border-bottom-right-radius: 4px;
}
.ai-msg.assistant .ai-msg-bubble {
  background: transparent;
  color: var(--text-default, #171717);
  padding-left: 0;
  padding-right: 0;
}

/* ============ 用户消息 ============ */
.ai-msg-user-body {
  position: relative;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ai-msg-actions--user {
  position: absolute;
  right: 0;
  bottom: 0;
  display: inline-flex;
  gap: 4px;
  padding: 2px;
  border-radius: 8px;
  background: var(--bg-base-default, #fff);
  border: 1px solid var(--border-neutral-l1, rgba(115,115,115,0.12));
  opacity: 0;
  transform: translateY(2px);
  pointer-events: none;
  transition: opacity 0.15s ease, transform 0.15s ease;
  z-index: 5;
}
.ai-msg.user:hover .ai-msg-actions--user,
.ai-msg-actions--user:hover {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}
.ai-msg.user .ai-msg-user-body { padding-bottom: 30px; }
.ai-msg-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #404040);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.ai-msg-action-btn:hover {
  background: var(--bg-overlay-l1, rgba(115,115,115,0.08));
  color: var(--bg-brand, #4B3FE3);
}

/* ============ 折叠态处理过程 ============ */
.ai-process-collapsed {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg-base-secondary, #F5F5F5);
  border: 1px solid var(--border-neutral-l1, rgba(115,115,115,0.12));
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary, #404040);
  transition: background 0.15s;
}
.ai-process-collapsed:hover {
  background: var(--bg-overlay-l1, rgba(115,115,115,0.08));
}
.ai-process-collapsed-label { font-weight: 600; color: var(--text-default, #171717); }
.ai-process-chip {
  font-size: 11px;
  color: var(--text-tertiary, #737373);
  background: var(--bg-overlay-l1, rgba(115,115,115,0.08));
  border-radius: 999px;
  padding: 1px 8px;
}
.ai-process-collapsed-chev { margin-left: auto; color: var(--text-tertiary, #737373); }

/* ============ 垂直时间线 ============ */
.ai-timeline {
  position: relative;
  padding-left: 28px;
  margin-bottom: 8px;
}
.ai-timeline-line {
  position: absolute;
  left: 10px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--border-neutral-l1, rgba(115,115,115,0.12));
  border-radius: 1px;
}

/* 时间线节点 */
.ai-timeline-node {
  position: relative;
  margin-bottom: 12px;
}
.ai-timeline-node:last-child {
  margin-bottom: 0;
}

/* 节点图标 */
.ai-timeline-node-icon {
  position: absolute;
  left: -28px;
  top: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-base-default, #fff);
  border: 2px solid var(--border-neutral-l1, rgba(115,115,115,0.12));
  color: var(--icon-secondary, #404040);
  font-size: 11px;
  z-index: 1;
}
.ai-timeline-node-icon--thinking {
  border-color: var(--bg-brand, #4B3FE3);
  color: var(--bg-brand, #4B3FE3);
}
.ai-timeline-node-icon--thinking.is-streaming {
  background: var(--bg-brand, #4B3FE3);
  color: #fff;
}
.ai-timeline-node-icon--tool {
  border-color: var(--text-tertiary, #737373);
  color: var(--text-tertiary, #737373);
}
.ai-timeline-node-icon--done {
  border-color: #00B983;
  background: #00B983;
  color: #fff;
}
.ai-timeline-node-icon--working {
  border-color: var(--bg-brand, #4B3FE3);
  background: var(--bg-brand, #4B3FE3);
  color: #fff;
}
.ai-timeline-node-icon--failed {
  border-color: #FF6B45;
  background: #FF6B45;
  color: #fff;
}
.ai-timeline-node-icon--loading {
  border-color: var(--border-neutral-l1, rgba(115,115,115,0.12));
  background: var(--bg-base-default, #fff);
}
.ai-timeline-loading-pulse {
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bg-brand, #4B3FE3);
  animation: loading-pulse 1.4s ease-in-out infinite;
}
@keyframes loading-pulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.75);
  }
}

/* 脉冲动画 */
.ai-timeline-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #fff;
  animation: timeline-pulse 1.2s ease-in-out infinite;
}
@keyframes timeline-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.7); }
}

/* 节点内容 */
.ai-timeline-node-content {
  flex: 1;
}
.ai-timeline-node-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
}
.ai-timeline-node-head--static {
  cursor: default;
}
.ai-timeline-node-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-default, #171717);
}
.ai-timeline-node-time {
  font-size: 11px;
  color: var(--text-tertiary, #737373);
  font-variant-numeric: tabular-nums;
}
.ai-timeline-node-chev {
  color: var(--text-tertiary, #737373);
  margin-left: auto;
}
.ai-timeline-node-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  background: var(--bg-overlay-l1, rgba(115,115,115,0.08));
  color: var(--text-secondary, #404040);
}
.ai-timeline-node-badge.badge-done { background: rgba(0,185,131,0.1); color: #00B983; }
.ai-timeline-node-badge.badge-working,
.ai-timeline-node-badge.badge-planning,
.ai-timeline-node-badge.badge-synthesis { background: rgba(75,63,227,0.1); color: var(--bg-brand, #4B3FE3); }
.ai-timeline-node-badge.badge-failed { background: rgba(255,107,69,0.1); color: #FF6B45; }
.ai-timeline-node-objective {
  font-size: 11px;
  color: var(--text-tertiary, #737373);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 节点展开内容 */
.ai-timeline-node-body {
  margin-top: 8px;
  padding-left: 0;
}
.ai-timeline-pre {
  margin: 0;
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary, #404040);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-family-mono, ui-monospace, monospace);
  background: var(--bg-base-secondary, #F5F5F5);
  border-radius: 6px;
  border-left: 2px solid var(--bg-brand, #4B3FE3);
}

/* 旋转动画 */
.ai-timeline-spin {
  animation: timeline-spin 1s linear infinite;
}
@keyframes timeline-spin {
  to { transform: rotate(360deg); }
}

/* ============ 主要内容 ============ */
.ai-msg-content {
  white-space: normal;
  word-break: break-word;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
}
.ai-msg.user .ai-msg-content { white-space: pre-wrap; }

/* Markdown 样式 */
.ai-msg-content :deep(h1),
.ai-msg-content :deep(h2),
.ai-msg-content :deep(h3),
.ai-msg-content :deep(h4) { margin: 12px 0 6px; font-weight: 600; }
.ai-msg-content :deep(h1) { font-size: 18px; }
.ai-msg-content :deep(h2) { font-size: 16px; }
.ai-msg-content :deep(h3) { font-size: 14px; }
.ai-msg-content :deep(p) { margin: 6px 0; }
.ai-msg-content :deep(ul),
.ai-msg-content :deep(ol) { padding-left: 20px; margin: 6px 0; }
.ai-msg-content :deep(li) { margin: 3px 0; }
.ai-msg-content :deep(code) {
  background: var(--bg-overlay-l1, rgba(115,115,115,0.08));
  padding: 2px 5px;
  border-radius: 4px;
  font-family: var(--font-family-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--bg-brand, #4B3FE3);
}
.ai-msg-content :deep(pre) {
  background: var(--bg-base-secondary, #F5F5F5);
  border: 1px solid var(--border-neutral-l1, rgba(115,115,115,0.12));
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  margin: 10px 0;
}
.ai-msg-content :deep(pre code) {
  background: none;
  padding: 0;
  color: var(--text-default, #171717);
}
.ai-msg-content :deep(strong) { font-weight: 600; }
.ai-msg-content :deep(a) { color: var(--bg-brand, #4B3FE3); }
.ai-msg-content :deep(blockquote) {
  border-left: 3px solid var(--bg-brand, #4B3FE3);
  background: var(--bg-overlay-l1, rgba(115,115,115,0.08));
  padding: 8px 14px;
  border-radius: 6px;
  margin: 8px 0;
  color: var(--text-secondary, #404040);
}
.ai-msg-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12px;
}
.ai-msg-content :deep(th),
.ai-msg-content :deep(td) {
  padding: 8px 12px;
  border: 1px solid var(--border-neutral-l1, rgba(115,115,115,0.12));
  text-align: left;
}
.ai-msg-content :deep(th) { background: var(--bg-base-secondary, #F5F5F5); font-weight: 600; }
.ai-msg-content :deep(tr:nth-child(2n)) { background: var(--bg-base-secondary, #F5F5F5); }

/* 流式光标 */
.ai-stream-caret {
  display: inline-block;
  width: 2px;
  height: 1.2em;
  margin-left: 1px;
  vertical-align: text-bottom;
  background: var(--bg-brand, #4B3FE3);
  border-radius: 1px;
  animation: caret-pulse 1.2s ease-in-out infinite;
}
@keyframes caret-pulse {
  0%, 100% { opacity: 1; transform: scaleY(1); }
  50% { opacity: 0.4; transform: scaleY(0.85); }
}

/* ============ System 消息 ============ */
.ai-msg-system-hidden { display: none; }
.ai-msg-system-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-neutral-l1, rgba(115,115,115,0.12));
  background: var(--bg-base-secondary, #F5F5F5);
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-secondary, #404040);
  max-width: 96%;
}
.ai-msg-system-card--compact_loading { border-left: 3px solid var(--bg-brand, #4B3FE3); }
.ai-msg-system-card--compact_success { border-left: 3px solid #00B983; }
.ai-msg-system-card--compact_too_short { border-left: 3px solid var(--text-tertiary, #737373); }
.ai-msg-system-card--compact_failed { border-left: 3px solid #FF6B45; }
.ai-msg-system-card--quick-action {
  border-left: 3px solid var(--bg-brand, #4B3FE3);
  background: var(--bg-overlay-l1, rgba(115,115,115,0.08));
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.ai-msg-system-icon { display: inline-block; margin-right: 6px; font-weight: 600; }
.ai-msg-system-icon-svg { width: 14px; height: 14px; color: var(--bg-brand, #4B3FE3); flex-shrink: 0; }

/* 用户消息截图 */
.ai-msg-images { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.ai-msg-images img {
  max-width: 160px;
  max-height: 160px;
  border-radius: 6px;
  border: 1px solid var(--border-neutral-l1, rgba(115,115,115,0.12));
  object-fit: cover;
  display: block;
}
</style>
