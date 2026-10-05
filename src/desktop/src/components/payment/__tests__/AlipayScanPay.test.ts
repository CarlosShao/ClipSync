// @vitest-environment jsdom
/**
 * 支付宝扫码面板的行为护栏（2026-10-05 补）。
 *
 * 这块此前**零测试覆盖**，而它是唯一碰钱的界面：勾选协议才下单、95s 过期、3s 轮询。
 * 一旦有人在重构里挪动勾选门或轮询，用户可能「没同意协议就出码」或「付了钱界面不认」，
 * 而这两种都不会被类型检查发现。
 *
 * 覆盖：
 *   ① 未勾选协议 → **绝不下单**（合规门，注释里写着「不得默认同意」）
 *   ② 勾选 → 下单一次、把原始响应交给父组件（升级折抵 proration 在顶层）、iframe 出码
 *   ③ 轮询命中 paid → emit paid(orderNo)
 *   ④ 轮询命中 cancelled → 过期文案 + 重试按钮（不是一直转圈）
 *   ⑤ 95s 码失效 → 过期态
 *   ⑥ 下单失败（409 ALREADY_SUBSCRIBED）→ 中文文案，不糊英文原文
 *   ⑦ hideFooter（内嵌单弹窗用）只影响底部按钮
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createPaymentOrder: vi.fn(),
  fetchOrderStatus: vi.fn(),
}))

vi.mock('@/api/payment', () => ({
  createPaymentOrder: mocks.createPaymentOrder,
  fetchOrderStatus: mocks.fetchOrderStatus,
}))

import { createApp, h, nextTick, type Component } from 'vue'
import AlipayScanPay from '../AlipayScanPay.vue'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()

/** 只等微任务与 Vue 调度；不用 setTimeout，避免和假定时器打架 */
async function tick(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function mount(props: Record<string, unknown> = {}, on: Record<string, unknown> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(AlipayScanPay as Component, { ...props, ...on }) })
  app.mount(host)
  return {
    host,
    unmount: () => {
      app.unmount()
      host.remove()
    },
  }
}

const okOrder = (orderNo = 'ORD1') => ({
  ok: true,
  status: 200,
  data: {
    order: {
      orderNo,
      amount: 19.89,
      currency: 'CNY',
      status: 'pending',
      paymentParams: { channel: 'alipay', cashierUrl: 'https://example.test/cashier' },
    },
    proration: { originalPrice: 19.9, creditAmount: 0.01, finalAmount: 19.89 },
  },
})

/** reka-ui 的 Checkbox 渲染成 role=checkbox 的按钮 */
function agreeCheckbox(host: HTMLElement): HTMLElement {
  const el = host.querySelector('[role="checkbox"]')
  if (!el) throw new Error('协议勾选框未渲染')
  return el as HTMLElement
}

beforeEach(() => {
  mocks.createPaymentOrder.mockReset()
  mocks.fetchOrderStatus.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AlipayScanPay · 协议门（合规）', () => {
  it('① 未勾选协议：不下单、不出现 iframe，只给遮罩提示', async () => {
    const m = mount({ planId: 'plan-ent', amountLabel: '¥19.89' })
    await tick()

    expect(m.host.querySelector('.qr-mask')).not.toBeNull()
    expect(m.host.querySelector('iframe')).toBeNull()
    // 关键：一个请求都不许发
    expect(mocks.createPaymentOrder).not.toHaveBeenCalled()

    m.unmount()
  })

  it('② 勾选后：下单一次、抛出原始响应（含顶层 proration）、iframe 出码', async () => {
    mocks.createPaymentOrder.mockResolvedValue(okOrder('ORD9'))
    const created: any[] = []
    const m = mount(
      { planId: 'plan-ent', billingCycle: 'monthly', amountLabel: '¥19.89' },
      { onOrderCreated: (d: any) => created.push(d) },
    )
    await tick()

    agreeCheckbox(m.host).click()
    await tick(8)

    expect(mocks.createPaymentOrder).toHaveBeenCalledTimes(1)
    expect(mocks.createPaymentOrder).toHaveBeenCalledWith({ planId: 'plan-ent', billingCycle: 'monthly' }, 'alipay')
    // 升级折抵在响应**顶层**，父组件靠它渲染结果页明细 —— 不能只抛 order
    expect(created).toHaveLength(1)
    expect(created[0].proration).toEqual({ originalPrice: 19.9, creditAmount: 0.01, finalAmount: 19.89 })

    const iframe = m.host.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('src')).toBe('https://example.test/cashier')
    expect(m.host.querySelector('.qr-mask')).toBeNull()

    m.unmount()
  })
})

