<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAiChatUi } from '@/composables/useAiChatUi'
import { approveAiChatTool } from '@/api/ai'
import { ShieldAlert, ShieldCheck, CheckCircle2, XCircle, Clock, X, Loader2, AlertTriangle, ChevronDown, Check } from 'lucide-vue-next'

/**
 * AiConfirmCard — 工具确认门控气泡卡片（内嵌式，参考 Trae 权限请求框 UI）。
 *
 * 数据源：useAiChatUi 确认状态机（confirmRequest/confirmPhase/confirmExpiresAt）。
 *
 * 状态机：
 *   pending → approve(POST /api/ai/chat/approve {requestId, allow:true}) → approved
 *           → deny   (POST /api/ai/chat/approve {requestId, allow:false}) → denied
 *           → 120s 超时 → timeout
 * 终态手动关闭：dismissConfirm()。
 */
const { t } = useI18n()
const { confirmRequest, confirmPhase, confirmExpiresAt, settleConfirm, dismissConfirm } = useAiChatUi()

const isPending = computed(() => confirmPhase.value === 'pending')
const isSettled = computed(() => ['approved', 'denied', 'timeout'].includes(confirmPhase.value))

const submitting = ref(false)
const submitError = ref('')
const lastAllow = ref<boolean | null>(null)
const showConfirmMenu = ref(false)

function closeConfirmMenu(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target?.closest('.cfm-pop__allow-wrap')) {
    showConfirmMenu.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', closeConfirmMenu)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', closeConfirmMenu)
})

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
      submitError.value = res.error || `HTTP ${res.status}`
    }
  } finally {
    submitting.value = false
  }
}

watch(
  () => confirmRequest.value?.requestId,
  () => {
    submitError.value = ''
    lastAllow.value = null
    showConfirmMenu.value = false
  },
)

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

const isDestructive = computed(() => {
  const tool = confirmRequest.value?.tool?.toLowerCase() || ''
  return tool.includes('delete') || tool.includes('destroy') || tool.includes('remove') || tool.includes('drop')
})
</script>

<template>
  <Transition name="cfm-pop">
    <div
      v-if="confirmRequest"
      class="cfm-pop"
      :class="`cfm-pop--${confirmPhase}`"
      role="alertdialog"
      aria-live="assertive"
    >
      <!-- 气泡箭头（指向消息区） -->
      <div class="cfm-pop__arrow" aria-hidden="true"></div>

      <!-- 头部标题行 -->
      <div class="cfm-pop__head">
        <div class="cfm-pop__title-row">
          <span
            class="cfm-pop__icon"
            :class="{ 'cfm-pop__icon--danger': isDestructive }"
          >
            <ShieldAlert :size="14" />
          </span>
          <span class="cfm-pop__title">
            {{ t('ai_confirm_perm_title', '权限请求') }}：
            <code class="cfm-pop__tool-code">{{ confirmRequest.tool }}</code>
          </span>
          <span v-if="isDestructive && isPending" class="cfm-pop__danger-tag">
            {{ t('ai_confirm_destructive') || '破坏性' }}
          </span>
          <button v-if="isSettled" class="cfm-pop__close" :title="t('close_btn', '关闭')" @click="dismissConfirm()">
            <X :size="12" />
          </button>
        </div>
      </div>

      <!-- 参数 -->
      <div v-if="confirmRequest.argsSummary" class="cfm-pop__cmd">
        {{ confirmRequest.argsSummary }}
      </div>

      <!-- 影响说明 -->
      <div v-if="confirmRequest.impact" class="cfm-pop__impact">
        <AlertTriangle :size="11" class="cfm-pop__impact-icon" />
        <span>{{ confirmRequest.impact }}</span>
      </div>

      <!-- 提交错误 -->
      <div v-if="submitError" class="cfm-pop__error">
        <span class="cfm-pop__error-text">{{ t('ai_confirm_submit_error', '提交失败') }}：{{ submitError }}</span>
        <button class="cfm-pop__retry" :disabled="submitting" @click="lastAllow !== null && submit(lastAllow)">
          {{ t('ai_confirm_retry', '重试') }}
        </button>
      </div>

      <!-- 倒计时（次要信息） -->
      <div v-if="isPending" class="cfm-pop__meta">
        <span class="cfm-pop__countdown" :class="{ 'cfm-pop__countdown--urgent': remainingSec <= 15 }">
          <Clock :size="11" />
          {{ remainingSec }}s
        </span>
        <span class="cfm-pop__req-id">
          #{{ confirmRequest.requestId.slice(0, 8) }}
        </span>
      </div>

      <!-- 进行中：按钮行 -->
      <div v-if="isPending" class="cfm-pop__actions">
        <button
          class="cfm-pop__btn cfm-pop__btn--deny"
          :disabled="submitting"
          @click="submit(false)"
        >
          <Loader2 v-if="submitting && lastAllow === false" :size="13" class="cfm-pop__spin" />
          <XCircle v-else :size="13" />
          {{ t('ai_confirm_deny', '拒绝') }}
          <span class="cfm-pop__kbd">Esc</span>
        </button>
        <div class="cfm-pop__allow-wrap">
          <button
            class="cfm-pop__btn cfm-pop__btn--approve"
            :disabled="submitting"
            @click="submit(true)"
          >
            <Loader2 v-if="submitting && lastAllow === true" :size="13" class="cfm-pop__spin" />
            <CheckCircle2 v-else :size="13" />
            {{ t('ai_confirm_once', '仅本次') }}
          </button>
          <button
            class="cfm-pop__btn-caret"
            :disabled="submitting"
            title="更多选项"
            tabindex="0"
            @click.stop="showConfirmMenu = !showConfirmMenu"
          >
            <ChevronDown :size="13" />
          </button>

          <!-- 下拉快捷放行菜单 -->
          <div v-if="showConfirmMenu" class="cfm-pop__menu">
            <button
              type="button"
              class="cfm-pop__menu-item"
              @click="showConfirmMenu = false; submit(true)"
            >
              <Check :size="12" />
              <span>{{ t('ai_confirm_once', '仅本次') }}</span>
            </button>
            <button
              v-if="confirmRequest?.tool"
              type="button"
              class="cfm-pop__menu-item"
              @click="showConfirmMenu = false; submit(true)"
            >
              <ShieldCheck :size="12" />
              <span>本会话始终允许 {{ confirmRequest.tool }}</span>
            </button>
            <button
              type="button"
              class="cfm-pop__menu-item cfm-pop__menu-item--danger"
              @click="showConfirmMenu = false; submit(true)"
            >
              <ShieldAlert :size="12" />
              <span>本会话始终允许所有操作</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 终态：结果横幅 -->
      <div v-else-if="isSettled" class="cfm-pop__settled" :class="`cfm-pop__settled--${confirmPhase}`">
        <component :is="settledIcon" :size="14" />
        <span>{{ settledLabel }}</span>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* ========== 气泡卡片本体 ========== */
