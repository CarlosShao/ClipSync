<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { listen } from '@tauri-apps/api/event'
import { useConfigStore } from '@/stores/configStore'
import { useTheme, resolvedMode } from '@/composables/useTheme'
import { useI18n } from '@/composables/useI18n'
import { useClipboard } from '@/composables/useClipboard'
import { useDevice } from '@/composables/useDevice'
import { useWebSocket } from '@/composables/useWebSocket'
import { useNotifications } from '@/composables/useNotifications'
import { useAnnouncements, type Announcement } from '@/composables/useAnnouncements'
import { useSonner } from '@/composables/useSonner'
import { usePrivacy } from '@/composables/usePrivacy'
import {
  setKeyboardLayer,
  topKeyboardLayer,
  resetKeyboardLayers,
  setQuickPasteOpen,
} from '@/composables/useClipboardKeyboard'
import * as tauri from '@/lib/tauri'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import ClipboardView from '@/components/clipboard/ClipboardView.vue'
// FavoritesView 非首屏（仅切到收藏页时挂载），改异步避免启动即解析其代码
const FavoritesView = defineAsyncComponent(() => import('@/components/clipboard/FavoritesView.vue'))
// TemplatesView 非首屏，异步加载
const TemplatesView = defineAsyncComponent(() => import('@/components/clipboard/TemplatesView.vue'))
import QuickPastePanel from '@/components/QuickPastePanel.vue'
// 设置类页面非首屏，改为异步加载，避免初始化时全部解析进内存
// SettingsView archived to backups/old-settings-v1/ — replaced by SettingsDialog (settings-dialog/)
const SettingsDialog = defineAsyncComponent(() => import('@/components/settings/settings-dialog/SettingsDialog.vue'))
// AI 聊天面板非首屏，异步加载
const AiChatPanel = defineAsyncComponent(() => import('@/components/ai/AiChatPanel.vue'))
const AiSummaryFloat = defineAsyncComponent(() => import('@/components/AiSummaryFloat.vue'))
const ProfileView = defineAsyncComponent(() => import('@/components/settings/ProfileView.vue'))
const DevicesView = defineAsyncComponent(() => import('@/components/settings/DevicesView.vue'))
const SubscriptionView = defineAsyncComponent(() => import('@/components/settings/SubscriptionView.vue'))
const NotificationsView = defineAsyncComponent(() => import('@/components/settings/NotificationsView.vue'))
// ModalManager 携带全套重型库（pdfjs/xlsx/mammoth/highlight.js/jszip/qrcode/jsqr/marked），
// 改为异步 + v-if 门控，仅在真正需要时才加载进内存，避免启动即常驻数十 MB
const ModalManager = defineAsyncComponent(() => import('@/components/modals/ModalManager.vue'))
import OnboardingView from '@/components/OnboardingView.vue'
import CoachMarks from '@/components/CoachMarks.vue'
import SatisfactionSurvey from '@/components/SatisfactionSurvey.vue'
import { perfFirstDataLoad } from '@/utils/perfMonitor'
import { useFeatureFlags } from '@/composables/useFeatureFlags'
import { useMenuAccess } from '@/composables/useMenuAccess'
import { api, toggleSensitive } from '@/api/client'
import { ensureDeviceId } from '@/composables/clipboardUpload'
import { Lock, AlertTriangle, Megaphone, X } from 'lucide-vue-next'

const configStore = useConfigStore()
const { t } = useI18n()
const clip = useClipboard()
const device = useDevice()
const ws = useWebSocket()
const notif = useNotifications()
// CO-35 公告投递：启动/登录后拉取（HomeView 是登录后唯一壳视图，两种路径都经过这里）
const ann = useAnnouncements()
const { toggleMode } = useTheme()
const toast = useSonner()
const privacy = usePrivacy()
const route = useRoute()
const router = useRouter()
// 功能开关 WS 推送写入快照（feature_flags.updated 分支用）
const { applyFeatureFlags } = useFeatureFlags()
// 菜单访问控制（MA-02）：AI/订阅入口显隐统一走注册表判定
const { can } = useMenuAccess()
const aiEnabled = computed(() => can('nav.ai'))

const sidebarOpen = ref(true)
const currentSub = ref('clipboard') // will be synced with route
const showQuickPaste = ref(false)
// 版本历史弹窗作用的条目 id（B9：由列表「更多 → 版本历史」写入，传给 ModalManager）
const versionItemId = ref('')

