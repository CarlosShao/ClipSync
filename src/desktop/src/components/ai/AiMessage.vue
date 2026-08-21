<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { Marked } from 'marked'
import { sanitizeHtml } from '@/utils/html'
import { ChevronRight, ChevronDown, Copy, Pencil, ListChecks, Languages, AlignLeft, HelpCircle, Sparkles, CheckCircle2, Loader2, XCircle, Bot } from 'lucide-vue-next'
import type { ChatMessage, AgentRun } from '@/api/ai'
import AiWaiting from './AiWaiting.vue'
import AiThinkingOrb from './AiThinkingOrb.vue'

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

// 字段存在性
const hasAgentRuns = computed(() => (props.message.agentRuns?.length || 0) > 0)
const hasToolCalls = computed(() => (props.message.toolCalls?.length || 0) > 0)
const hasThinking = computed(() => (props.message.thinking?.length || 0) > 0)
const hasContent = computed(() => (props.message.content?.length || 0) > 0)
const hasProcess = computed(() => hasThinking.value || hasToolCalls.value || hasAgentRuns.value)

// ===== 消息生命周期状态机（assistant 消息）=====
// 注意：thinkingActive===false 表示工具已开始调用 → 思考阶段已结束
// 1. 加载态：流式刚开始，助手消息还没收到任何数据
const isLoading = computed(() => isStreamingNow.value && !hasThinking.value && !hasContent.value && !hasToolCalls.value)
// 2. 思考进行中：收到思考 token，且思考阶段尚未结束
const isThinkingPhase = computed(() => isStreamingNow.value && hasThinking.value && props.message.thinkingActive !== false)
// 3. 思考已结束，正在处理（出答案 / 跑工具）但流式未结束
const isProcessing = computed(() => isStreamingNow.value && !isThinkingPhase.value && (hasContent.value || hasToolCalls.value || hasThinking.value))
// 4. 任务完成（流关闭 + 有答案）
const isFinished = computed(() => !isStreamingNow.value && hasContent.value)

// 思考已完成（非流式 或 思考阶段已结束）：orb → breathing、shimmer 停
const thinkingDone = computed(() => hasThinking.value && !isThinkingPhase.value)

function runActive(run: AgentRun): boolean {
  return run.status === 'planning' || run.status === 'working' || run.status === 'synthesis'
}

// 折叠逻辑：所有消息默认展开（process 相关组件就是给用户看的）
// 折叠条只在用户主动点击 collapse 后才出现；不再根据 index 强制折叠
collapsed.value = false
const userCollapsed = ref(false) // 用户主动折叠的标记
watch(isStreamingNow, (now) => {
  if (now) {
    // 流式开始 → 自动展开并清掉用户折叠
    expandedThinking.value = false
    userCollapsed.value = false
  }
})

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

// 工具调用状态：每个工具调用是否已收到结果
function toolDone(toolId: string): boolean {
  if (!isStreamingNow.value) return true // 流结束 → 全部完成
  return (props.message.toolResults || []).some((r) => r.tool_call_id === toolId)
}
function toolIcon(toolId: string) {
  return toolDone(toolId) ? CheckCircle2 : Loader2
}

// 工具 orb 状态：按工具名关键字映射（skill 第十一章状态表）
const TOOL_ORB_STATE: Array<[RegExp, string]> = [
  [/search|query|find|lookup|检索|搜索|查/i, 'searching'],
  [/connect|api|http|fetch|get_|post_|request|调用|请求/i, 'connecting'],
  [/solve|calc|compute|分析|计算|解析/i, 'solving'],
  [/dedup|merge|group|聚合|合并|去重/i, 'weaving'],
  [/write|create|insert|save|写入|创建|生成|新增/i, 'composing'],
  [/plan|architect|拆解|规划|架构|设计/i, 'shaping'],
]
function toolOrbState(name: string): string {
  const key = name || ''
  for (const [re, st] of TOOL_ORB_STATE) {
    if (re.test(key)) return st
  }
  return 'working'
}
// 工具是否失败：流结束后无该工具结果则视为失败（由父级传入，这里用 toolResults 兜底）
function toolFailed(toolId: string): boolean {
  if (isStreamingNow.value) return false
  const calls = props.message.toolCalls || []
  const results = props.message.toolResults || []
  // 若流已结束且该工具无对应结果 → 失败
  return calls.some((c) => c.id === toolId) && !results.some((r) => r.tool_call_id === toolId)
}

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

