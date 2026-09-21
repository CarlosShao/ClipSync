<script setup lang="ts">
/**
 * 个人资料页「套餐管理」卡片（2026-09-19 用户裁定：套餐管理唯一场所）。
 *
 * 订阅页被砍掉后，升级/退款都收在这张卡里：
 *  · 升级：只升不降（Enterprise 无入口），点开全局「选择套餐」弹窗流（pricing 步），
 *    支付状态机仍只有 PricingPaymentModals 一份；
 *  · 申请退款（2026-09-20 裁定改人工审核）：客户端只提交申请，服务端不调渠道、
 *    仅落一条待审申请并立即收回权益，管理台点「审核通过」那一刻才真打款。
 *    可退性判定与天数（退款窗口 / 审核工作日）全在服务端（refundPolicy.js），
 *    前端只转述 refundable/reasonCode 与接口回传的天数，绝不自行放行、绝不写死天数；
 *  · 不提供「取消订阅」按钮：本产品没有自动续费，到期自动回落 Free —— 没有可取消的
 *    对象，放个按钮就是假按钮；这行事实用一句话写明。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useConfigStore } from '@/stores/configStore'
import { useSonner } from '@/composables/useSonner'
import { invalidatePlanLimits } from '@/composables/usePlanLimits'
import {
  formatExpiryDate,
  hasUpgradeHeadroom,
  invalidateCurrentSubscription,
  loadCurrentSubscription,
  resolveCurrentSubscription,
} from '@/composables/useSubscriptionAccess'
import { fetchMyRefundRequests, fetchRefundableOrders, requestRefund, type RefundableOrder } from '@/api/payment'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import { Clock, Crown, Undo2, AlertTriangle } from 'lucide-vue-next'

const emit = defineEmits<{ 'open-modal': [type: string] }>()

const { t } = useI18n()
const configStore = useConfigStore()
const toast = useSonner()

const current = computed(() => resolveCurrentSubscription(configStore.user.plan))
const expiryText = computed(() => formatExpiryDate(current.value.periodEnd))
const currentPlanLabel = computed(() => t('role_' + (current.value.planName || 'Free').toLowerCase()))
const upgradable = computed(() => hasUpgradeHeadroom(current.value.planName))
/** 退款只针对付费生效中的订阅；Free/超管走不到这里（超管由 ProfileView 隐藏整卡） */
const refundable = computed(() => current.value.paidActive)

function refreshSubscription() {
  void loadCurrentSubscription(true)
}
onMounted(() => {
  void loadCurrentSubscription()
  void loadPendingNotice()
  // 本卡片读 /subscriptions/current，侧栏与限额读 auth/me：只拉前者会让两处
  // 同时显示不同档位（驳回还原后「卡片 Pro、侧栏还在催升级」就是这么来的）
  void configStore.fetchUserProfile()
  window.addEventListener('clipsync:subscription-changed', refreshSubscription)
})
onUnmounted(() => window.removeEventListener('clipsync:subscription-changed', refreshSubscription))

// ===== 退款申请弹窗 =====
const refundOpen = ref(false)
/** list=订单清单；confirm=二次确认（钱的事必须两步） */
const refundStep = ref<'list' | 'confirm'>('list')
const orders = ref<RefundableOrder[]>([])
const ordersLoading = ref(false)
/** 天数全部来自服务端（后台可配置）：null=还没拿到，此时只渲染不含天数的文案，绝不回落到写死值 */
const windowDays = ref<number | null>(null)
const reviewBusinessDays = ref<number | null>(null)
const selected = ref<RefundableOrder | null>(null)
const submitting = ref(false)
/** listNotice=点了暂时不能提交的单时的内联说明；submittedNotice=提交成功后的回执 */
const listNotice = ref('')
const submittedNotice = ref('')
/** 卡片上的「退款审核中」一行（存在待审申请才显示） */
const hasPendingRequest = ref(false)

