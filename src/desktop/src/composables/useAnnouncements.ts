// === 公告投递（CO-35）===
// 数据源：后端 GET /api/app/announcements（optionalAuth，受众按登录身份过滤）+
// POST /api/app/announcements/:id/read（登录后已读回执，服务端 PK 幂等）。
// 服务端列表响应不回传已读标记（字段：id/title/content/audience/displayMode/sentAt），
// 已读状态由客户端本地记录（localStorage）驱动 unreadCount 与横幅显隐；
// 回执仅供服务端统计，上报失败不影响本端判定。
// displayMode 语义（与移动端/管理台对齐）：once 只提示一次（已读即不再展示），
// persistent 常驻提示直到用户知悉（横幅「我知道了」写 dismissed-announcement-{id}）。
import { ref, computed } from 'vue'
import { api } from '@/api/client'
import { useConfigStore } from '@/stores/configStore'

export interface Announcement {
  id: string
  title: string
  content: string
  audience: string
  displayMode: 'once' | 'persistent'
  sentAt: string
}

// ===== 模块级单例状态（跨组件共享，与 useNotifications 同模式）=====
const announcements = ref<Announcement[]>([])
const loading = ref(false)

// ===== 本地已读记录（localStorage 持久化，跨会话生效）=====
const READ_KEY = 'clipsync-announcement-reads'
function loadReadIds(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(READ_KEY) || '[]') as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}
// 用 ref 承载 Set：变更时整体替换新 Set，保证 unreadCount 计算属性可响应
const readIds = ref<Set<string>>(loadReadIds())

function persistReadIds() {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify([...readIds.value]))
  } catch {
    /* ignore */
  }
}

function isRead(id: string): boolean {
  return readIds.value.has(id)
}

/**
 * 本地标记已读 + 上报回执（fire-and-forget）。
 * 已读则直接返回（防重复上报/重复写库，服务端回执本身也幂等）。
 */
function markRead(id: string) {
  if (!id || readIds.value.has(id)) return
  const next = new Set(readIds.value)
  next.add(id)
  readIds.value = next
  persistReadIds()
  // 未登录只做本地标记：回执端点 401 会触发全局登出广播，不能误伤游客态
  if (!useConfigStore().config.token) return
  api('POST', `/api/app/announcements/${id}/read`).catch(() => {})
}

// ===== 横幅关闭记忆（localStorage 键 dismissed-announcement-{id}）=====
const DISMISSED_PREFIX = 'dismissed-announcement-'
function isDismissed(id: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_PREFIX + id) === '1'
  } catch {
    return false
  }
}
/** 知悉公告：写横幅关闭记忆 + 上报已读回执（本地标记由 markRead 兜底防重复） */
function dismissAnnouncement(id: string) {
  try {
    localStorage.setItem(DISMISSED_PREFIX + id, '1')
  } catch {
    /* ignore */
  }
  markRead(id)
}

async function fetchAnnouncements() {
  if (loading.value) return
  loading.value = true
  try {
    const res = await api<{ announcements: Announcement[] }>('GET', '/api/app/announcements')
    if (res.ok && Array.isArray(res.data?.announcements)) {
      announcements.value = res.data.announcements
    } else {
      // 拉取失败静默（console.warn），不影响主界面
      console.warn('[Announcements] 拉取公告失败:', res.error)
    }
  } catch (e: any) {
    console.warn('[Announcements] 拉取公告异常:', e?.message || e)
  } finally {
    loading.value = false
  }
}

/** 未读数：列表按 created_at DESC 返回，未读 = 本地已读记录中不存在的条目 */
const unreadCount = computed(() => announcements.value.filter((a) => !readIds.value.has(a.id)).length)

/** 用户登出 / 切换账号时清空公告列表（已读/关闭记忆保留，避免旧公告重弹） */
function reset() {
  announcements.value = []
  loading.value = false
}

export function useAnnouncements() {
  return {
    announcements,
    loading,
    unreadCount,
    fetchAnnouncements,
    isRead,
    markRead,
    isDismissed,
    dismissAnnouncement,
    reset,
  }
}
