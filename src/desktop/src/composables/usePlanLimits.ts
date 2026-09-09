// === 套餐限额（F0.4）：唯一数据源是后端 /api/subscriptions/current 下发 ===
// 此前桌面端在 clipboardUpload 与 useClipboard.uploadFileItem 两处各自硬编码了
// Free 128MB / Pro 256MB / Enterprise 1GB 的上传阈值，与服务端
// subscription_plans 表漂移；本模块统一改为后端下发 + 模块级缓存。
// 契约：{ subscription: {...}|null, plan: { maxFileSizeMb, maxStorageMb,
// maxFilesPerClip, fileRetentionDays, ... } }；admin 场景下部分字段可能为 null。
import { ref } from 'vue'
import { api } from '@/api/client'

/**
 * 套餐限额（桌面端消费的字段子集）。
 * Number.POSITIVE_INFINITY 表示「不限」：后端对 admin 等场景返回 null/缺省
 * 即视为不限，客户端不做预限制，越权行为仍由服务端权威校验兜底。
 */
export interface PlanLimits {
  /** 单文件上传上限（MB） */
  maxFileSizeMb: number
  /** 存储总量上限（MB） */
  maxStorageMb: number
  /** 单个 clip 允许附带的文件数上限 */
  maxFilesPerClip: number
  /** 文件保留天数 */
  fileRetentionDays: number
}

// ------------------------------------------------------------------------
// DB 不可达兜底（保守默认值）—— 注意：这不是业务阈值！
// 仅当首次加载 /api/subscriptions/current 失败（后端不可达、网络异常、
// 响应中无 plan）时使用，目的是「DB 不可达时桌面端不至于放行超大上传」。
// 真实业务阈值只存在于服务端 subscription_plans 表，以上述接口下发为准。
// fileRetentionDays 未知时不做客户端预过期（文件过期由服务端权威执行）。
// ------------------------------------------------------------------------
const FALLBACK_LIMITS: PlanLimits = {
  maxFileSizeMb: 20, // 保守默认：单文件 20MB
  maxStorageMb: 200, // 保守默认：存储总量 200MB
  maxFilesPerClip: 3, // 保守默认：每个 clip 3 个文件
  fileRetentionDays: Number.POSITIVE_INFINITY, // 未知 → 客户端不预过期
}

// 缓存 5 分钟：套餐变更属低频事件，避免每次上传都打一次接口
const CACHE_TTL_MS = 5 * 60 * 1000

// 模块级单例状态：所有调用方共享同一份缓存与在途请求，绝不重复请求后端
let cached: PlanSnapshot | null = null
let cachedAt = 0
// L2：当前缓存是否来自兜底默认值（真实接口从未成功返回）。为 true 时客户端预检应放行
//（兜底 20MB 会误拦 Pro 用户 20-128MB 的合法文件），交服务端 413 + handleQuotaResponse 兜底。
let cachedIsFallback = false
let inflight: Promise<PlanLimits> | null = null
// L-3：缓存代数。invalidatePlanLimits 时 +1；在途请求 resolve 时仅当代数一致才写缓存，
// 防止升级前发起的 fetch 把旧套餐数据回写缓存。
let generation = 0
// 在途请求所属代数：invalidate 后新调用不复用旧代请求（避免拿到过期套餐值）
let inflightGeneration = -1

// === plan.features 快照（MA-01/MA-05）===
// 与套餐限额同一次 GET /api/subscriptions/current 请求顺带提取（避免第二个请求），
// 供 useMenuAccess 的 planFeature 判定消费。null = 从未成功获取（拉取失败/尚未加载）：
// 消费方按 fail-open 处理（服务端 requireFeature 403 权威兜底），与 isFlagEnabled 哲学一致。
// 响应式 ref：订阅变更 invalidatePlanLimits 后置 null，下次成功拉取自动回填。
export const planFeaturesSnapshot = ref<Record<string, boolean> | null>(null)

/** 后端字段归一：null / undefined / 非正的有限数（如 admin 的不限字段）→ Infinity */
function normalizeLimit(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY
}

/** 内部快照：限额字段 + 同一次请求顺带提取的 plan.features 归一布尔表 */
interface PlanSnapshot extends PlanLimits {
  features: Record<string, boolean>
}