const pendingLineText = computed(() =>
  reviewBusinessDays.value === null
    ? t('refund_pending_line_no_days')
    : t('refund_pending_line', { days: reviewBusinessDays.value }),
)

/** 服务端提交申请时把承诺工作日数带在响应里，优先于列表接口的值 */
function applyDays(data: { windowDays?: number; reviewBusinessDays?: number } | undefined) {
  if (typeof data?.windowDays === 'number') windowDays.value = data.windowDays
  if (typeof data?.reviewBusinessDays === 'number') reviewBusinessDays.value = data.reviewBusinessDays
}

async function openRefund() {
  refundOpen.value = true
  refundStep.value = 'list'
  selected.value = null
  listNotice.value = ''
  submittedNotice.value = ''
  await loadOrders()
}

async function loadOrders() {
  ordersLoading.value = true
  try {
    const res = await fetchRefundableOrders()
    if (res.ok && Array.isArray(res.data?.orders)) {
      orders.value = res.data.orders
      applyDays(res.data)
      // 别的设备上提交过的申请也要让卡片这一行亮起来（列表是同一份服务端真相）
      if (orders.value.some((o) => o.refundRequest?.status === 'pending')) hasPendingRequest.value = true
    } else {
      orders.value = []
      toast.show(res.error || t('refund_load_fail'), 'error')
    }
  } catch {
    orders.value = []
  }
  ordersLoading.value = false
}

/** 有待审申请时在「当前套餐」下提示一行；工作日数只在订单列表接口里回传，故命中时补一次轻量拉取 */
async function loadPendingNotice() {
  const res = await fetchMyRefundRequests()
  const pending = res.ok ? (res.data?.requests || []).find((r) => r.status === 'pending') : null
  hasPendingRequest.value = Boolean(pending)
  if (pending && reviewBusinessDays.value === null) applyDays((await fetchRefundableOrders()).data)
}

function toConfirm(o: RefundableOrder) {
  selected.value = o
  listNotice.value = ''
  refundStep.value = 'confirm'
}

function backToList() {
  refundStep.value = 'list'
  selected.value = null
}

/**
 * 错误码 / reasonCode → 中文文案（服务端返回的是英文，中文环境直接展示等于没做国际化
 * ——2026-09-19 用户实测打回）。未知码回落服务端 message，绝不吞错误；
 * code 走 api() 的 data 透传（client.ts 错误分支带 data=json）。
 *
 * 「非最近一笔」这一闸服务端已从 NOT_LATEST_PAID_ORDER 改名为 NOT_CURRENT_SUB_ORDER
 * （语义收紧：只能退当前生效订阅的最近一笔已付订单，历史订单/已退过的单永不顺移可退）。
 * 新旧两个码同文案、case 并列保留，避免服务端灰度期间前端露出裸英文码。
 */
function refundErrorText(res: { error?: string; data?: any }): string {
  const code = res.data?.code
  switch (code) {
    case 'REFUND_CHANNEL_FAILED':
    case 'REFUND_NOT_CONFIRMED':
      return t('refund_err_channel')
    case 'REFUND_WINDOW_EXPIRED':
      return windowExpiredText()
    case 'NOT_CURRENT_SUB_ORDER':
    case 'NOT_LATEST_PAID_ORDER':
      return t('refund_reason_NOT_CURRENT_SUB_ORDER')
    case 'ALREADY_REFUNDED':
      return t('refund_reason_ALREADY_REFUNDED')
    case 'CHANNEL_UNSUPPORTED':
    case 'REFUND_CHANNEL_UNSUPPORTED':
      return t('refund_reason_CHANNEL_UNSUPPORTED')
    case 'REFUND_REQUEST_PENDING':
      return t('refund_err_pending')
    case 'REFUND_REQUEST_ORDER_REQUIRED':
      return t('refund_err_order_required')
    case 'REFUND_STATE_CONFLICT':
      return t('refund_err_conflict')
    case 'REFUND_LOCAL_UPDATE_FAILED':
      return t('refund_err_local_update_failed')
    case 'ALIPAY_NOT_CONFIGURED':
      return t('refund_err_alipay_not_configured')
    case 'SUBSCRIPTION_DISABLED':
      return t('refund_err_disabled')
    case 'ORDER_NOT_FOUND':
      return t('refund_err_not_found')
    default:
      return res.error || t('refund_fail_generic')
  }
}

