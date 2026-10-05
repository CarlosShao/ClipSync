<script setup lang="ts">
/**
 * 订阅支付弹窗流（2026-10-05 改版：单弹窗 checkout）。
 *
 * 结构：
 *   pricing   —— 套餐三卡（PlanCards，1000px）
 *   checkout  —— **一个弹窗干完全部**：左＝折抵明细，右＝支付方式 + 二维码；
 *                支付成功后同一个弹窗切成结果页
 *
 * 为什么合成一个（owner 2026-10-05「支付界面太土，一个弹窗直接就全干了」）：
 *   旧流程是「套餐卡 → 支付方式（只列支付宝）→ 扫码 → 结果」四个弹窗接力，
 *   每一步都要用户重新读一遍上下文；而且「选择支付方式」那一步显示的是**目录标价**，
 *   与实付（折抵后的差额）对不上 —— 用户看到企业版 ¥19.9、订单却是 ¥19.89。
 *
 * 折抵明细来自 POST /api/payments/upgrade-quote（**只读试算，不建单**），
 * 进入 checkout 时立即拉取，所以「点升级」那一刻明细就在了；不用 create-order 换明细，
 * 是因为那会提前造一条 pending 单，与 95s 过期 / 24h 关单扫描 / 开关关闭不建单三条语义打架。
 * 服务端两个端点共用同一段 resolveOrderPricing()，故试算金额逐分等于实收
 *（tests/upgrade-quote.test.js 钉死）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import AlipayScanPay from '@/components/payment/AlipayScanPay.vue'
import {
  estimatePeriodEnd,
  forfeitAmount as calcForfeitAmount,
  hasProration as calcHasProration,
  payableAmount,
} from '@/components/payment/checkoutMath'
import PlanCards from '@/components/pricing/PlanCards.vue'
import { CircleCheck, Clock, Landmark, MessageCircle } from 'lucide-vue-next'
import type { PricingPlan } from '@/composables/usePlanLimits'
import { invalidatePlanLimits } from '@/composables/usePlanLimits'
import { fetchOrderStatus, fetchUpgradeQuote, type UpgradeQuote } from '@/api/payment'
import { api } from '@/api/client'
import { useConfigStore } from '@/stores/configStore'
import { useMenuAccess } from '@/composables/useMenuAccess'
import { cycleLabelKey, invalidateCurrentSubscription, type BillingCycle } from '@/composables/useSubscriptionAccess'
import './modal-shared.css'

const props = defineProps<{ showModalType: string }>()
const emit = defineEmits<{ close: []; 'switch-modal': [type: string] }>()

const { t } = useI18n()
const configStore = useConfigStore()
// 弹窗流自身也过能力判定：入口（侧栏/设置/订阅页）已用 can('nav.subscription')，
// 这里再兜一层 —— enable_subscription 运行中被关掉时，已挂载的弹窗不再给出购买卡。
const { can } = useMenuAccess()

// ===== 套餐目录/档位判定已收敛到 PlanCards（与设置子页、订阅页同一套只升不降规则）=====

// Plan selection state (for pricing → checkout flow)
interface SelectedPlan {
  id: string
  name: string
  price: number
  cycle: BillingCycle
}
const selectedPlan = ref<SelectedPlan | null>(null)

// ===== 折抵试算（左栏明细的唯一数据来源）=====
const quote = ref<UpgradeQuote | null>(null)
const quoteLoading = ref(false)
const quoteError = ref('')

/**
 * 升级折抵明细（来自下单响应；结果页展示「原价/折抵/实付」）。
 * 没拿到就是 null —— 结果页相应行不渲染，绝不伪造折抵金额。
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

const selectedPeriodLabel = computed(() => (selectedPlan.value ? t(cycleLabelKey(selectedPlan.value.cycle)) : ''))

/** 服务端回的是 ISO 串；本地算「预计到期」时直接给 Date。两种都收，避免调用方各自 new。 */
function formatDateTime(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function money(v: number | null | undefined): string {
  return `¥${Number(v ?? 0).toFixed(2)}`
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

/**
 * 拉试算。参数**必须与 AlipayScanPay 下发给 create-order 的一致**
 *（父组件不传 subscriptionId ⇒ 两个端点都走 { planId, billingCycle }），
 * 否则「试算 == 实收」这条不变量会在客户端这一层被破坏。
 */
async function loadQuote() {
  const p = selectedPlan.value
  if (!p) return
  quote.value = null
  quoteError.value = ''
  quoteLoading.value = true
  try {
    const res = await fetchUpgradeQuote({ planId: p.id, billingCycle: p.cycle })
    if (res.ok && res.data?.quote) {
      quote.value = res.data.quote
    } else {
      // 失败不阻断支付：实付以订单为准（create-order 有同一套判定，会给出自己的错）
      quoteError.value = res.error || ''
    }
  } catch (e: any) {
    quoteError.value = e?.message || ''
  } finally {
    quoteLoading.value = false
  }
}

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
  paymentResult.value = null
  emit('switch-modal', 'checkout')
}

// 进入 checkout 立即拉明细（「点升级」那一刻就要看得见）
watch(
  () => props.showModalType,
  (v) => {
    if (v === 'checkout') void loadQuote()
  },
  { immediate: true },
)

/** 是否有折抵（无生效订阅 / 全价新订时为 false ⇒ 左栏只列「升级后套餐」） */
const hasProration = computed(() => calcHasProration(quote.value))

/**
 * 因 0.01 下限而不予结转的金额。口径与兜底见 checkoutMath.forfeitAmount。
 */
const forfeitAmount = computed(() => calcForfeitAmount(quote.value))

/**
 * 「新套餐有效期至」**只能是预计**：履约侧是「从 NOW() 起完整一个 billingCycle」
 *（orderFulfillment.js:213-214），所以下单前算不出精确值。
 * 标签里已写「（预计）」，支付成功后结果页显示服务端回传的真实到期时间。
 */
const estimatedExpiry = computed(() => {
  const p = selectedPlan.value
  if (!p) return ''
  return formatDateTime(estimatePeriodEnd(p.cycle)).slice(0, 10)
})

function dateOnly(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return formatDateTime(d).slice(0, 10)
}

/**
 * 二维码上方展示的应付金额：有试算就用**折抵后的差额**，否则退回目录标价。
 * 旧实现恒传目录标价，正是「界面写 ¥19.9、订单 ¥19.89」对不上的原因。
 */
const payableLabel = computed(() => money(payableAmount(quote.value, selectedPlan.value?.price ?? 0)))

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

/** 扫码支付成功：拉订单终态 + 真实订阅到期时间，同一个弹窗切成结果页 */
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
  // 折抵明细取自**订单自身**的 proration（下单那一刻锁定的口径），优先于试算
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
}

