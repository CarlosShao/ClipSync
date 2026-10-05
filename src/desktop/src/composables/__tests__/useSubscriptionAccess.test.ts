// === useSubscriptionAccess 纯判定单测（订阅 UI 重做）===
// 只测不依赖网络的纯函数：档位序/只升不降判定、年付折扣（含定价红线）、
// 周期取价、到期日格式化、入口治理用的 hasUpgradeHeadroom。
// 快照请求（loadCurrentSubscription）不在此覆盖：它只是 api() 的薄封装。
// vi.mock('@/api/client') 必须保留：本环境无 DOM，真实 client.ts 的依赖链
// （configStore → useClipboard → useI18n）会在模块加载期读 localStorage 直接崩。
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/api/client', () => ({
  api: async () => ({ ok: false, status: 0 }),
}))

import {
  choiceCtaKey,
  cycleLabelKey,
  formatExpiryDate,
  hasUpgradeHeadroom,
  isChoiceActionable,
  priceForCycle,
  resolvePlanChoice,
  tierRankByName,
  yearlySavingPct,
  normalizeFeatureLabels,
  canRequestSelfRefund,
  normalizeCurrent,
  type CurrentSubscription,
} from '@/composables/useSubscriptionAccess'
import type { PricingPlan } from '@/composables/usePlanLimits'

const plan = (name: string, monthly: number, yearly = 0): PricingPlan => ({
  id: name.toLowerCase(),
  name,
  displayName: name,
  priceMonthly: monthly,
  priceYearly: yearly,
})

const free = plan('Free', 0, 0)
const pro = plan('Pro', 9.9, 99)
const enterprise = plan('Enterprise', 29, 290)
const plans = [free, pro, enterprise]

const sub = (planName: string, opts: Partial<CurrentSubscription> = {}): CurrentSubscription => ({
  planName,
  periodEnd: null,
  subscriptionId: planName === 'Free' ? null : 'sub-1',
  paidActive: planName !== 'Free',
  // 默认夹具是「真付过钱」的常规付费用户；赠期场景由用例显式传 purchaseBacked: false
  purchaseBacked: planName === 'Free' ? null : true,
  priceMonthly: opts.priceMonthly ?? 0,
  features: [],
  ...opts,
})

/** 与 PlanCards 同一口径：当前档月付价从目录里查 */
const monthly = (cur: CurrentSubscription | null) =>
  cur ? (plans.find((p) => p.name === cur.planName)?.priceMonthly ?? null) : null

describe('tierRankByName / hasUpgradeHeadroom（入口治理）', () => {
  it('Free<Pro<Enterprise，未知套餐按 Free 处理', () => {
    expect(tierRankByName('Free')).toBe(0)
    expect(tierRankByName('pro')).toBe(1)
    expect(tierRankByName('ENTERPRISE')).toBe(2)
    expect(tierRankByName('')).toBe(0)
    expect(tierRankByName(undefined)).toBe(0)
  })

  it('Free/Pro 有升级空间，Enterprise 没有', () => {
    expect(hasUpgradeHeadroom('Free')).toBe(true)
    expect(hasUpgradeHeadroom('Pro')).toBe(true)
    expect(hasUpgradeHeadroom('Enterprise')).toBe(false)
    // 异常套餐名保守按 Free 处理 → 认为有空间（服务端 403/409 兜底）
    expect(hasUpgradeHeadroom('Weird')).toBe(true)
  })
})

