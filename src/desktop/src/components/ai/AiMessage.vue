<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, type Component } from 'vue'
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
const isStreamingNow = computed(() => props.isStreaming)

// 思考折叠状态管理：支持多段各自独立展开/折叠
const expandedSegments = ref<Record<number, boolean>>({})
function toggleThinking(index: number) {
  expandedSegments.value[index] = !isThinkingExpanded(index)
}
function isThinkingExpanded(index: number): boolean {
  if (expandedSegments.value[index] !== undefined) {
    return expandedSegments.value[index]
  }
  // 默认收起：直播中的思考以头部单行跑马灯展示（占位一行、体感飞速输出），
  // 点击头部才展开全文正文。若沿用"直播默认展开"，长思考会把消息撑得过长。
  return false
}

// 字段存在性
const hasAgentRuns = computed(() => (props.message.agentRuns?.length || 0) > 0)
const hasToolCalls = computed(
  () => (props.message.toolCalls?.length || 0) > 0 || (props.message.toolResults?.length || 0) > 0,
)
const hasThinking = computed(() => (props.message.thinking?.length || 0) > 0)
// 多轮思考分段（工具调用前后的思考各自成段）；无分段时退化为 [全量] 单段
const thinkingSegments = computed(() => {
  const segs = props.message.thinkingSegments
  if (segs && segs.length > 0) return segs
  const t = props.message.thinking
  return t ? [{ text: t, startedAt: props.message.thinkingStartedAt }] : []
})
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
// 判断当前是否正有活跃思考段在流式输出（包含多轮思考的最新段）
const hasLiveThinkingSegment = computed(() => {
  if (!isStreamingNow.value) return false
  if (props.message.thinkingActive === false) return false
  const segs = props.message.thinkingSegments
  if (segs && segs.length > 0) {
    const last = segs[segs.length - 1]
    return last?.isLive !== false
  }
  return isThinkingPhase.value
})

// 子代理详情抽屉（UI-D：AiAgentCards 点击卡片 → 此处打开 AiAgentDrawer）
const agentDrawerRun = ref<AgentRun | null>(null)

// ===== 过程折叠（UI-C 统一结构）=====
// 流式中：默认展开过程；流式结束后：自动折叠过程，显示分割线，只展示总结
// 用户也可以手动展开/折叠
const userCollapsed = ref(false)

// ===== 任务总耗时计时 =====
const taskStartedAt = ref<number | null>(null)
const taskDurationMs = ref(0)
let taskTimer: number | null = null

function startTaskTimer() {
  stopTaskTimer()
  taskStartedAt.value = Date.now()
  taskDurationMs.value = 0
  taskTimer = window.setInterval(() => {
    if (taskStartedAt.value) {
      taskDurationMs.value = Date.now() - taskStartedAt.value
    }
  }, 200)
}

function stopTaskTimer() {
  if (taskTimer !== null) {
    window.clearInterval(taskTimer)
    taskTimer = null
  }
}

watch(isStreamingNow, (now, wasStreaming) => {
  if (now) {
    // 开始流式：展开过程，启动计时
    expandedSegments.value = {}
    userCollapsed.value = false
    startTaskTimer()
  } else if (wasStreaming) {
    // 流式结束：自动折叠过程，停止计时
    stopTaskTimer()
    if (taskStartedAt.value) {
      taskDurationMs.value = Date.now() - taskStartedAt.value
    }
    // ask_user 交互卡片仍等待作答时绝不自动折叠，保持过程流中的卡片展开可见
    if (!pendingAskUser.value) {
      userCollapsed.value = true
    }
  }
})

onMounted(() => {
  if (isStreamingNow.value) {
    startTaskTimer()
  }
})