.cfm-pop {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  box-shadow:
    0 4px 14px rgba(0, 0, 0, 0.08),
    0 1px 3px rgba(0, 0, 0, 0.04);
}
.cfm-pop--approved {
  border-color: color-mix(in srgb, var(--success) 22%, var(--border-subtle));
  background: color-mix(in srgb, var(--success) 3%, var(--bg-surface));
}
.cfm-pop--denied {
  border-color: color-mix(in srgb, var(--text-tertiary) 22%, var(--border-subtle));
  background: color-mix(in srgb, var(--bg-hover) 50%, var(--bg-surface));
}
.cfm-pop--timeout {
  border-color: color-mix(in srgb, var(--warning) 22%, var(--border-subtle));
  background: color-mix(in srgb, var(--warning) 3%, var(--bg-surface));
}

/* 气泡箭头：指向消息区（上方） */
.cfm-pop__arrow {
  position: absolute;
  top: -7px;
  left: 24px;
  width: 12px;
  height: 12px;
  background: inherit;
  border-left: 1px solid var(--border-subtle);
  border-top: 1px solid var(--border-subtle);
  transform: rotate(45deg);
  border-radius: 2px 0 0 0;
}

/* 头部标题行 */
.cfm-pop__head {
  display: flex;
  align-items: center;
}
.cfm-pop__title-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  min-width: 0;
  flex: 1;
}
.cfm-pop__icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.cfm-pop__icon--danger {
  color: var(--danger, #ef4444);
  background: color-mix(in srgb, var(--danger, #ef4444) 10%, transparent);
}
.cfm-pop--approved .cfm-pop__icon {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 10%, transparent);
}
.cfm-pop--denied .cfm-pop__icon,
.cfm-pop--timeout .cfm-pop__icon {
  color: var(--text-secondary);
  background: var(--bg-hover);
}
.cfm-pop__title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}
.cfm-pop__tool-code {
  font-family: ui-monospace, monospace;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--accent);
  padding: 2px 7px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.cfm-pop__icon--danger + .cfm-pop__title .cfm-pop__tool-code {
  color: var(--danger, #ef4444);
  background: color-mix(in srgb, var(--danger, #ef4444) 8%, transparent);
}
.cfm-pop__danger-tag {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--danger, #ef4444);
  background: color-mix(in srgb, var(--danger, #ef4444) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger, #ef4444) 20%, transparent);
  border-radius: 4px;
  padding: 1px 6px;
  line-height: 1.4;
}
.cfm-pop__close {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  margin-left: auto;
  transition:
    color 0.12s,
    background-color 0.12s;
}
.cfm-pop__close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* 参数行 */
.cfm-pop__cmd {
  font-size: 11.5px;
  font-family: ui-monospace, monospace;
  color: var(--text-secondary);
  padding: 5px 8px;
  border-radius: 6px;
  background: var(--bg-hover);
  word-break: break-all;
  line-height: 1.5;
}

/* 影响说明 */
.cfm-pop__impact {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-primary);
  opacity: 0.92;
}
.cfm-pop__impact-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--warning);
}

/* 提交错误 */
.cfm-pop__error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--danger) 6%, transparent);
  font-size: 11.5px;
  color: var(--danger);
}
.cfm-pop__error-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.cfm-pop__retry {
  flex-shrink: 0;
  padding: 3px 10px;
  border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
  border-radius: 5px;
  background: var(--bg-surface);
  color: var(--danger);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.12s;
}
.cfm-pop__retry:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}
.cfm-pop__retry:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 次要信息行 */
.cfm-pop__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  opacity: 0.75;
  margin-top: -2px;
}
.cfm-pop__countdown {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-tertiary);
}
.cfm-pop__countdown--urgent {
  color: var(--danger);
}
.cfm-pop__req-id {
  font-size: 10.5px;
  font-family: ui-monospace, monospace;
  color: var(--text-tertiary);
}

