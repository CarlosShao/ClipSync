<script setup lang="ts">
import { ref, computed, watch, type Component } from 'vue'
import { useI18n } from '@/composables/useI18n'
import {
  ChevronRight,
  ChevronDown,
  Copy,
  Pencil,
  ListChecks,
  Languages,
  AlignLeft,
  HelpCircle,
  Sparkles,
  CheckCircle2,
  Loader2,
  XCircle,
  Bot,
} from 'lucide-vue-next'
import type { ChatMessage, AgentRun } from '@/api/ai'
import AiWaiting from './AiWaiting.vue'
import AiThinkingOrb from './AiThinkingOrb.vue'
import AiStreamText from './AiStreamText.vue'
import AiProcessChips from './AiProcessChips.vue'
import AiToolTimeline from './AiToolTimeline.vue'

/**
 * AiMessage — 单条消息渲染（UI-C 重构）
 *
 * 统一「过程折叠」结构（assistant 消息）：
 *   折叠态：AiProcessChips（思考 Ns / 工具 N 次 / 子代理 N 个，点击展开）
 *   展开态：ThinkingCollapse 插入位（①） → 工具时间线（②） → 子代理卡片插入位（③） → 内容
 *
 * 流式内容渲染改用 AiStreamText（Markdown 节流：≥100ms 或 ≥200 字符才 parse 一次，
 * 终态强制刷新），替代原先的逐 token 全量重渲。
 *
 * 【UI-D 插入位说明】
 *   ① 思考折叠：当前为过渡实现（AiWaiting + 内联思考面板），UI-D 交付
 *      AiThinkingCollapse.vue（合并 AiThinking/AiWaiting，删除 orbs-js）后整体替换。
 *   ② 工具时间线：已接入 AiToolTimeline.vue；UI-D 重构该组件（写操作标注/
 *      破坏性标签/等待确认态）时保持 toolCalls/toolResults props 契约即可。
 *   ③ 子代理卡片：当前为内联 wf-table，UI-D 交付 AiAgentCards.vue（合并
 *      AiAgentSummary）后替换本区块。
 */
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

// 思考已完成（非流式 或 思考阶段已结束）：orb → breathing、shimmer 停
const thinkingDone = computed(() => hasThinking.value && !isThinkingPhase.value)

function runActive(run: AgentRun): boolean {
  return run.status === 'planning' || run.status === 'working' || run.status === 'synthesis'
}

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

// 思考面板标题：进行中「深度思考」 vs 完成「深度思考 · Ns」
const thinkingPanelTitle = computed(() => {
  if (thinkingSecs.value > 0) return `深度思考 · ${thinkingSecs.value}s`
  return '深度思考'
})

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

// 格式化耗时
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remain = sec % 60
  return `${min}m ${remain}s`
}

// 子代理图标：按 status 决定
function runIcon(run: AgentRun) {
  if (run.status === 'done') return CheckCircle2
  if (run.status === 'failed') return XCircle
  if (runActive(run)) return Loader2
  return Bot
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
          <span class="ai-msg-system-icon">⟳</span><span>{{ t('ai_compact_loading') || '正在压缩上下文…' }}</span>
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

          <!-- 【UI-D 插入位 ①】ThinkingCollapse：以下等待态 + 思考面板为过渡实现，
               UI-D 交付 AiThinkingCollapse.vue（合并 AiThinking/AiWaiting）后整体替换 -->
          <!-- 状态 1：等待加载（首字前）—— AiWaiting：orb + 「正在思考中」shimmer -->
          <AiWaiting v-if="isLoading" class="ai-waiting-block" />

          <!-- 状态 2：深度思考面板（左 orb + 标题 + 思考过程） -->
          <div v-if="hasThinking" class="ai-think-panel">
            <div class="ai-think-head" @click="expandedThinking = !expandedThinking">
              <AiThinkingOrb class="ai-think-orb" :state="isThinkingPhase ? 'composing' : 'breathing'" :size="24" />
              <span class="ai-think-title" :class="{ paused: thinkingDone }" :data-text="thinkingPanelTitle">{{
                thinkingPanelTitle
              }}</span>
              <ChevronRight v-if="!expandedThinking" :size="13" class="ai-think-chev" />
              <ChevronDown v-else :size="13" class="ai-think-chev" />
            </div>
            <div class="ai-think-body" :class="{ collapsed: !expandedThinking }">
              <pre class="ai-think-md">{{ message.thinking }}</pre>
            </div>
          </div>

          <!-- 【UI-D 插入位 ②】工具时间线：已接入 AiToolTimeline；
               UI-D 重构该组件（写操作标注/破坏性标签/确认态）时保持 props 契约 -->
          <!-- 状态 3：工具调用时间线（思考阶段结束后显示） -->
          <AiToolTimeline
            v-if="!isThinkingPhase && visibleToolCalls.length"
            :tool-calls="visibleToolCalls"
            :tool-results="message.toolResults"
          />

          <!-- 【UI-D 插入位 ③】子代理卡片：以下 wf-table 为过渡实现，
               UI-D 交付 AiAgentCards.vue（合并 AiAgentSummary）后替换本区块 -->
          <!-- 状态 3：子代理 / 工作流步骤（思考阶段结束后才显示） -->
          <div v-if="!isThinkingPhase && visibleAgentRuns.length" class="ai-wf-table">
            <div
              v-for="(run, i) in visibleAgentRuns"
              :key="run.id"
              class="ai-wf-row"
              :class="{ active: runActive(run), done: run.status === 'done', failed: run.status === 'failed' }"
            >
              <span class="ai-wf-n">{{ String(i + 1).padStart(2, '0') }}</span>
              <span class="ai-wf-name">
                <component :is="runIcon(run)" :size="12" class="ai-wf-icon" :class="{ 'ai-wf-spin': runActive(run) }" />
                {{ run.name }}
              </span>
              <span class="ai-wf-meta">{{
                run.duration ? formatDuration(run.duration) : runActive(run) ? 'running' : run.status
              }}</span>
              <div class="ai-wf-bar">
                <i :style="{ width: run.status === 'done' ? '100%' : runActive(run) ? '60%' : '0%' }"></i>
              </div>
            </div>
          </div>

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

/* ================================================================
   agent-workflow-ui skill 基准（对齐 demo agent-workflow-demo）
   - waiting: AiWaiting（orb + 「正在思考中」字内 shimmer）
   - think-panel: 左 orb + 「深度思考」标题 shimmer + 思考过程
   - wf-table: 工作流极简表格行 + 进度条
   ================================================================ */

/* ---- 等待加载（AiWaiting 容器）---- */
.ai-waiting-block {
  margin: 2px 0 0;
}

/* ---- 深度思考面板 ---- */
.ai-think-panel {
  margin: 8px 0 0;
  overflow: hidden;
}
.ai-think-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 2px;
  cursor: pointer;
  user-select: none;
}
.ai-think-orb {
  flex-shrink: 0;
  display: block;
}
.ai-think-title {
  position: relative;
  display: inline-block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  overflow: visible;
}
/* 字内笔画间 shimmer：与 demo 原版一致
   （transparent 基色 + mix-blend-mode: screen/multiply → 文字永不消失，只有高光带在字内流动）
   ⚠️ 必须用 background-image 而不是 background 简写——简写会清掉 background-clip:text
   ⚠️ 不要改回 currentColor/text-fill-color:transparent 写法——无 mix-blend-mode 时渐变未覆盖的文字会变透明，看起来像"横扫整个 box" */
