<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { Marked } from 'marked'
import { sanitizeHtml } from '@/utils/html'
import { ChevronRight, Copy, Pencil } from 'lucide-vue-next'
import type { ChatMessage, AgentRun } from '@/api/ai'
import AiThinking from './AiThinking.vue'
import AiToolTimeline from './AiToolTimeline.vue'
import AiAgentSummary from './AiAgentSummary.vue'
import AiAgentDrawer from './AiAgentDrawer.vue'

const props = defineProps<{ message: ChatMessage; index: number; isStreaming: boolean }>()
const emit = defineEmits<{ reedit: [content: string] }>()
const { t } = useI18n()

// 历史用户消息上的 hover 操作条（复制 / 重新编辑）。仅 user 消息显示。
const userActionsVisible = ref(false)
async function copyUserContent() {
  const text = stripViewContext(props.message.content || '').trim()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 剪贴板不可用时静默失败，不阻断交互
  }
}
function reeditUserContent() {
  const text = stripViewContext(props.message.content || '').trim()
  if (!text) return
  emit('reedit', text)
}

// 上下文感知标记（#229）：剥离注入到 user 消息的"当前页面"上下文，保持 UI 干净
const VIEW_CTX_OPEN = '\u2404VIEWCTX\u2404'
const VIEW_CTX_CLOSE = '\u2404/VIEWCTX\u2404'
function stripViewContext(content: string): string {
  if (!content || !content.includes(VIEW_CTX_OPEN)) return content
  const start = content.indexOf(VIEW_CTX_OPEN)
  const end = content.indexOf(VIEW_CTX_CLOSE)
  if (start >= 0 && end > start) return content.slice(0, start) + content.slice(end + VIEW_CTX_CLOSE.length)
  return content
}

// GFM 已默认开启（表格、删除线、任务列表等）；breaks:false 保持标准 markdown 段落语义。
const marked = new Marked({ gfm: true, breaks: false })
const expandedThinking = ref(false)
// 任务处理过程（思考/工具/子代理）是否折叠；所有任务完成、最终答案输出后自动折叠。
const collapsed = ref(false)
// 抽屉中正在查看详情的子代理运行卡片（null 表示未打开）
const drawerRun = ref<AgentRun | null>(null)

// 当前消息是否处于“正在生成”状态（仅最后一条助手消息为 true）
const isStreamingNow = computed(() => props.isStreaming && props.index === 0)

// 历史已完成消息默认折叠；正在流式的不折叠。
if (!isStreamingNow.value) collapsed.value = true
watch(isStreamingNow, (now, before) => {
  if (now) collapsed.value = false // 开始流式 → 展开看实时过程
  else if (before) collapsed.value = true // 流结束 → 自动折叠
})

// 思考是否正在流式生长：有 thinking 内容且 thinkingActive 仍为 true
const isThinkingStreaming = computed(() =>
  isStreamingNow.value &&
  (props.message.thinking?.length || 0) > 0 &&
  props.message.thinkingActive !== false,
)

// 思考是否已结束：有内容，但已经停止（工具开始 / 答案开始 / 流结束）
const isThinkingDone = computed(() =>
  (props.message.thinking?.length || 0) > 0 &&
  (!isStreamingNow.value || props.message.thinkingActive === false),
)

const hasAgentRuns = computed(() => (props.message.agentRuns?.length || 0) > 0)
const hasToolCalls = computed(() => (props.message.toolCalls?.length || 0) > 0)
const hasThinking = computed(() => (props.message.thinking?.length || 0) > 0)

// 是否存在“任务处理过程”（思考 / 工具 / 子代理），决定是否需要折叠头
const hasProcess = computed(() => hasThinking.value || hasToolCalls.value || hasAgentRuns.value)

// loading 占位：尚未收到任何有效阶段数据（无 thinking、无答案、无工具、无 agent 运行卡片）
const isLoading = computed(() =>
  isStreamingNow.value &&
  !isThinkingStreaming.value &&
  !isThinkingDone.value &&
  !hasAgentRuns.value &&
  !hasToolCalls.value &&
  (props.message.content?.trim().length || 0) === 0,
)

// 当主消息有全局 thinking 流正在展开时，暂时隐藏 agentRuns；否则立即展示 Agent 运行卡片
const visibleAgentRuns = computed(() => {
  if (isThinkingStreaming.value) return []
  return props.message.agentRuns || []
})