async function fetchPlanLimits(): Promise<PlanSnapshot> {
  // 与 SubscriptionView 相同的调用方式：GET /api/subscriptions/current（Bearer 由 api() 注入）
  const res = await api('GET', '/api/subscriptions/current')
  if (!res.ok || !res.data) {
    throw new Error(`[usePlanLimits] HTTP ${res.status}: ${res.error || 'no data'}`)
  }
  const payload: any = res.data
  const plan = payload?.plan
  if (!plan || typeof plan !== 'object') {
    throw new Error('[usePlanLimits] response has no plan object')
  }
  // plan.features（JSONB 对象，pg 已解析）：归一为纯布尔表，供 planFeature 门控消费
  const features: Record<string, boolean> = {}
  if (plan.features && typeof plan.features === 'object' && !Array.isArray(plan.features)) {
    for (const [k, v] of Object.entries(plan.features as Record<string, unknown>)) {
      features[k] = v === true
    }
  }
  return {
    maxFileSizeMb: normalizeLimit(plan.maxFileSizeMb),
    maxStorageMb: normalizeLimit(plan.maxStorageMb),
    maxFilesPerClip: normalizeLimit(plan.maxFilesPerClip),
    fileRetentionDays: normalizeLimit(plan.fileRetentionDays),
    features,
  }
}

/**
 * 拉取并缓存套餐限额（模块级缓存，TTL 5 分钟，在途请求单飞去重）。
 * - 缓存未过期 → 直接返回
 * - 已过期 → 请求后端；成功则刷新缓存
 * - 失败 → console.warn 后沿用上次成功缓存值；首次失败（无缓存）退回
 *   FALLBACK_LIMITS 并标记 cachedIsFallback。失败同样顺延 TTL 起点：故障期间
 *   每 5 分钟至多重试一次，不会每次上传都打接口。
 * - L-3：请求发起时捕获代数，resolve 后仅当代数一致才写缓存/顺延 TTL；
 *   期间发生过 invalidatePlanLimits（订阅变更）则丢弃结果，避免旧套餐数据回写。
 */
export async function loadPlanLimits(): Promise<PlanLimits> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return { ...cached }
  // 在途请求属于旧代（请求期间发生过 invalidate）→ 不复用，按新代重新拉取
  if (inflight && inflightGeneration === generation) return inflight
  const gen = generation
  const p = doFetchPlanLimits(gen)
  inflight = p
  inflightGeneration = gen
  return p
}

/**
 * 单飞请求体。gen 为发起时的缓存代数：resolve 后仅当代数一致才写缓存/顺延 TTL；
 * 期间发生过 invalidatePlanLimits（订阅变更）则丢弃结果，避免旧套餐数据回写（L-3）。
 */
async function doFetchPlanLimits(gen: number): Promise<PlanLimits> {
  try {
    const fresh = await fetchPlanLimits()
    if (gen === generation) {
      cached = fresh
      cachedIsFallback = false
      cachedAt = Date.now()
      // features 与限额同源同代：仅当代数一致才回写响应式快照（对齐 L-3 口径）
      planFeaturesSnapshot.value = { ...fresh.features }
    }
    return { ...fresh }
  } catch (e) {
    console.warn('[usePlanLimits] 加载套餐限额失败，沿用上次缓存/兜底值：', e)
    if (gen === generation) {
      // 沿用旧缓存（来自真实接口）→ 非兜底；首次失败（无缓存）才退到兜底默认值。
      // 兜底快照的 features 为空表仅用于满足内部类型；planFeaturesSnapshot 保持 null
      //（消费方 fail-open），此处不会把兜底值当真实 features 发布。
      cachedIsFallback = cached === null
      cached = cached ?? { ...FALLBACK_LIMITS, features: {} }
      cachedAt = Date.now()
    }
    return { ...(cached ?? FALLBACK_LIMITS) }
  } finally {
    // 仅当在途请求仍属于本代时清空：期间新代请求可能已接管 inflight（L-3）
    if (inflightGeneration === gen) {
      inflight = null
      inflightGeneration = -1
    }
  }
}

/**
 * 订阅变更（升级/降级/取消）后调用：立即失效缓存，下一次取值重新拉取。
 * 订阅变更流程（PricingModal / 取消订阅等）可在成功回调里调用
 * usePlanLimits().invalidatePlanLimits()。
 * L-3：代数 +1 —— 升级前发起的在途请求 resolve 后代数不一致，不再把旧套餐
 * 数据写回缓存；invalidate 后的新调用经 inflightGeneration 判定不复用旧代请求。
 */
export function invalidatePlanLimits(): void {
  generation += 1
  cached = null
  cachedAt = 0
  cachedIsFallback = false
  // features 快照随缓存一起失效：回 null（fail-open），下次成功拉取自动回填
  planFeaturesSnapshot.value = null
}

/**
 * L2：当前缓存套餐数据是否来自兜底默认值（拉取 /api/subscriptions/current 首次失败、
 * 无旧缓存可沿用）。为 true 时客户端预检不做拦截（放行交服务端权威校验），
 * 避免 20MB 兜底值误拦 Pro 用户 20-128MB 的合法上传。须在 await getPlanLimits() /
 * getMaxUploadBytes() 之后读取（loadPlanLimits 内部已更新该状态）。
 */
export function isPlanLimitsFallback(): boolean {
  return cachedIsFallback
}

