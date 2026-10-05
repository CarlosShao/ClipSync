// @vitest-environment jsdom
/**
 * 订阅支付单弹窗（2026-10-05 改版）的界面回归。
 *
 * owner 的原话是「支付界面太土，一个弹窗全干完」，但这次改版真正的价值在两件**判据**上，
 * 界面好不好看只能靠眼睛，这两条却能钉死：
 *   ① 折抵明细必须**点升级那一刻**就在（走只读试算接口，不是靠先建一条 pending 单换来的）；
 *   ② 二维码旁显示的应付金额必须是**折抵后的差额**，不是目录标价
 *      —— 旧实现显示标价，于是「界面 ¥19.90 / 订单 ¥19.89」对不上（owner 实测）。
 *
 * 另外钉住两个刻意的取舍：
 *   · 微信支付是**禁用占位**（「暂未开放」），不是可点会报错的假按钮；
 *   · 试算失败**不阻断支付**（实付以订单为准），只是明细区说明读不到。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPricingPlans: vi.fn(),
  fetchUpgradeQuote: vi.fn(),
  fetchOrderStatus: vi.fn(),
  createPaymentOrder: vi.fn(),
  api: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('@/api/payment', () => ({
  fetchUpgradeQuote: mocks.fetchUpgradeQuote,
  fetchOrderStatus: mocks.fetchOrderStatus,
  createPaymentOrder: mocks.createPaymentOrder,
}))

// 只替换价格目录，其余（invalidatePlanLimits 等）用真实实现
vi.mock('@/composables/usePlanLimits', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getPricingPlans: mocks.getPricingPlans }
})

vi.mock('@/composables/useSonner', () => ({
  useSonner: () => ({ show: mocks.toast, loading: vi.fn(), dismiss: vi.fn(), rateLimited: vi.fn() }),
}))

vi.mock('@/composables/useMenuAccess', () => ({
  useMenuAccess: () => ({
    can: () => true,
    modeOf: () => 'ok',
    setOverrides: vi.fn(),
    resetOverrides: vi.fn(),
  }),
}))

vi.mock('@/api/client', () => ({ api: mocks.api }))

import { createApp, h, nextTick, ref, type Component } from 'vue'
import { createPinia } from 'pinia'
import PricingPaymentModals from '../PricingPaymentModals.vue'
import { useI18n } from '@/composables/useI18n'
import type { PricingPlan } from '@/composables/usePlanLimits'
import type { UpgradeQuote } from '@/api/payment'

const { t } = useI18n()

const PLANS: PricingPlan[] = [
  { id: 'free-id', name: 'Free', displayName: '免费版', priceMonthly: 0, priceYearly: 0 },
  { id: 'pro-id', name: 'Pro', displayName: '专业版', priceMonthly: 9.9, priceYearly: 99 },
  { id: 'ent-id', name: 'Enterprise', displayName: '企业版', priceMonthly: 19.9, priceYearly: 199 },
]

/** 生产现场的真实形状：Pro 实付 ¥0.01，折抵 ¥0.01，企业版 ¥19.90 ⇒ 差额 ¥19.89 */
const quoteFixture = (over: Partial<UpgradeQuote> = {}): UpgradeQuote => ({
  planId: 'ent-id',
  planName: 'Enterprise',
  billingCycle: 'monthly',
  currency: 'CNY',
  originalPrice: 19.9,
  creditAmount: 0.01,
  finalAmount: 19.89,
  paidAmount: 0.01,
  usedAmount: 0,
  creditSource: 'order',
  remainingDays: 45.22,
  cycleDays: 61,
  currentPeriodStart: '2026-09-19T08:07:40.000Z',
  currentPeriodEnd: '2026-11-19T08:07:40.000Z',
  oldSubscriptionId: 'sub-1',
  oldPlanId: 'pro-id',
  floorApplied: false,
  forfeitAmount: 0,
  ...over,
})

