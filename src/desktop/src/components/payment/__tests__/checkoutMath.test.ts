// 纯计算，无 DOM：本文件只 import type，运行期不碰 api/client
import { describe, it, expect } from 'vitest'
import {
  consumedCredit,
  estimatePeriodEnd,
  forfeitAmount,
  hasProration,
  payableAmount,
  roundToCent,
} from '../checkoutMath'
import type { UpgradeQuote } from '@/api/payment'

/**
 * 结账明细口径（2026-10-05 owner 拍板：残值 > 新价时超出部分作废，但明细必须写明）。
 *
 * 这些数字是**用户直接看到并会自己复算的**，所以逐条钉死：
 *  - 应付金额必须显示折抵后的差额，不能是目录标价（旧实现就是显示标价，导致
 *    「界面 ¥19.9 / 订单 ¥19.89」对不上）；
 *  - 作废金额在服务端字段缺失（旧后端）时也要能本地算出来，否则会出现
 *    「剩余可抵扣 ¥89.10，却只需付 ¥0.01」且无任何解释。
 */

const quote = (over: Partial<UpgradeQuote> = {}): UpgradeQuote => ({
  planId: 'plan-ent',
  planName: 'Enterprise',
  billingCycle: 'monthly',
  currency: 'CNY',
  originalPrice: 19.9,
  creditAmount: 0,
  finalAmount: 19.9,
  paidAmount: null,
  usedAmount: null,
  creditSource: null,
  remainingDays: null,
  cycleDays: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  oldSubscriptionId: null,
  oldPlanId: null,
  ...over,
})

describe('roundToCent（与服务端同口径的取整）', () => {
  it('浮点噪声不产生差一分的随机结果', () => {
    expect(roundToCent(9.9 * 3)).toBe(29.7)
    expect(roundToCent(989.9999999999999 / 100)).toBe(9.9)
  })

  it('非法输入按 0（宁可不显示，也不出 NaN）', () => {
    expect(roundToCent(Number.NaN)).toBe(0)
    expect(roundToCent(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('hasProration', () => {
  it('无 quote / 无生效订阅（paidAmount 为 null）→ false', () => {
    expect(hasProration(null)).toBe(false)
    expect(hasProration(undefined)).toBe(false)
    expect(hasProration(quote())).toBe(false)
  })

  it('有实付基准 → true（0 也算「有」，它是一条真实的基准金额）', () => {
    expect(hasProration(quote({ paidAmount: 0.01 }))).toBe(true)
    expect(hasProration(quote({ paidAmount: 0 }))).toBe(true)
  })
})

describe('consumedCredit / forfeitAmount', () => {
  it('残值小于新价：全额用上，没有作废', () => {
    const q = quote({ paidAmount: 7.96, creditAmount: 3.98, finalAmount: 15.92 })
    expect(consumedCredit(q)).toBe(3.98)
    expect(forfeitAmount(q)).toBe(0)
  })

  it('★残值高于新价：只用掉 新价 − 0.01，其余作废', () => {
    // 「年付 Pro ¥99，剩 90% 时升级到月付企业版 ¥19.90」这一类
    const q = quote({ paidAmount: 99, creditAmount: 89.1, finalAmount: 0.01 })
    expect(consumedCredit(q)).toBe(19.89)
    expect(forfeitAmount(q)).toBe(69.21)
  })

  it('服务端给了 forfeitAmount 就以服务端为准（唯一真相，客户端不覆盖）', () => {
    const q = quote({ paidAmount: 99, creditAmount: 89.1, finalAmount: 0.01, forfeitAmount: 70 })
    expect(forfeitAmount(q)).toBe(70)
  })

  it('服务端字段缺失（旧后端）时本地按同一公式兜底；0 是合法值不算缺失', () => {
    const missing = quote({ paidAmount: 99, creditAmount: 89.1, finalAmount: 0.01 })
    expect(missing.forfeitAmount).toBeUndefined()
    expect(forfeitAmount(missing)).toBe(69.21)
    const explicitZero = quote({ paidAmount: 7.96, creditAmount: 3.98, finalAmount: 15.92, forfeitAmount: 0 })
    expect(forfeitAmount(explicitZero)).toBe(0)
  })

  it('无折抵 → 作废恒为 0（不编造一个不存在的损失）', () => {
    expect(forfeitAmount(quote())).toBe(0)
    expect(forfeitAmount(null)).toBe(0)
  })
})

describe('payableAmount（二维码旁展示的应付金额）', () => {
  it('有试算 → 用折抵后的差额，不是目录标价', () => {
    // 生产现场：企业版标价 19.90，Pro 折抵 0.01，实际订单 19.89
    const q = quote({ paidAmount: 0.01, creditAmount: 0.01, finalAmount: 19.89 })
    expect(payableAmount(q, 19.9)).toBe(19.89)
  })

  it('没拿到试算 → 退回目录标价（此时右栏也会显示读不到明细的说明）', () => {
    expect(payableAmount(null, 19.9)).toBe(19.9)
  })
})

describe('estimatePeriodEnd（新套餐有效期至，只能预计）', () => {
  it('月付 +1 个月 / 年付 +1 年，且不改动传入的 Date', () => {
    const from = new Date('2026-10-05T10:00:00')
    expect(estimatePeriodEnd('monthly', from).toISOString().slice(0, 10)).toBe('2026-11-05')
    expect(estimatePeriodEnd('yearly', from).toISOString().slice(0, 10)).toBe('2027-10-05')
    expect(from.toISOString().slice(0, 10)).toBe('2026-10-05')
  })
})
