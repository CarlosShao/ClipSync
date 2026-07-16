import { ref, computed } from 'vue'
import { api } from '@/api/client'
import {
  getNotificationHistory,
  markNotificationRead,
  getNotificationPreferences,
  updateNotificationPreference,
  type NotificationHistoryRow,
} from '@/api/notifications'

export type NotifCategory = 'subscription' | 'update' | 'device' | 'security'

export interface Notif {
  id: string
  category: NotifCategory
  title: string
  body: string
  time: number
  read: boolean
}

// 后端 notification_type → 前端分类
export function typeToCategory(type?: string | null): NotifCategory {
  if (!type) return 'update'
  const t = type.toLowerCase()
  if (t.includes('device')) return 'device'
  if (t.includes('security')) return 'security'
  if (t.includes('subscription')) return 'subscription'
  return 'update'
}

function mapRow(row: NotificationHistoryRow): Notif {
  return {
    id: String(row.id),
    category: typeToCategory(row.notification_type),
    title: row.title || '',
    body: row.content || '',
    time: row.sent_at ? new Date(row.sent_at).getTime() : Date.now(),
    read: !!row.read_at,
  }
}

// ===== 模块级单例状态（跨组件共享，WS 实时推送可全局更新）=====
const notifications = ref<Notif[]>([])
const loading = ref(false)

// 加载历史期间的实时推送缓冲：loadHistory 异步请求在途时到达的 WS 推送，
// 若直接插入会被 loadHistory 的整表重写覆盖丢失。先缓存，加载完成后合并去重。
let pendingRealtime: Notif[] = []

async function loadHistory() {
  if (loading.value) return
  loading.value = true
  pendingRealtime = []
  try {
    const res = await getNotificationHistory(100, 0)
    if (res.ok && Array.isArray(res.data)) {
      const history = res.data.map(mapRow)
      // 合并加载期间缓冲的实时推送（按 id 去重），防止丢失
      const seen = new Set(history.map((h) => h.id))
      const buffered = pendingRealtime.filter((n) => {
        if (seen.has(n.id)) return false
        seen.add(n.id)
        return true
      })
      notifications.value = [...buffered, ...history]
    } else {
      // 请求失败（未登录/离线/服务端未起）：保留现有数据，不覆盖
      console.warn('[Notifications] 加载历史失败:', res.error)
    }
  } catch (e: any) {
    console.warn('[Notifications] 加载历史异常:', e?.message || e)
  } finally {
    loading.value = false
  }
}

/** 用户登出 / 切换账号时清空通知列表，防止旧数据残留 */
function reset() {
  notifications.value = []
  loading.value = false
}

async function markRead(id: string) {
  const n = notifications.value.find((x) => x.id === id)
  if (!n) return
  if (n.read) return // 已读则避免重复请求
  n.read = true // 乐观更新
  const res = await markNotificationRead(id)
  if (!res.ok) {
    // 回滚
    n.read = false
    console.warn('[Notifications] 标记已读失败:', res.error)
  }
}

async function markAllRead() {
  const unread = notifications.value.filter((n) => !n.read)
  unread.forEach((n) => (n.read = true)) // 乐观更新
  await Promise.all(
    unread.map((n) =>
      markNotificationRead(n.id).then((res) => {
        // 仅当接口真正失败且当前仍显示已读时才回滚
        if (!res.ok && n.read) n.read = false
      }),
    ),
  )
}

// WS 实时推送 → 插入列表（去重）
function pushRealtime(payload: any) {
  if (!payload || payload.type !== 'notification') return
  const id = payload.id != null ? String(payload.id) : `rt_${Date.now()}`
  const n: Notif = {
    id,
    category: typeToCategory(payload.notificationType),
    title: payload.title || '',
    body: payload.body || '',
    time: payload.timestamp ? new Date(payload.timestamp).getTime() : Date.now(),
    read: false,
  }
  // 历史加载在途：先缓冲，待 loadHistory 合并，避免被整表重写覆盖
  if (loading.value) {
    if (!pendingRealtime.some((x) => x.id === id)) pendingRealtime.push(n)
    return
  }
  if (notifications.value.some((x) => x.id === id)) return
  notifications.value = [n, ...notifications.value]
}

const unreadCount = computed(() => notifications.value.filter((n) => !n.read).length)

// ===== 通知偏好（与后端 notification_type 映射）=====
// 前端开关 key → 后端 notification_type
export const PREF_TYPE_BY_KEY: Record<string, string> = {
  nfNewDevice: 'device_online',
  nfSyncDone: 'sync_complete',
  nfSecurity: 'security_alert',
  nfUpdates: 'product_update',
}
const KEY_BY_PREF_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(PREF_TYPE_BY_KEY).map(([k, v]) => [v, k]),
)

async function loadPreferencesInto(target: Record<string, boolean>) {
  try {
    const res = await getNotificationPreferences()
    if (res.ok && Array.isArray(res.data)) {
      const map: Record<string, boolean> = {}
      res.data.forEach((p) => { map[p.notification_type] = !!p.enabled })
      Object.entries(PREF_TYPE_BY_KEY).forEach(([key, type]) => {
        if (map[type] !== undefined) target[key] = map[type]
      })
    }
  } catch (e: any) {
    console.warn('[Notifications] 加载偏好失败:', e?.message || e)
  }
}

async function savePreference(key: string, enabled: boolean) {
  const type = PREF_TYPE_BY_KEY[key]
  if (!type) return
  const res = await updateNotificationPreference(type, enabled)
  if (!res.ok) console.warn('[Notifications] 保存偏好失败:', res.error)
}

export function useNotifications() {
  return {
    notifications,
    unreadCount,
    loading,
    loadHistory,
    markRead,
    markAllRead,
    pushRealtime,
    loadPreferencesInto,
    savePreference,
    reset,
    PREF_TYPE_BY_KEY,
    KEY_BY_PREF_TYPE,
  }
}