describe('resolvePlanChoice（只升不降）', () => {
  it('Free 用户：Pro/Enterprise 是「订阅」，Free 卡是「当前套餐」', () => {
    const cur = sub('Free')
    expect(resolvePlanChoice(free, cur, monthly(cur))).toBe('current')
    expect(resolvePlanChoice(pro, cur, monthly(cur))).toBe('subscribe')
    expect(resolvePlanChoice(enterprise, cur, monthly(cur))).toBe('subscribe')
  })

  it('Pro 用户：Free 是「已包含」，Pro 是「当前套餐」，Enterprise 是「升级」', () => {
    const cur = sub('Pro')
    expect(resolvePlanChoice(free, cur, monthly(cur))).toBe('included')
    expect(resolvePlanChoice(pro, cur, monthly(cur))).toBe('current')
    expect(resolvePlanChoice(enterprise, cur, monthly(cur))).toBe('upgrade')
  })

  it('Enterprise 用户：低档全部「已包含」，自身「当前套餐」', () => {
    const cur = sub('Enterprise')
    expect(resolvePlanChoice(free, cur, monthly(cur))).toBe('included')
    expect(resolvePlanChoice(pro, cur, monthly(cur))).toBe('included')
    expect(resolvePlanChoice(enterprise, cur, monthly(cur))).toBe('current')
  })

  it('目录缺失（plan=null）→ unavailable；目录查不到当前档价格时放行（服务端权威）', () => {
    expect(resolvePlanChoice(null, sub('Pro'), 9.9)).toBe('unavailable')
    // 当前档不在价格目录里（改价/新套餐）→ 不拦用户，按可买处理；
    // Free 显「订阅」，其余显「升级」
    expect(resolvePlanChoice(pro, sub('Free'), null)).toBe('subscribe')
    expect(resolvePlanChoice(pro, sub('Weird'), null)).toBe('upgrade')
    expect(resolvePlanChoice(pro, sub('Pro'), null)).toBe('current')
  })

  it('价格相等但套餐名不同 → 不给可点（当作当前档，避免同价重复购买）', () => {
    const twin = plan('ProPlus', 9.9, 99)
    expect(resolvePlanChoice(twin, sub('Pro'), 9.9)).toBe('current')
  })

  it('仅 upgrade/subscribe 可点', () => {
    expect(isChoiceActionable('upgrade')).toBe(true)
    expect(isChoiceActionable('subscribe')).toBe(true)
    expect(isChoiceActionable('current')).toBe(false)
    expect(isChoiceActionable('included')).toBe(false)
    expect(isChoiceActionable('unavailable')).toBe(false)
  })
})

describe('卡片按钮文案键', () => {
  it('四种状态各有独立键（不得混用「变更套餐」旧词）', () => {
    expect(choiceCtaKey('current')).toBe('plan_cta_current')
    expect(choiceCtaKey('included')).toBe('plan_cta_included')
    expect(choiceCtaKey('upgrade')).toBe('plan_cta_upgrade')
    expect(choiceCtaKey('subscribe')).toBe('plan_cta_subscribe')
    expect(choiceCtaKey('unavailable')).toBe('ft_building')
  })
})

describe('yearlySavingPct（含定价红线：折扣不得低于原价 1/3）', () => {
  it('¥99 / ¥9.9×12 ⇒ 省 17%', () => {
    expect(yearlySavingPct(9.9, 99)).toBe(17)
  })

  it('无年付价 / 年付不便宜 / 数据异常 → 0（角标不渲染）', () => {
    expect(yearlySavingPct(9.9, 0)).toBe(0)
    expect(yearlySavingPct(9.9, 118.8)).toBe(0)
    expect(yearlySavingPct(9.9, 150)).toBe(0)
    expect(yearlySavingPct(0, 0)).toBe(0)
    expect(yearlySavingPct(NaN, 99)).toBe(0)
  })

  it('折扣低于原价 1/3 视为脏数据，不展示（宁可不写）', () => {
    // 1 折 ⇒ pct=90 > 67
    expect(yearlySavingPct(10, 12)).toBe(0)
    // 恰好 1/3 价 ⇒ pct=67，允许展示
    expect(yearlySavingPct(10, 40)).toBe(67)
  })
})

describe('周期取价与文案', () => {
  it('年付用 priceYearly，缺年付价时回落月付（绝不显示 ¥0 假价）', () => {
    expect(priceForCycle(pro, 'monthly')).toBe(9.9)
    expect(priceForCycle(pro, 'yearly')).toBe(99)
    expect(priceForCycle(plan('Pro', 9.9, 0), 'yearly')).toBe(9.9)
    expect(priceForCycle(null, 'yearly')).toBe(0)
  })

  it('/月 与 /年', () => {
    expect(cycleLabelKey('monthly')).toBe('price_per_mo')
    expect(cycleLabelKey('yearly')).toBe('price_per_yr')
  })
})

