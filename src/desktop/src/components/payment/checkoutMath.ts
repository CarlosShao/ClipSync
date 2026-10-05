/**
 * 结账明细的纯计算（从 PricingPaymentModals.vue 抽出，便于单测）。
 *
 * 为什么单独一个文件：这几条直接决定**用户看到多少钱**，一旦漂移就是
 * 「界面写 ¥19.9、订单 ¥19.89」这类对不上的问题（2026-10-05 owner 实测反馈）。
 * 留在组件里只能靠肉眼看，抽出来才能用断言钉住。
 */
import type { UpgradeQuote } from '@/api/payment'
import type { BillingCycle } from '@/composables/useSubscriptionAccess'

/**
 * 分位取整。与服务端 services/proration.js 的 roundToCent 同口径：
 * 先把乘 100 后的浮点噪声按 12 位有效数字归一（9.9*3 这类会写成 989.9999999999999）再取整，
 * 避免客户端算出的「作废金额」比服务端差一分。
 */
export function roundToCent(amount: number): number {
  const n = Number(amount)
  if (!Number.isFinite(n)) return 0
  return Math.round(Number((n * 100).toPrecision(12))) / 100
}

/** 折抵是否成立：有生效订阅、服务端算出了实付基准（全价新订时 paidAmount 为 null ⇒ false） */
export function hasProration(quote: UpgradeQuote | null | undefined): boolean {
  return Boolean(quote && quote.paidAmount != null)
}

/** 实际被用掉的折抵 = min(残值, 新价 − 实付差额)。差额有 0.01 下限，故残值可能用不满。 */
export function consumedCredit(quote: UpgradeQuote): number {
  const credit = Number(quote.creditAmount) || 0
  const usable = Math.max(0, (Number(quote.originalPrice) || 0) - (Number(quote.finalAmount) || 0))
  return roundToCent(Math.min(credit, usable))
}

/**
 * 因 0.01 下限而**不予结转**的金额（owner 2026-10-05 口径：继续作废，但明细必须写明）。
 *
 * 服务端给了 forfeitAmount 就以服务端为准（唯一真相）；字段缺失（旧后端还没部署
 * 43e89093）时本地按同一公式兜底 —— 否则在「明细已上线、后端未部署」的窗口期，
 * 用户会看到「剩余可抵扣 ¥89.10，却只需付 ¥0.01」而界面上没有任何解释。
 */
export function forfeitAmount(quote: UpgradeQuote | null | undefined): number {
  if (!hasProration(quote)) return 0
  const q = quote as UpgradeQuote
  if (typeof q.forfeitAmount === 'number' && Number.isFinite(q.forfeitAmount)) return q.forfeitAmount
  return roundToCent(Math.max(0, (Number(q.creditAmount) || 0) - consumedCredit(q)))
}

/**
 * 二维码旁展示的应付金额：有试算就用**折抵后的差额**，否则退回目录标价。
 * 旧实现恒传目录标价，正是「界面 ¥19.9 / 订单 ¥19.89」对不上的原因。
 */
export function payableAmount(quote: UpgradeQuote | null | undefined, listPrice: number): number {
  const final = Number(quote?.finalAmount)
  if (quote && Number.isFinite(final)) return final
  return roundToCent(listPrice)
}

/**
 * 「新套餐有效期至」的预计值：履约侧是「从 NOW() 起完整一个 billingCycle」
 *（orderFulfillment.js:213-214），下单前算不出精确值，故只作预计展示（标签写「（预计）」）。
 *
 * 注：JS 的 setMonth 在月末会溢出（1/31 + 1 月 → 3/3），与 Postgres 的 INTERVAL 语义不同；
 * 这只影响一个标着「预计」的展示值，不参与任何金额计算，支付成功后结果页显示服务端真实到期时间。
 */
export function estimatePeriodEnd(cycle: BillingCycle, from: Date = new Date()): Date {
  const d = new Date(from.getTime())
  if (cycle === 'yearly') d.setFullYear(d.getFullYear() + 1)
  else d.setMonth(d.getMonth() + 1)
  return d
}
