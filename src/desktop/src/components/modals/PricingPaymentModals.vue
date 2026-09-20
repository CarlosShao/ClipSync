<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import AlipayScanPay from '@/components/payment/AlipayScanPay.vue'
import PlanCards from '@/components/pricing/PlanCards.vue'
import { Landmark, CircleCheck, Clock } from 'lucide-vue-next'
import type { PricingPlan } from '@/composables/usePlanLimits'
import { invalidatePlanLimits } from '@/composables/usePlanLimits'
import { fetchOrderStatus } from '@/api/payment'
import { api } from '@/api/client'
import { useConfigStore } from '@/stores/configStore'
import { useMenuAccess } from '@/composables/useMenuAccess'
import {
  cycleLabelKey,
  invalidateCurrentSubscription,
  type BillingCycle,
} from '@/composables/useSubscriptionAccess'
import './modal-shared.css'

defineProps<{ showModalType: string }>()
const emit = defineEmits<{ close: []; 'switch-modal': [type: string] }>()

const { t } = useI18n()
const configStore = useConfigStore()
// 弹窗流自身也过能力判定：入口（侧栏/设置/订阅页）已用 can('nav.subscription')，
// 这里再兜一层 —— enable_subscription 运行中被关掉时，已挂载的弹窗不再给出购买卡。
const { can } = useMenuAccess()

// ===== 套餐目录/档位判定已收敛到 PlanCards（与设置子页、订阅页同一套只升不降规则）=====

// Plan selection state (for pricing → payment flow)
interface SelectedPlan {
  id: string
  name: string
  price: number
  cycle: BillingCycle
}
const selectedPlan = ref<SelectedPlan | null>(null)
/**
 * 升级折抵（服务端 POST /api/payments/create-order 响应 order.metadata.proration）。
 * 同事并行实现中：没拿到就是 null —— 结果页相应行不渲染，绝不伪造折抵金额。
 */
interface Proration {
  originalPrice: number
  creditAmount: number
  finalAmount: number
}
const proration = ref<Proration | null>(null)
interface PayDetail {
  orderNo: string
  amount?: string
  plan?: string
  paidAt?: string
  expiresAt?: string
  originalAmount?: string
  creditAmount?: string
}
const paymentResult = ref<{
  kind: 'success' | 'fail' | 'pending'
  message: string
  detail?: PayDetail
} | null>(null)

const selectedPeriodLabel = computed(() =>
  selectedPlan.value ? t(cycleLabelKey(selectedPlan.value.cycle)) : '',
)

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function money(v: number): string {
  return `¥${Number(v).toFixed(2)}`
}

function payDetailRows(d: PayDetail): { k: string; v: string }[] {
  const rows = [
    { k: t('pay_result_order_no'), v: d.orderNo },
    { k: t('pay_result_plan'), v: d.plan || '' },
    { k: t('pay_result_original_amount'), v: d.originalAmount || '' },
    { k: t('pay_result_credit_amount'), v: d.creditAmount || '' },
    { k: t('pay_result_amount'), v: d.amount || '' },
    { k: t('pay_result_paid_at'), v: d.paidAt || '' },
    { k: t('pay_result_expires_at'), v: d.expiresAt || '' },
  ]
  return rows.filter((r) => r.v)
}

// ===== Plan Selection → Payment Flow =====
/** PlanCards 只在「升级/订阅」可点时才抛 select：档位判定（当前档置灰、低档已包含）在卡片里已做完 */
function onPlanSelect(plan: PricingPlan, cycle: BillingCycle) {
  const price = cycle === 'yearly' ? (plan.priceYearly > 0 ? plan.priceYearly : plan.priceMonthly) : plan.priceMonthly
  selectedPlan.value = {
    id: plan.id,
    name: plan.displayName || plan.name,
    price,
    cycle,
  }
  proration.value = null
  emit('switch-modal', 'payment')
}

/** 下单成功：create-order 响应顶层 proration 为升级折抵明细（兼容 metadata.proration 旧形） */
function onOrderCreated(data: any) {
  const p = data?.proration ?? data?.order?.metadata?.proration
  if (!p || typeof p !== 'object') {
    proration.value = null
    return
  }
  const originalPrice = Number(p.originalPrice)
  const creditAmount = Number(p.creditAmount)
  const finalAmount = Number(p.finalAmount)
  if (![originalPrice, creditAmount, finalAmount].every((n) => Number.isFinite(n))) {
    proration.value = null
    return
  }
  proration.value = { originalPrice, creditAmount, finalAmount }
}

