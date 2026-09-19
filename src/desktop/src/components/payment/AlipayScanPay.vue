<script setup lang="ts">
/**
 * 支付宝扫码支付面板（TRAE 式交互）。
 *
 * 交互流程（对照 TRAE 的会员升级弹窗）：
 *   1. 未勾选协议 → 二维码区域是**遮罩**，提示「勾选协议后显示二维码」
 *   2. 勾选协议 → 露出二维码（由支付宝收银台 iframe 渲染，qr_pay_mode=4）
 *   3. 用户扫码付款 → 前端**轮询**订单状态
 *   4. 轮询到 paid → 父组件关闭遮罩并提示开通成功
 *
 * 为什么用 iframe 而不是自己画二维码：
 *   支付宝「电脑网站支付」**不返回二维码码串**（返回码串的 alipay.trade.precreate
 *   是线下「当面付/订单码支付」产品，需要实体门店照片，本项目不能用）。
 *   官方对 qr_pay_mode 前置模式的定位就是「商户以 iframe 请求支付宝页面」，
 *   因此这是唯一合规路径。iframe 所需域名已在 tauri.conf.json 的 frame-src 放行。
 *
 * 二维码有效期约 120 秒（官方固定，不可修改），超时需重新下单 —— 见 expired 分支。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import Checkbox from '@/components/ui/checkbox/Checkbox.vue'
import Button from '@/components/ui/button/Button.vue'
import { createPaymentOrder, fetchOrderStatus } from '@/api/payment'
import type { BillingCycle } from '@/composables/useSubscriptionAccess'

const props = defineProps<{
  /** 要开通的套餐 id（新订） */
  planId?: string
  /** 已有订阅 id（升级场景）；与 planId 二选一 */
  subscriptionId?: string
  /**
   * 计费周期（月付/年付），透传服务端 create-order。
   * 缺省 'monthly' —— 与服务端默认值一致，老调用方不传也不会改变行为。
   */
  billingCycle?: BillingCycle
  /** 展示用金额与周期文案 */
  amountLabel?: string
  periodLabel?: string
}>()

const emit = defineEmits<{
  paid: [orderNo: string]
  close: []
  /** 下单成功：把服务端原始 order 交给父组件（升级折抵 metadata.proration 由父组件展示） */
  orderCreated: [order: any]
}>()

const { t } = useI18n()

/**
 * 下单失败的档位类错误（服务端 409 code）→ 本地文案。
 * 桌面端 UI 已做「只升不降」，正常路径走不到这两个码；它们存在是给
 * 多设备并发下单/缓存过期等竞态留一条诚实说明，而不是把英文原文糊给用户。
 */
const ORDER_ERROR_KEYS: Record<string, string> = {
  ALREADY_SUBSCRIBED: 'pay_err_already_subscribed',
  DOWNGRADE_NOT_ALLOWED: 'pay_err_downgrade_not_allowed',
}
function orderErrorMessage(res: { error?: string; data?: any }): string {
  const code = String(res.data?.code || '')
  const key = ORDER_ERROR_KEYS[code]
  if (key) return t(key)
  return res.error || t('pay_scan_failed')
}

const agreed = ref(false)
const loading = ref(false)
const cashierUrl = ref('')
const orderNo = ref('')
const errorMsg = ref('')
/** 轮询超时（码失效后转 expired 态，见 PAY_TIMEOUT_MS 注释） */
const expired = ref(false)

/**
 * 轮询超时：支付宝实测报文 qrExpirySeconds=99（收银台 HTML 隐藏域），
 * 码 99s 即失效；旧值 150s 会留 51s「假活码」。取 95s 留 4s 余量，
 * 到期立即转过期态引导重新下单。
 */
const PAY_TIMEOUT_MS = 95_000
const POLL_INTERVAL_MS = 3_000

let pollTimer: ReturnType<typeof setInterval> | null = null
let expireTimer: ReturnType<typeof setTimeout> | null = null