const visibleToolCalls = computed(() => {
  if (isThinkingStreaming.value) return []
  return props.message.toolCalls || []
})

// 是否显示思考组件（loading 占位 / 深度思考 / 已完成）
const showThinking = computed(() => isLoading.value || isThinkingStreaming.value || isThinkingDone.value)
// 传给 AiThinking 的 isStreaming：loading 占位和 thinking 流式阶段都扫光
const thinkingIsStreaming = computed(() => isLoading.value || isThinkingStreaming.value)

// 思考阶段强制展开，让用户看到 reasoning 流式生长；结束后保持展开便于回看
watch(isThinkingStreaming, (now, before) => {
  if (before && !now) expandedThinking.value = true
})

// 记录思考结束时刻，用于折叠头显示“深度思考 Ns”
const thinkingEndedAt = ref<number | null>(null)
watch(
  () => [props.message.thinkingStartedAt, props.message.thinkingActive],
  () => {
    if (
      props.message.thinkingStartedAt &&
      props.message.thinkingActive === false &&
      thinkingEndedAt.value === null
    ) {
      thinkingEndedAt.value = Date.now()
    }
  },
)

const thinkingSecs = computed(() => {
  const s = props.message.thinkingStartedAt
  if (!s) return 0
  const end = thinkingEndedAt.value ?? (props.message.thinkingActive !== false ? Date.now() : s)
  return Math.max(0, Math.floor((end - s) / 1000))
})

// 折叠头中用于概括处理过程的标签（深度思考 / 工具调用次数 / 子代理数量）
const processChips = computed<string[]>(() => {
  const chips: string[] = []
  if (hasThinking.value) {
    const sec = thinkingSecs.value
    chips.push(sec > 0 ? t('ai_process_thinking', { n: sec }) : t('ai_thinking_deep', '深度思考'))
  }
  const toolCount = props.message.toolCalls?.length || 0
  if (toolCount > 0) chips.push(t('ai_process_tools', { n: toolCount }))
  const agentCount = props.message.agentRuns?.length || 0
  if (agentCount > 0) chips.push(t('ai_process_agents', { n: agentCount }))
  return chips
})

function compactBlankLines(content: string): string {
  if (!content) return ''
  return content.replace(/\n{3,}/g, '\n\n').trim()
}

function renderMarkdown(content: string): string {
  const compacted = compactBlankLines(content)
  if (!compacted) return ''
  try {
    return sanitizeHtml(marked.parse(compacted) as string)
  } catch {
    return sanitizeHtml(compacted)
  }
}

// === 流式输出打字机逐字动画（#232）===
// 流式期间逐字呈现 AI 回复：维护"已显示字符数"displayCount，定时增长直到追平全文。
// 按段落边界截断（避免 markdown 结构被截断导致渲染错乱）；流结束立即显示全文。
const displayCount = ref(0)
let typewriterTimer: ReturnType<typeof setInterval> | null = null

function stopTypewriter() {
  if (typewriterTimer) {
    clearInterval(typewriterTimer)
    typewriterTimer = null
  }
  displayCount.value = props.message.content?.length || 0
}

function startTypewriter() {
  stopTypewriter()
  const total = props.message.content?.length || 0
  displayCount.value = Math.min(displayCount.value, total)
  // 每 18ms 增加 1 个字符，接近人类阅读节奏（约 55 字/秒）
  typewriterTimer = setInterval(() => {
    const len = props.message.content?.length || 0
    if (displayCount.value >= len) {
      // 内容已追平，继续等待新 chunk
      return
    }
    // 逐字 + 偶尔跨越空行/空格（加速长文本）
    displayCount.value = Math.min(len, displayCount.value + 1)
  }, 18)
}

watch(
  () => props.isStreaming && props.index === 0 && props.message.role === 'assistant',
  (now) => {
    if (now) startTypewriter()
    else stopTypewriter()
  },
  { immediate: true },
)

// 打字机渲染内容：流式时只取前 displayCount 个字符，并尽量在段落边界截断
const typewriterContent = computed(() => {
  const content = props.message.content || ''
  if (!isStreamingNow.value || props.message.role !== 'assistant') return content
  const n = Math.min(displayCount.value, content.length)
  if (n >= content.length) return content
  // 找最近段落边界（换行），避免断在 markdown 结构/单词中间
  const boundary = content.lastIndexOf('\n', n - 1)
  if (boundary > 0 && n - boundary < 120) return content.slice(0, boundary + 1)
  return content.slice(0, n)
})

