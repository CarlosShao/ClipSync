// === 订阅/升级语义唯一真相源（订阅 UI 重做）===
// 产品事实（2026-09 支付宝联调结论）：**没有自动续费**。个体户资质无法开通支付宝
// 商家扣款，月付/年付都是「一次性购买一个周期，到期手动续」。因此：
//   · 文案红线：任何位置不得出现「自动续费 / 连续包月 / 连续订阅」；
//   · 交互红线：**只升不降**（低于当前档的套餐不可点），同套餐不提供重复购买入口；
//   · 「取消订阅」无事可取消 —— 订阅页只展示到期时间，见 SubscriptionView。
// 本模块只放纯判定 + 当前订阅快照，不依赖 Pinia（可单测）；UI 侧的档位序
// 一律按 priceMonthly 比较（与服务端 /api/subscriptions/plans 的 ORDER BY 同构）。
import { ref } from 'vue'
import { api } from '@/api/client'
import type { PricingPlan } from '@/composables/usePlanLimits'

/** 计费周期：与服务端 POST /api/payments/create-order 的 billingCycle 取值一致 */
export type BillingCycle = 'monthly' | 'yearly'

/**
 * 一张套餐卡在当前用户视角下的可选性：
 *  - current     已是这个套餐：置灰「当前套餐」（到期后 /current 回落 Free，届时可再订阅）
 *  - included    低于当前档：置灰「已包含」，不提供降级入口
 *  - upgrade     高于当前档且当前为付费档：「升级」
 *  - subscribe   高于当前档且当前为 Free：「订阅」
 *  - unavailable 套餐目录里没有这一档（接口失败/未上架）：保留占位，点击提示建设中
 */
export type PlanChoice = 'current' | 'included' | 'upgrade' | 'subscribe' | 'unavailable'

/** 当前订阅快照（GET /api/subscriptions/current 的消费子集） */
export interface CurrentSubscription {
  /** 套餐英文名：Free / Pro / Enterprise；拿不到时是 fallback */
  planName: string
  /** 当前周期到期时间（ISO 字符串），Free/无订阅为 null */
  periodEnd: string | null
  /** 订阅记录 id（升级场景可传给 create-order；当前履约走 planId，保留备用） */
  subscriptionId: string | null
  /** 是否处于付费生效期：true ⇒ 再次购买属「升级」，需提示残值折抵 */
  paidActive: boolean
  /** 当前档月付价（元）；/current 的 plan.price 即 price_monthly，Free 恒 0 */
  priceMonthly: number
  /** 当前档权益展示串（plan.features 归一，订阅页直接列） */
  features: string[]
}

/** plan.features 可能是 JSON 字符串、字符串数组或 {label|name} 对象数组 → 统一成展示串数组 */
export function normalizeFeatureLabels(raw: unknown): string[] {
  let arr: any = raw
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr)
    } catch {
      return []
    }
  }
  if (!Array.isArray(arr)) return []
  return arr
    .map((f: any) => (typeof f === 'string' ? f : String(f?.label ?? f?.name ?? '')))
    .filter(Boolean)
}

// 档位序按 priceMonthly 比较是本模块的唯一口径；按名字排序只用于
// 「拿不到价格目录」时的入口治理（侧栏账号区要在不请求 plans 的前提下决定显隐）。
const NAME_TIER_ORDER: Record<string, number> = { free: 0, pro: 1, enterprise: 2 }
/** 最高档 rank（Enterprise）：rank >= 该值即无升级空间 */
export const TOP_TIER_RANK = NAME_TIER_ORDER.enterprise

/** 按套餐名的档位序：未知/空套餐按 Free(0) 处理，与 useMenuAccess 口径一致 */
export function tierRankByName(name: string | null | undefined): number {
  const v = NAME_TIER_ORDER[String(name ?? '').trim().toLowerCase()]
  return typeof v === 'number' ? v : 0
}

/**
 * 年付相对「12 × 月付」的折扣百分比（¥99 vs ¥9.9×12=¥118.8 ⇒ 17）。
 * 返回 0 表示不展示角标，两种情形：
 *  ① 数据缺失/异常（priceYearly<=0、月付为 0、折扣非正）；
 *  ② **折扣低于原价 1/3**（pct>67）—— 定价红线：目录数据明显异常时宁可不写，
 *     也不能在界面上挂出「省 90%」这类不可能兑现的承诺。
 */
