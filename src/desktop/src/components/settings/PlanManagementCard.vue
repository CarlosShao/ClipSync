<script setup lang="ts">
/**
 * 个人资料页「套餐管理」卡片（2026-09-19 用户裁定：套餐管理唯一场所）。
 *
 * 订阅页被砍掉后，升级/退款都收在这张卡里：
 *  · 升级：只升不降（Enterprise 无入口），点开全局「选择套餐」弹窗流（pricing 步），
 *    支付状态机仍只有 PricingPaymentModals 一份；
 *  · 申请退款：真实退款（服务端 alipay.trade.refund 原路退回 + 权益立即收回），
 *    可退性判定全在服务端（refundPolicy.js），前端只转述 refundable/reasonCode，
 *    绝不自行放行；
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
import { fetchRefundableOrders, requestRefund, type RefundableOrder } from '@/api/payment'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import { Crown, Undo2, AlertTriangle } from 'lucide-vue-next'

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
  window.addEventListener('clipsync:subscription-changed', refreshSubscription)
})
onUnmounted(() => window.removeEventListener('clipsync:subscription-changed', refreshSubscription))

// ===== 退款弹窗 =====
const refundOpen = ref(false)
/** list=订单清单；confirm=二次确认（钱的事必须两步） */
const refundStep = ref<'list' | 'confirm'>('list')
const orders = ref<RefundableOrder[]>([])
const ordersLoading = ref(false)
const windowDays = ref(7)
const selected = ref<RefundableOrder | null>(null)
const submitting = ref(false)

async function openRefund() {
  refundOpen.value = true
  refundStep.value = 'list'
  selected.value = null
  await loadOrders()
}

async function loadOrders() {
  ordersLoading.value = true
  try {
    const res = await fetchRefundableOrders()
    if (res.ok && Array.isArray(res.data?.orders)) {
      orders.value = res.data.orders
      if (typeof res.data.windowDays === 'number') windowDays.value = res.data.windowDays
    } else {
      orders.value = []
      toast.show(res.error || t('refund_load_fail'), 'error')
    }
  } catch {
    orders.value = []
  }
  ordersLoading.value = false
}

function toConfirm(o: RefundableOrder) {
  selected.value = o
  refundStep.value = 'confirm'
}

function backToList() {
  refundStep.value = 'list'
  selected.value = null
}

async function confirmRefund() {
  const o = selected.value
  if (!o || submitting.value) return
  submitting.value = true
  const res = await requestRefund(o.orderNo)
  submitting.value = false
  if (res.ok) {
    toast.show(t('refund_success'), 'success')
    refundOpen.value = false
    refundStep.value = 'list'
    selected.value = null
    // 权益已立即收回：作废限额/订阅快照/账号 plan，并广播（与支付成功同一套收敛）
    invalidatePlanLimits()
    invalidateCurrentSubscription()
    void configStore.fetchUserProfile()
    window.dispatchEvent(new CustomEvent('clipsync:subscription-changed'))
  } else {
    // 服务端拒绝（超窗/非最近一笔/渠道…）：如实展示，不自动重试
    toast.show(res.error || t('refund_fail_generic'), 'error')
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

/** 不可退原因：服务端 reasonCode → 中文文案（未知码兜底联系客服） */
function reasonText(code: string | null): string {
  switch (code) {
    case 'ALREADY_REFUNDED':
      return t('refund_reason_ALREADY_REFUNDED')
    case 'REFUND_WINDOW_EXPIRED':
      return t('refund_reason_REFUND_WINDOW_EXPIRED', { days: windowDays.value })
    case 'NOT_LATEST_PAID_ORDER':
      return t('refund_reason_NOT_LATEST_PAID_ORDER')
    case 'CHANNEL_UNSUPPORTED':
      return t('refund_reason_CHANNEL_UNSUPPORTED')
    default:
      return t('refund_reason_default')
  }
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

    <!-- 申请退款：订单清单 → 二次确认 → 服务端真实退款 -->
    <ModalDialog
      :open="refundOpen"
      :title="refundStep === 'list' ? t('refund_request_btn') : t('refund_confirm_title')"
      max-width="480px"
      @close="refundOpen = false"
    >
      <template v-if="refundStep === 'list'">
        <p class="pmc-desc">{{ t('refund_list_desc', { days: windowDays }) }}</p>
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
              <Button v-if="o.refundable" variant="outline" size="sm" @click="toConfirm(o)">{{
                t('refund_btn')
              }}</Button>
              <span v-else class="pmc-order-reason">{{ reasonText(o.reasonCode) }}</span>
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