onUnmounted(stopTypewriter)

function roleLabel() {
  return props.message.role === 'user' ? t('ai_you') : t('ai_assistant')
}

// 快捷指令：解析 systemMeta.kind='quick_action_<x>' → 标签/图标，但不暴露完整 prompt。
const QUICK_ACTIONS_KIND_META: Record<string, { icon: string; i18nKey: string }> = {
  quick_action_summarize: { icon: '📝', i18nKey: 'ai_quick_applied_summarize' },
  quick_action_translate: { icon: '🌐', i18nKey: 'ai_quick_applied_translate' },
  quick_action_format: { icon: '🧹', i18nKey: 'ai_quick_applied_format' },
  quick_action_explain: { icon: '💡', i18nKey: 'ai_quick_applied_explain' },
}
const quickActionKind = computed(() => {
  const kind = props.message.systemMeta?.kind
  return kind && kind.startsWith('quick_action_') ? kind : null
})
const quickActionMeta = computed(() => (quickActionKind.value ? QUICK_ACTIONS_KIND_META[quickActionKind.value] : null))
const quickActionIcon = computed(() => quickActionMeta.value?.icon ?? '·')
const quickActionLabel = computed(() => (quickActionMeta.value ? t(quickActionMeta.value.i18nKey) : ''))
</script>