export function yearlySavingPct(priceMonthly: number, priceYearly: number): number {
  if (!Number.isFinite(priceMonthly) || !Number.isFinite(priceYearly)) return 0
  if (priceMonthly <= 0 || priceYearly <= 0) return 0
  const full = priceMonthly * 12
  if (priceYearly >= full) return 0
  const pct = Math.round(((full - priceYearly) / full) * 100)
  if (pct <= 0 || pct > 67) return 0
  return pct
}

/** 选定周期下的套餐价格（年付缺数据时回落月付，绝不显示 ¥0 假价） */
export function priceForCycle(plan: PricingPlan | null, cycle: BillingCycle): number {
  if (!plan) return 0
  if (cycle === 'yearly') return plan.priceYearly > 0 ? plan.priceYearly : plan.priceMonthly
  return plan.priceMonthly
}

/** 周期后缀文案键：/月 与 /年 */
export function cycleLabelKey(cycle: BillingCycle): string {
  return cycle === 'yearly' ? 'price_per_yr' : 'price_per_mo'
}

/**
 * 档位判定（只升不降）。curPrice 为当前档月付价（目录查不到时传 null）。
 * 目录缺失（plan=null）→ unavailable；价格不可比（curPrice=null）时按「可升」放行，
 * 权威判定仍由服务端 409（ALREADY_SUBSCRIBED / DOWNGRADE_NOT_ALLOWED）兜底。
 */
export function resolvePlanChoice(
  candidate: PricingPlan | null,
  current: CurrentSubscription | null,
  curPrice: number | null,
): PlanChoice {
  if (!candidate) return 'unavailable'
  const cName = String(candidate.name || '').trim().toLowerCase()
  const uName = String(current?.planName || '').trim().toLowerCase()
  if (uName && cName === uName) return 'current'
  const candPrice = candidate.priceMonthly
  if (curPrice === null) return uName === 'free' || !uName ? 'subscribe' : 'upgrade'
  if (candPrice < curPrice) return 'included'
  if (candPrice === curPrice) return 'current'
  return !uName || uName === 'free' || curPrice <= 0 ? 'subscribe' : 'upgrade'
}

/** 该判定下用户能否点开支付流 */
export function isChoiceActionable(choice: PlanChoice): boolean {
  return choice === 'upgrade' || choice === 'subscribe'
}

/** 卡片按钮文案键 */
export function choiceCtaKey(choice: PlanChoice): string {
  switch (choice) {
    case 'current':
      return 'plan_cta_current'
    case 'included':
      return 'plan_cta_included'
    case 'subscribe':
      return 'plan_cta_subscribe'
    case 'unavailable':
      return 'ft_building'
    default:
      return 'plan_cta_upgrade'
  }
}

/** 套餐名/特性展示键（弹窗、设置子页、订阅页共用，避免三处各写一份） */
export const PLAN_ORDER_KEYS = ['free', 'pro', 'enterprise'] as const
export const PLAN_NAME_KEYS: Record<string, string> = {
  free: 'price_free',
  pro: 'price_pro',
  enterprise: 'price_enterprise',
}
export const PLAN_FEATURE_KEYS: Record<string, string[]> = {
  free: ['feat_3dev', 'feat_100hist', 'feat_community'],
  pro: ['feat_unlimited_dev', 'feat_unlimited_hist', 'feat_priority'],
  enterprise: ['feat_team', 'feat_api', 'feat_priority'],
}

// ---------------------------------------------------------------------------
// 当前订阅快照（模块级单例，与 usePlanLimits 同一请求口径）
// ---------------------------------------------------------------------------
// 订阅到期时间 / 当前档位是升级入口的前提数据。缓存 60s：支付成功、订阅变更后由
// 调用方显式 invalidateCurrentSubscription() 作废，不靠 TTL 收敛。
const CURRENT_TTL_MS = 60 * 1000

export const currentSubscription = ref<CurrentSubscription | null>(null)

let currentFetchedAt = 0
let currentInflight: Promise<CurrentSubscription | null> | null = null

/**
 * GET /api/subscriptions/current 的字段归一。
 * 服务端历史上 camelCase / snake_case 混发（现有支付结果页读的是 snake_case，
 * 新契约写的是 current_period_end），两个键都取，取到哪个算哪个。
 */