describe('AlipayScanPay · 轮询与过期', () => {
  it('③ 3s 轮询命中 paid → 抛 paid(orderNo) 并停止计时器', async () => {
    vi.useFakeTimers()
    mocks.createPaymentOrder.mockResolvedValue(okOrder('ORD42'))
    mocks.fetchOrderStatus.mockResolvedValue({ ok: true, status: 200, data: { order: { status: 'paid' } } })

    const paid: string[] = []
    const m = mount({ planId: 'plan-ent' }, { onPaid: (no: string) => paid.push(no) })
    await tick(4)

    agreeCheckbox(m.host).click()
    await tick(8)
    expect(mocks.fetchOrderStatus).not.toHaveBeenCalled() // 还没到 3s

    vi.advanceTimersByTime(3000)
    await tick(6)

    expect(mocks.fetchOrderStatus).toHaveBeenCalledWith('ORD42')
    expect(paid).toEqual(['ORD42'])

    // 停表：再走 10s 不再轮询
    vi.advanceTimersByTime(10_000)
    await tick(6)
    expect(mocks.fetchOrderStatus).toHaveBeenCalledTimes(1)

    m.unmount()
  })

  it('④ 轮询命中 cancelled → 显示过期文案与重试按钮（不无限转圈）', async () => {
    vi.useFakeTimers()
    mocks.createPaymentOrder.mockResolvedValue(okOrder('ORD7'))
    mocks.fetchOrderStatus.mockResolvedValue({
      ok: true,
      status: 200,
      data: { order: { status: 'cancelled' } },
    })

    const m = mount({ planId: 'plan-ent' })
    await tick(4)
    agreeCheckbox(m.host).click()
    await tick(8)

    vi.advanceTimersByTime(3000)
    await tick(6)

    expect(m.host.textContent).toContain(t('pay_expired'))
    expect(m.host.querySelector('button')).not.toBeNull()
    // 已停表
    expect(mocks.fetchOrderStatus).toHaveBeenCalledTimes(1)

    m.unmount()
  })

  it('⑤ 95s 码失效 → 转过期态（支付宝实测码 99s 失效，旧值 150s 会留「假活码」）', async () => {
    vi.useFakeTimers()
    mocks.createPaymentOrder.mockResolvedValue(okOrder('ORD8'))
    mocks.fetchOrderStatus.mockResolvedValue({ ok: true, status: 200, data: { order: { status: 'pending' } } })

    const m = mount({ planId: 'plan-ent' })
    await tick(4)
    agreeCheckbox(m.host).click()
    await tick(8)
    expect(m.host.querySelector('iframe')).not.toBeNull()

    vi.advanceTimersByTime(95_000)
    await tick(6)

    expect(m.host.textContent).toContain(t('pay_expired'))
    expect(m.host.querySelector('iframe')).toBeNull()

    m.unmount()
  })
})

describe('AlipayScanPay · 失败与内嵌', () => {
  it('⑥ 下单被拒（409 ALREADY_SUBSCRIBED）→ 走本地文案，服务端英文原文不得漏到界面', async () => {
    // 服务端 error 用一句绝不可能出现在任何 locale 文案里的哨兵串：
    // 断言「按 code 映射本地文案」且「原始英文不漏」，与当前 locale 无关
    mocks.createPaymentOrder.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'RAW_SERVER_TEXT_MUST_NOT_LEAK',
      data: { code: 'ALREADY_SUBSCRIBED' },
    })

    const m = mount({ planId: 'plan-pro' })
    await tick(4)
    agreeCheckbox(m.host).click()
    await tick(8)

    expect(m.host.textContent).toContain(t('pay_err_already_subscribed'))
    expect(m.host.textContent).not.toContain('RAW_SERVER_TEXT_MUST_NOT_LEAK')

    m.unmount()
  })

  it('⑦ hideFooter 隐藏自带关闭按钮；缺省仍然有（独立使用行为不变）', async () => {
    const withFooter = mount({ planId: 'p' })
    await tick()
    expect(withFooter.host.querySelector('.pay-scan-footer')).not.toBeNull()
    withFooter.unmount()

    const embedded = mount({ planId: 'p', hideFooter: true })
    await tick()
    expect(embedded.host.querySelector('.pay-scan-footer')).toBeNull()
    embedded.unmount()
  })
})
