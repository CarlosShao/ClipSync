// === 统一用户数据清理（登出 / 换号 / 会话失效的唯一出口）===
// 所有登出路径都必须调用 clearAllUserState()，不再各写一份：
//   - 主动登出 configStore.logout()
//   - 会话过期 / 被踢 / 401 刷新失败 client.ts forceLogout()
// 只清「用户数据 + 内存单例」；configStore 的响应式 refs（config.token/user_id、user.value）
// 与 client.ts 的模块级 csrf 变量由各自调用方复位（它们属于各自模块的私有状态）。
//
// 清理范围（穷尽）：
//   localStorage 用户数据键 + 命名空间分桶（离线队列 / 内容缓存）+ 同步日志 + 用户归属标记
//   内存单例：剪贴板列表/分页/筛选/去重、复制回声去重（含明文）、blob objectURL、
//             设备列表缓存、收藏树、当前用户 RBAC、条目解锁明文缓存、通知、公告、
//             套餐限额快照、当前订阅快照、功能开关、策略、菜单覆盖。
// 保留（设备级，不含用户数据）：后端地址、主题/字号/字体、快捷键、同步间隔、
//   引导/教练/问卷/首用标记、AI 面板宽度与模式偏好、记住我、安全通知已读、公告已读记忆。

import { releaseAllObjectUrls } from '@/composables/clipboardObjectUrls'
import { resetClipboardState } from '@/composables/clipboardState'
import { resetCopiedMemory } from '@/composables/clipboardDedup'
import { clearContentCache } from '@/composables/clipboardCache'
import { clearDevicesCache } from '@/composables/clipboardLoad'
import { resetSyncLog } from '@/composables/useSyncLog'
import { useCollectionStore } from '@/stores/collectionStore'
import { useUser } from '@/composables/useUser'
import { useItemPassword } from '@/composables/useItemPassword'
import { useNotifications } from '@/composables/useNotifications'
import { useAnnouncements } from '@/composables/useAnnouncements'
import { invalidatePlanLimits } from '@/composables/usePlanLimits'
import { invalidateCurrentSubscription } from '@/composables/useSubscriptionAccess'
import { resetFeatureFlags } from '@/composables/useFeatureFlags'
import { resetPolicies } from '@/composables/usePolicy'
import { resetOverrides } from '@/composables/useMenuAccess'
import { clearQueue } from '@/utils/offlineQueue'
import { clearUserScope } from '@/utils/userScope'
import * as tauri from '@/lib/tauri'

// 非命名空间的用户数据 / 凭证键。content-cache-v2 与 offline-queue 已命名空间化，
// 由 clearContentCache()/clearQueue() 负责清除（含旧无命名空间键与所有历史用户分桶）。
const USER_DATA_KEYS = [
  'clipsync-token',
  'clipsync-refresh-token',
  'clipsync-csrf',
  'clipsync-avatar',
  'clipsync-last-sync-at',
  'clipsync-clipboard-filter',
  'clipsync-favorites',
  'clipsync-device-id',
  'clipsync-chunked-upload',
]

export function clearAllUserState(): void {
  // ── localStorage：凭证 + 用户数据 ──
  for (const key of USER_DATA_KEYS) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  }
  // 命名空间分桶（清掉所有用户桶 + 匿名桶 + 旧无命名空间键）
  clearQueue()
  clearContentCache()
  // 同步日志（记录了上个账号剪贴板条目的类型/大小/来源）
  resetSyncLog()
  // 复位用户归属标记，使下次登录从匿名桶起、解析后重新命名空间化
  clearUserScope()

  // ── 内存单例 ──
  releaseAllObjectUrls() // 图片 blob objectURL（防旧账号图片常驻 WebView 内存）
  resetClipboardState() // 剪贴板列表/分页/筛选/上传去重
  resetCopiedMemory() // 复制回声去重映射（copiedItems 含剪贴板明文）
  clearDevicesCache() // 设备列表内存缓存

  // Pinia store 与 composable 单例：全部 try 包裹，store/composable 未初始化时跳过
  try {
    useCollectionStore().reset() // 收藏夹树
  } catch {
    /* ignore */
  }
  try {
    useUser().resetUser() // 当前用户 RBAC（复位 loaded，确保下次登录重取）
  } catch {
    /* ignore */
  }
  try {
    useItemPassword().clearUnlocked() // 条目解锁后的明文缓存
  } catch {
    /* ignore */
  }
  try {
    useNotifications().reset()
  } catch {
    /* ignore */
  }
  try {
    useAnnouncements().reset()
  } catch {
    /* ignore */
  }
  try {
    invalidatePlanLimits() // 套餐限额快照
    invalidateCurrentSubscription() // 当前订阅快照
    resetFeatureFlags()
    resetPolicies()
    resetOverrides() // 菜单覆盖
  } catch {
    /* ignore */
  }

  // ── Rust 侧持久化认证态（clear_auth 只清 token/device_id/user_id，不动 server_url/快捷键）──
  try {
    tauri.clearAuth().catch(() => {})
  } catch {
    /* 非 Tauri 环境（浏览器 dev）忽略 */
  }
}
