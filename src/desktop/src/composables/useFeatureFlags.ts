// === 功能开关（feature flags）桌面端消费层 ===
// 唯一数据源：后端 GET /api/app/feature-flags（公开只读快照）+ WS `feature_flags.updated` 推送。
// 服务端权威强制（requireFlag 403 + flagDisabled 标识）始终兜底；本层负责把
// 「开关关闭」提前到 UI 层：隐藏/禁用所有相关入口（AI / 公开分享 / 2FA / 订阅）。
// 契约与优先级见 src/server/src/utils/featureFlags.js：
//   管理台写库 → 进程内 ≤5s 生效 → WS 广播全端 → 客户端拉取/推送即时感知。
import { ref } from 'vue'
import { api } from '@/api/client'

/** 客户端可见的开关键（与服务端 routes/app.js CLIENT_FLAG_KEYS 对齐） */
export type FeatureFlagKey =
  | 'enable_subscription'
  | 'enable_ai_agent'
  | 'enable_public_sharing'
  | 'enable_2fa'
  | 'signup_waitlist'
  | 'enable_signup'

// 模块级单例状态：所有组件共享同一份快照，WS 推送一次更新全局生效
const flags = ref<Record<string, boolean>>({})
const loaded = ref(false)
let inflight: Promise<void> | null = null

/**
 * 从后端拉取最新开关快照（公开端点，登录前后均可调用）。
 * 失败时保留上次快照并静默——开关系统故障不应隐藏全部功能入口，
 * 此时未加载的键按 isFlagEnabled 默认放行，交服务端 403 兜底。
 */
export async function refreshFeatureFlags(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await api('GET', '/api/app/feature-flags')
      if (res.ok && res.data && typeof res.data === 'object') {
        const next = (res.data as any).flags ?? res.data
        if (next && typeof next === 'object') {
          flags.value = { ...flags.value, ...next }
          loaded.value = true
        }
      }
    } catch {
      /* 静默失败：保留上次快照，未加载键默认放行 */
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** WS `feature_flags.updated` 推送到达时直接写入快照（无网络往返） */
export function applyFeatureFlags(next: Record<string, boolean> | undefined | null): void {
  if (next && typeof next === 'object') {
    flags.value = { ...flags.value, ...next }
    loaded.value = true
  }
}

/** 登出时清空快照，避免下一个账号继承上一个账号感知的开关状态 */
export function resetFeatureFlags(): void {
  flags.value = {}
  loaded.value = false
}

/**
 * 读取单个开关。未加载/未知键默认 true（放行）：与后端 isFlagEnabled 的
 * fallback=true 哲学一致——开关基础设施异常时客户端不隐藏入口，
 * 越权行为仍由服务端 403（flagDisabled）权威兜底。
 */
export function isFlagEnabled(key: FeatureFlagKey): boolean {
  const v = flags.value[key]
  return v === undefined ? true : Boolean(v)
}

/** Vue 组合式入口：多组件调用共享模块级单例状态 */
export function useFeatureFlags() {
  return { flags, loaded, isFlagEnabled, refreshFeatureFlags, applyFeatureFlags, resetFeatureFlags }
}
