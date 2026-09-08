// === 菜单/能力访问控制（MA-01）===
// 把散落在各组件的 feature flag v-if、套餐硬编码、超管判定收敛到一张声明式
// 注册表（MENU_CAPABILITIES），UI 层只问 can(key) / modeOf(key) 两个问题。
//
// 数据源（三层与判定）：
//   1. flags         —— useFeatureFlags（/api/app/feature-flags + WS feature_flags.updated）
//   2. minPlan       —— configStore.user.plan（/api/auth/me 维护），按档位序比较
//   3. planFeature   —— GET /api/subscriptions/current 的 plan.features 布尔键
//                       （经 usePlanLimits 同一请求/缓存提取，见 getPlanFeatures）
//   4. superAdminOnly —— useUser.isSuperAdmin（roleKey === 'super_admin'，MA-06 决策）
//
// 兜底哲学与 isFlagEnabled 一致：数据不可用（开关快照未加载 / features 快照 null）
// 时默认放行，越权行为由服务端 403 / requireFeature 权威兜底；只有拿到了明确
// 的否定数据（flag=false / features 键 !== true / 档位不足 / 非超管）才拦截。
import { ref } from 'vue'
import { isFlagEnabled, type FeatureFlagKey } from '@/composables/useFeatureFlags'
import { useUser } from '@/composables/useUser'
import { useConfigStore } from '@/stores/configStore'
import { getPlanFeatures, planFeaturesSnapshot } from '@/composables/usePlanLimits'

/** 套餐档位（与服务端 subscription_plans.name 对齐；禁止硬编码到业务判定里，仅注册表引用） */
export type MenuPlanTier = 'Free' | 'Pro' | 'Enterprise'

/** 能力不满足时的 UI 表现：hide=入口不渲染，disable=渲染但置灰/拒绝交互 */
export type MenuAccessMode = 'hide' | 'disable'

/** modeOf() 的返回：ok=放行 */
export type MenuAccessModeResult = 'ok' | MenuAccessMode

/** 注册表条目：各层条件为「与」关系，省略的层视为满足 */
export interface MenuCapability {
  /** 依赖的功能开关键（全部开启才放行） */
  flags?: string[]
  /** 最低套餐档位（Free < Pro < Enterprise） */
  minPlan?: MenuPlanTier
  /** 依赖的 subscription_plans.features 布尔键（如 hasOcr） */
  planFeature?: string
  /** 仅系统超管（roleKey === 'super_admin'）可见 */
  superAdminOnly?: boolean
  /** 不满足时的表现，缺省 'hide' */
  mode?: MenuAccessMode
}

/**
 * 菜单能力注册表（唯一真相源）。
 * 迁移原则：现有行为等价迁移 —— 原先直接判 isFlagEnabled 的入口只映射 flags 层。
 * Flutter 侧（MA-04）按同一批键名镜像常量，键名即两端契约。
 */
export const MENU_CAPABILITIES: Record<string, MenuCapability> = {
  // --- 功能开关层（原 11 处 flag 门控的归一，MA-02）---
  'nav.ai': { flags: ['enable_ai_agent'] },
  'nav.subscription': { flags: ['enable_subscription'] },
  'settings.ai': { flags: ['enable_ai_agent'] },
  'settings.subscription': { flags: ['enable_subscription'] },
  'settings.security.2fa': { flags: ['enable_2fa'] },
  // share.create：公开分享创建已挂服务端套餐墙（team_management，仅 Enterprise true，
  // 见 middleware/planFeature.js；已创建链接的访问/管理不受影响）。右键菜单空间小
  // 无升级引导位，取默认 hide，误触路径由服务端 403 中文提示兜底。
  'share.create': { flags: ['enable_public_sharing'], planFeature: 'team_management' },
  // --- 套餐层（MA-03：GeneralSettings 无限历史硬编码收敛）---
  'history.unlimited': { minPlan: 'Pro', mode: 'disable' },
  // --- 角色层（MA-06：管理控制台外链仅超管）---
  'nav.admin': { superAdminOnly: true },
  // --- plan.features 差异化功能（MA-05 决策：按真实 features 布尔键真锁，禁止硬编码套餐名）---
  // Wave2-H 调研结论：真实库键为 ai_classify/team_management/full_text_search/
  // push_notification/version_history_days/audit_logs/offline_queue/e2e_encryption；
  // hasOcr/hasAICategories/hasPrioritySync/hasTeamSharing 为移动端营销占位，库中不存在。
  // ai_classify：POST /api/ai/suggest（AI 建议）已挂服务端套餐墙，三档当前均 true（零行为变化）。
  // ocr：服务端有实现但 features 无对应键——待产品拍板键名后在此登记并挂墙（现在挂会锁死全员）。
  // priority_sync：功能不存在（无服务端执行点），不注册。
  'feature.ai_categories': { planFeature: 'ai_classify' },
}

// ---------------------------------------------------------------------------
// menu_overrides（MA-07）—— 诚实状态：本轮仅预留接口，未接入生效通道
// ---------------------------------------------------------------------------
// 服务端的 menu_overrides 存在 system_configs 表，唯一读取端点是
// GET /api/admin/configs（仅管理台/管理员会话可读），客户端没有任何公开只读
// 端点能拿到它。因此本轮【不发起任何不存在的请求】：setOverrides() 仅提供
// 进程内写入入口（生效通道待服务端补「公开只读端点 + WS 推送」后接入，
// 届时在 app 启动 / WS 分支里调用本方法即可，注册表判定逻辑无需改动）。
const overrides = ref<Record<string, boolean>>({})