async function confirmRefund() {
  const o = selected.value
  if (!o || submitting.value) return
  submitting.value = true
  const res = await requestRefund(o.orderNo)
  submitting.value = false
  if (res.ok) {
    applyDays(res.data?.request)
    toast.show(t('refund_success'), 'success')
    submittedNotice.value =
      reviewBusinessDays.value === null ? '' : t('refund_submitted_notice', { days: reviewBusinessDays.value })
    hasPendingRequest.value = true
    refundStep.value = 'list'
    selected.value = null
    // 权益已立即收回：作废限额/订阅快照/账号 plan，并广播（与支付成功同一套收敛）
    invalidatePlanLimits()
    invalidateCurrentSubscription()
    void configStore.fetchUserProfile()
    window.dispatchEvent(new CustomEvent('clipsync:subscription-changed'))
    // 重拉列表，让这一单当场变成「退款审核中」
    void loadOrders()
  } else {
    // 服务端拒绝（已有待审申请/超窗/非最近一笔/渠道…）：错误码映射中文，如实展示，不自动重试
    const notice = refundErrorText(res)
    toast.show(notice, 'error')
    listNotice.value = notice
    refundStep.value = 'list'
    selected.value = null
    void loadOrders()
  }
}

function money(v: number): string {
  return `¥${Number(v).toFixed(2)}`
}

function dateText(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString()
}

/** 超窗文案要带窗口天数，而天数只能来自服务端；没拿到时退化成不承诺具体天数 */
function windowExpiredText(): string {
  return windowDays.value === null
    ? t('refund_reason_default')
    : t('refund_reason_REFUND_WINDOW_EXPIRED', { days: windowDays.value })
}

/** 不可退原因：服务端 reasonCode → 中文文案（未知码兜底联系客服） */
function reasonText(code: string | null): string {
  switch (code) {
    case 'ALREADY_REFUNDED':
      return t('refund_reason_ALREADY_REFUNDED')
    case 'REFUND_WINDOW_EXPIRED':
      return windowExpiredText()
    case 'NOT_CURRENT_SUB_ORDER':
    case 'NOT_LATEST_PAID_ORDER':
      return t('refund_reason_NOT_CURRENT_SUB_ORDER')
    case 'CHANNEL_UNSUPPORTED':
    case 'REFUND_CHANNEL_UNSUPPORTED':
      return t('refund_reason_CHANNEL_UNSUPPORTED')
    case 'REFUND_REQUEST_PENDING':
      return t('refund_state_reviewing')
    default:
      return t('refund_reason_default')
  }
}

/** 一单在列表里的呈现状态；refundRequest 由服务端在同一份列表响应里带出 */
type RowState = 'refunded' | 'reviewing' | 'requestable'

function rowState(o: RefundableOrder): RowState {
  if (o.status === 'refunded' || o.reasonCode === 'ALREADY_REFUNDED') return 'refunded'
  // 清单只会带在途申请（pending=待审核、processing=管理员已认领正在打款）；
  // 审核通过后订单直接变 refunded、驳回后申请单不再是在途 —— 都落回 refunded/requestable
  const st = o.refundRequest?.status
  if (st === 'pending' || st === 'processing') return 'reviewing'
  return 'requestable'
}

/**
 * 入口可见性（2026-09-20 用户裁定）：每一笔已付订单都要看得见「申请退款」，
 * 超期/非锚点单也一样给按钮 —— 藏起来用户只会以为功能坏了。审核中/已退款的单才收口。
 */
