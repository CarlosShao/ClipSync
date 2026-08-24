<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAiChatUi } from '@/composables/useAiChatUi'
import { approveAiChatTool } from '@/api/ai'
import { ShieldAlert, CheckCircle2, XCircle, Clock, X, Loader2 } from 'lucide-vue-next'

/**
 * AiConfirmCard — 工具确认门控卡片（UI-E，对接后端 Package C）。
 *
 * 数据源：useAiChatUi 确认状态机（confirmRequest/confirmPhase/confirmExpiresAt）。
 * SSE 事件由 AiChatPanel 侧转发到 useAiChatUi.feedConfirmMeta（见 AiChatPanel.vue 注释）。
 *
 * 状态机：
 *   pending（进行中，120s 倒计时，超时由 useAiChatUi 定时器自动转 timeout）
 *     ├─ 批准 → POST /api/ai/chat/approve {requestId, allow:true}  → approved
 *     ├─ 拒绝 → POST /api/ai/chat/approve {requestId, allow:false} → denied
 *     └─ 120s 无操作 → timeout
 *   终态（approved/denied/timeout）可手动关闭（dismissConfirm）；首个终态获胜。
 *   请求失败（后端未就绪 404 属预期）：卡片内显示错误 + 重试按钮，不崩组件、不 settle。
 *
 * Mock 测试方式（后端未就绪时，无需真实 SSE）：
 *   1. 临时在任意已挂载组件（如 AiChatPanel onMounted）或单测中执行：
 *      const { feedConfirmMeta } = useAiChatUi()
 *      feedConfirmMeta({
 *        type: 'confirm_tool_action',
 *        requestId: 'demo-1',
 *        tool: 'delete_clipboard_items',
 *        argsSummary: 'ids=[1,2,3]',
 *        impact: '将永久删除 3 条剪贴板记录',
 *      })
 *   2. 或直接 openConfirm({ requestId: 'demo-1', tool: '...', impact: '...' })。
 *   批准/拒绝会真实请求 /api/ai/chat/approve —— 404 为预期行为，用于验证错误态+重试。
 */
const { t } = useI18n()
const { confirmRequest, confirmPhase, confirmExpiresAt, settleConfirm, dismissConfirm } = useAiChatUi()

const isPending = computed(() => confirmPhase.value === 'pending')
const isSettled = computed(() => ['approved', 'denied', 'timeout'].includes(confirmPhase.value))

// ---- 提交（批准/拒绝）----
const submitting = ref(false)
const submitError = ref('')
/** 最近一次失败的 allow 值，重试按钮复用 */
const lastAllow = ref<boolean | null>(null)

async function submit(allow: boolean) {
  const req = confirmRequest.value
  if (!req || !isPending.value || submitting.value) return
  submitting.value = true
  submitError.value = ''
  lastAllow.value = allow
  try {
    const res = await approveAiChatTool({ requestId: req.requestId, allow })
    if (res.ok) {
      settleConfirm(allow ? 'approved' : 'denied')
    } else {
      // 后端未就绪（404）/网络失败：保持 pending 态展示错误，可重试
      submitError.value = res.error || `HTTP ${res.status}`
    }
  } finally {
    submitting.value = false
  }
}

// 新请求打开时清空上一轮的提交错误
watch(
  () => confirmRequest.value?.requestId,
  () => {
    submitError.value = ''
    lastAllow.value = null
  },
)

// ---- 120s 倒计时展示（超时判定本身在 useAiChatUi 定时器，这里只渲染剩余秒数）----
const remainingSec = ref(0)
let tickTimer: ReturnType<typeof setInterval> | null = null