// Avatar URL：头像可在 Profile 页随时更换，必须保持响应式并监听变更事件
// （旧实现只在挂载时读一次 localStorage，改头像后侧栏不更新）
const userAvatarUrl = ref(
  typeof localStorage !== 'undefined' ? localStorage.getItem('clipsync-avatar') || undefined : undefined,
)
function syncAvatarFromStorage() {
  userAvatarUrl.value = localStorage.getItem('clipsync-avatar') || undefined
}
window.addEventListener('clipsync:avatar-changed', syncAvatarFromStorage)
// 跨窗口（其它 webview 改了头像）经 storage 事件同步
window.addEventListener('storage', (e) => {
  if (e.key === 'clipsync-avatar') syncAvatarFromStorage()
})
// 侧栏「公告」入口（AppSidebar）→ 打开公告列表弹窗（模块级单例状态，跨组件总线模式）
function openAnnouncementsFromSidebar() {
  showAnnouncementList.value = true
  ann.announcements.value.forEach((a) => {
    if (!ann.isRead(a.id)) ann.markRead(a.id)
  })
}
window.addEventListener('clipsync:open-announcements', openAnnouncementsFromSidebar)
onUnmounted(() => {
  window.removeEventListener('clipsync:avatar-changed', syncAvatarFromStorage)
  window.removeEventListener('clipsync:open-announcements', openAnnouncementsFromSidebar)
})

// Sync route param to currentSub (both initial load and runtime navigation)
if (route.params.sub) currentSub.value = route.params.sub as string
watch(
  () => route.params.sub,
  (sub) => {
    if (sub) currentSub.value = sub as string
  },
)

// === 死设置接线（B8）===
// syncInterval 的单位是「分钟」（GeneralSettings 选项：0 实时 / 5 / 15），
// 0 = 纯事件驱动，不再兜底轮询。
watch(
  () => configStore.syncInterval,
  (v) => clip.setPollInterval(Number(v) * 60_000),
  { immediate: true },
)
// maxHistory：本地列表保留上限。999999 表示「无限」（Pro 专属），归一为 0 = 不裁剪。
watch(
  () => configStore.maxHistory,
  (v) => clip.setMaxHistory(Number(v) >= 999999 ? 0 : Number(v)),
  { immediate: true },
)

// Modal state
const showModalType = ref('')
const showForgotPwd = ref(false)
const previewItem = ref<any>(null)
const previewType = ref('')
const confirmMessage = ref('')
let confirmCallback: (() => void) | null = null
// 门控：仅当有弹窗/忘记密码/预览项时才挂载 ModalManager（否则其重型库常驻内存）
const modalManagerActive = computed(() => !!showModalType.value || showForgotPwd.value || !!previewItem.value)
const showOnboarding = ref(!localStorage.getItem('clipsync-onboarded'))
const showCoachMarks = ref(false)
const showSettingsDialog = ref(false)
const settingsInitialCategory = ref('')
const aiSidebarOpen = ref(false)
// AI 功能开关集中守卫：开关关闭时快捷键/侧栏/托盘任何路径都无法打开 AI 面板，
// 且开关切换为关闭时立即收起已打开的面板（全链路隐藏，服务端 403 兜底依旧有效）。
function toggleAiPanel() {
  if (!aiEnabled.value) return
  aiSidebarOpen.value = !aiSidebarOpen.value
}
watch(aiEnabled, (on) => {
  if (!on) aiSidebarOpen.value = false
})
function openAiSettings() {
  // 开关关闭时不允许进入 AI 供应商配置页（防止「未配置供应商→添加供应商」死路）
  if (!aiEnabled.value) return
  settingsInitialCategory.value = 'ai'
  showSettingsDialog.value = true
}
// 设置弹窗关闭：抽成方法而非多语句内联 handler —— prettier 会把
// `@close="a; b"` 拆行并丢掉分号，导致 Vue 模板表达式解析失败（构建报错）。
function closeSettingsDialog() {
  showSettingsDialog.value = false
  settingsInitialCategory.value = ''
}
function openModalFromDialog(type: string) {
  showModalType.value = type
}

// PIN verification dialog
const showPinDialog = ref(false)
const pinInput = ref('')
const pinVerifying = ref(false)
const pinError = ref('')
const pinNoPinSet = ref(false)
const pinCountdown = ref(0) // remaining seconds shown in dialog
let pinCountdownTimer: ReturnType<typeof setInterval> | null = null
const pinBtnDisabled = computed(() => pinVerifying.value || !pinInput.value)

function startPinCountdown() {
  stopPinCountdown()
  pinCountdown.value = Math.ceil(privacy.pinRemaining.value / 1000)
  pinCountdownTimer = setInterval(() => {
    const remaining = privacy.pinRemaining.value
    pinCountdown.value = remaining > 0 ? Math.ceil(remaining / 1000) : 0
    if (remaining <= 0) stopPinCountdown()
  }, 1000)
}
function stopPinCountdown() {
  if (pinCountdownTimer) {
    clearInterval(pinCountdownTimer)
    pinCountdownTimer = null
  }
  pinCountdown.value = 0
}

function openPinDialog() {
  showPinDialog.value = true
  pinInput.value = ''
  pinError.value = ''
  pinNoPinSet.value = false
  startPinCountdown()
}
function openPinSetupPrompt() {
  showPinDialog.value = true
  pinInput.value = ''
  pinError.value = ''
  pinNoPinSet.value = true
  stopPinCountdown()
}
function closePinDialog() {
  showPinDialog.value = false
  pinInput.value = ''
  pinError.value = ''
  pinNoPinSet.value = false
  stopPinCountdown()
}
function goToSettings() {
  closePinDialog()
  showSettingsDialog.value = true
}
async function verifyPin() {
  pinError.value = ''
  if (!pinInput.value) {
    pinError.value = t('pin_required') || '请输入 PIN'
    return
  }
  pinVerifying.value = true
  try {
    await new Promise((r) => setTimeout(r, 200))
    const ok = await privacy.verifyPin(pinInput.value)
    if (ok) {
      closePinDialog()
      toast.show(t('pin_verified') || 'PIN 验证成功', 'success')
    } else {
      pinError.value = t('pin_wrong') || 'PIN 错误'
    }
  } finally {
    pinVerifying.value = false
  }
}