const checkoutTitle = computed(() => {
  if (!paymentResult.value) return t('checkout_title')
  if (paymentResult.value.kind === 'success') return t('sub_result_success')
  if (paymentResult.value.kind === 'pending') return t('sub_result_pending')
  return t('sub_result_fail')
})
</script>

<template>
  <!-- Pricing：套餐三卡（唯一外部入口是 'pricing'） -->
  <ModalDialog
    :open="showModalType === 'pricing'"
    :title="t('modal_pricing')"
    max-width="1000px"
    @close="emit('close')"
  >
    <!-- enable_subscription 关闭：不给购买入口，也不报错——按「功能建设中」如实占位 -->
    <PlanCards v-if="can('nav.subscription')" @select="onPlanSelect" />
    <div v-else class="modal-state">{{ t('ft_building') }}</div>
  </ModalDialog>

  <!-- Checkout：左＝折抵明细，右＝支付方式 + 二维码；支付成功后原地切结果页 -->
  <ModalDialog :open="showModalType === 'checkout'" :title="checkoutTitle" max-width="780px" @close="emit('close')">
    <!-- ① 支付成功/失败结果页（同一个弹窗，不再另开一个） -->
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

    <!-- ② 结账：左右分栏 -->
    <div v-else-if="selectedPlan" class="co-cols">
      <!-- 左栏：折抵明细 -->
      <div class="co-left">
        <div v-if="quoteLoading" class="co-state">{{ t('checkout_quote_loading') }}</div>

        <div v-else-if="quote" class="co-body">
          <section v-if="hasProration" class="co-block">
            <div class="co-block-title">{{ t('checkout_current_plan') }}</div>
            <dl class="co-rows">
              <dt>{{ t('checkout_paid_amount') }}</dt>
              <dd>{{ money(quote.paidAmount) }}</dd>
              <dt>{{ t('checkout_used_amount') }}</dt>
              <dd>{{ money(quote.usedAmount) }}</dd>
              <dt>{{ t('checkout_credit_amount') }}</dt>
              <dd class="co-credit">{{ money(quote.creditAmount) }}</dd>
              <dt>{{ t('checkout_current_expiry') }}</dt>
              <dd>{{ dateOnly(quote.currentPeriodEnd) }}</dd>
            </dl>
            <!-- 赠期/mock 订阅没有支付记录，折抵基准是套餐标价 —— 必须说清楚，
                 不能让它读起来像「你付过这笔钱」 -->
            <p v-if="quote.creditSource === 'plan'" class="co-note">
              {{ t('checkout_credit_by_plan') }}
            </p>
          </section>

          <section class="co-block">
            <div class="co-block-title">{{ t('checkout_new_plan') }}</div>
            <dl class="co-rows">
              <dt>{{ t('checkout_new_price') }}</dt>
              <dd>{{ money(quote.originalPrice) }}</dd>
              <dt>{{ t('checkout_new_expiry') }}</dt>
              <dd>{{ estimatedExpiry }}</dd>
            </dl>
          </section>

          <div class="co-due">
            <span>{{ t('checkout_due') }}</span>
            <strong>{{ money(quote.finalAmount) }}</strong>
          </div>

          <!-- owner 2026-10-05 口径：残值高于新价时超出部分作废，但必须写出来
               （否则用户自己一算「剩 ¥89.10 为何只付 ¥0.01」就是一笔糊涂账） -->
          <p v-if="forfeitAmount > 0" class="co-note co-note--warn">
            {{ t('checkout_forfeit', { amount: money(forfeitAmount) }) }}
          </p>
        </div>

        <div v-else class="co-body">
          <div class="co-state co-state--warn">{{ t('checkout_quote_failed') }}</div>
          <p v-if="quoteError" class="co-note co-note--warn">{{ quoteError }}</p>
          <p class="co-note">{{ t('checkout_quote_fallback') }}</p>
        </div>
      </div>

      <!-- 右栏：支付方式 + 二维码 -->
      <div class="co-right">
        <div class="co-plan">
          <span class="co-plan-name">{{ selectedPlan.name }}</span>
          <span class="co-plan-cycle">{{ selectedPeriodLabel }}</span>
        </div>

        <!-- 旧「支付方式」步的摘要里有这一句，2026-10-05 改单弹窗时被我漏掉了。
             它出现在「即将付钱」这一刻最有价值：本产品**无自动续费**，不能让人在付款前
             以为会被连续扣款（PlanCards 的 BillingCycleToggle 上也有，但那是上一步）。 -->
        <p class="co-once-note">{{ t('cycle_once_note') }}</p>

        <!-- 渠道：目前只接入支付宝。微信是**禁用占位**，不是可点入口 ——
             不放「可点但报错」的假按钮（产品诚信面），也不发任何请求。 -->
        <div class="co-channels">
          <div class="co-channel co-channel--active">
            <Landmark class="pay-icon pay-icon--alipay" />
            <span>{{ t('pay_alipay') }}</span>
          </div>
          <div class="co-channel co-channel--disabled">
            <MessageCircle class="pay-icon pay-icon--wechat" />
            <span>{{ t('pay_wechat') }}</span>
            <em class="co-channel-tag">{{ t('checkout_channel_disabled') }}</em>
          </div>
        </div>

        <AlipayScanPay
          v-if="selectedPlan"
          :plan-id="selectedPlan.id"
          :billing-cycle="selectedPlan.cycle"
          :amount-label="payableLabel"
          :period-label="selectedPeriodLabel"
          hide-footer
          @order-created="onOrderCreated"
          @paid="onPaid"
          @close="emit('close')"
        />
      </div>
    </div>

    <div v-else class="modal-state">{{ t('ft_building') }}</div>
  </ModalDialog>