<template>
  <div class="ai-msg" :class="message.role">
    <div class="ai-msg-bubble">
      <div class="ai-msg-role">{{ roleLabel() }}</div>

      <!-- 折叠态：任务处理过程已完成，收起为一行（点击展开回看） -->
      <div
        v-if="message.role === 'assistant' && hasProcess && collapsed"
        class="ai-process-collapsed"
        @click="collapsed = false"
      >
        <span class="ai-process-collapsed-label">{{ t('ai_process_collapsed') }}</span>
        <span v-for="chip in processChips" :key="chip" class="ai-process-chip">{{ chip }}</span>
        <ChevronRight :size="13" class="ai-process-collapsed-chev" />
      </div>

      <!-- 展开态：思考 / 工具调用 / 子代理执行 -->
      <template v-else>
        <!-- 阶段 1/2/3：loading 占位 / 深度思考 / 思考完成 -->
        <AiThinking
          v-if="message.role === 'assistant' && showThinking"
          :thinking="message.thinking || ''"
          :thinking-started-at="message.thinkingStartedAt"
          :is-streaming="thinkingIsStreaming"
          :expanded="expandedThinking || isThinkingStreaming"
          @toggle="expandedThinking = !expandedThinking"
        />

        <!-- 工具调用日志：仅在思考结束后出现（带时间线序号 + 子代理归属） -->
        <AiToolTimeline
          v-if="message.role === 'assistant' && visibleToolCalls.length"
          :tool-calls="visibleToolCalls"
          :tool-results="message.toolResults"
        />

        <!-- 多代理并行模式：子代理摘要行（点击展开详情抽屉），仅在思考结束后出现 -->
        <AiAgentSummary
          v-if="message.role === 'assistant' && visibleAgentRuns.length"
          :runs="visibleAgentRuns"
          @open="drawerRun = $event"
        />
      </template>

      <!-- 子代理执行详情抽屉（点击摘要行打开，❌ 或 ESC 关闭，不影响主流程继续） -->
      <AiAgentDrawer
        v-if="drawerRun"
        :run="drawerRun"
        :is-streaming="isStreaming"
        @close="drawerRun = null"
      />

      <div v-if="message.role === 'assistant'" class="ai-msg-content markdown-body">
        <!-- 打字机逐字渲染（#232）：流式时只显示前 N 字符，末尾带闪烁光标 -->
        <span v-html="renderMarkdown(typewriterContent)"></span>
        <span v-if="isStreamingNow && typewriterContent.length < (message.content?.length || 0)" class="ai-type-caret"></span>
      </div>
      <template v-else-if="message.role === 'system'">
        <!-- 快捷指令（总结/翻译/格式化/解释）：仅显示"已应用指令"标签，完整 prompt 不暴露给用户 -->
        <div
          v-if="quickActionKind"
          class="ai-msg-system-card ai-msg-system-card--quick-action"
        >
          <span class="ai-msg-system-icon">{{ quickActionIcon }}</span>
          <span>{{ quickActionLabel }}</span>
        </div>
        <!-- 手动 /compact 命令结果横幅：success / loading / too_short / failed 四种 -->
        <div
          v-if="message.systemMeta?.kind?.startsWith('compact_')"
          class="ai-msg-system-card"
          :class="`ai-msg-system-card--${message.systemMeta?.kind}`"
        >
          <template v-if="message.systemMeta?.kind === 'compact_loading'">
            <span class="ai-msg-system-icon">⟳</span>
            <span>{{ t('ai_compact_loading') || '正在压缩上下文…' }}</span>
          </template>
          <template v-else-if="message.systemMeta?.kind === 'compact_success'">
            <span class="ai-msg-system-icon">✓</span>
            <span>{{ t('ai_compact_success', { removed: message.systemMeta.removed ?? 0, savedTokens: message.systemMeta.savedTokens ?? 0 }) }}</span>
            <details v-if="message.systemMeta.summaryPreview" class="ai-msg-system-preview">
              <summary>{{ t('ai_compact_view_summary') || '查看压缩摘要' }}</summary>
              <pre>{{ message.systemMeta.summaryPreview }}{{ message.systemMeta.summaryPreview.length >= 600 ? '\n…' : '' }}</pre>
            </details>
          </template>
          <template v-else-if="message.systemMeta?.kind === 'compact_too_short'">
            <span class="ai-msg-system-icon">·</span>
            <span>{{ t('ai_compact_too_short') }}</span>
          </template>
          <template v-else>
            <span class="ai-msg-system-icon">✕</span>
            <span>{{ message.content }}</span>
          </template>
        </div>
        <!-- 其它 system 消息：保留原文（多为上游"自动压缩"提示横幅） -->
        <div v-else class="ai-msg-content">{{ compactBlankLines(message.content) }}</div>
      </template>
      <template v-else>
        <!-- 用户消息：hover 显示「复制 / 重新编辑」操作条（右上角） -->
        <div
          class="ai-msg-user-body"
          @mouseenter="userActionsVisible = true"
          @mouseleave="userActionsVisible = false"
        >
          <!-- 用户随消息发送的截图缩略图（多模态 vision 提问） -->
          <div v-if="message.images?.length" class="ai-msg-images">
            <img v-for="(img, i) in message.images" :key="i" :src="img.data" :alt="img.mime" />
          </div>
          <div class="ai-msg-content">{{ compactBlankLines(stripViewContext(message.content)) }}</div>
          <div class="ai-msg-actions" :class="{ visible: userActionsVisible }">
            <button class="ai-msg-action-btn" :title="t('ai_copy')" @click="copyUserContent">
              <Copy :size="13" />
            </button>
            <button class="ai-msg-action-btn" :title="t('ai_reedit')" @click="reeditUserContent">
              <Pencil :size="13" />
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ai-msg {
  display: flex;
}
.ai-msg.user {
  justify-content: flex-end;
}
/* 历史用户消息操作条容器：相对定位，让「复制 / 重新编辑」按钮悬浮在气泡右上角 */
.ai-msg-user-body {
  position: relative;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ai-msg-actions {
  position: absolute;
  top: -10px;
  right: 6px;
  display: flex;
  gap: 4px;
  padding: 2px;
  border-radius: 8px;
  background: var(--bg-elevated, #fff);
  border: 1px solid var(--border-default, #e2e8f0);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  opacity: 0;
  transform: translateY(4px);
  pointer-events: none;
  transition: opacity 0.15s ease, transform 0.15s ease;
  z-index: 5;
}
.ai-msg-actions.visible {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}
.ai-msg-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #64748b);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.ai-msg-action-btn:hover {
  background: var(--accent-bg, rgba(99, 102, 241, 0.1));
  color: var(--accent, #6366f1);
}
.ai-msg.assistant {
  justify-content: flex-start;
}
/* /compact 命令的 system 消息横幅：success / loading / too_short / failed
   状态用左侧色条 + 不同背景色区分，让用户清楚看到"刚才发生了什么"。 */
.ai-msg.system {
  justify-content: center;
  margin: 4px 0;
}
.ai-msg-system-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--ai-border, rgba(127,127,127,0.18));
  background: var(--ai-system-bg, rgba(127,127,127,0.06));
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--ai-fg-muted, #6b7280);
  max-width: 96%;
}
.ai-msg-system-card--compact_loading {
  border-left: 3px solid #3b82f6;
  background: rgba(59, 130, 246, 0.06);
}
.ai-msg-system-card--compact_success {
  border-left: 3px solid #10b981;
  background: rgba(16, 185, 129, 0.06);
  color: var(--ai-fg, inherit);
}
.ai-msg-system-card--compact_too_short {
  border-left: 3px solid #94a3b8;
}
.ai-msg-system-card--compact_failed {
  border-left: 3px solid #ef4444;
  background: rgba(239, 68, 68, 0.06);
  color: #b91c1c;
}
.ai-msg-system-card--quick-action {
  border-left: 3px solid #8b5cf6;
  background: rgba(139, 92, 246, 0.07);
  color: var(--ai-fg, inherit);
  font-size: 12px;
  padding: 4px 10px;
}
.ai-msg-system-icon {
  display: inline-block;
  margin-right: 6px;
  font-weight: 600;
}
.ai-msg-system-preview {
  margin-top: 4px;
  font-size: 11.5px;
}
.ai-msg-system-preview summary {
  cursor: pointer;
  color: var(--accent);
  user-select: none;
}
.ai-msg-system-preview pre {
  margin: 6px 0 0 0;
  padding: 8px 10px;
  background: var(--ai-bg-soft, rgba(127,127,127,0.06));
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ai-fg, inherit);
}
.ai-msg-bubble {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 96%;
  min-width: 0;
  padding: 16px 20px;
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
  opacity: 0.6;
  margin-bottom: 8px;
}