// 选择支付方式 —— 2026-09-16 接入真实支付宝扫码支付。
//
// 历史演进（值得留痕，避免再次退化成假实现）：
//   ① 最初：直接 POST /api/subscriptions/subscribe 并弹「订阅成功」——**假成功**，
//      用户没付款却显示订阅生效。
//   ② 中间态：改成「支付渠道接入中」占位 —— 诚实但不可用。
//   ③ 现在：进入支付宝扫码面板（勾选协议 → 二维码 → 轮询订单状态 → 成功后解锁）。
//
// 微信支付**不接入**：需已认证公众号（300 元/年），成本不允许；产品决策见
// docs/audit/external-dependency-audit-2026-09-09.md 的 B1 节。
function selectPaymentMethod(_method: string) {
  const p = selectedPlan.value
  if (!p) return
  emit('switch-modal', 'pay-scan')
}

/** 扫码支付成功：拉订单终态 + 真实订阅到期时间，结果页展示明细 */
async function onPaid(orderNo: string) {
  const detail: PayDetail = { orderNo }
  try {
    const res = await fetchOrderStatus(orderNo)
    const o = res.ok ? (res.data as any)?.order : null
    if (o) {
      detail.amount = `¥${Number(o.amount).toFixed(2)}`
      detail.paidAt = o.paidAt ? formatDateTime(o.paidAt) : ''
    }
  } catch {
    /* 详情拉取失败不阻塞成功提示，仅少几行信息 */
  }
  // 折抵明细来自下单响应（订单状态接口不回传 metadata）
  if (proration.value) {
    detail.originalAmount = money(proration.value.originalPrice)
    detail.creditAmount = `- ${money(proration.value.creditAmount)}`
    if (!detail.amount) detail.amount = money(proration.value.finalAmount)
  }
  try {
    // 有效期必须读服务端订阅真实到期（续费是叠加延长，不能用支付时间+1月硬算）
    const subRes = await api<any>('GET', '/api/subscriptions/current')
    const sub = subRes.ok ? subRes.data?.subscription : null
    const end = sub?.current_period_end ?? sub?.currentPeriodEnd ?? null
    if (end) detail.expiresAt = formatDateTime(String(end))
  } catch {
    /* 同上 */
  }
  if (selectedPlan.value) detail.plan = selectedPlan.value.name
  // 订阅已变更：作废三处缓存（限额/features、订阅快照、auth/me 的 plan 冗余字段），
  // 否则侧栏档位与「当前套餐」卡片会在 TTL 内继续显示旧套餐。
  invalidatePlanLimits()
  invalidateCurrentSubscription()
  void configStore.fetchUserProfile()
  // 弹窗背后的订阅页/侧栏仍挂着：广播一次（与 clipsync:avatar-changed 同一总线模式），
  // 否则刚付款的档位要到下次进入页面才刷新。
  window.dispatchEvent(new CustomEvent('clipsync:subscription-changed'))
  paymentResult.value = { kind: 'success', message: t('pay_paid_ok'), detail }
  emit('switch-modal', 'payment-result')
}
</script>