function stopTimers() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (expireTimer) {
    clearTimeout(expireTimer)
    expireTimer = null
  }
}

onUnmounted(stopTimers)

/** 下单拿收银台 URL */
async function createOrder() {
  loading.value = true
  errorMsg.value = ''
  expired.value = false
  try {
    const res = await createPaymentOrder(
      props.subscriptionId
        ? { subscriptionId: props.subscriptionId, billingCycle: props.billingCycle ?? 'monthly' }
        : { planId: props.planId, billingCycle: props.billingCycle ?? 'monthly' },
      'alipay',
    )

    if (!res.ok) {
      errorMsg.value = orderErrorMessage(res)
      return
    }

    const order: any = (res.data as any)?.order
    const url = order?.paymentParams?.cashierUrl
    if (!url) {
      errorMsg.value = t('pay_scan_failed')
      return
    }
    // 透传完整响应体：升级折抵 proration 在服务端响应的**顶层**（不在 order 里）
    emit('orderCreated', res.data)
    cashierUrl.value = url
    orderNo.value = order.orderNo
    startPolling()
    startExpiry()
  } catch (e: any) {
    errorMsg.value = e?.message || t('pay_scan_failed')
  } finally {
    loading.value = false
  }
}

/** 轮询订单状态；服务端会顺带主动查一次支付宝做兜底 */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    if (!orderNo.value) return
    try {
      const res = await fetchOrderStatus(orderNo.value)
      if (!res.ok) return // 网络抖动：继续轮询，不打扰用户
      const status = (res.data as any)?.order?.status
      if (status === 'paid') {
        stopTimers()
        emit('paid', orderNo.value)
      } else if (status === 'cancelled' || status === 'failed') {
        stopTimers()
        errorMsg.value = t('pay_expired')
      }
    } catch {
      /* 轮询失败静默重试 */
    }
  }, POLL_INTERVAL_MS)
}

function startExpiry() {
  if (expireTimer) clearTimeout(expireTimer)
  expireTimer = setTimeout(() => {
    stopTimers()
    expired.value = true
  }, PAY_TIMEOUT_MS)
}

/** 勾选协议后才下单/展示二维码（与 TRAE 一致：先同意再出码） */
async function onAgreeChange(v: boolean | 'indeterminate') {
  agreed.value = v === true
  if (agreed.value && !cashierUrl.value && !loading.value) {
    await createOrder()
  }
}

/** 重新获取二维码（过期后） */
async function retry() {
  cashierUrl.value = ''
  orderNo.value = ''
  await createOrder()
}

// 组件挂载即预取？不 —— 必须等用户勾选协议，符合合规要求（不得默认同意）
defineExpose({ retry })

const showMask = computed(() => !agreed.value || loading.value || !!errorMsg.value || expired.value)
</script>