/* 折叠态处理过程头：类 WorkBuddy “已完成” 折叠条 */
.ai-process-collapsed {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  width: 100%;
  padding: 10px 16px;
  margin-bottom: 10px;
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  transition: background 0.15s, color 0.15s;
}
.ai-process-collapsed:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.ai-process-collapsed-label {
  font-weight: 700;
  color: var(--text-primary);
}
.ai-process-chip {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  background: var(--bg-hover);
  border-radius: 999px;
  padding: 1px 8px;
  white-space: nowrap;
}
.ai-process-collapsed-chev {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.ai-msg-content {
  white-space: normal;
  word-break: break-word;
  /* #218：长表格/长代码/超长无空格内容在气泡内横向滚动，而非把布局撑破 */
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
}
/* 打字机光标（#232）：流式逐字输出时在文字末尾闪烁 */
.ai-type-caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  background: var(--accent, #6366f1);
  animation: ai-type-caret-blink 0.9s step-end infinite;
}
@keyframes ai-type-caret-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.ai-msg.user .ai-msg-content {
  white-space: pre-wrap;
}
/* 用户消息中的截图缩略图（多模态 vision 提问） */
.ai-msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.ai-msg-images img {
  max-width: 160px;
  max-height: 160px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle);
  object-fit: cover;
  display: block;
}
.ai-msg-content :deep(h1),
.ai-msg-content :deep(h2),
.ai-msg-content :deep(h3),
.ai-msg-content :deep(h4) {
  margin: 10px 0 4px;
  font-weight: 600;
}
.ai-msg-content :deep(h1) { font-size: 15px; }
.ai-msg-content :deep(h2) { font-size: 14px; }
.ai-msg-content :deep(h3) { font-size: 13px; }
.ai-msg-content :deep(p) { margin: 6px 0; }
.ai-msg-content :deep(ul),
.ai-msg-content :deep(ol) {
  padding-left: 20px;
  margin: 6px 0;
}
.ai-msg-content :deep(li) { margin: 3px 0; }
.ai-msg-content :deep(li > p) { margin: 0; }
.ai-msg-content :deep(code) {
  background: rgba(0,0,0,0.06);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
.ai-msg-content :deep(pre) {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
  margin: 8px 0;
}
.ai-msg-content :deep(pre code) {
  background: none;
  padding: 0;
}
.ai-msg-content :deep(strong) { font-weight: 600; }
.ai-msg-content :deep(a) { color: var(--accent); }
.ai-msg-content :deep(blockquote) {
  border-left: 3px solid var(--accent);
  background: var(--accent-bg);
  padding: 12px 16px;
  border-radius: var(--radius-sm);
  margin: 10px 0;
  color: var(--text-secondary);
}
.ai-msg-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 4px 0;
  font-size: 12px;
}
.ai-msg-content :deep(th),
.ai-msg-content :deep(td) {
  padding: 6px 10px;
  border: 1px solid var(--border-subtle);
  text-align: left;
}
.ai-msg-content :deep(th) {
  background: var(--bg-surface);
  font-weight: 600;
}
.ai-msg-content :deep(tr:nth-child(2n)) {
  background: var(--bg-surface);
}
</style>