let stopPolling: (() => void) | null = null
// ws.onMessage 返回的取消函数。useWebSocket 的 handlers 是模块级数组，组件卸载/登出时
// 不会自动摘除 —— 不保存并调用它，重新登录会再挂一个 handler，一次推送触发 N 次刷新。
let offWsMessage: (() => void) | null = null
let nativeNotifPermission = false
// 托盘菜单事件（A7 由 Rust emit，前端只 listen）：卸载时统一摘除
let trayUnlisteners: (() => void)[] = []

// === CO-21 维护模式（桌面横幅 + 同步暂停）===
// 数据源：启动时 GET /api/app/maintenance（公开快照端点，无需 token）+ WS maintenance.updated 推送。
// 开启时暂停 clip 自动轮询与原生剪贴板监听（等价「自动同步暂停」），不改动用户 autoSync 偏好，
// 恢复时反向；同步请求的强制拦截仍由服务端 maintenanceGuard（503）权威兜底。
const maintenanceOn = ref(false)
function setMaintenanceMode(mode: unknown) {
  maintenanceOn.value = mode === 'on'
}
watch([maintenanceOn, () => configStore.autoSync], ([on, autoSync]) => {
  if (on) {
    // 维护开启：停轮询 + 停原生剪贴板监听（Rust 侧 start/stop 均幂等）
    stopPolling?.()
    stopPolling = null
    tauri.stopClipboardMonitor().catch(() => {})
  } else {
    // 维护关闭（或维护期间用户拨动 autoSync 开关）：按当前偏好恢复
    if (!stopPolling) stopPolling = clip.startPolling(1500)
    if (autoSync) tauri.startClipboardMonitor().catch(() => {})
  }
})

// === CO-35 公告横幅 + 全部公告弹窗 ===
// 横幅展示最新一条「未读且未关闭」的公告（2026-09-09 修复：此前只认 persistent，
// 而管理台默认下发的是 once——once 公告完全静默、无任何触达，用户验收打回）。
// once 语义 = 「显示 1 次」：点「我知道了」即 markRead 永不再弹；persistent 关闭后仅当次隐藏。
// 关闭记忆走 localStorage 键 dismissed-announcement-{id}（useAnnouncements 内读写），
// 会话内用 ref 同步驱动响应式（isDismissed 读 localStorage 不具备响应性）。
const bannerDismissedId = ref('')
const bannerAnnouncement = computed<Announcement | null>(
  () =>
    ann.announcements.value.find(
      (a) =>
        !ann.isRead(a.id) &&
        bannerDismissedId.value !== a.id &&
        !ann.isDismissed(a.id),
    ) || null,
)
const showAnnouncementList = ref(false)
// 「我知道了」：写关闭记忆 + 上报已读回执
function dismissAnnouncementBanner() {
  if (!bannerAnnouncement.value) return
  ann.dismissAnnouncement(bannerAnnouncement.value.id)
  bannerDismissedId.value = bannerAnnouncement.value.id
}
// 「查看全部」：弹窗展示即视为阅读，未读逐条上报回执（fire-and-forget，
// markRead 内部已读短路防重复）
function openAnnouncementList() {
  showAnnouncementList.value = true
  ann.announcements.value.forEach((a) => {
    if (!ann.isRead(a.id)) ann.markRead(a.id)
  })
}
function formatAnnouncementTime(iso: string) {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? new Date(t).toLocaleString() : ''
}

function detachTrayListeners() {
  trayUnlisteners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* ignore */
    }
  })
  trayUnlisteners = []
}

function detachWsHandler() {
  offWsMessage?.()
  offWsMessage = null
}

// === 键盘层级栈登记 ===
// Esc 由最高层消费（PIN > 预览 > ModalManager 弹窗 > AI 面板 > 快速粘贴 > 列表），
// 列表快捷键在任意弹层打开时被冻结（见 useClipboardKeyboard）。
watch(
  [showPinDialog, previewItem, showModalType, showForgotPwd, showSettingsDialog, aiSidebarOpen, showQuickPaste],
  () => {
    setKeyboardLayer('pin', showPinDialog.value)
    setKeyboardLayer('preview', !!previewItem.value)
    setKeyboardLayer('modal', !!(showModalType.value || showForgotPwd.value || showSettingsDialog.value))
    setKeyboardLayer('ai', aiSidebarOpen.value)
    // 快速粘贴面板是全局单例：HomeView 的 showQuickPaste 是唯一真相源
    setQuickPasteOpen(showQuickPaste.value)
  },
  { immediate: true },
)

