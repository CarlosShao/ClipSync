<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import AlipayScanPay from '@/components/payment/AlipayScanPay.vue'
import { Landmark, CircleCheck, Clock } from 'lucide-vue-next'
import { getPricingPlans, type PricingPlan } from '@/composables/usePlanLimits'
import { fetchOrderStatus } from '@/api/payment'
import { api } from '@/api/client'
import './modal-shared.css'

defineProps<{ showModalType: string }>()
const emit = defineEmits<{ close: []; 'switch-modal': [type: string] }>()

const { t } = useI18n()
const toast = useSonner()

// ===== 真实套餐价格（与管理台 subscription_plans 对齐，此前硬编码 ¥9.9/¥29 已移除）=====
const plans = ref<PricingPlan[]>([])
const FEATURE_KEYS: Record<string, string[]> = {
  free: ['feat_3dev', 'feat_100hist', 'feat_community'],
  pro: ['feat_unlimited_dev', 'feat_unlimited_hist', 'feat_priority'],
  enterprise: ['feat_team', 'feat_api', 'feat_priority'],
}
const PLAN_NAME_KEYS: Record<string, string> = {
  free: 'price_free',
  pro: 'price_pro',
  enterprise: 'price_enterprise',
}
const orderedPlans = ref<{ key: string; plan: PricingPlan | null }[]>([])

onMounted(async () => {
  plans.value = await getPricingPlans()
  const byKey = new Map(plans.value.map((p) => [p.name.toLowerCase(), p]))
  orderedPlans.value = ['free', 'pro', 'enterprise'].map((key) => ({
    key,
    plan: byKey.get(key) ?? null,
  }))
})

function planName(key: string): string {
  return t(PLAN_NAME_KEYS[key] ?? key)
}
function planPrice(plan: PricingPlan | null): string {
  return plan ? `¥${plan.priceMonthly}` : '—'
}

// Plan selection state (for pricing → payment flow)
const selectedPlan = ref<{ id: string; name: string; price: number } | null>(null)
interface PayDetail {
  orderNo: string
  amount?: string
  plan?: string
  paidAt?: string
  expiresAt?: string
}
const paymentResult = ref<{
  kind: 'success' | 'fail' | 'pending'
  message: string
  detail?: PayDetail
} | null>(null)

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function payDetailRows(d: PayDetail): { k: string; v: string }[] {
  const rows = [
    { k: t('pay_result_order_no'), v: d.orderNo },
    { k: t('pay_result_plan'), v: d.plan || '' },
    { k: t('pay_result_amount'), v: d.amount || '' },
    { k: t('pay_result_paid_at'), v: d.paidAt || '' },
    { k: t('pay_result_expires_at'), v: d.expiresAt || '' },
  ]
  return rows.filter((r) => r.v)
}

// ===== Plan Selection → Payment Flow =====
function selectPlan(plan: PricingPlan | null) {
  if (!plan) {
    toast.show(t('ft_building'), 'info')
    return
  }
  if (plan.name.toLowerCase() === 'free' || plan.priceMonthly === 0) {
    toast.show(t('already_free'), 'info')
    return
  }
  selectedPlan.value = { id: plan.id, name: plan.displayName || plan.name, price: plan.priceMonthly }
  emit('switch-modal', 'payment')
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
  try {
    // 有效期必须读服务端订阅真实到期（续费是叠加延长，不能用支付时间+1月硬算）
    const subRes = await api<any>('GET', '/api/subscriptions/current')
    const end = subRes.ok ? subRes.data?.subscription?.current_period_end : null
    if (end) detail.expiresAt = formatDateTime(end)
  } catch {
    /* 同上 */
  }
  if (selectedPlan.value) detail.plan = selectedPlan.value.name
  paymentResult.value = { kind: 'success', message: t('pay_paid_ok'), detail }
  emit('switch-modal', 'payment-result')
}
</script>

<template>
  <!-- Pricing -->
  <ModalDialog :open="showModalType === 'pricing'" :title="t('modal_pricing')" max-width="560px" @close="emit('close')">
    <div class="pricing-grid">
      <div
        v-for="entry in orderedPlans"
        :key="entry.key"
        class="price-card"
        :class="{ popular: entry.key === 'pro' }"
        @click="selectPlan(entry.plan)"
      >
        <div v-if="entry.key === 'pro'" class="pc-tag">{{ t('price_popular') }}</div>
        <div class="pc-name">{{ planName(entry.key) }}</div>
        <div class="pc-price">
          {{ planPrice(entry.plan) }}<span class="pc-period">{{ t('price_per_mo') }}</span>
        </div>
        <div class="pc-feats">
          <template v-for="feat in FEATURE_KEYS[entry.key]" :key="feat">
            ✓ {{ t(feat) }}<br />
          </template>
        </div>
      </div>
    </div>
  </ModalDialog>

  <!-- Payment Method -->
  <!-- 只提供支付宝：微信支付需已认证公众号（300 元/年），成本不允许，产品决策不接入 -->
  <ModalDialog :open="showModalType === 'payment'" :title="t('modal_payment')" max-width="420px" @close="emit('close')">
    <div v-if="selectedPlan" class="pay-summary">
      <div class="pay-summary-name">{{ selectedPlan.name }}</div>
      <div class="pay-summary-price">
        ¥{{ selectedPlan.price }}<span class="pay-summary-period">{{ t('price_per_mo') }}</span>
      </div>
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
      :amount-label="`¥${selectedPlan.price}`"
      :period-label="t('price_per_mo')"
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
.pricing-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
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
.price-card {
  padding: 20px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  cursor: pointer;
  position: relative;
}
.price-card:hover {
  border-color: var(--accent);
}
.price-card.popular {
  border-color: var(--accent);
  background: var(--accent-light);
}
.pc-tag {
  position: absolute;
  top: -8px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 10px;
  font-weight: 600;
  color: var(--text-inverse);
  background: var(--accent);
  padding: 2px 10px;
  border-radius: 8px;
}
.pc-name {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.pc-price {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 12px;
}
.pc-period {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-tertiary);
}
.pc-feats {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.8;
}

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
