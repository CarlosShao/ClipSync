<script setup lang="ts">
import { ref, computed, watch, type Component } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { ChevronDown, Copy, Pencil, ListChecks, Languages, AlignLeft, HelpCircle, Sparkles } from 'lucide-vue-next'
import type { ChatMessage, AgentRun, ToolCall } from '@/api/ai'
import AiThinkingCollapse from './AiThinkingCollapse.vue'
import AiAgentCards from './AiAgentCards.vue'
import AiAgentDrawer from './AiAgentDrawer.vue'
import AiStreamText from './AiStreamText.vue'
import AiProcessChips from './AiProcessChips.vue'
import AiToolTimeline from './AiToolTimeline.vue'

/**
 * AiMessage — 单条消息渲染（UI-C 重构，UI-D 过程可视化接入）
 *
 * 统一「过程折叠」结构（assistant 消息）：
 *   折叠态：AiProcessChips（思考 Ns / 工具 N 次 / 子代理 N 个，点击展开）
 *   展开态：① AiThinkingCollapse（loading 扫光/深度思考折叠面板）→ ② AiToolTimeline
 *           （写操作标注/破坏性标签/等待确认态）→ ③ AiAgentCards（子代理卡片网格，
 *           点击打开 AiAgentDrawer）→ 内容（AiStreamText 节流渲染 Markdown）
 */
const props = defineProps<{ 
  message: ChatMessage
  index: number
  isStreaming: boolean
  isLatest: boolean
  // 破坏性工具确认门控：当前正在等待确认的工具名（用于 AiToolTimeline “等待确认”态标注）
  confirmTool?: string | null
}>()
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
      try {
        window.prompt('复制下面文本到剪贴板：', text)
      } catch {
        /* ignore */
      }
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

// 纯文本压缩（用户/系统消息直接展示用；assistant Markdown 由 AiStreamText 内部处理）
function compactBlankLines(content: string): string {
  if (!content) return ''
  return content.replace(/\n{3,}/g, '\n\n').trim()
}

// 状态计算
const expandedThinking = ref(false)
const isStreamingNow = computed(() => props.isStreaming)

// 字段存在性
const hasAgentRuns = computed(() => (props.message.agentRuns?.length || 0) > 0)
const hasToolCalls = computed(
  () => (props.message.toolCalls?.length || 0) > 0 || (props.message.toolResults?.length || 0) > 0,
)
const hasThinking = computed(() => (props.message.thinking?.length || 0) > 0)
const hasContent = computed(() => (props.message.content?.length || 0) > 0)
const hasProcess = computed(() => hasThinking.value || hasToolCalls.value || hasAgentRuns.value)

// ===== 消息生命周期状态机（assistant 消息）=====
// 注意：thinkingActive===false 表示工具已开始调用 → 思考阶段已结束
// 1. 加载态：流式刚开始，助手消息还没收到任何数据
const isLoading = computed(() => isStreamingNow.value && !hasThinking.value && !hasContent.value && !hasToolCalls.value)
// 2. 思考进行中：收到思考 token，且思考阶段尚未结束
const isThinkingPhase = computed(
  () => isStreamingNow.value && hasThinking.value && props.message.thinkingActive !== false,
)

// 子代理详情抽屉（UI-D：AiAgentCards 点击卡片 → 此处打开 AiAgentDrawer）
const agentDrawerRun = ref<AgentRun | null>(null)

// ===== 过程折叠（UI-C 统一结构）=====
// 默认展开；流式结束后可点「收起」进入折叠态（AiProcessChips），点 chips 行展开。
// 流式开始时自动展开并清除用户折叠标记。
const userCollapsed = ref(false)
watch(isStreamingNow, (now) => {
  if (now) {
    expandedThinking.value = false
    userCollapsed.value = false
  }
})