/**
 * 真实更新检查（B10：托盘「检查更新」菜单入口）。
 * 走 A7 的 check_for_updates 命令：未配置 pubkey 时 Rust 会 reject，
 * 此时必须给出明确失败提示，绝不能谎报"已是最新"。
 */
async function runUpdateCheck() {
  try {
    const res = await tauri.checkForUpdates()
    if (res?.hasUpdate) toast.show(t('upd_available', { v: res.version || '' }), 'success')
    else toast.show(t('upd_uptodate'), 'info')
  } catch (e: any) {
    console.warn('[Home] check for updates failed:', e?.message || e)
    toast.show(t('upd_check_failed'), 'error')
  }
}

/** 列表「更多 → 版本历史」：记录条目 id 并打开版本历史弹窗（B9 / 决策 D4） */
function onVersionHistory(item: any) {
  versionItemId.value = item?.id || ''
  showModalType.value = 'versions'
}

/** Send a native OS notification (system tray balloon). Silently skips if permission denied. */
function notifyNative(title: string, body: string) {
  if (!nativeNotifPermission) return
  try {
    sendNotification({ title, body })
  } catch {
    /* plugin not available */
  }
}

onMounted(async () => {
  // Request native notification permission once
  try {
    if (await isPermissionGranted()) {
      nativeNotifPermission = true
    } else {
      nativeNotifPermission = (await requestPermission()) === 'granted'
    }
  } catch {
    /* plugin not available in dev mode */
  }

  stopPolling = clip.startPolling(1500)
  // 首屏启动时预热 deviceId：离线队列的 create payload 必须带有效 deviceId，
  // 等断网后再现取会失败，导致无法入队。
  ensureDeviceId().catch(() => null)
  device.loadDevices()
  ws.connect()
  notif.loadHistory()
  // CO-35：公告快照（optionalAuth，未登录也能拉 audience='all'，失败静默）
  ann.fetchAnnouncements()
  // CO-21：维护模式初始快照（公开端点，无需 token）；后续变化走 WS maintenance.updated
  api('GET', '/api/app/maintenance')
    .then((res) => {
      if (res.ok && res.data) setMaintenanceMode((res.data as any).maintenance)
    })
    .catch(() => {})
  // WebSocket 推送（设备注册后后端定向广播）→ 刷新列表 + 弹系统通知；通知推送 → 实时插入收件箱
  // 事件名与后端广播契约对齐：clipboard.js 广播 new_clipboard / clipboard_updated / clipboard_favorite / clipboard_deleted
  offWsMessage = ws.onMessage((data) => {
    if (data?.type === 'new_clipboard') {
      clip.refresh()
      perfFirstDataLoad()
      // Native notification: show what was synced (skip if window is focused)
      const source = data.item?.sourceDeviceId || ''
      const preview = data.item?.contentPreview || ''
      const label = source ? `${source}` : t('app_name')
      const text = preview ? String(preview).slice(0, 80) : t('empty_action')
      // Only notify when main window is not focused (avoid redundant alerts)
      try {
        notifyNative(label, text)
      } catch {
        /* ignore */
      }
      // 远程条目自动写入系统剪贴板（2026-09：手机复制/截图 → PC 无需打开本应用直接 Ctrl+V）。
      // 服务端 broadcastToUser 包含来源设备自身，必须按 deviceId 过滤自己的上传回声；
      // 延迟到列表刷新之后执行（autoCopyRemoteItem 内部找不到条目还会刷新+重试），
      // 真实条目才带 metadata，密码保护判定才有依据。
      const incoming = data.item
      const myDeviceId = localStorage.getItem('clipsync-device-id')
      if (incoming?.id && incoming?.sourceDeviceId && incoming.sourceDeviceId !== myDeviceId) {
        setTimeout(() => {
          clip.autoCopyRemoteItem(incoming.id).catch(() => {})
        }, 500)
      }
    } else if (
      data?.type === 'clipboard_updated' ||
      data?.type === 'clipboard_favorite' ||
      data?.type === 'clipboard_deleted'
    ) {
      clip.refresh()
    }
    if (data?.type === 'registered') {
      // 设备注册成功（含断线重连）：先感知断线窗口内其他设备的删除（墓碑流水），
      // 再刷新列表补齐新增。失败静默，靠后续手动刷新兜底。
      clip
        .syncDeletions()
        .then(() => clip.refresh())
        .catch(() => {})
    }
    if (data?.type === 'feature_flags.updated') {
      // 管理台切换功能开关的全端广播：直接写快照，AI/分享等入口即时显隐
      applyFeatureFlags(data.flags)
    }
    if (data?.type === 'maintenance.updated') {
      // CO-21：管理台切换维护模式的全端广播（mode: 'on' | 'off'）→ 横幅 + 同步暂停即时切换
      setMaintenanceMode(data.mode)
    }
    if (data?.type === 'force_logout') {
      // AF-41：管理台「远程下线」——服务端已推送指令并断开本设备连接，
      // 清除本地登录态回登录页（重新登录即重新信任设备）
      void notifyNative(t('app_name'), data.reason || t('kicked_by_admin'))
      handleLogout()
      return
    }
    if (data?.type === 'announcement.new') {
      // AN-05：管理台下发公告的全端广播 → 立即拉取（横幅/未读数自动响应）
      ann.fetchAnnouncements().catch(() => {})
    }
    if (data?.type === 'notification') {
      notif.pushRealtime(data)
      // Also push native notification for server-initiated alerts
      const title = data.title || t('app_name')
      const body = data.body || ''
      if (body) notifyNative(title, body)
    }
  })

  // Expose the quick-paste toggle for the Rust global-shortcut handler to call via eval.
  // This is the SINGLE source of truth — the visible panel is bound to HomeView's showQuickPaste.
  ;(window as any).__toggleQuickPaste = () => {
    showQuickPaste.value = !showQuickPaste.value
  }
  ;(window as any).__toggleWindow = () => {
    tauri.toggleWindow()
  }
  ;(window as any).__toggleTheme = () => {
    toggleMode()
  }
  ;(window as any).__toggleAiPanel = () => {
    toggleAiPanel()
  }
  ;(window as any).__isAiPanelOpen = () => aiSidebarOpen.value

  // 恢复全局快捷键（快速粘贴 / 显隐主窗口 / AI 面板）。
  // Rust setup 启动时也会注册默认值，这里把用户自定义或默认值整体重设一次，
  // 避免 HMR 未重编 Rust 时用了旧二进制里的默认快捷键。
  try {
    const saved = JSON.parse(localStorage.getItem('clipsync-custom-shortcuts') || '{}')
    const defaultGlobals: Record<string, string[]> = {
      quickPaste: ['Ctrl', 'Shift', 'V'],
      toggleWindow: ['Ctrl', 'Alt', 'Space'],
      toggleAiPanel: ['Ctrl', 'Shift', 'A'],
    }
    const globalMap: Record<string, string> = {}
    for (const gid of Object.keys(defaultGlobals)) {
      const ks = saved[gid] || defaultGlobals[gid]
      if (Array.isArray(ks) && ks.length) globalMap[gid] = ks.join('+')
    }
    if (Object.keys(globalMap).length) {
      tauri.setGlobalShortcuts(globalMap).catch((e) => console.warn('[Home] setGlobalShortcuts failed:', e))
    }
  } catch (e) {
    console.warn('[Home] shortcut restore failed:', e)
  }

  // === 托盘菜单事件（B10）===
  // Rust 侧（A7）emit tray://open-settings / tray://check-updates。
  // 若 A 流尚未 emit，listen 只是静默挂起一个永不触发的监听器，不会报错。
  try {
    trayUnlisteners.push(
      await listen('tray://open-settings', () => {
        settingsInitialCategory.value = ''
        showSettingsDialog.value = true
      }),
    )
  } catch (e) {
    console.warn('[Home] listen tray://open-settings failed:', e)
  }
  try {
    trayUnlisteners.push(await listen('tray://check-updates', () => runUpdateCheck()))
  } catch (e) {
    console.warn('[Home] listen tray://check-updates failed:', e)
  }

  document.addEventListener('keydown', handleGlobalKeydown)
  try {
    tauri.setTitlebarMode(resolvedMode.value === 'dark')
  } catch (e) {
    console.warn('[Home] setTitlebarMode failed:', e)
  }
})

