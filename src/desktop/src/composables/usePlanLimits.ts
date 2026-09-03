// === 套餐限额（F0.4）：唯一数据源是后端 /api/subscriptions/current 下发 ===
// 此前桌面端在 clipboardUpload 与 useClipboard.uploadFileItem 两处各自硬编码了
// Free 128MB / Pro 256MB / Enterprise 1GB 的上传阈值，与服务端
// subscription_plans 表漂移；本模块统一改为后端下发 + 模块级缓存。
// 契约：{ subscription: {...}|null, plan: { maxFileSizeMb, maxStorageMb,
// maxFilesPerClip, fileRetentionDays, ... } }；admin 场景下部分字段可能为 null。
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
let cached: PlanLimits | null = null
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

/** 后端字段归一：null / undefined / 非正的有限数（如 admin 的不限字段）→ Infinity */
function normalizeLimit(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY
}

async function fetchPlanLimits(): Promise<PlanLimits> {
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
  return {
    maxFileSizeMb: normalizeLimit(plan.maxFileSizeMb),
    maxStorageMb: normalizeLimit(plan.maxStorageMb),
    maxFilesPerClip: normalizeLimit(plan.maxFilesPerClip),
    fileRetentionDays: normalizeLimit(plan.fileRetentionDays),
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
    }
    return { ...fresh }
  } catch (e) {
    console.warn('[usePlanLimits] 加载套餐限额失败，沿用上次缓存/兜底值：', e)
    if (gen === generation) {
      // 沿用旧缓存（来自真实接口）→ 非兜底；首次失败（无缓存）才退到兜底默认值
      cachedIsFallback = cached === null
      cached = cached ?? FALLBACK_LIMITS
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
 * usePlanLimits：Vue 组合式入口。状态全部在模块级（单例），
 * 多组件/多实例调用共享同一缓存与在途请求，不会重复请求后端。
 */
export function usePlanLimits() {
  return { getPlanLimits, getMaxUploadBytes, isPlanLimitsFallback, invalidatePlanLimits, getUpgradePlanBenefits }
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