function stopTick() {
  if (tickTimer !== null) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

watch(
  [isPending, confirmExpiresAt],
  ([pending, expiresAt]) => {
    stopTick()
    if (!pending || !expiresAt) {
      remainingSec.value = 0
      return
    }
    const update = () => {
      remainingSec.value = Math.max(0, Math.ceil((confirmExpiresAt.value! - Date.now()) / 1000))
    }
    update()
    tickTimer = setInterval(update, 1000)
  },
  { immediate: true },
)

onBeforeUnmount(stopTick)

// ---- 终态文案 ----
const settledIcon = computed(() => {
  if (confirmPhase.value === 'approved') return CheckCircle2
  if (confirmPhase.value === 'denied') return XCircle
  return Clock
})
const settledLabel = computed(() => {
  if (confirmPhase.value === 'approved') return t('ai_confirm_approved', '已批准')
  if (confirmPhase.value === 'denied') return t('ai_confirm_denied', '已拒绝')
  return t('ai_confirm_timeout', '已超时（120 秒未确认）')
})
</script>

<template>
  <div
    v-if="confirmRequest"
    class="ai-confirm"
    :class="`ai-confirm--${confirmPhase}`"
    role="alertdialog"
    aria-live="polite"
  >
    <!-- 头部：图标 + 标题 + 工具名 + 关闭（仅终态） -->
    <div class="ai-confirm-head">
      <ShieldAlert :size="16" class="ai-confirm-icon" />
      <span class="ai-confirm-title">{{ t('ai_confirm_title', '操作确认') }}</span>
      <span class="ai-confirm-tool">{{ confirmRequest.tool }}</span>
      <button v-if="isSettled" class="ai-confirm-close" :title="t('close_btn', '关闭')" @click="dismissConfirm()">
        <X :size="14" />
      </button>
    </div>

    <!-- 详情：参数摘要 / 影响说明 / 请求 ID -->
    <div class="ai-confirm-body">
      <div v-if="confirmRequest.argsSummary" class="ai-confirm-row">
        <span class="ai-confirm-label">{{ t('ai_confirm_args', '参数') }}</span>
        <code class="ai-confirm-code">{{ confirmRequest.argsSummary }}</code>
      </div>
      <div v-if="confirmRequest.impact" class="ai-confirm-row">
        <span class="ai-confirm-label">{{ t('ai_confirm_impact', '影响') }}</span>
        <span class="ai-confirm-impact">{{ confirmRequest.impact }}</span>
      </div>
      <div class="ai-confirm-row">
        <span class="ai-confirm-label">{{ t('ai_confirm_request_id', '请求') }}</span>
        <code class="ai-confirm-id">{{ confirmRequest.requestId }}</code>
      </div>
    </div>

    <!-- 提交错误（后端未就绪 404 属预期）：可重试 -->
    <div v-if="submitError" class="ai-confirm-error">
      <span class="ai-confirm-error-text">{{ t('ai_confirm_submit_error', '提交失败') }}：{{ submitError }}</span>
      <button class="ai-confirm-retry" :disabled="submitting" @click="lastAllow !== null && submit(lastAllow)">
        {{ t('ai_confirm_retry', '重试') }}
      </button>
    </div>

    <!-- 进行中：倒计时 + 批准/拒绝 -->
    <div v-if="isPending" class="ai-confirm-actions">
      <span class="ai-confirm-countdown" :class="{ 'ai-confirm-countdown--urgent': remainingSec <= 15 }">
        {{ t('ai_confirm_expires_in', { s: remainingSec }) || `${remainingSec}s` }}
      </span>
      <button class="ai-confirm-btn ai-confirm-btn--deny" :disabled="submitting" @click="submit(false)">
        <Loader2 v-if="submitting && lastAllow === false" :size="13" class="ai-confirm-spin" />
        {{ t('ai_confirm_deny', '拒绝') }}
      </button>
      <button class="ai-confirm-btn ai-confirm-btn--approve" :disabled="submitting" @click="submit(true)">
        <Loader2 v-if="submitting && lastAllow === true" :size="13" class="ai-confirm-spin" />
        {{ t('ai_confirm_approve', '批准') }}
      </button>
    </div>

    <!-- 终态：结果横幅 -->
    <div v-else-if="isSettled" class="ai-confirm-settled" :class="`ai-confirm-settled--${confirmPhase}`">
      <component :is="settledIcon" :size="14" />
      <span>{{ settledLabel }}</span>
    </div>
  </div>
</template>

<style scoped>
.ai-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warning) 6%, var(--bg-surface));
  animation: ai-confirm-in 0.18s ease-out;
  flex-shrink: 0;
}
.ai-confirm--approved {
  border-color: color-mix(in srgb, var(--success) 45%, transparent);
  background: color-mix(in srgb, var(--success) 5%, var(--bg-surface));
}
.ai-confirm--denied {
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  background: color-mix(in srgb, var(--danger) 5%, var(--bg-surface));
}
.ai-confirm--timeout {
  border-color: color-mix(in srgb, var(--warning) 45%, transparent);
}