</template>

<style scoped>
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

/* ===== checkout 左右分栏 ===== */
.co-cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.co-left,
.co-right {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.co-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.co-block {
  padding: 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
}
.co-block-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.co-rows {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 12px;
  margin: 0;
  font-size: 12.5px;
}
.co-rows dt {
  color: var(--text-tertiary);
}
.co-rows dd {
  margin: 0;
  text-align: right;
  color: var(--text-primary);
}
/* 剩余可抵扣是用户最关心的一格，给它成功色 */
.co-credit {
  color: var(--success);
  font-weight: 600;
}
.co-due {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  font-size: 12.5px;
  color: var(--text-tertiary);
}
.co-due strong {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
}
.co-note {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-tertiary);
}
.co-note--warn {
  color: var(--warning);
}
.co-state {
  font-size: 12.5px;
  color: var(--text-tertiary);
  padding: 8px 0;
}
.co-state--warn {
  color: var(--warning);
}

/* ===== 右栏 ===== */
.co-plan {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.co-plan-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.co-plan-cycle {
  font-size: 12px;
  color: var(--text-tertiary);
}
/* 「一次性购买、不会自动扣款」——付款前这一刻的定心丸，别再漏掉 */
.co-once-note {
  margin: -4px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-tertiary);
}
.co-channels {
  display: flex;
  gap: 8px;
}
.co-channel {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  font-size: 13px;
  color: var(--text-primary);
}
.co-channel--active {
  border-color: var(--accent);
}
.co-channel--disabled {
  opacity: 0.55;
}
.co-channel-tag {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
  font-size: 10px;
  font-style: normal;
}
.pay-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

/* ===== 结果页 ===== */
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