onUnmounted(() => {
  if (stopPolling) stopPolling()
  detachWsHandler()
  detachTrayListeners()
  resetKeyboardLayers()
  delete (window as any).__toggleQuickPaste
  delete (window as any).__toggleWindow
  delete (window as any).__toggleTheme
  document.removeEventListener('keydown', handleGlobalKeydown)
})

function handleGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    // 按层级栈由高到低逐层消费：PIN 弹窗 > 预览弹窗 > ModalManager 弹窗 > AI 面板 > 快速粘贴。
    // 之前先从 quickPaste 开始判断，导致 PIN/预览弹窗开着时按 Esc 反而关掉了底层的面板。
    const layer = topKeyboardLayer()
    if (layer === 'pin') {
      closePinDialog()
      return
    }
    if (layer === 'preview') {
      closePreview()
      return
    }
    if (layer === 'modal') {
      showModalType.value = ''
      return
    }
    if (layer === 'ai' && !showSettingsDialog.value) {
      aiSidebarOpen.value = false
      return
    }
    if (layer === 'quickPaste') {
      showQuickPaste.value = false
      return
    }
    return
  }
  // Ctrl+K 全局唯一入口（ClipboardView 侧已移除重复注册链，否则两条通道互相抵消）
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault()
    showQuickPaste.value = !showQuickPaste.value
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'j') {
    e.preventDefault()
    toggleAiPanel()
  }
}

function switchSub(sub: string) {
  currentSub.value = sub
  router.push(`/app/${sub}`)
  if (sub === 'devices') device.loadDevices()
}

function openModal(type: string) {
  showModalType.value = type
}
function closeModal() {
  showModalType.value = ''
}