async function tick(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

let unmountFlow: (() => void) | null = null

/**
 * 挂载整个弹窗流（含真实 PlanCards），并接住 switch-modal —— 与 HomeView 的接线方式一致：
 * 弹窗只抛事件，由父级改 showModalType。
 */
function mountFlow() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const modalType = ref('pricing')
  const switches: string[] = []
  const app = createApp({
    render: () =>
      h(PricingPaymentModals as Component, {
        showModalType: modalType.value,
        onSwitchModal: (type: string) => {
          switches.push(type)
          modalType.value = type
        },
        onClose: () => {
          modalType.value = ''
        },
      }),
  })
  app.use(createPinia())
  app.mount(host)
  unmountFlow = () => {
    app.unmount()
    host.remove()
  }
  return { modalType, switches }
}

/** 套餐三卡里第 3 张（企业版）的 CTA —— PLAN_ORDER_KEYS 顺序是 free/pro/enterprise */
function enterpriseCta(): HTMLButtonElement {
  const cards = document.querySelectorAll('.pc-card')
  const cta = cards[2]?.querySelector('.pc-cta') as HTMLButtonElement
  if (!cta) throw new Error('企业版 CTA 未渲染')
  return cta
}

async function enterCheckout() {
  const flow = mountFlow()
  await tick(8)
  enterpriseCta().click()
  await tick(8)
  return flow
}

const bodyText = () => document.body.textContent || ''

beforeEach(() => {
  document.body.innerHTML = ''
  mocks.getPricingPlans.mockReset().mockResolvedValue(PLANS)
  mocks.fetchUpgradeQuote.mockReset()
  mocks.api.mockReset().mockResolvedValue({ ok: false, status: 0 })
  mocks.fetchOrderStatus.mockReset()
  mocks.createPaymentOrder.mockReset()
})

afterEach(() => {
  unmountFlow?.()
  unmountFlow = null
})

describe('单弹窗结账流 · 试算的调用时机与参数', () => {
  it('点企业版「升级」→ 切到 checkout，并**立刻**用与下单相同的 { planId, billingCycle } 拉试算', async () => {
    mocks.fetchUpgradeQuote.mockResolvedValue({ ok: true, status: 200, data: { quote: quoteFixture() } })

    const flow = await enterCheckout()

    expect(flow.switches).toContain('checkout')
    expect(mocks.fetchUpgradeQuote).toHaveBeenCalledTimes(1)
    // 必须与 AlipayScanPay 下发给 create-order 的参数一致，否则「试算 == 实收」在客户端这层就断了
    expect(mocks.fetchUpgradeQuote).toHaveBeenCalledWith({ planId: 'ent-id', billingCycle: 'monthly' })
    // 关键：进 checkout 就拉明细，**没有**建任何订单
    expect(mocks.createPaymentOrder).not.toHaveBeenCalled()
  })
})