/** 套餐限额：null 字段已转为 Infinity（不限）；首次加载失败时为保守兜底值。 */
export async function getPlanLimits(): Promise<PlanLimits> {
  return loadPlanLimits()
}

/** 单文件上传上限（字节）。Infinity 表示不限。 */
export async function getMaxUploadBytes(): Promise<number> {
  const { maxFileSizeMb } = await getPlanLimits()
  return maxFileSizeMb * 1024 * 1024
}

/**
 * plan.features 快照（MA-01）：返回 null = 快照不可用（拉取失败/尚未加载），
 * 消费方自行决定兜底策略（useMenuAccess 按 fail-open 放行，服务端权威校验兜底）。
 * 复用 loadPlanLimits 的单飞请求与 TTL 缓存，不会发起第二个请求。
 */
export async function getPlanFeatures(): Promise<Record<string, boolean> | null> {
  await loadPlanLimits()
  return planFeaturesSnapshot.value
}

/**
 * usePlanLimits：Vue 组合式入口。状态全部在模块级（单例），
 * 多组件/多实例调用共享同一缓存与在途请求，不会重复请求后端。
 */
export function usePlanLimits() {
  return { getPlanLimits, getMaxUploadBytes, isPlanLimitsFallback, invalidatePlanLimits, getUpgradePlanBenefits, getPlanFeatures, planFeaturesSnapshot }
}

// ------------------------------------------------------------------------
// 下一档套餐收益查询（F3.1 升级引导，只读扩展）
// ------------------------------------------------------------------------

/**
 * 下一档套餐收益（按套餐名从 GET /api/subscriptions/plans 列表查询）。
 * 升级按钮文案的单文件/存储数值一律来自该接口，桌面端绝不硬编码套餐数值；
 * 套餐名不在列表 / 接口失败时返回 null，调用方退化为不带数值的升级文案。
 */
export interface UpgradePlanBenefits {
  name: string
  maxFileSizeMb: number
  maxStorageMb: number
}

// plans 列表与套餐限额同频（低频变更），复用同一 TTL；失败不缓存（下次重试）
let plansCache: { at: number; plans: UpgradePlanBenefits[] } | null = null

export async function getUpgradePlanBenefits(
  planName: string | null | undefined,
): Promise<UpgradePlanBenefits | null> {
  const name = String(planName || '').trim()
  if (!name) return null
  if (plansCache && Date.now() - plansCache.at < CACHE_TTL_MS) {
    return plansCache.plans.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null
  }
  // GET /api/subscriptions/plans：公开端点，响应
  // { plans: [{ name, maxFileSizeMb, maxStorageMb, ... }] }（camelCase，见 subscriptions.js）
  const res = await api('GET', '/api/subscriptions/plans')
  if (!res.ok || !Array.isArray(res.data?.plans)) return null
  const plans: UpgradePlanBenefits[] = (res.data.plans as any[])
    .map((p) => ({
      name: String(p?.name || ''),
      maxFileSizeMb: normalizeLimit(p?.maxFileSizeMb),
      maxStorageMb: normalizeLimit(p?.maxStorageMb),
    }))
    .filter((p) => p.name)
  plansCache = { at: Date.now(), plans }
  return plans.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null
}

// ------------------------------------------------------------------------
// 套餐价格（订阅/支付页渲染源：管理台 subscription_plans 实时数据，杜绝硬编码）
// ------------------------------------------------------------------------

export interface PricingPlan {
  id: string
  /** 套餐英文标识：Free / Pro / Enterprise */
  name: string
  displayName: string
  /** 月付价格（元），来自管理台可编辑的 price_monthly */
  priceMonthly: number
  /** 年付价格（元） */
  priceYearly: number
}

let pricingCache: { at: number; plans: PricingPlan[] } | null = null

/**
 * 套餐价格列表（GET /api/subscriptions/plans，公开端点）。
 * PricingSubPage / PricingPaymentModals 渲染源——此前两处硬编码 ¥9.9/¥29
 * 与管理台套餐表（19.9/199）不一致（用户验收实测），统一改走本接口。
 * 失败返回空数组，调用方显示「—」占位而非虚构价格。
 */
export async function getPricingPlans(): Promise<PricingPlan[]> {
  if (pricingCache && Date.now() - pricingCache.at < CACHE_TTL_MS) {
    return pricingCache.plans
  }
  const res = await api('GET', '/api/subscriptions/plans')
  if (!res.ok || !Array.isArray(res.data?.plans)) return []
  const plans: PricingPlan[] = (res.data.plans as any[])
    .map((p) => ({
      id: String(p?.id || ''),
      name: String(p?.name || ''),
      displayName: String(p?.displayName || p?.name || ''),
      priceMonthly: Number(p?.price ?? p?.priceMonthly ?? 0),
      priceYearly: Number(p?.priceYearly ?? 0),
    }))
    .filter((p) => p.id && p.name)
  pricingCache = { at: Date.now(), plans }
  return plans
}