function normalizeCurrent(payload: any): CurrentSubscription {
  const sub = payload?.subscription ?? null
  const plan = payload?.plan ?? null
  const rawEnd = sub?.current_period_end ?? sub?.currentPeriodEnd ?? null
  const planName = String(plan?.name ?? '').trim()
  const price = Number(plan?.price ?? plan?.priceMonthly ?? plan?.price_monthly ?? 0)
  return {
    planName,
    periodEnd: rawEnd ? String(rawEnd) : null,
    subscriptionId: sub?.id != null ? String(sub.id) : null,
    // 付费生效：有订阅记录且当前档月付 > 0（Free 行 price 恒为 0）
    paidActive: Boolean(sub) && planName.toLowerCase() !== 'free' && price > 0,
    priceMonthly: Number.isFinite(price) ? price : 0,
    features: normalizeFeatureLabels(plan?.features),
  }
}

/** 拉取当前订阅（TTL 60s + 单飞去重）；失败返回 null，调用方按 fallback 渲染 */
export async function loadCurrentSubscription(force = false): Promise<CurrentSubscription | null> {
  if (!force && currentSubscription.value && Date.now() - currentFetchedAt < CURRENT_TTL_MS)
    return currentSubscription.value
  if (!force && currentInflight) return currentInflight
  const p = (async () => {
    try {
      const res = await api<any>('GET', '/api/subscriptions/current')
      if (!res.ok || !res.data) return currentSubscription.value
      const snap = normalizeCurrent(res.data)
      currentSubscription.value = snap
      currentFetchedAt = Date.now()
      return snap
    } catch {
      // 网络/后端异常：保持旧快照（可能为 null），入口治理退化为 fallback 档位
      return currentSubscription.value
    } finally {
      currentInflight = null
    }
  })()
  currentInflight = p
  return p
}

/** 订阅变更（支付成功/换号）后作废快照，下一次读取重新拉 */
export function invalidateCurrentSubscription(): void {
  currentSubscription.value = null
  currentFetchedAt = 0
  currentInflight = null
}

/**
 * 组件用的当前订阅视图：快照未加载时用 auth/me 下发的 plan 兜底
 * （configStore.user.plan 缺省 'Free'），保证首屏不会把 Pro 用户误判成 Free。
 */
export function resolveCurrentSubscription(fallbackPlanName?: string | null): CurrentSubscription {
  if (currentSubscription.value) {
    const snap = currentSubscription.value
    if (snap.planName) return snap
    return { ...snap, planName: String(fallbackPlanName || 'Free') }
  }
  return {
    planName: String(fallbackPlanName || 'Free'),
    periodEnd: null,
    subscriptionId: null,
    paidActive: false,
    priceMonthly: 0,
    features: [],
  }
}

/** 在套餐目录里按名字找当前档的月付价（大小写不敏感）；找不到返回 null */
export function currentMonthlyPrice(
  plans: PricingPlan[],
  current: CurrentSubscription | null | undefined,
): number | null {
  const name = String(current?.planName || '').trim().toLowerCase()
  if (!name) return null
  const hit = plans.find((p) => String(p.name || '').trim().toLowerCase() === name)
  return hit ? hit.priceMonthly : null
}

/** 到期时间展示串：YYYY-MM-DD；无值/非法值返回 ''（调用方显示占位「—」） */
export function formatExpiryDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 是否存在升级空间（入口治理用，不依赖价格目录）：
 * Free/Pro 有更高档可买，Enterprise 已是顶格 —— Enterprise 用户任何升级入口都不出现。
 */
export function hasUpgradeHeadroom(planName: string | null | undefined): boolean {
  return tierRankByName(planName) < TOP_TIER_RANK
}

export function useSubscriptionAccess() {
  return {
    currentSubscription,
    loadCurrentSubscription,
    invalidateCurrentSubscription,
    resolveCurrentSubscription,
    resolvePlanChoice,
    isChoiceActionable,
    choiceCtaKey,
    priceForCycle,
    cycleLabelKey,
    yearlySavingPct,
    currentMonthlyPrice,
    formatExpiryDate,
    hasUpgradeHeadroom,
    tierRankByName,
  }
}