function onPreviewImage(item: any) {
  previewItem.value = item
  previewType.value = 'image'
}
function onPreviewText(item: any) {
  previewItem.value = item
  previewType.value = 'text'
}
function onPreviewFile(item: any) {
  // 统一走 DocPreviewModal（ModalManager）预览文件类型内容
  previewItem.value = item
  previewType.value = 'file'
}
function closePreview() {
  previewItem.value = null
  previewType.value = ''
}
function onShowPinDialog() {
  openPinDialog()
}
function onShowPinSetup() {
  openPinSetupPrompt()
}
async function onToggleSensitive(item: any) {
  try {
    const newVal = !item.metadata?.sensitive
    await toggleSensitive(item.id, newVal)
    // Update local item metadata
    const target = clip.items.value.find((i) => i.id === item.id)
    if (target) {
      ;(target as any).metadata = { ...(target as any).metadata, sensitive: newVal }
    }
    toast.show(newVal ? t('sens_locked') || '已标记为敏感' : t('sens_unlocked') || '已取消敏感标记', 'success')
  } catch (e: any) {
    toast.show(e.message || t('sens_toggle_fail') || '操作失败', 'error')
  }
}
function onOnboardingComplete() {
  showOnboarding.value = false
  // Show coach marks after onboarding completes
  if (!localStorage.getItem('clipsync-coach-done')) {
    showCoachMarks.value = true
  }
}

function onCoachMarksComplete() {
  showCoachMarks.value = false
}

function showConfirm(msg: string, cb: () => void) {
  confirmMessage.value = msg
  confirmCallback = cb
  showModalType.value = 'confirm'
}
function handleLogout() {
  notif.reset()
  ann.reset()
  // 先摘掉 WS handler 再断开：否则重新登录后新旧 handler 叠加，一条推送触发多次刷新
  detachWsHandler()
  configStore.logout()
  ws.disconnect()
  router.replace('/auth')
}
function confirmAction() {
  if (confirmCallback) {
    confirmCallback()
    confirmCallback = null
  }
  showModalType.value = ''
}
</script>