/* 按钮区 */
.cfm-pop__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
}
.cfm-pop__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px 11px;
  border-radius: 6px;
  border: 1px solid transparent;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    border-color 0.12s ease,
    color 0.12s ease,
    box-shadow 0.12s ease,
    transform 0.08s ease;
  white-space: nowrap;
}
.cfm-pop__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.cfm-pop__btn:not(:disabled):active {
  transform: scale(0.97);
}
.cfm-pop__kbd {
  font-family: ui-monospace, monospace;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
  border: 1px solid var(--border-subtle);
  line-height: 1.3;
  margin-left: 2px;
}

/* 拒绝按钮 */
.cfm-pop__btn--deny {
  color: var(--text-secondary);
  border-color: var(--border-default);
  background: var(--bg-surface);
}
.cfm-pop__btn--deny:not(:disabled):hover {
  color: var(--text-primary);
  background: var(--bg-hover);
  border-color: var(--border-default);
}

/* 允许按钮组合 */
.cfm-pop__allow-wrap {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  border-radius: 6px;
  overflow: visible;
  border: 1px solid var(--danger, #ef4444);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.cfm-pop__allow-wrap:has(:disabled) {
  opacity: 0.5;
  cursor: not-allowed;
}
.cfm-pop__btn--approve {
  color: #fff;
  background: var(--danger, #ef4444);
  border-color: transparent;
  border-radius: 5px 0 0 5px;
  border-right: 1px solid color-mix(in srgb, #fff 18%, transparent);
}
.cfm-pop__btn--approve:not(:disabled):hover {
  background: color-mix(in srgb, var(--danger, #ef4444) 88%, #000);
}
.cfm-pop__btn-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  padding: 0 5px;
  border: none;
  border-radius: 0 5px 5px 0;
  background: var(--danger, #ef4444);
  color: #fff;
  cursor: pointer;
  transition: background-color 0.12s ease;
}
.cfm-pop__btn-caret:not(:disabled):hover {
  background: color-mix(in srgb, var(--danger, #ef4444) 88%, #000);
}
.cfm-pop__btn-caret:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 浮动下拉菜单 */
.cfm-pop__menu {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 220px;
  background: var(--bg-surface, #ffffff);
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 100;
}
.cfm-pop__menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: var(--text-primary, #1f2937);
  font-size: 12px;
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  transition: background-color 0.12s, color 0.12s;
}
.cfm-pop__menu-item:hover {
  background: var(--bg-hover, #f3f4f6);
}
.cfm-pop__menu-item--danger {
  color: var(--danger, #ef4444);
}
.cfm-pop__menu-item--danger:hover {
  background: color-mix(in srgb, var(--danger, #ef4444) 10%, transparent);
}

/* 终态结果 */
.cfm-pop__settled {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-top: 8px;
  margin-top: 4px;
  font-size: 12.5px;
  font-weight: 500;
  border-top: 1px solid var(--border-subtle);
}
.cfm-pop__settled--approved {
  color: var(--success);
}
.cfm-pop__settled--denied {
  color: var(--danger);
}
.cfm-pop__settled--timeout {
  color: var(--warning);
}

.cfm-pop__spin {
  animation: cfm-spin 0.8s linear infinite;
}
@keyframes cfm-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 过渡动画：从下方滑入 */
.cfm-pop-enter-active,
.cfm-pop-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}
.cfm-pop-enter-from,
.cfm-pop-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (prefers-reduced-motion: reduce) {
  .cfm-pop__spin {
    animation-duration: 2.4s;
  }
  .cfm-pop-enter-active,
  .cfm-pop-leave-active {
    transition: none;
  }
}

/* 键盘可达性 */
.cfm-pop__close:focus-visible,
.cfm-pop__retry:focus-visible,
.cfm-pop__btn:focus-visible,
.cfm-pop__btn-caret:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>