.ai-think-title::after {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    transparent 35%,
    rgba(255, 255, 255, 0.85) 50%,
    transparent 65%,
    transparent 100%
  );
  background-size: 220% 100%;
  background-position: 100% 0;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  animation: ai-think-shimmer 2.5s ease-in-out infinite;
  mix-blend-mode: screen;
}
html.light .ai-think-title::after {
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    transparent 35%,
    rgba(24, 24, 27, 0.85) 50%,
    transparent 65%,
    transparent 100%
  );
  background-size: 220% 100%;
  mix-blend-mode: multiply;
}
/* 思考完成 → shimmer 停止 */
.ai-think-title.paused::after {
  animation: none;
  background-position: 100% 0;
}
@keyframes ai-think-shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -20% 0;
  }
}
.ai-think-chev {
  color: var(--text-tertiary);
  margin-left: auto;
  flex-shrink: 0;
}
/* 思考内容：markdown 样式（左竖线 + 等宽） */
.ai-think-body {
  overflow: hidden;
  transition: opacity 0.25s ease;
  /* 思考内容可能上千字，不要 max-height 截断（外层消息容器自带滚动） */
  max-height: none;
  opacity: 1;
  padding-top: 8px;
  padding-left: 4px;
}
.ai-think-body.collapsed {
  max-height: 0;
  opacity: 0;
  padding-top: 0;
}
.ai-think-md {
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.7;
  border-left: 2px solid var(--border-neutral-l1, var(--border-default));
  padding: 4px 0 4px 12px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  background: transparent;
}

/* ---- 工作流表格（demo wf 风格；UI-D 插入位 ③ 过渡实现）---- */
.ai-wf-table {
  border: 1px solid var(--border-neutral-l1, var(--border-default));
  border-radius: 10px;
  overflow: hidden;
  margin: 6px 0 14px;
}
.ai-wf-row {
  display: grid;
  grid-template-columns: 26px 1fr auto;
  gap: 12px;
  align-items: baseline;
  padding: 8px 13px;
  font-size: 13px;
  border-top: 1px solid var(--border-neutral-l1, var(--border-default));
  position: relative;
  transition: background 0.3s;
}
.ai-wf-row:first-child {
  border-top: 0;
}
.ai-wf-n {
  font-family: var(--font-family-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-tertiary);
  transition: color 0.3s;
}
.ai-wf-meta {
  font-family: var(--font-family-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-tertiary);
  text-align: right;
}
.ai-wf-bar {
  position: absolute;
  left: 13px;
  right: 13px;
  bottom: 0;
  height: 1px;
  background: var(--border-neutral-l1, var(--border-default));
  overflow: hidden;
}
.ai-wf-bar > i {
  display: block;
  height: 100%;
  width: 0;
  background: var(--text-secondary);
  transition: width 0.25s linear;
}
.ai-wf-row.active {
  background: var(--bg-base-secondary, var(--bg-hover));
}
.ai-wf-row.active .ai-wf-name {
  color: var(--text-default, var(--text-primary));
}
.ai-wf-row.active .ai-wf-n {
  color: var(--text-secondary);
}
.ai-wf-row.done .ai-wf-name {
  color: var(--text-secondary);
}
.ai-wf-row.done .ai-wf-bar > i {
  width: 100% !important;
}
.ai-wf-row.failed .ai-wf-name {
  color: var(--danger);
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
  .ai-think-title::after,
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