describe('formatExpiryDate（到期时间：YYYY-MM-DD）', () => {
  it('ISO → 本地日期串', () => {
    expect(formatExpiryDate('2026-10-01T16:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('null / 非法值 → 空串（调用方显示占位，不编造日期）', () => {
    expect(formatExpiryDate(null)).toBe('')
    expect(formatExpiryDate(undefined)).toBe('')
    expect(formatExpiryDate('not-a-date')).toBe('')
  })
})

describe('normalizeFeatureLabels', () => {
  it('JSON 字符串 / 字符串数组 / {label|name} 对象数组统一成展示串', () => {
    expect(normalizeFeatureLabels('["a","b"]')).toEqual(['a', 'b'])
    expect(normalizeFeatureLabels(['a'])).toEqual(['a'])
    expect(normalizeFeatureLabels([{ label: '无限设备' }, { name: '优先支持' }])).toEqual([
      '无限设备',
      '优先支持',
    ])
    expect(normalizeFeatureLabels(undefined)).toEqual([])
    expect(normalizeFeatureLabels('非 JSON')).toEqual([])
    expect(normalizeFeatureLabels({ team_management: true })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2026-10-05：退款入口判据收紧（owner 实测：赠期一个月 Pro 后立刻冒出「申请退款」）
// ---------------------------------------------------------------------------
// 现场根因是 paidActive 由**套餐目录价 > 0** 推出，赠期出来的订阅与真金白银买的
// 长得一模一样。真实「有没有付过钱」只有服务端知道（/subscriptions/current 的
// purchaseBacked，判据是 refundPolicy 的锚点查询）。下面把这条规则的每个分支钉死。

describe('canRequestSelfRefund（退款入口可见性）', () => {
  it('付费生效 + 有真实已付订单支撑 → 显示', () => {
    expect(canRequestSelfRefund(sub('Pro', { paidActive: true, purchaseBacked: true }))).toBe(true)
  })

  it('★赠期场景：付费生效但服务端说没有人付过钱 → 必须收口', () => {
    // 这正是 owner 遇到的：赠期把 free 账号变成 active Pro，paidActive 也是 true
    expect(canRequestSelfRefund(sub('Pro', { paidActive: true, purchaseBacked: false }))).toBe(false)
  })

  it('旧后端未回传该字段（null）→ 退回旧行为，不能把入口整体藏掉', () => {
    // 若这里返回 false，「后端没升级」就会表现成「退款入口集体消失」这种假故障
    expect(canRequestSelfRefund(sub('Pro', { paidActive: true, purchaseBacked: null }))).toBe(true)
  })

  it('非付费生效（Free / 到期回落）→ 显示入口的前提都不成立', () => {
    expect(canRequestSelfRefund(sub('Free', { paidActive: false, purchaseBacked: null }))).toBe(false)
    expect(canRequestSelfRefund(sub('Pro', { paidActive: false, purchaseBacked: true }))).toBe(false)
  })

  it('快照缺失 → 不显示（此时 paidActive 本就为 false）', () => {
    expect(canRequestSelfRefund(null)).toBe(false)
    expect(canRequestSelfRefund(undefined)).toBe(false)
  })
})

describe('normalizeCurrent：purchaseBacked 的三态映射', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    subscription: { id: 's1', status: 'active', currentPeriodEnd: '2026-11-19T00:00:00.000Z' },
    plan: { name: 'Pro', price: 9.9, features: [] },
    ...over,
  })

  it('服务端明确 false → false（收口）', () => {
    expect(normalizeCurrent(payload({ purchaseBacked: false })).purchaseBacked).toBe(false)
  })

  it('服务端明确 true → true', () => {
    expect(normalizeCurrent(payload({ purchaseBacked: true })).purchaseBacked).toBe(true)
  })

  it('字段缺失 → null（= 未知，沿用旧行为），绝不把它当成 false', () => {
    expect(normalizeCurrent(payload()).purchaseBacked).toBeNull()
  })

  it('非布尔（字符串/数字）一律按未知处理，不猜', () => {
    expect(normalizeCurrent(payload({ purchaseBacked: 'false' })).purchaseBacked).toBeNull()
    expect(normalizeCurrent(payload({ purchaseBacked: 0 })).purchaseBacked).toBeNull()
  })

  it('顺带确认 paidActive 仍是「有订阅 + 档位非 Free + 目录价 > 0」', () => {
    const snap = normalizeCurrent(payload())
    expect(snap.paidActive).toBe(true)
    expect(snap.planName).toBe('Pro')
    expect(normalizeCurrent(payload({ plan: { name: 'Free', price: 0, features: [] } })).paidActive).toBe(false)
  })
})