<template>
  <div class="app-shell">
    <AppSidebar
      :sidebar-open="sidebarOpen"
      :current-sub="currentSub"
      :items-count="clip.mainTotalItems.value"
      :user-name="configStore.user.name"
      :user-plan="configStore.user.plan"
      :user-email="configStore.user.email"
      :user-avatar-url="userAvatarUrl"
      :settings-dialog-open="showSettingsDialog"
      :ai-open="aiSidebarOpen"
      @toggle="sidebarOpen = !sidebarOpen"
      @navigate="switchSub"
      @open-settings-dialog="showSettingsDialog = true"
      @open-ai="toggleAiPanel"
      @logout="handleLogout"
    />

    <main class="main-content">
      <!-- CO-21 维护模式横幅：维护期间轮询与自动同步已暂停（服务端 503 强制兜底） -->
      <div v-if="maintenanceOn" class="maintenance-banner" role="alert">
        <AlertTriangle :size="16" :stroke-width="2" />
        <span>{{ t('maintenance_banner') }}</span>
      </div>
      <!-- CO-35 公告横幅：最新一条 persistent 未读公告，可关闭（记忆到 localStorage） -->
      <div v-if="bannerAnnouncement" class="announcement-banner" role="status">
        <Megaphone :size="16" :stroke-width="2" class="announcement-banner-icon" />
        <span class="announcement-banner-title">{{ bannerAnnouncement.title }}</span>
        <span class="announcement-banner-content">
          <span class="announcement-marquee">
            <span class="announcement-marquee-track">
              <span class="announcement-marquee-text">{{ bannerAnnouncement.content }}</span>
              <span class="announcement-marquee-text" aria-hidden="true">{{ bannerAnnouncement.content }}</span>
            </span>
          </span>
        </span>
        <button class="announcement-btn" @click="openAnnouncementList">
          {{ t('ann_view_all', '查看全部') }}
        </button>
        <button class="announcement-btn announcement-btn--primary" @click="dismissAnnouncementBanner">
          {{ t('ann_got_it', '我知道了') }}
        </button>
      </div>
      <ClipboardView
        v-if="currentSub === 'clipboard' || currentSub === 'archive'"
        :mode="currentSub === 'archive' ? 'archive' : 'default'"
        @toggle-quick-paste="showQuickPaste = !showQuickPaste"
        @toggle-theme="toggleMode"
        @preview-image="onPreviewImage"
        @preview-text="onPreviewText"
        @preview-file="onPreviewFile"
        @show-pin-dialog="onShowPinDialog"
        @show-pin-setup="onShowPinSetup"
        @toggle-sensitive="onToggleSensitive"
        @version-history="onVersionHistory"
      />
      <FavoritesView
        v-else-if="currentSub === 'favorites'"
        @preview-image="onPreviewImage"
        @preview-text="onPreviewText"
        @preview-file="onPreviewFile"
        @show-pin-dialog="onShowPinDialog"
        @show-pin-setup="onShowPinSetup"
        @toggle-sensitive="onToggleSensitive"
      />
      <TemplatesView v-else-if="currentSub === 'templates'" />
      <!-- SettingsView archived to backups/old-settings-v1/ — replaced by SettingsDialog -->
      <ProfileView v-else-if="currentSub === 'profile'" />
      <DevicesView v-else-if="currentSub === 'devices'" @open-modal="openModal" />
      <NotificationsView v-else-if="currentSub === 'notifications'" />
      <!-- enable_subscription 关闭：订阅页不渲染（侧栏入口已隐藏，直接改 URL 也不可达） -->
      <SubscriptionView
        v-else-if="currentSub === 'subscription' && can('nav.subscription')"
        @open-modal="openModal"
      />
    </main>

    <!-- AI 面板（右侧展开/折叠）：view 传入当前页面上下文，AI 回答可感知用户所在页面（#229）。
         enable_ai_agent 关闭：面板不挂载，快捷键/侧栏入口均已守卫。 -->
    <AiChatPanel
      v-if="aiEnabled"
      :open="aiSidebarOpen"
      :view="currentSub"
      @close="aiSidebarOpen = false"
      @open-settings="openAiSettings"
    />
  </div>

  <QuickPastePanel :open="showQuickPaste" @close="showQuickPaste = false" />

  <!-- 复制剪贴板后 AI 摘要浮窗（AI 关闭时一并隐藏） -->
  <AiSummaryFloat v-if="aiEnabled" />

  <ModalManager
    v-if="modalManagerActive"
    :show-modal-type="showModalType"
    :show-forgot-pwd="showForgotPwd"
    :preview-item="previewItem"
    :preview-type="previewType"
    :confirm-message="confirmMessage"
    :version-item-id="versionItemId"
    @close-modal="closeModal"
    @close-forgot-pwd="showForgotPwd = false"
    @close-preview="closePreview"
    @confirm-action="confirmAction"
    @switch-modal="openModal"
    @show-pin-dialog="onShowPinDialog"
    @show-pin-setup="onShowPinSetup"
    @toggle-sensitive="onToggleSensitive"
  />

  <!-- PIN Verification Dialog -->
  <div v-if="showPinDialog" class="pin-overlay" @click.self="closePinDialog">
    <div class="pin-dialog">
      <div class="pin-dialog-header">
        <Lock :size="18" />
        <span>{{ pinNoPinSet ? t('pin_setup_title') || '请先设置 PIN' : t('pin_title') || 'PIN 验证' }}</span>
      </div>
      <p v-if="pinNoPinSet" class="pin-dialog-hint">{{ t('pin_setup_hint') || '查看/复制敏感数据需要先设置 PIN' }}</p>
      <p v-else class="pin-dialog-hint">{{ t('pin_hint') || '请输入 PIN 以查看/复制敏感数据' }}</p>
      <!-- Countdown timer (shown during PIN verification) -->
      <div v-if="!pinNoPinSet && pinCountdown > 0" class="pin-countdown">
        {{ t('pin_countdown', { s: pinCountdown }) || `PIN 验证剩余 ${pinCountdown} 秒` }}
      </div>
      <!-- PIN input (hidden when no PIN set) -->
      <input
        v-if="!pinNoPinSet"
        v-model="pinInput"
        type="password"
        inputmode="numeric"
        maxlength="6"
        class="pin-input"
        :placeholder="t('pin_placeholder') || '输入 PIN'"
        @keyup.enter="verifyPin"
      />
      <div v-if="pinError" class="pin-error">{{ pinError }}</div>
      <div class="pin-dialog-actions">
        <!-- Plain HTML buttons to avoid Button component rendering issues -->
        <button class="pin-btn-cancel" @click="closePinDialog">{{ t('cancel_btn') }}</button>
        <template v-if="pinNoPinSet">
          <button class="pin-btn-primary" @click="goToSettings">{{ t('pin_go_settings') || '前往设置' }}</button>
        </template>
        <template v-else>
          <button
            class="pin-btn-primary"
            :class="{ 'pin-btn-primary--active': pinInput && !pinVerifying }"
            @click="verifyPin"
          >
            {{ pinVerifying ? t('verifying') || '验证中...' : t('pin_verify_btn') || '验证' }}
          </button>
        </template>
      </div>
    </div>
  </div>

  <!-- CO-35 全部公告弹窗：打开即逐条上报已读回执（fire-and-forget） -->
  <div v-if="showAnnouncementList" class="ann-overlay" @click.self="showAnnouncementList = false">
    <div class="ann-dialog">
      <div class="ann-dialog-header">
        <Megaphone :size="18" />
        <span>{{ t('ann_list_title', '公告') }}</span>
        <button class="ann-close" :title="t('common_close') || '关闭'" @click="showAnnouncementList = false">
          <X :size="16" />
        </button>
      </div>
      <div class="ann-dialog-body">
        <div v-if="ann.loading.value && ann.announcements.value.length === 0" class="ann-empty">
          {{ t('ai_loading', '加载中…') }}
        </div>
        <div v-else-if="ann.announcements.value.length === 0" class="ann-empty">
          {{ t('ann_empty', '暂无公告') }}
        </div>
        <article v-for="a in ann.announcements.value" :key="a.id" class="ann-item">
          <div class="ann-item-head">
            <span class="ann-item-title">{{ a.title }}</span>
            <span class="ann-item-time">{{ formatAnnouncementTime(a.sentAt) }}</span>
          </div>
          <p class="ann-item-content">{{ a.content }}</p>
        </article>
      </div>
    </div>
  </div>

  <!-- First-run experience -->
  <OnboardingView v-if="showOnboarding" @complete="onOnboardingComplete" />
  <CoachMarks v-if="showCoachMarks && !showOnboarding" @complete="onCoachMarksComplete" />

  <!-- Satisfaction Survey (shows after 7 days, once per 30 days) -->
  <SatisfactionSurvey />

  <!-- Settings Dialog (v2 — progressive migration) -->
  <SettingsDialog
    :open="showSettingsDialog"
    :initial-category="settingsInitialCategory"
    @close="closeSettingsDialog"
  />
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--bg-base);
}
.main-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* CO-21 维护横幅：内容区顶部全宽警示条，用现有 warning 色板变量适配全部主题 */
.maintenance-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 9px 16px;
  background: var(--warning-bg);
  color: var(--warning);
  border-bottom: 1px solid var(--warning);
  font-size: 13px;
  font-weight: 500;
}
/* CO-21：横幅存在时视图区让出其高度（视图根元素弹性填充剩余空间；
   无横幅时单个视图子元素仍占满 main-content，行为不变） */