// 思考面板标题：进行中「深度思考」 vs 完成「深度思考 · Ns」
const thinkingPanelTitle = computed(() => {
  if (thinkingSecs.value > 0) return `深度思考 · ${thinkingSecs.value}s`
  return '深度思考'
})

// 折叠标签
const collapsedLabel = computed(() => {
  if (isFinished.value) return '处理完成'
  if (thinkingSecs.value > 0) return `思考 ${thinkingSecs.value}s`
  if (isProcessing.value) return '处理中'
  return '查看思考过程'
})
// 折叠条里各步骤的摘要
const processSummary = computed(() => {
  const parts: string[] = []
  if (thinkingSecs.value > 0) parts.push(`思考 ${thinkingSecs.value}s`)
  if (hasToolCalls.value) parts.push(`${visibleToolCalls.value.length} 个工具`)
  if (hasAgentRuns.value) parts.push(`${visibleAgentRuns.value.length} 个代理`)
  return parts.join(' · ')
})

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

// 工具调用 arguments 字段是 JSON 字符串，解析为对象以便展示
function parseToolArgs(raw: string): Record<string, any> {
  if (!raw) return {}
  try {
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : { value: String(obj) }
  } catch {
    return { raw }
  }
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

    <!-- 助手消息 - 按状态机渲染组件（对齐 demo agent-ui-clipsync.html） -->
    <template v-else>
      <div class="ai-msg-bubble">

        <!-- 折叠态：仅在用户主动折叠 + 有处理过程 + 非流式时显示 -->
        <div v-if="userCollapsed && hasProcess && !isStreamingNow" class="ai-process-collapsed" @click="userCollapsed = false">
          <span class="ai-process-collapsed-label">{{ collapsedLabel }}</span>
          <span v-if="processSummary" class="ai-process-chip">{{ processSummary }}</span>
          <ChevronRight :size="13" class="ai-process-collapsed-chev" />
        </div>

        <!-- 展开态：按状态机依次渲染 -->
        <template v-else>

          <!-- 状态 1：等待加载（首字前）—— AiWaiting：orb + 「正在思考中」shimmer -->
          <AiWaiting v-if="isLoading" class="ai-waiting-block" />

          <!-- 状态 2：深度思考面板（左 orb + 标题 + markdown 思考过程） -->
          <div v-if="hasThinking" class="ai-think-panel">
            <div class="ai-think-head" @click="expandedThinking = !expandedThinking">
              <AiThinkingOrb
                class="ai-think-orb"
                :state="isThinkingPhase ? 'composing' : 'breathing'"
                :size="24"
              />
              <span
                class="ai-think-title"
                :class="{ paused: thinkingDone }"
                :data-text="thinkingPanelTitle"
              >{{ thinkingPanelTitle }}</span>
              <ChevronRight v-if="!expandedThinking" :size="13" class="ai-think-chev" />
              <ChevronDown v-else :size="13" class="ai-think-chev" />
            </div>
            <div class="ai-think-body" :class="{ collapsed: !expandedThinking }">
              <pre class="ai-think-md">{{ message.thinking }}</pre>
            </div>
          </div>

          <!-- 状态 3：工具调用（左 orb 按工具类型 + 状态标签三态） -->
          <template v-if="!isThinkingPhase">
            <div v-for="(tc, i) in visibleToolCalls" :key="`tc-${i}`" class="ai-tool-card" :class="{ 'ai-tool-card--done': toolDone(tc.id), 'ai-tool-card--err': toolFailed(tc.id) }">
              <div class="ai-tool-inner">
                <div class="ai-tool-row">
                  <AiThinkingOrb
                    class="ai-tool-orb"
                    :state="toolDone(tc.id) ? 'breathing' : (toolOrbState(tc.name) as any)"
                    :size="18"
                  />
                  <span class="ai-tool-name">{{ tc.name }}</span>
                  <span
                    class="ai-tool-st"
                    :class="toolFailed(tc.id) ? 'err' : (toolDone(tc.id) ? 'ok' : 'running')"
                  >
                    <span v-if="!toolDone(tc.id) && !toolFailed(tc.id)" class="ai-tool-spin"></span>
                    {{ toolFailed(tc.id) ? '失败 ✕' : (toolDone(tc.id) ? '✓ 成功' : '运行中') }}
                  </span>
                </div>
                <div v-if="tc.arguments" class="ai-tool-args">
                  <div v-for="(val, key) in parseToolArgs(tc.arguments)" :key="key" class="ai-tool-arg">
                    <span class="ai-tool-k">{{ key }}:</span>
                    <span class="ai-tool-v">{{ val }}</span>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- 状态 3：子代理 / 工作流步骤（思考阶段结束后才显示） -->
          <div v-if="!isThinkingPhase && visibleAgentRuns.length" class="ai-wf-table">
            <div v-for="(run, i) in visibleAgentRuns" :key="run.id"
                 class="ai-wf-row" :class="{ active: runActive(run), done: run.status === 'done', failed: run.status === 'failed' }">
              <span class="ai-wf-n">{{ String(i + 1).padStart(2, '0') }}</span>
              <span class="ai-wf-name">
                <component :is="runIcon(run)" :size="12" class="ai-wf-icon" :class="{ 'ai-wf-spin': runActive(run) }" />
                {{ run.name }}
              </span>
              <span class="ai-wf-meta">{{ run.duration ? formatDuration(run.duration) : (runActive(run) ? 'running' : run.status) }}</span>
              <div class="ai-wf-bar"><i :style="{ width: run.status === 'done' ? '100%' : (runActive(run) ? '60%' : '0%') }"></i></div>
            </div>
          </div>

          <!-- 主要内容输出（答案区） -->
          <div v-if="hasContent || (isStreamingNow && hasContent)" class="ai-msg-content markdown-body">
            <span v-html="renderMarkdown(streamingContent)"></span>
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
  color: var(--accent-foreground, #fff);
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
  bottom: -2px;
  display: none;
  gap: 4px;
  padding: 2px;
  border-radius: 8px;
  background: var(--bg-base-default, #fff);
  border: 1px solid var(--border-neutral-l1, rgba(115,115,115,0.12));
  z-index: 5;
  transition: opacity 0.15s ease;
}
.ai-msg.user:hover .ai-msg-actions--user {
  display: inline-flex;
}
.ai-msg.user .ai-msg-user-body { padding-bottom: 0; }
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
  color: var(--accent);
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

/* 用户主动折叠按钮（展开时显示） */
.ai-collapse-btn {
  font-size: 11px;
  color: var(--text-secondary, #404040);
  cursor: pointer;
  margin-top: 6px;
  padding: 4px 0;
  display: inline-block;
  transition: color .15s;
}
.ai-collapse-btn:hover { color: var(--text-default, #171717); }

/* ================================================================
   agent-workflow-ui skill 基准（对齐 demo agent-workflow-demo）
   - waiting: AiWaiting（orb + 「正在思考中」字内 shimmer）
   - think-panel: 左 orb + 「深度思考」标题 shimmer + markdown 思考过程
   - tool-card: 左 orb（按工具类型）+ 状态标签三态
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
  color: var(--text-secondary, #404040);
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
  0% { background-position: 100% 0; }
  100% { background-position: -20% 0; }
}
.ai-think-chev {
  color: var(--text-tertiary, #737373);
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
  color: var(--text-secondary, #404040);
  line-height: 1.7;
  border-left: 2px solid var(--border-neutral-l1, rgba(115,115,115,0.25));
  padding: 4px 0 4px 12px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  background: transparent;
}

/* ---- 工具调用卡片（左 orb + 状态标签三态）---- */
.ai-tool-card {
  margin: 4px 0;
  font-size: 12px;
  color: var(--text-secondary, #404040);
  background: var(--bg-base-secondary, #f9fafb);
  border: 1px solid var(--border-neutral-l1, rgba(115,115,115,0.16));
  border-radius: 8px;
  overflow: hidden;
  transition: border-color 0.2s;
}
.ai-tool-card--done { border-left: 2px solid rgba(0,185,131,0.5); }
.ai-tool-card--err { border-color: rgba(255,107,69,0.6); border-left: 2px solid rgba(255,107,69,0.6); }
.ai-tool-inner { padding: 8px 11px; }
.ai-tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ai-tool-orb {
  flex-shrink: 0;
  display: block;
}
.ai-tool-name {
  font-weight: 600;
  color: var(--text-default, #171717);
}
.ai-tool-st {
  margin-left: auto;
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 500;
  transition: background 0.2s, color 0.2s;
}
.ai-tool-st.running { color: var(--accent, #3b82f6); background: var(--accent-bg, rgba(59,130,246,.12)); }
.ai-tool-st.ok { color: #00B983; background: rgba(0,185,131,.1); }
.ai-tool-st.err { color: #FF6B45; background: rgba(255,107,69,.1); }
.ai-tool-spin {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  animation: ai-tool-spin .7s linear infinite;
}
@keyframes ai-tool-spin { to { transform: rotate(360deg); } }
.ai-tool-args { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.ai-tool-arg { display: flex; gap: 6px; font-family: var(--font-family-mono, ui-monospace, monospace); }
.ai-tool-k { color: var(--text-tertiary, #737373); }
.ai-tool-v { color: var(--text-default, #171717); word-break: break-all; }

/* ---- 工作流表格（demo wf 风格）---- */
.ai-wf-table {
  border: 1px solid var(--border-neutral-l1, rgba(115,115,115,0.18));
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
  border-top: 1px solid var(--border-neutral-l1, rgba(115,115,115,0.10));
  position: relative;
  transition: background .3s;
}
.ai-wf-row:first-child { border-top: 0; }
.ai-wf-n {
  font-family: var(--font-family-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-tertiary, #737373);
  transition: color .3s;
}
.ai-think-done-icon { color: var(--text-secondary, #475569); flex-shrink: 0; }
.ai-wf-meta {
  font-family: var(--font-family-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-tertiary, #737373);
  text-align: right;
}
.ai-wf-bar {
  position: absolute;
  left: 13px; right: 13px; bottom: 0;
  height: 1px;
  background: var(--border-neutral-l1, rgba(115,115,115,0.20));
  overflow: hidden;
}
.ai-wf-bar > i {
  display: block;
  height: 100%;
  width: 0;
  background: var(--text-secondary, #404040);
  transition: width .25s linear;
}
.ai-wf-row.active { background: var(--bg-base-secondary, #f9fafb); }
.ai-wf-row.active .ai-wf-name { color: var(--text-default, #171717); }
.ai-wf-row.active .ai-wf-n { color: var(--text-secondary, #404040); }
.ai-wf-row.done .ai-wf-name { color: var(--text-secondary, #404040); }
.ai-wf-row.done .ai-wf-bar > i { width: 100% !important; }
.ai-wf-row.failed .ai-wf-name { color: #FF6B45; }

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
  color: var(--accent);
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
.ai-msg-content :deep(a) { color: var(--accent); }
.ai-msg-content :deep(blockquote) {
  border-left: 3px solid var(--accent);
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

/* 流式光标：中性灰 */
.ai-stream-caret {
  display: inline-block;
  width: 2px;
  height: 1.2em;
  margin-left: 1px;
  vertical-align: text-bottom;
  background: var(--text-secondary, #404040);
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
.ai-msg-system-card--compact_loading { border-left: 3px solid var(--accent); }
.ai-msg-system-card--compact_success { border-left: 3px solid #00B983; }
.ai-msg-system-card--compact_too_short { border-left: 3px solid var(--text-tertiary, #737373); }
.ai-msg-system-card--compact_failed { border-left: 3px solid #FF6B45; }
.ai-msg-system-card--quick-action {
  border-left: 3px solid var(--accent);
  background: var(--bg-overlay-l1, rgba(115,115,115,0.08));
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.ai-msg-system-icon { display: inline-block; margin-right: 6px; font-weight: 600; }
.ai-msg-system-icon-svg { width: 14px; height: 14px; color: var(--accent); flex-shrink: 0; }

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