// 格式化耗时显示：3m 59s 或 1h 5m 23s
const taskDurationText = computed(() => {
  let ms = taskDurationMs.value
  // 如果当前组件未在流式中记录到耗时（如历史消息重载或流式结束立即挂载），回退到思考耗时
  if (ms <= 0 && thinkingSecs.value > 0) {
    ms = thinkingSecs.value * 1000
  }
  if (ms <= 0) return ''
  const totalSec = Math.floor(ms / 1000)
  if (totalSec <= 0) return '1s'
  const hours = Math.floor(totalSec / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
})

// 组件卸载时清理计时器
onUnmounted(() => {
  stopTaskTimer()
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

// 多段思考与工具调用匹配：返回紧随思考段 si 执行的工具调用列表
function getToolsForSegment(si: number) {
  if (!visibleToolCalls.value.length) return []
  // 单段思考或无分段：所有工具关联到第 0 段
  if (thinkingSegments.value.length <= 1) {
    return si === 0 ? visibleToolCalls.value : []
  }
  // 多段思考：按 segIndex 精确匹配属于该思考段紧随其后执行的工具
  const matched = visibleToolCalls.value.filter((tc: any) => tc.segIndex === si)
  if (matched.length > 0) return matched

  // 兜底逻辑：如果所有 toolCalls 都没有 segIndex（如历史旧数据），挂在第 0 段
  const hasAnySegIndex = visibleToolCalls.value.some((tc: any) => typeof tc.segIndex === 'number')
  if (!hasAnySegIndex && si === 0) {
    return visibleToolCalls.value
  }
  return []
}

// 交互式提问卡片（ask_user）：内嵌渲染在 AiToolTimeline 过程流中调用发生的位置，
// 这里仅跟踪其"待作答"状态，供过程面板自动折叠豁免使用
const askUserStep = computed(() => {
  const calls = visibleToolCalls.value || []
  return calls.find((tc) => tc.name === 'ask_user') || null
})
// 待作答 = 存在 ask_user 调用且尚未收到对应 tool_result
const pendingAskUser = computed(() => {
  const s = askUserStep.value
  if (!s) return false
  return !props.message.toolResults?.some((tr) => tr.tool_call_id === s.id)
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
        <!-- ===== 过程区域（折叠/展开） ===== -->
        <template v-if="hasProcess">
          <!-- 折叠态：过程统计 chips 行（含任务总耗时） -->
          <AiProcessChips
            v-if="userCollapsed && !isStreamingNow"
            :message="message"
            :thinking-secs="thinkingSecs"
            :task-duration-text="taskDurationText"
            @toggle="userCollapsed = false"
          />

          <!-- 展开态：按状态机依次渲染 -->
          <template v-else>
            <!-- 展开态收起入口：流式结束后出现（ask_user 待作答时不显示，避免误折叠藏起卡片） -->
            <button
              v-if="!isStreamingNow && !pendingAskUser"
              type="button"
              class="ai-process-collapse-btn"
              @click="userCollapsed = true"
            >
              <ChevronDown :size="12" />
              <span>{{ t('ai_process_collapse', '收起过程') }}</span>
            </button>

            <!-- 思考过程与工具时间线：按执行轮次时序交替渲染 -->
            <template v-if="thinkingSegments.length > 0">
              <template v-for="(seg, si) in thinkingSegments" :key="`think-${si}-${seg.id || ''}`">
                <AiThinkingCollapse
                  v-if="isLoading || hasThinking"
                  :thinking="seg.text"
                  :thinking-started-at="seg.startedAt ?? message.thinkingStartedAt"
                  :is-streaming="isStreamingNow && (seg.isLive ?? (isThinkingPhase && si === thinkingSegments.length - 1))"
                  :expanded="isThinkingExpanded(si)"
                  @toggle="toggleThinking(si)"
                />
                <!-- 该思考段紧随其后执行的工具调用 -->
                <AiToolTimeline
                  v-if="getToolsForSegment(si).length"
                  :tool-calls="getToolsForSegment(si)"
                  :tool-results="message.toolResults"
                  :confirm-tool="confirmTool ?? null"
                />
                <!-- 多段思考：段间插入细分隔线，避免两段粘连 -->
                <div v-if="thinkingSegments.length > 1 && si < thinkingSegments.length - 1" class="ai-think-seg-gap"></div>
              </template>
            </template>

            <!-- 无思考段时的纯工具调用（兜底） -->
            <template v-else-if="visibleToolCalls.length">
              <AiToolTimeline
                :tool-calls="visibleToolCalls"
                :tool-results="message.toolResults"
                :confirm-tool="confirmTool ?? null"
              />
            </template>

            <!-- 子代理 -->
            <AiAgentCards
              v-if="visibleAgentRuns.length"
              :runs="visibleAgentRuns"
              @open="agentDrawerRun = $event"
            />
          </template>

          <!-- 子代理详情抽屉 -->
          <AiAgentDrawer
            v-if="agentDrawerRun"
            :run="agentDrawerRun"
            :is-streaming="isStreamingNow"
            @close="agentDrawerRun = null"
          />

          <!-- 分割线：过程与总结之间 -->
          <div v-if="hasContent && !isStreamingNow" class="ai-process-divider">
            <span class="ai-divider-line"></span>
          </div>
        </template>

        <!-- ===== 总结内容 ===== -->
        <div v-if="hasContent && (!isStreamingNow || !hasLiveThinkingSegment)" class="ai-msg-content markdown-body">
          <AiStreamText :text="streamingContent" :done="!isStreamingNow" />
          <span v-if="isStreamingNow && !hasToolCalls" class="ai-stream-caret"></span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ============ 消息容器 ============ */
.ai-msg {
  display: flex;
  position: relative;
  margin: 1px 0;
}
.ai-msg.user {
  justify-content: flex-end;
}
.ai-msg.assistant {
  justify-content: flex-start;
}
.ai-msg.system {
  justify-content: center;
  margin: 2px 0;
}

/* ============ 气泡 ============ */
.ai-msg-bubble {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 96%;
  min-width: 0;
  padding: 4px 8px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.55;
  gap: 3px;
}
.ai-msg.user .ai-msg-bubble {
  background: var(--accent);
  color: var(--accent-foreground, rgb(255 255 255));
  border-bottom-right-radius: 3px;
}
.ai-msg.assistant .ai-msg-bubble {
  background: transparent;
  color: var(--text-default, var(--text-primary));
  padding: 0;
  gap: 2px;
  width: 100%;
}

/* ============ 用户消息 ============ */
.ai-msg-user-body {
  position: relative;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ai-msg-actions--user {
  position: absolute;
  right: 0;
  bottom: -2px;
  display: none;
  gap: 4px;
  padding: 2px;
  border-radius: 5px;
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
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
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

/* ============ 过程折叠（行内 flow 风格） ============ */
.ai-process-collapse-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  align-self: flex-start;
  padding: 1px 2px;
  border: none;
  border-radius: 3px;
  background: transparent;
  font-size: 10.5px;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.1s ease;
}
.ai-process-collapse-btn:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

/* ============ 过程与总结分割线 ============ */
.ai-process-divider {
  display: flex;
  align-items: center;
  margin: 4px 0;
  gap: 8px;
}

.ai-divider-line {
  flex: 1;
  height: 1px;
  background: var(--border-subtle, var(--border-default));
  opacity: 0.5;
}

/* ============ 主要内容 ============ */
.ai-msg-content {
  white-space: normal;
  word-break: break-word;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.6;
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
