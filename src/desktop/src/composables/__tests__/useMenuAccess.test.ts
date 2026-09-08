// === useMenuAccess 单测（MA-01 工单缺口）===
// 三依赖（useFeatureFlags / useUser / configStore / usePlanLimits 的 features 快照）
// 全部 vi.mock 注入受控数据，不依赖 Pinia 真实 store 与网络。
// 注册表真值以 useMenuAccess.ts 的 MENU_CAPABILITIES 为准（键名与条件见该文件）。
import { ref } from 'vue'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- 受控依赖状态（mock 工厂内只建闭包不取值，读取发生在测试执行期，规避 TDZ）----
// flags 快照：isFlagEnabled 与服务端同哲学——未加载/未知键默认放行，仅明确 false 拦截
const flagValues: Record<string, boolean> = {}
// 当前用户
const isSuperAdmin = ref(false)
const mockUserState = { plan: 'Free' as string }
// plan.features 快照：null = 未加载（fail-open），否则键值是权威数据
const featuresSnapshot = ref<Record<string, boolean> | null>(null)

vi.mock('@/composables/useFeatureFlags', () => ({
  isFlagEnabled: (key: string) => flagValues[key] !== false,
}))
vi.mock('@/composables/useUser', () => ({
  useUser: () => ({ isSuperAdmin }),
}))
vi.mock('@/stores/configStore', () => ({
  useConfigStore: () => ({ user: mockUserState }),
}))
vi.mock('@/composables/usePlanLimits', () => ({
  get planFeaturesSnapshot() {
    return featuresSnapshot
  },
  getPlanFeatures: async () => featuresSnapshot.value,
}))

import { can, modeOf, setOverrides, resetOverrides, useMenuAccess } from '@/composables/useMenuAccess'

function setPlan(plan: string) {
  mockUserState.plan = plan
}

beforeEach(() => {
  // 每个用例从「全放行基线」出发：flag 未设、Free 用户、非超管、features 未加载
  for (const k of Object.keys(flagValues)) delete flagValues[k]
  isSuperAdmin.value = false
  setPlan('Free')
  featuresSnapshot.value = null
  resetOverrides()
})

describe('can() 三层判定（flag × 套餐 × planFeature）', () => {
  it('flags 层：enable_ai_agent 开 → nav.ai 放行；关 → 拦截', () => {
    flagValues['enable_ai_agent'] = true
    expect(can('nav.ai')).toBe(true)
    flagValues['enable_ai_agent'] = false
    expect(can('nav.ai')).toBe(false)
  })

  it('minPlan 层：history.unlimited — Pro/Enterprise 达标，Free 拦截', () => {
    setPlan('Free')
    expect(can('history.unlimited')).toBe(false)
    setPlan('Pro')
    expect(can('history.unlimited')).toBe(true)
    setPlan('Enterprise')
    expect(can('history.unlimited')).toBe(true)
  })

  it('planFeature 层：feature.ai_categories — ai_classify=true 放行，false 拦截，快照 null fail-open', () => {
    featuresSnapshot.value = { ai_classify: true }
    expect(can('feature.ai_categories')).toBe(true)
    featuresSnapshot.value = { ai_classify: false }
    expect(can('feature.ai_categories')).toBe(false)
    // 快照未加载（拉取失败/尚未加载）→ 放行，服务端 requireFeature 403 兜底
    featuresSnapshot.value = null
    expect(can('feature.ai_categories')).toBe(true)
  })

  it('多层与关系：share.create 需 flag 与 planFeature 同时满足', () => {
    // share.create = flags[enable_public_sharing] + planFeature[team_management]
    flagValues['enable_public_sharing'] = true
    featuresSnapshot.value = { team_management: true }
    expect(can('share.create')).toBe(true)
    featuresSnapshot.value = { team_management: false }
    expect(can('share.create')).toBe(false)
    flagValues['enable_public_sharing'] = false
    featuresSnapshot.value = { team_management: true }
    expect(can('share.create')).toBe(false)
  })

  it('superAdminOnly 层：nav.admin 仅超管放行', () => {
    expect(can('nav.admin')).toBe(false)
    isSuperAdmin.value = true
    expect(can('nav.admin')).toBe(true)
  })
})

describe('未知键默认放行', () => {
  it("can('unknown.key') === true，注册表外不做拦截", () => {
    expect(can('unknown.key')).toBe(true)
    expect(can('feature.not_registered')).toBe(true)
  })
})

describe('modeOf 有效 UI 模式', () => {
  it('放行 → ok', () => {
    flagValues['enable_ai_agent'] = true
    expect(modeOf('nav.ai')).toBe('ok')
  })

  it('拦截且注册表缺省 mode → hide', () => {
    flagValues['enable_ai_agent'] = false
    expect(modeOf('nav.ai')).toBe('hide')
  })

  it("拦截且注册表 mode='disable' → disable（history.unlimited @ Free）", () => {
    setPlan('Free')
    expect(modeOf('history.unlimited')).toBe('disable')
  })

  it('未知键 → can=true → ok', () => {
    expect(modeOf('unknown.key')).toBe('ok')
  })
})

describe('superAdmin 豁免层（跳过 minPlan/planFeature，不豁免 flags）', () => {
  it('超管跳过 minPlan：Free + superAdmin → history.unlimited 放行', () => {
    setPlan('Free')
    isSuperAdmin.value = true
    expect(can('history.unlimited')).toBe(true)
  })

  it('超管跳过 planFeature：ai_classify=false + superAdmin → feature.ai_categories 放行', () => {
    featuresSnapshot.value = { ai_classify: false }
    isSuperAdmin.value = true
    expect(can('feature.ai_categories')).toBe(true)
  })

  it('超管不豁免 flags 层：enable_ai_agent 关 + superAdmin → nav.ai 仍拦截', () => {
    flagValues['enable_ai_agent'] = false
    isSuperAdmin.value = true
    expect(can('nav.ai')).toBe(false)
  })
})

describe('menu_overrides 覆盖（setOverrides / resetOverrides）', () => {
  it("显式 false 优先拦截：flag 开着也拦", () => {
    flagValues['enable_ai_agent'] = true
    expect(can('nav.ai')).toBe(true)
    setOverrides({ 'nav.ai': false })
    expect(can('nav.ai')).toBe(false)
  })

  it("显式 true 短路放行：Free 用户也放（其余层不参与）", () => {
    setPlan('Free')
    expect(can('history.unlimited')).toBe(false)
    setOverrides({ 'history.unlimited': true })
    expect(can('history.unlimited')).toBe(true)
  })

  it('resetOverrides 后恢复注册表判定', () => {
    setOverrides({ 'nav.ai': false, 'history.unlimited': true })
    setPlan('Pro')
    resetOverrides()
    flagValues['enable_ai_agent'] = true
    expect(can('nav.ai')).toBe(true)
    setPlan('Free')
    expect(can('history.unlimited')).toBe(false)
  })
})

describe('useMenuAccess 组合式入口', () => {
  it('返回 can/modeOf/overrides 接口与 features 快照', async () => {
    const { can: canFn, modeOf: modeFn, planFeatures } = useMenuAccess()
    expect(typeof canFn).toBe('function')
    expect(typeof modeFn).toBe('function')
    // ensurePlanFeaturesLoaded 触发的 getPlanFeatures 已被 mock，返回受控快照
    await vi.waitFor(() => expect(planFeatures.value).toStrictEqual(featuresSnapshot.value))
  })
})