<template>
  <!-- Pricing -->
  <ModalDialog :open="showModalType === 'pricing'" :title="t('modal_pricing')" max-width="1000px" @close="emit('close')">
    <!-- enable_subscription 关闭：不给购买入口，也不报错——按「功能建设中」如实占位 -->
    <PlanCards v-if="can('nav.subscription')" @select="onPlanSelect" />
    <div v-else class="modal-state">{{ t('ft_building') }}</div>
  </ModalDialog>

  <!-- Payment Method -->
  <!-- 只提供支付宝：微信支付需已认证公众号（300 元/年），成本不允许，产品决策不接入 -->
  <ModalDialog :open="showModalType === 'payment'" :title="t('modal_payment')" max-width="420px" @close="emit('close')">
    <div v-if="selectedPlan" class="pay-summary">
      <div class="pay-summary-name">{{ selectedPlan.name }}</div>
      <div class="pay-summary-price">
        ¥{{ selectedPlan.price }}<span class="pay-summary-period">{{ selectedPeriodLabel }}</span>
      </div>
      <div class="pay-summary-cycle">{{ t('cycle_once_note') }}</div>
    </div>
    <div class="pay-methods">
      <Button
        variant="outline"
        class="w-full justify-start payment-option"
        @click="selectPaymentMethod('alipay')"
      >
        <Landmark class="pay-icon pay-icon--alipay" /> <span>{{ t('pay_alipay') }}</span>
      </Button>
    </div>
  </ModalDialog>

  <!-- Scan to Pay（勾选协议 → 二维码 → 轮询订单状态） -->
  <ModalDialog
    :open="showModalType === 'pay-scan'"
    :title="t('pay_scan_title')"
    max-width="420px"
    @close="emit('close')"
  >
    <AlipayScanPay
      v-if="selectedPlan"
      :plan-id="selectedPlan.id"
      :billing-cycle="selectedPlan.cycle"
      :amount-label="`¥${selectedPlan.price}`"
      :period-label="selectedPeriodLabel"
      @order-created="onOrderCreated"
      @paid="onPaid"
      @close="emit('close')"
    />
  </ModalDialog>

  <!-- Payment Result -->
  <ModalDialog
    :open="showModalType === 'payment-result'"
    :title="
      paymentResult?.kind === 'success'
        ? t('sub_result_success')
        : paymentResult?.kind === 'pending'
          ? t('sub_result_pending')
          : t('sub_result_fail')
    "
    max-width="400px"
    @close="emit('close')"
  >
    <div v-if="paymentResult" class="pay-result">
      <div class="pay-result-icon" :class="paymentResult.kind">
        <CircleCheck v-if="paymentResult.kind === 'success'" :size="48" />
        <Clock v-else-if="paymentResult.kind === 'pending'" :size="48" />
        <span v-else style="font-size: 48px">!</span>
      </div>
      <p class="pay-result-msg">{{ paymentResult.message }}</p>
      <dl v-if="paymentResult.detail" class="pay-result-detail">
        <template v-for="row in payDetailRows(paymentResult.detail)" :key="row.k">
          <dt>{{ row.k }}</dt>
          <dd>{{ row.v }}</dd>
        </template>
      </dl>
      <Button class="w-full" @click="emit('close')">{{ t('confirm_t') }}</Button>
    </div>
  </ModalDialog>
</template>

<style scoped>
.payment-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  cursor: pointer;
  font-size: 14px;
  color: var(--text-primary);
  transition: all 150ms;
}
.payment-option:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}
.pay-icon {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
}
/* 支付渠道品牌色：微信绿 / 支付宝蓝是固定的品牌识别色，不随主题变化 */
/* stylelint-disable color-no-hex */
.pay-icon--wechat {
  color: #07c160;
}
.pay-icon--alipay {
  color: #1677ff;
}
/* stylelint-enable color-no-hex */
/* 套餐卡样式（.price-card/.pc-*）已随卡片一起迁到 components/pricing/PlanCards.vue */

.pay-summary {
  margin-bottom: 16px;
  padding: 12px;
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
}
.pay-summary-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.pay-summary-price {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  margin-top: 4px;
}
.pay-summary-period {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-tertiary);
}
/* 一次性购买说明：防止「月付/年付」被读成自动续费（本产品无自动扣款） */
.pay-summary-cycle {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-tertiary);
}
.pay-methods {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pay-result {
  text-align: center;
  padding: 16px 0;
}
.pay-result-icon {
  /* lucide svg 是块级元素，text-align 对它无效，必须 flex 居中 */
  display: flex;
  justify-content: center;
  margin-bottom: 16px;
}
.pay-result-icon.success {
  color: var(--success);
}
.pay-result-icon.fail {
  color: var(--danger);
}
.pay-result-icon.pending {
  color: var(--warning);
}
.pay-result-msg {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 20px;
  line-height: 1.5;
}
.pay-result-detail {
  width: 100%;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
  margin: 0 0 20px;
  padding: 12px 14px;
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.pay-result-detail dt {
  color: var(--text-tertiary);
  white-space: nowrap;
}
.pay-result-detail dd {
  margin: 0;
  color: var(--text-primary);
  text-align: right;
  word-break: break-all;
}
</style>