function canRequest(o: RefundableOrder): boolean {
  return rowState(o) === 'requestable'
}

/** 按钮下方（或替代按钮）那一行状态/原因 */
function rowHint(o: RefundableOrder): string {
  switch (rowState(o)) {
    case 'refunded':
      return t('refund_reason_ALREADY_REFUNDED')
    case 'reviewing':
      return t('refund_state_reviewing')
    default:
      return o.refundable ? '' : reasonText(o.reasonCode)
  }
}

function onRefundClick(o: RefundableOrder) {
  if (!o.refundable) {
    // 闸在服务端：不可退的单点了绝不发请求，只在弹窗里把 reasonCode 讲成人话
    listNotice.value = refundErrorText({ data: { code: o.reasonCode }, error: reasonText(o.reasonCode) })
    return
  }
  listNotice.value = ''
  toConfirm(o)
}
</script>

<template>
  <div class="pmc">
    <div class="pmc-head">
      <div class="pmc-title">{{ t('prof_plan_section') }}</div>
      <div class="pmc-plan">
        <span class="pmc-plan-name">{{ currentPlanLabel }}</span>
        <span v-if="expiryText" class="pmc-expiry">{{ t('sub_expiry_date', { date: expiryText }) }}</span>
      </div>
      <!-- 没有自动续费 ⇒ 没有「取消订阅」这个动作；这句话就是该诉求的诚实答案 -->
      <div class="pmc-note">{{ t('cycle_once_note') }}</div>
      <!-- 权益在申请提交那一刻就已收回，审核期账号是免费版，这行解释「为什么我付过钱却是 Free」 -->
      <div v-if="hasPendingRequest" class="pmc-pending">
        <Clock :size="13" />
        <span>{{ pendingLineText }}</span>
      </div>
    </div>
    <div class="pmc-actions">
      <Button v-if="upgradable" class="pmc-btn" @click="emit('open-modal', 'pricing')">
        <Crown :size="14" />
        <span>{{ t('sub_upgrade_plan') }}</span>
      </Button>
      <Button v-if="refundable" variant="outline" class="pmc-btn" @click="openRefund">
        <Undo2 :size="14" />
        <span>{{ t('refund_request_btn') }}</span>
      </Button>
    </div>

    <!-- 申请退款：订单清单 → 二次确认 → 服务端落待审申请（权益立即收回，打款等人工审核） -->
    <ModalDialog
      :open="refundOpen"
      :title="refundStep === 'list' ? t('refund_request_btn') : t('refund_confirm_title')"
      max-width="780px"
      @close="refundOpen = false"
    >
      <template v-if="refundStep === 'list'">
        <p class="pmc-desc">{{ t('refund_list_desc') }}</p>
        <p v-if="windowDays !== null" class="pmc-desc">{{ t('refund_window_hint', { days: windowDays }) }}</p>
        <div v-if="submittedNotice" class="pmc-notice">{{ submittedNotice }}</div>
        <div v-if="listNotice" class="pmc-notice pmc-notice--warn">{{ listNotice }}</div>
        <div v-if="ordersLoading" class="pmc-state">{{ t('refund_loading') }}</div>
        <div v-else-if="orders.length === 0" class="pmc-state">{{ t('refund_empty') }}</div>
        <div v-else class="pmc-orders">
          <div v-for="o in orders" :key="o.orderId" class="pmc-order">
            <div class="pmc-order-info">
              <div class="pmc-order-no">{{ o.orderNo }}</div>
              <div class="pmc-order-date">{{ dateText(o.paidAt) }}</div>
              <div v-if="o.creditAmount > 0" class="pmc-order-credit">
                {{ t('refund_credit_note', { orig: money(o.originalAmount), credit: money(o.creditAmount) }) }}
              </div>
            </div>
            <div class="pmc-order-right">
              <span class="pmc-order-amount">{{ money(o.amount) }}</span>
              <Button v-if="canRequest(o)" variant="outline" size="sm" @click="onRefundClick(o)">{{
                t('refund_btn')
              }}</Button>
              <span v-if="rowHint(o)" class="pmc-order-reason">{{ rowHint(o) }}</span>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="selected">
        <div class="pmc-confirm-amount">
          <AlertTriangle :size="16" />
          <span>{{ t('refund_confirm_warn', { amount: money(selected.amount) }) }}</span>
        </div>
        <ul class="pmc-confirm-list">
          <li>{{ t('refund_confirm_point_1') }}</li>
          <li>{{ t('refund_confirm_point_2') }}</li>
          <li v-if="reviewBusinessDays !== null">
            {{ t('refund_confirm_review_hint', { days: reviewBusinessDays }) }}
          </li>
          <li v-if="selected.creditAmount > 0">{{ t('refund_confirm_point_3') }}</li>
        </ul>
        <div class="pmc-confirm-actions">
          <Button variant="ghost" :disabled="submitting" @click="backToList">{{ t('cancel_btn') }}</Button>
          <Button class="pmc-confirm-btn" :disabled="submitting" @click="confirmRefund">
            {{ submitting ? t('refund_processing') : t('refund_confirm_btn') }}
          </Button>
        </div>
      </template>
    </ModalDialog>
  </div>
