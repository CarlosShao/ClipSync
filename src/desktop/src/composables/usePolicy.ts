// === 客户端策略下发（AN-02）桌面端消费层 ===
// 唯一数据源：后端 GET /api/app/policies（公开只读快照，ETag/短缓存）+ WS `policies.updated` 推送。
// 语义（工单 AN-02）：服务端值为默认/边界；`allowUserOverride: false` 的项客户端对应
// 设置项置灰锁定（用户改了也不生效，实际值始终被钳制在策略边界内）。
// 与本地 prefs 的合并策略在消费点执行（configStore 的原始偏好不动，钳制在读取侧）——
// 策略解除后本地值自动恢复生效，与工单验收「改回允许用户改后本地值恢复」一致。
//
// fail-open 哲学与 useFeatureFlags 一致：策略未加载/未知键按目录默认语义（=「不干预」，
// 与历史行为一致）放行，服务端配额/限流等权威兜底不受影响。
import { ref, computed } from 'vue'
import { api } from '@/api/client'

/** 客户端可见的策略键（与服务端 utils/clientPolicies.js POLICY_CATALOG 对齐） */
export type PolicyKey = 'pin_min_length' | 'sync_interval_min_minutes' | 'max_history_items'

export interface PolicyEntry {
  value: number
  allowUserOverride: boolean
}

// 模块级单例状态：所有组件共享同一份快照，WS 推送一次更新全局生效
const policies = ref<Record<string, PolicyEntry>>({})
const loaded = ref(false)
let inflight: Promise<void> | null = null

/**
 * 从后端拉取最新策略快照（公开端点，登录前后均可调用）。
 * 失败时保留上次快照并静默——策略系统故障不应阻塞客户端主流程，
 * 未加载的键按默认语义（不干预）执行。
 */
export async function refreshPolicies(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await api('GET', '/api/app/policies')
      if (res.ok && res.data && typeof res.data === 'object') {
        const next = (res.data as any).policies ?? res.data
        if (next && typeof next === 'object') {
          applyPolicySnapshot(next)
        }
      }
    } catch {
      /* 静默失败：保留上次快照，未加载键按默认语义 */
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** WS `policies.updated` 推送到达时直接写入快照（无网络往返） */
export function applyPolicySnapshot(next: Record<string, PolicyEntry> | undefined | null): void {
  if (!next || typeof next !== 'object') return
  const clean: Record<string, PolicyEntry> = {}
  for (const [k, v] of Object.entries(next)) {
    if (v && typeof v === 'object' && typeof (v as any).value === 'number') {
      clean[k] = { value: (v as any).value, allowUserOverride: (v as any).allowUserOverride !== false }
    }
  }
  policies.value = { ...policies.value, ...clean }
  loaded.value = true
}

/** 登出时清空快照，避免下一个账号继承上一个账号感知的策略状态 */
export function resetPolicies(): void {
  policies.value = {}
  loaded.value = false
}

/** 读取策略数值；未加载/未知键返回 fallback（默认语义 = 不干预） */
export function policyNumber(key: PolicyKey, fallback: number): number {
  const v = policies.value[key]?.value
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 该策略是否允许用户在客户端自行修改（未加载默认允许） */
export function policyAllowsOverride(key: PolicyKey): boolean {
  return policies.value[key]?.allowUserOverride !== false
}

// ── 三个真实消费点的边界值（模块级 computed，跨组件共享响应式）──

/** PIN 最小位数（4-6，默认 4 = 原行为） */
export const pinMinLength = computed(() =>
  Math.min(6, Math.max(4, Math.round(policyNumber('pin_min_length', 4))))
)

/** 同步间隔下限（分钟，0 = 不干预） */
export const minSyncIntervalMinutes = computed(() =>
  Math.max(0, Math.round(policyNumber('sync_interval_min_minutes', 0)))
)

/** 本地历史上限（条，0 = 不干预 = 不设上限） */
export const maxHistoryCeiling = computed(() =>
  Math.max(0, Math.round(policyNumber('max_history_items', 0)))
)

/** Vue 组合式入口：多组件调用共享模块级单例状态 */
export function usePolicy() {
  return {
    policies,
    loaded,
    pinMinLength,
    minSyncIntervalMinutes,
    maxHistoryCeiling,
    policyAllowsOverride,
    refreshPolicies,
    applyPolicySnapshot,
    resetPolicies,
  }
}