/**
 * 预留接口：写入 menu_overrides 覆盖表（键 → true 强制放行 / false 强制拦截）。
 * ⚠️ 当前没有自动拉取通道（见上方诚实状态说明）——只有调用方显式调用才会生效。
 */
export function setOverrides(next: Record<string, boolean> | undefined | null): void {
  overrides.value = next && typeof next === 'object' ? { ...next } : {}
}

/** 清空 overrides（登出/换号时调用方负责，与 resetFeatureFlags 同模式） */
export function resetOverrides(): void {
  overrides.value = {}
}

// ---------------------------------------------------------------------------
// 判定实现
// ---------------------------------------------------------------------------

/** 档位序：Free(0) < Pro(1) < Enterprise(2)。未知/空套餐按 0 处理（保守，与原 `plan !== 'Pro' && ...` 行为一致） */
const PLAN_TIER_ORDER: Record<string, number> = { free: 0, pro: 1, enterprise: 2 }
function planTierOf(name: string | undefined | null): number {
  const v = PLAN_TIER_ORDER[String(name ?? '').trim().toLowerCase()]
  return typeof v === 'number' ? v : 0
}

/** flags 层：全部开启才放行；快照未加载/未知键由 isFlagEnabled 默认放行 */
function checkFlags(cap: MenuCapability): boolean {
  if (!cap.flags || cap.flags.length === 0) return true
  return cap.flags.every((f) => isFlagEnabled(f as FeatureFlagKey))
}

/** minPlan 层：当前套餐档位 ≥ 要求档位 */
function checkMinPlan(cap: MenuCapability): boolean {
  if (!cap.minPlan) return true
  const configStore = useConfigStore()
  return planTierOf(configStore.user.plan) >= planTierOf(cap.minPlan)
}

/**
 * planFeature 层：plan.features[键] === true。
 * features 快照为 null（拉取失败/尚未加载）→ 放行（fail-open，服务端 requireFeature 403 兜底）；
 * 快照已加载则键值是权威数据：缺失或非 true 一律拦截。
 */
function checkPlanFeature(cap: MenuCapability): boolean {
  if (!cap.planFeature) return true
  const snap = planFeaturesSnapshot.value
  if (!snap) return true
  return snap[cap.planFeature] === true
}

/** superAdminOnly 层：useUser.isSuperAdmin（roleKey === 'super_admin'） */
function checkSuperAdmin(cap: MenuCapability): boolean {
  if (!cap.superAdminOnly) return true
  return useUser().isSuperAdmin.value
}

/**
 * 能力判定：四层与。未知键默认放行（注册表外不做拦截，避免新入口被误杀）。
 * 可在模板/计算属性中直接调用：内部全部读取响应式数据（flags 快照、user.plan、
 * features 快照、roleKey），依赖变更会自动触发重渲染。
 *
 * MA-05 决策（超管不受套餐限制）：super_admin 跳过 minPlan/planFeature 两层
 * （套餐是商业概念，超管是系统身份——不显示"免费版"也不被功能墙拦）；
 * flags 层保留（全局运营开关对所有人生效，包括超管）。
 */
export function can(key: string): boolean {
  const cap = MENU_CAPABILITIES[key]
  if (!cap) return true
  // overrides 显式覆盖（MA-07 预留）：false 拦截优先，true 放行短路其余层
  const ov = overrides.value[key]
  if (ov === false) return false
  if (ov === true) return true
  if (!checkFlags(cap)) return false
  if (cap.minPlan || cap.planFeature) {
    // 超管跳过套餐层（useUser.isSuperAdmin 为响应式 ref）
    if (!useUser().isSuperAdmin.value) {
      if (!checkMinPlan(cap)) return false
      if (!checkPlanFeature(cap)) return false
    }
  }
  return checkSuperAdmin(cap)
}

/**
 * 有效 UI 模式：ok=放行；否则取注册表 mode（缺省 'hide'）。
 * 未知键 → can=true → 'ok'。
 */
export function modeOf(key: string): MenuAccessModeResult {
  if (can(key)) return 'ok'
  return MENU_CAPABILITIES[key]?.mode ?? 'hide'
}

// plan.features 首次拉取去重：仅在快照缺失且无在途请求时触发（loadPlanLimits
// 内部还有 TTL/单飞兜底，不会重复打接口）。快照为 null 时下次 useMenuAccess()
// 调用会再试，失败路径命中 TTL 缓存，代价可忽略。
let planFeaturesInflight: Promise<unknown> | null = null
function ensurePlanFeaturesLoaded(): void {
  if (planFeaturesSnapshot.value || planFeaturesInflight) return
  planFeaturesInflight = getPlanFeatures().finally(() => {
    planFeaturesInflight = null
  })
}

/** Vue 组合式入口：多组件调用共享模块级注册表与快照状态 */
export function useMenuAccess() {
  // 组件 setup 内调用（此时 Pinia 已激活）：顺带触发 plan.features 首次拉取
  ensurePlanFeaturesLoaded()
  return { can, modeOf, setOverrides, resetOverrides, planFeatures: planFeaturesSnapshot }
}