describe('单弹窗结账流 · 折抵明细', () => {
  it('四项分解 + 差额都渲染出来（实付/已使用/剩余可抵扣/当前有效期）', async () => {
    mocks.fetchUpgradeQuote.mockResolvedValue({ ok: true, status: 200, data: { quote: quoteFixture() } })
    await enterCheckout()

    const text = bodyText()
    expect(text).toContain(t('checkout_current_plan'))
    expect(text).toContain(t('checkout_paid_amount'))
    expect(text).toContain(t('checkout_used_amount'))
    expect(text).toContain(t('checkout_credit_amount'))
    expect(text).toContain(t('checkout_current_expiry'))
    expect(text).toContain(t('checkout_due'))
    // 当前有效期至 = 服务端给的 currentPeriodEnd（本地日期）
    expect(text).toContain('2026-11-19')
    // 差额 = 折抵后的实付
    expect(text).toContain('¥19.89')
  })

  it('★二维码旁的应付金额是**折抵后差额**，不是目录标价 ¥19.90', async () => {
    mocks.fetchUpgradeQuote.mockResolvedValue({ ok: true, status: 200, data: { quote: quoteFixture() } })
    await enterCheckout()

    const amountValue = document.querySelector('.pay-scan-amount .value')
    expect(amountValue).not.toBeNull()
    expect(amountValue?.textContent).toContain('¥19.89')
    // 旧实现显示目录标价，这里必须不再是它
    expect(amountValue?.textContent).not.toContain('¥19.90')
  })

  it('残值高于新价：把**作废金额**写出来（owner 口径：继续作废，但必须可见）', async () => {
    mocks.fetchUpgradeQuote.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        quote: quoteFixture({
          paidAmount: 99,
          usedAmount: 9.9,
          creditAmount: 89.1,
          finalAmount: 0.01,
          floorApplied: true,
          forfeitAmount: undefined, // 旧后端不回传该字段 ⇒ 客户端本地兜底算
        }),
      },
    })
    await enterCheckout()

    const text = bodyText()
    expect(text).toContain('¥0.01')
    expect(text).toContain('69.21')
    expect(text).toContain('¥89.10')
  })

  it('无折抵（全价新订）时只列「升级后套餐」，不出现空荡荡的「当前套餐」段', async () => {
    mocks.fetchUpgradeQuote.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        quote: quoteFixture({
          paidAmount: null,
          usedAmount: null,
          creditSource: null,
          creditAmount: 0,
          finalAmount: 19.9,
          currentPeriodEnd: null,
          floorApplied: false,
          forfeitAmount: null,
        }),
      },
    })
    await enterCheckout()

    const text = bodyText()
    expect(text).toContain(t('checkout_new_plan'))
    expect(text).not.toContain(t('checkout_current_plan'))
    expect(text).toContain('¥19.90')
  })

  it('赠期订阅（creditSource=plan）要说清「按套餐标价折算」，不能读成「你付过钱」', async () => {
    mocks.fetchUpgradeQuote.mockResolvedValue({
      ok: true,
      status: 200,
      data: { quote: quoteFixture({ creditSource: 'plan', paidAmount: 9.9, creditAmount: 4.95, finalAmount: 14.95 }) },
    })
    await enterCheckout()

    expect(bodyText()).toContain(t('checkout_credit_by_plan'))
  })
})

describe('单弹窗结账流 · 渠道与降级', () => {
  it('微信支付是**禁用占位**：不是按钮、带「暂未开放」，点不动也发不出请求', async () => {
    mocks.fetchUpgradeQuote.mockResolvedValue({ ok: true, status: 200, data: { quote: quoteFixture() } })
    await enterCheckout()

    const wechat = document.querySelector('.co-channel--disabled')
    expect(wechat).not.toBeNull()
    expect(wechat?.textContent).toContain(t('pay_wechat'))
    expect(wechat?.textContent).toContain(t('checkout_channel_disabled'))
    // 刻意用 div 而非 button/可点元素：假按钮属于产品诚信问题，本仓库一贯拒绝
    expect(wechat?.tagName.toLowerCase()).toBe('div')

    // 支付宝是唯一激活渠道
    expect(document.querySelector('.co-channel--active')?.textContent).toContain(t('pay_alipay'))
  })

  it('试算失败**不阻断支付**：明细区如实说明，协议勾选框仍在（实付以订单为准）', async () => {
    mocks.fetchUpgradeQuote.mockResolvedValue({
      ok: false,
      status: 503,
      error: 'Subscription feature is disabled by administrator',
      data: { code: 'SUBSCRIPTION_DISABLED' },
    })
    await enterCheckout()

    expect(bodyText()).toContain(t('checkout_quote_failed'))
    expect(bodyText()).toContain(t('checkout_quote_fallback'))
    // 支付面板照常渲染（协议门才是下单的闸）
    expect(document.querySelector('.qr-mask')).not.toBeNull()
    // 拿不到试算 ⇒ 退回目录标价展示，不显示一个凭空捏造的差额
    expect(document.querySelector('.pay-scan-amount .value')?.textContent).toContain('¥19.90')
  })
})