</template>

<style scoped>
.pmc {
  margin-top: 16px;
  padding: 18px 20px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}
.pmc-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  margin-bottom: 10px;
}
.pmc-plan {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.pmc-plan-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}
.pmc-expiry {
  font-size: 12.5px;
  color: var(--text-secondary);
}
.pmc-note {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--text-tertiary);
}
.pmc-pending {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  background: var(--warning-bg);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  font-size: 12px;
  color: var(--text-primary);
}
.pmc-pending svg {
  color: var(--warning);
  flex-shrink: 0;
}
.pmc-actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
  flex-wrap: wrap;
}
.pmc-btn {
  gap: 6px;
}
.pmc-desc {
  font-size: 12.5px;
  color: var(--text-secondary);
  margin: 0 0 12px;
  line-height: 1.5;
}
.pmc-notice {
  margin: -4px 0 12px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: var(--success-bg);
  border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
  color: var(--text-primary);
  font-size: 12.5px;
  line-height: 1.5;
}
.pmc-notice--warn {
  background: var(--warning-bg);
  border-color: color-mix(in srgb, var(--warning) 30%, transparent);
}
/* 两行说明挨着排，只留最后一行与列表的间距 */
.pmc-desc + .pmc-desc {
  margin-top: -6px;
}
.pmc-state {
  text-align: center;
  padding: 20px;
  color: var(--text-tertiary);
  font-size: 13px;
}
.pmc-orders {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.pmc-order {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-hover);
  border: 1px solid var(--border-subtle);
}
.pmc-order-info {
  min-width: 0;
}
.pmc-order-no {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
  word-break: break-all;
}
.pmc-order-date {
  font-size: 11px;
  color: var(--text-tertiary);
}
.pmc-order-credit {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 2px;
}
.pmc-order-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
}
.pmc-order-amount {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.pmc-order-reason {
  font-size: 11px;
  color: var(--text-tertiary);
  text-align: right;
  max-width: 160px;
}
.pmc-confirm-amount {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warning) 8%, var(--bg-surface));
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.5;
}
.pmc-confirm-amount svg {
  color: var(--warning);
  flex-shrink: 0;
  margin-top: 2px;
}
.pmc-confirm-list {
  margin: 12px 0 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.9;
}
.pmc-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
.pmc-confirm-btn {
  background: var(--danger);
  color: #fff;
}
.pmc-confirm-btn:hover {
  background: color-mix(in srgb, var(--danger) 88%, black);
}
</style>