.main-content > :not(.maintenance-banner):not(.announcement-banner) {
  flex: 1;
  min-height: 0;
}
/* CO-35 公告横幅：内容区顶部全宽提示条，用 accent 色板与维护警示条（warning）区分 */
.announcement-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 8px 16px;
  background: var(--accent-bg);
  color: var(--accent);
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  font-size: 13px;
}
.announcement-banner-icon {
  flex-shrink: 0;
}
.announcement-banner-title {
  font-weight: 600;
  white-space: nowrap;
}
.announcement-banner-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  color: var(--text-secondary);
}
/* AF-57 跑马灯：内容复制两份无缝循环滚动，比静态省略号醒目；
   悬停暂停便于阅读；reduce-motion（设置页「减少动画」）下静止显示 */
.announcement-marquee {
  display: block;
  width: 100%;
  overflow: hidden;
  mask-image: linear-gradient(to right, transparent, black 3%, black 97%, transparent);
  -webkit-mask-image: linear-gradient(to right, transparent, black 3%, black 97%, transparent);
}
.announcement-marquee-track {
  display: inline-flex;
  white-space: nowrap;
  animation: announcement-marquee 16s linear infinite;
  will-change: transform;
}
.announcement-marquee-text {
  padding-right: 72px;
}
.announcement-marquee-track:hover {
  animation-play-state: paused;
}
@keyframes announcement-marquee {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}
:global(html.reduce-motion) .announcement-marquee-track {
  animation: none;
  /* 静止时仍完整展示首份内容（不滚动也不省略） */
}
.announcement-btn {
  flex-shrink: 0;
  padding: 4px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.announcement-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.announcement-btn--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: white;
}
.announcement-btn--primary:hover {
  opacity: 0.9;
  background: var(--accent);
  color: white;
}

/* CO-35 全部公告弹窗：复用 PIN 弹窗的遮罩/卡片骨架 */
.ann-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-toast);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-modal-overlay);
  animation: fadeIn 0.15s ease;
}
.ann-dialog {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  width: 520px;
  max-width: 90vw;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-modal);
  animation: slideUp 0.2s ease;
  overflow: hidden;
}
.ann-dialog-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-default);
  font-size: 16px;
  font-weight: 600;
  flex-shrink: 0;
}
.ann-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ann-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.ann-dialog-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ann-empty {
  font-size: 13px;
  color: var(--text-tertiary);
  text-align: center;
  padding: 28px 0;
}
.ann-item {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 12px 14px;
}
.ann-item-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.ann-item-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
}
.ann-item-time {
  font-size: 11.5px;
  color: var(--text-tertiary);
  white-space: nowrap;
}
.ann-item-content {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
}
.btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* PIN Verification Dialog */
.pin-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-toast);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-modal-overlay);
  animation: fadeIn 0.15s ease;
}
.pin-dialog {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  padding: 28px;
  max-width: 380px;
  width: 100%;
  box-shadow: var(--shadow-modal);
  animation: slideUp 0.2s ease;
}
.pin-dialog-header {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}
.pin-dialog-hint {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 20px;
  line-height: 1.5;
}
.pin-input {
  width: 100%;
  height: 40px;
  text-align: center;
  font-size: 18px;
  letter-spacing: 6px;
}
.pin-error {
  font-size: 12px;
  color: var(--danger);
  margin-top: 8px;
  text-align: center;
}
.pin-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}
.pin-btn-cancel {
  padding: 8px 18px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.pin-btn-cancel:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.pin-btn-primary {
  padding: 8px 18px;
  border-radius: var(--radius-md);
  border: none;
  background: var(--accent);
  color: white;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.pin-btn-primary:hover {
  opacity: 0.9;
}
.pin-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pin-btn-primary--active {
  opacity: 1;
}
.pin-countdown {
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: center;
  margin-top: 8px;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes ai-panel-pop {
  from {
    opacity: 0;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