@keyframes ai-confirm-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.ai-confirm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.ai-confirm-icon {
  flex-shrink: 0;
  color: var(--warning);
}
.ai-confirm--approved .ai-confirm-icon {
  color: var(--success);
}
.ai-confirm--denied .ai-confirm-icon {
  color: var(--danger);
}
.ai-confirm-title {
  flex-shrink: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
}
.ai-confirm-tool {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: var(--text-2xs);
  font-family: ui-monospace, monospace;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 12%, transparent);
}
.ai-confirm-close {
  margin-left: auto;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    color 0.12s,
    background-color 0.12s;
}
.ai-confirm-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.ai-confirm-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ai-confirm-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.ai-confirm-label {
  flex-shrink: 0;
  width: 3em;
  font-size: var(--text-2xs);
  color: var(--text-tertiary);
}
.ai-confirm-code,
.ai-confirm-id {
  margin: 0;
  min-width: 0;
  font-size: var(--text-xs);
  font-family: ui-monospace, monospace;
  color: var(--text-secondary);
  word-break: break-all;
}
.ai-confirm-id {
  opacity: 0.75;
}
.ai-confirm-impact {
  min-width: 0;
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--text-primary);
  word-break: break-word;
}

.ai-confirm-error {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-xs);
  color: var(--danger);
}
.ai-confirm-error-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.ai-confirm-retry {
  flex-shrink: 0;
  padding: 2px 10px;
  border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--danger);
  font-size: var(--text-xs);
  cursor: pointer;
  transition: background-color 0.12s;
}
.ai-confirm-retry:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}
.ai-confirm-retry:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ai-confirm-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ai-confirm-countdown {
  margin-right: auto;
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-tertiary);
}
.ai-confirm-countdown--urgent {
  color: var(--danger);
}
.ai-confirm-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  transition:
    opacity 0.12s,
    transform 0.12s;
}
.ai-confirm-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ai-confirm-btn:not(:disabled):active {
  transform: scale(0.97);
}
.ai-confirm-btn--approve {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 45%, transparent);
  background: color-mix(in srgb, var(--success) 10%, transparent);
}
.ai-confirm-btn--deny {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  background: transparent;
}
.ai-confirm-spin {
  animation: ai-confirm-spin 0.8s linear infinite;
}
@keyframes ai-confirm-spin {
  to {
    transform: rotate(360deg);
  }
}

.ai-confirm-settled {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  font-weight: 500;
}
.ai-confirm-settled--approved {
  color: var(--success);
}
.ai-confirm-settled--denied {
  color: var(--danger);
}
.ai-confirm-settled--timeout {
  color: var(--warning);
}

@media (prefers-reduced-motion: reduce) {
  .ai-confirm {
    animation: none;
  }
  .ai-confirm-spin {
    animation-duration: 2.4s;
  }
}

/* 键盘可达性：focus-visible 高亮（--accent token） */
.ai-confirm-close:focus-visible,
.ai-confirm-retry:focus-visible,
.ai-confirm-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