<template>
  <div class="pay-scan">
    <!-- 金额 -->
    <div v-if="amountLabel" class="pay-scan-amount">
      <span class="label">{{ t('pay_amount') }}</span>
      <span class="value">
        {{ amountLabel }}<span v-if="periodLabel" class="period">{{ periodLabel }}</span>
      </span>
    </div>

    <!-- 二维码区（遮罩 / iframe / 错误 / 过期） -->
    <div class="qr-box">
      <template v-if="loading">
        <div class="qr-placeholder">{{ t('pay_scan_loading') }}</div>
      </template>

      <template v-else-if="errorMsg">
        <div class="qr-placeholder qr-error">
          <p>{{ errorMsg }}</p>
          <Button variant="outline" size="sm" @click="retry">{{ t('pay_retry') }}</Button>
        </div>
      </template>

      <template v-else-if="expired">
        <div class="qr-placeholder qr-error">
          <p>{{ t('pay_expired') }}</p>
          <Button variant="outline" size="sm" @click="retry">{{ t('pay_retry') }}</Button>
        </div>
      </template>

      <template v-else-if="!agreed">
        <!-- 未勾选协议：遮罩盖住二维码 -->
        <div class="qr-placeholder qr-mask">
          <p>{{ t('pay_scan_need_agree') }}</p>
        </div>
      </template>

      <template v-else-if="cashierUrl">
        <!--
          支付宝收银台：qr_pay_mode=4 时该页面直接渲染可定义宽度的二维码。
          sandbox 允许脚本与同源表单提交（收银台自身需要）；不放 allow-popups 之外的权限。

          居中方案（2026-09-19 两轮实测得出）：支付宝前置页的二维码**贴页面
          左上角渲染**（.qrcode-mini-content.fn-left 左浮动），且页面内容略大于
          二维码本体。iframe 直接收窄到二维码尺寸会撑出滚动条；放大 iframe 再
          flex 居中则二维码偏左。故用固定 240×240 iframe（内容完整不滚动）+
          204×204 overflow-hidden 裁剪窗框住左上角二维码，由外层 flex 居中裁剪窗。
        -->
        <div class="qr-clip">
          <iframe
            :src="cashierUrl"
            class="qr-frame"
            :title="t('pay_qr_alt')"
            sandbox="allow-scripts allow-forms allow-same-origin"
            referrerpolicy="no-referrer"
          />
        </div>
        <p class="qr-waiting">{{ t('pay_waiting') }}</p>
      </template>
    </div>

    <!-- 协议勾选（合规必需：不得默认勾选） -->
    <label class="agree-row">
      <Checkbox :model-value="agreed" @update:model-value="onAgreeChange" />
      <span class="agree-text">
        {{ t('pay_agree_prefix') }}
        <a href="https://api.clipchain.top/terms-of-service.html" target="_blank" rel="noopener noreferrer">
          {{ t('pay_agree_tos') }}
        </a>
        {{ t('pay_agree_and') }}
        <a href="https://api.clipchain.top/privacy-policy.html" target="_blank" rel="noopener noreferrer">
          {{ t('pay_agree_privacy') }}
        </a>
      </span>
    </label>

    <div class="pay-scan-footer">
      <Button variant="ghost" @click="emit('close')">{{ t('pay_close') }}</Button>
    </div>
  </div>
</template>

<style scoped>
.pay-scan {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.pay-scan-amount {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 12px 14px;
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
}
.pay-scan-amount .label {
  font-size: 13px;
  color: var(--text-secondary);
}
.pay-scan-amount .value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
}
.pay-scan-amount .period {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-tertiary);
}

.qr-box {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-surface);
}

/* 裁剪窗：框住支付宝前置页左上角的 200px 二维码（qrcode_width=200，
   实测贴左上角渲染），204 留 4px 白边防切到码点。margin-top 补视觉居中。 */
.qr-clip {
  width: 204px;
  height: 204px;
  margin-top: 18px;
  overflow: hidden;
  border-radius: var(--radius-sm);
}

.qr-frame {
  width: 240px;
  height: 240px;
  display: block;
  border: 0;
  background: #fff;
}

.qr-placeholder {
  padding: 28px 20px;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
  line-height: 1.6;
}
.qr-mask {
  /* 遮罩观感：与 TRAE 一致，勾选协议前不显示二维码 */
  width: 100%;
  min-height: 240px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: repeating-linear-gradient(
    45deg,
    var(--bg-hover),
    var(--bg-hover) 10px,
    var(--bg-surface) 10px,
    var(--bg-surface) 20px
  );
}
.qr-error {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}

.qr-waiting {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.agree-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
  cursor: pointer;
}
.agree-text a {
  color: var(--accent);
  text-decoration: none;
}
.agree-text a:hover {
  text-decoration: underline;
}

.pay-scan-footer {
  display: flex;
  justify-content: flex-end;
}
</style>