// 思考计时
const thinkingEndedAt = ref<number | null>(null)
watch(
  () => [props.message.thinkingStartedAt, props.message.thinkingActive],
  () => {
    if (props.message.thinkingStartedAt && props.message.thinkingActive === false && thinkingEndedAt.value === null) {
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

// 流式内容（交给 AiStreamText 节流渲染）
const streamingContent = computed(() => props.message.content || '')

// 可见工具/代理：思考阶段只显示思考面板，工具/代理在思考结束后才显示
const visibleAgentRuns = computed(() => {
  return props.message.agentRuns || []
})
// 工具调用：toolCalls 优先；缺失时从 toolResults 兜底（有些实现只下发 result 不下发 call）
const visibleToolCalls = computed(() => {
  const calls = props.message.toolCalls || []
  if (calls.length) return calls
  const results = props.message.toolResults || []
  return results.map((r) => ({
    id: r.tool_call_id,
    name: r.name || 'tool',
    arguments: '',
  }))
})

// 调试：把所有 assistant 消息的关键字段打出来供排查（仅当字段变化时）
watch(() => props.message, () => {
  if (props.message.role === 'assistant' && props.message.id) {
    console.log('[AiMessage] message', {
      id: props.message.id,
      hasThinking: hasThinking.value,
      hasContent: hasContent.value,
      hasToolCalls: Boolean((props.message.toolCalls || []).length),
      toolCallsCount: (props.message.toolCalls || []).length,
      toolResultsCount: (props.message.toolResults || []).length,
      hasAgentRuns: hasAgentRuns.value,
      agentRunsCount: (props.message.agentRuns || []).length,
      isStreaming: isStreamingNow.value,
      thinkingActive: props.message.thinkingActive,
    })
  }
}, { deep: false })
// 快捷指令
const QUICK_ACTIONS_KIND_META: Record<string, { icon: Component; i18nKey: string }> = {
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
          <div class="ai-msg-content">
            {{ compactBlankLines(stripUserInputMarkers(stripViewContext(message.content))) }}
          </div>
        </div>
      </div>
      <div class="ai-msg-actions ai-msg-actions--user">
        <button class="ai-msg-action-btn" :title="t('ai_copy')" @click.stop="copyUserContent">
          <Copy :size="13" />
        </button>
        <button class="ai-msg-action-btn" :title="t('ai_reedit')" @click.stop="reeditUserContent">
          <Pencil :size="13" />
        </button>
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
      <div
        v-else-if="message.systemMeta?.kind?.startsWith('compact_')"
        class="ai-msg-system-card"
        :class="`ai-msg-system-card--${message.systemMeta?.kind}`"
      >
        <template v-if="message.systemMeta?.kind === 'compact_loading'">
          <span class="ai-msg-system-icon">⟳</span><span>{{ t('ai_compact_loading', '正在压缩上下文…') }}</span>
        </template>
        <template v-else-if="message.systemMeta?.kind === 'compact_success'">
          <span class="ai-msg-system-icon">✓</span>
          <span>{{
            t('ai_compact_success', {
              removed: message.systemMeta.removed ?? 0,
              savedTokens: message.systemMeta.savedTokens ?? 0,
            })
          }}</span>
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

    <!-- 助手消息 - 统一「过程折叠」结构：折叠 chips ←→ 展开（思考 → 时间线 → 子代理 → 内容） -->
    <template v-else>
      <div class="ai-msg-bubble">
        <!-- 折叠态：过程统计 chips 行（点击展开；与展开态「收起过程」按钮联动） -->
        <AiProcessChips
          v-if="userCollapsed && hasProcess && !isStreamingNow"
          :message="message"
          :thinking-secs="thinkingSecs"
          @toggle="userCollapsed = false"
        />

        <!-- 展开态：按状态机依次渲染 -->
        <template v-else>
          <!-- 展开态收起入口：流式结束后出现，点击进入折叠 chips 态 -->
          <button
            v-if="hasProcess && !isStreamingNow"
            type="button"
            class="ai-process-collapse-btn"
            @click="userCollapsed = true"
          >
            <ChevronDown :size="12" />
            <span>{{ t('ai_process_collapse', '收起过程') }}</span>
          </button>

          <!-- 【UI-D 插入位 ①】AiThinkingCollapse：loading 扫光（首字前）→ 深度思考面板
               （流式中扫光+计时+打字机；完成后折叠为「深度思考 Ns」摘要行） -->
          <AiThinkingCollapse
            v-if="isLoading || hasThinking"
            :thinking="message.thinking || ''"
            :thinking-started-at="message.thinkingStartedAt"
            :is-streaming="isThinkingPhase || isLoading"
            :expanded="expandedThinking"
            @toggle="expandedThinking = !expandedThinking"
          />

          <!-- 【UI-D 插入位 ②】AiToolTimeline：工具时间线（写操作标注/破坏性标签/等待确认态） -->
          <AiToolTimeline
            v-if="!isThinkingPhase && visibleToolCalls.length"
            :tool-calls="visibleToolCalls"
            :tool-results="message.toolResults"
            :confirm-tool="confirmTool ?? null"
          />

          <!-- 【UI-D 插入位 ③】AiAgentCards：子代理并行卡片网格（点击卡片打开详情抽屉） -->
          <AiAgentCards
            v-if="!isThinkingPhase && visibleAgentRuns.length"
            :runs="visibleAgentRuns"
            @open="agentDrawerRun = $event"
          />

          <!-- 子代理详情抽屉（保持原 AiAgentDrawer 打开链路） -->
          <AiAgentDrawer
            v-if="agentDrawerRun"
            :run="agentDrawerRun"
            :is-streaming="isStreamingNow"
            @close="agentDrawerRun = null"
          />

          <!-- 主要内容输出（答案区）：AiStreamText 节流渲染 Markdown（≥100ms/≥200 字符） -->
          <div v-if="hasContent" class="ai-msg-content markdown-body">
            <AiStreamText :text="streamingContent" :done="!isStreamingNow" />
            <span v-if="isStreamingNow && !hasToolCalls" class="ai-stream-caret"></span>
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
  background: var(--accent);
  color: var(--accent-foreground, rgb(255 255 255));
  border-bottom-right-radius: 4px;
}
.ai-msg.assistant .ai-msg-bubble {
  background: transparent;
  color: var(--text-default, var(--text-primary));
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
  bottom: -2px;
  display: none;
  gap: 4px;
  padding: 2px;
  border-radius: 8px;
  background: var(--bg-base-default, var(--bg-surface));
  border: 1px solid var(--border-neutral-l1, var(--border-default));
  z-index: var(--z-index-10);
  transition: opacity 0.15s ease;
}
.ai-msg.user:hover .ai-msg-actions--user {
  display: inline-flex;
}
.ai-msg.user .ai-msg-user-body {
  padding-bottom: 0;
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
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
}
.ai-msg-action-btn:hover {
  background: var(--bg-overlay-l1, var(--bg-hover));
  color: var(--accent);
}

/* ============ 过程折叠（UI-C 统一结构） ============ */
/* 展开态收起入口 */
.ai-process-collapse-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
  padding: 2px 8px;
  border: none;
  border-radius: 999px;
  background: transparent;
  font-size: 11px;
  color: var(--text-tertiary);
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
}
.ai-process-collapse-btn:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

/* ============ 主要内容 ============ */
.ai-msg-content {
  white-space: normal;
  word-break: break-word;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
}
.ai-msg.user .ai-msg-content {
  white-space: pre-wrap;
}

/* Markdown 样式（AiStreamText 渲染的节点在 .ai-msg-content 内） */
.ai-msg-content :deep(h1),
.ai-msg-content :deep(h2),
.ai-msg-content :deep(h3),
.ai-msg-content :deep(h4) {
  margin: 12px 0 6px;
  font-weight: 600;
}
.ai-msg-content :deep(h1) {
  font-size: 18px;
}
.ai-msg-content :deep(h2) {
  font-size: 16px;
}
.ai-msg-content :deep(h3) {
  font-size: 14px;
}
.ai-msg-content :deep(p) {
  margin: 6px 0;
}
.ai-msg-content :deep(ul),
.ai-msg-content :deep(ol) {
  padding-left: 20px;
  margin: 6px 0;
}
.ai-msg-content :deep(li) {
  margin: 3px 0;
}
.ai-msg-content :deep(code) {
  background: var(--bg-overlay-l1, var(--bg-hover));
  padding: 2px 5px;
  border-radius: 4px;
  font-family: var(--font-family-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--accent);
}
.ai-msg-content :deep(pre) {
  background: var(--bg-base-secondary, var(--bg-hover));
  border: 1px solid var(--border-neutral-l1, var(--border-default));
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  margin: 10px 0;
}
.ai-msg-content :deep(pre code) {
  background: none;
  padding: 0;
  color: var(--text-default, var(--text-primary));
}
.ai-msg-content :deep(strong) {
  font-weight: 600;
}
.ai-msg-content :deep(a) {
  color: var(--accent);
}
.ai-msg-content :deep(blockquote) {
  border-left: 3px solid var(--accent);
  background: var(--bg-overlay-l1, var(--bg-hover));
  padding: 8px 14px;
  border-radius: 6px;
  margin: 8px 0;
  color: var(--text-secondary);
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
  border: 1px solid var(--border-neutral-l1, var(--border-default));
  text-align: left;
}
.ai-msg-content :deep(th) {
  background: var(--bg-base-secondary, var(--bg-hover));
  font-weight: 600;
}
.ai-msg-content :deep(tr:nth-child(2n)) {
  background: var(--bg-base-secondary, var(--bg-hover));
}

/* 流式光标：中性灰 */
.ai-stream-caret {
  display: inline-block;
  width: 2px;
  height: 1.2em;
  margin-left: 1px;
  vertical-align: text-bottom;
  background: var(--text-secondary);
  border-radius: 1px;
  animation: caret-pulse 1.2s ease-in-out infinite;
}
@keyframes caret-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scaleY(1);
  }
  50% {
    opacity: 0.4;
    transform: scaleY(0.85);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-stream-caret {
    animation: none;
  }
}

/* ============ System 消息 ============ */
.ai-msg-system-hidden {
  display: none;
}
.ai-msg-system-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-neutral-l1, var(--border-default));
  background: var(--bg-base-secondary, var(--bg-hover));
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-secondary);
  max-width: 96%;
}
.ai-msg-system-card--compact_loading {
  border-left: 3px solid var(--accent);
}
.ai-msg-system-card--compact_success {
  border-left: 3px solid var(--success);
}
.ai-msg-system-card--compact_too_short {
  border-left: 3px solid var(--text-tertiary);
}
.ai-msg-system-card--compact_failed {
  border-left: 3px solid var(--danger);
}
.ai-msg-system-card--quick-action {
  border-left: 3px solid var(--accent);
  background: var(--bg-overlay-l1, var(--bg-hover));
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.ai-msg-system-icon {
  display: inline-block;
  margin-right: 6px;
  font-weight: 600;
}
.ai-msg-system-icon-svg {
  width: 14px;
  height: 14px;
  color: var(--accent);
  flex-shrink: 0;
}

/* 用户消息截图 */
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
  border: 1px solid var(--border-neutral-l1, var(--border-default));
  object-fit: cover;
  display: block;
}
</style>
