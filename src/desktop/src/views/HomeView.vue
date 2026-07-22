<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useConfigStore } from '@/stores/configStore'
import { useTheme, currentMode } from '@/composables/useTheme'
import { useI18n } from '@/composables/useI18n'
import { useClipboard } from '@/composables/useClipboard'
import { useDevice } from '@/composables/useDevice'
import { useWebSocket } from '@/composables/useWebSocket'
import { useNotifications } from '@/composables/useNotifications'
import { useSonner } from '@/composables/useSonner'
import { usePrivacy } from '@/composables/usePrivacy'
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
const SettingsView = defineAsyncComponent(() => import('@/components/settings/SettingsView.vue'))
const ProfileView = defineAsyncComponent(() => import('@/components/settings/ProfileView.vue'))
const DevicesView = defineAsyncComponent(() => import('@/components/settings/DevicesView.vue'))
const SubscriptionView = defineAsyncComponent(() => import('@/components/settings/SubscriptionView.vue'))
const NotificationsView = defineAsyncComponent(() => import('@/components/settings/NotificationsView.vue'))
// ModalManager/DocumentDrawer 携带全套重型库（pdfjs/xlsx/mammoth/highlight.js/jszip/qrcode/jsqr/marked），
// 改为异步 + v-if 门控，仅在真正需要时才加载进内存，避免启动即常驻数十 MB
const ModalManager = defineAsyncComponent(() => import('@/components/modals/ModalManager.vue'))
const DocumentDrawer = defineAsyncComponent(() => import('@/components/DocumentDrawer.vue'))
import OnboardingView from '@/components/OnboardingView.vue'
import CoachMarks from '@/components/CoachMarks.vue'
import SatisfactionSurvey from '@/components/SatisfactionSurvey.vue'
import { perfFirstDataLoad } from '@/utils/perfMonitor'
import { toggleSensitive } from '@/api/client'
import { Lock } from 'lucide-vue-next'

const configStore = useConfigStore()
const { t } = useI18n()
const clip = useClipboard()
const device = useDevice()
const ws = useWebSocket()
const notif = useNotifications()
const { toggleMode } = useTheme()
const toast = useSonner()
const privacy = usePrivacy()
const route = useRoute()
const router = useRouter()

const sidebarOpen = ref(true)
const currentSub = ref('clipboard')  // will be synced with route
const showQuickPaste = ref(false)

// Avatar URL from localStorage (set by profile save / login)
const userAvatarUrl = typeof localStorage !== 'undefined' ? localStorage.getItem('clipsync-avatar') || undefined : undefined

// Sync route param to currentSub (both initial load and runtime navigation)
if (route.params.sub) currentSub.value = route.params.sub as string
watch(() => route.params.sub, (sub) => {
  if (sub) currentSub.value = sub as string
})

// Modal state
const showModalType = ref('')
const showForgotPwd = ref(false)
const previewItem = ref<any>(null)
const previewType = ref('')
const showDrawer = ref(false)
const drawerItem = ref<any>(null)
const confirmMessage = ref('')
let confirmCallback: (() => void) | null = null
// 门控：仅当有弹窗/忘记密码/预览项时才挂载 ModalManager（否则其重型库常驻内存）
const modalManagerActive = computed(() => !!showModalType.value || showForgotPwd.value || !!previewItem.value)
const showOnboarding = ref(!localStorage.getItem('clipsync-onboarded'))
const showCoachMarks = ref(false)

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
  if (pinCountdownTimer) { clearInterval(pinCountdownTimer); pinCountdownTimer = null }
  pinCountdown.value = 0
}

function openPinDialog() { showPinDialog.value = true; pinInput.value = ''; pinError.value = ''; pinNoPinSet.value = false; startPinCountdown() }
function openPinSetupPrompt() { showPinDialog.value = true; pinInput.value = ''; pinError.value = ''; pinNoPinSet.value = true; stopPinCountdown() }
function closePinDialog() { showPinDialog.value = false; pinInput.value = ''; pinError.value = ''; pinNoPinSet.value = false; stopPinCountdown() }
function goToSettings() { closePinDialog(); router.push('/app/settings') }
async function verifyPin() {
  pinError.value = ''
  if (!pinInput.value) { pinError.value = t('pin_required') || '请输入 PIN'; return }
  pinVerifying.value = true
  try {
    await new Promise(r => setTimeout(r, 200))
    const ok = privacy.verifyPin(pinInput.value)
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
let nativeNotifPermission = false

/** Send a native OS notification (system tray balloon). Silently skips if permission denied. */
function notifyNative(title: string, body: string) {
  if (!nativeNotifPermission) return
  try { sendNotification({ title, body }) } catch { /* plugin not available */ }
}

onMounted(async () => {
  // Request native notification permission once
  try {
    if (await isPermissionGranted()) {
      nativeNotifPermission = true
    } else {
      nativeNotifPermission = (await requestPermission()) === 'granted'
    }
  } catch { /* plugin not available in dev mode */ }

  stopPolling = clip.startPolling(1500)
  device.loadDevices()
  ws.connect()
  notif.loadHistory()
  // WebSocket 新剪贴通知 → 刷新列表 + 弹系统通知；通知推送 → 实时插入收件箱
  ws.onMessage((data) => {
    if (data?.type === 'new_clip' || data?.action === 'sync' || data?.event === 'clipboard_update') {
      clip.refresh()
      perfFirstDataLoad()
      // Native notification: show what was synced (skip if window is focused)
      const source = data.clip?.sourceDevice?.name || data.source || ''
      const preview = data.clip?.contentPreview || data.clip?.content || ''
      const label = source ? `${source}` : t('app_name')
      const text = preview ? String(preview).slice(0, 80) : t('empty_action')
      // Only notify when main window is not focused (avoid redundant alerts)
      try { notifyNative(label, text) } catch { /* ignore */ }
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
  ;(window as any).__toggleQuickPaste = () => { showQuickPaste.value = !showQuickPaste.value }
  ;(window as any).__toggleWindow = () => { tauri.toggleWindow() }
  ;(window as any).__toggleTheme = () => { toggleMode() }

  // Re-apply user's saved global shortcuts (Rust hardcodes defaults at startup,
  // so without this the user's customization is lost after a restart).
  try {
    const saved = JSON.parse(localStorage.getItem('clipsync-custom-shortcuts') || '{}')
    const globalMap: Record<string, string> = {}
    for (const gid of ['quickPaste', 'toggleWindow']) {
      const ks = saved[gid]
      if (Array.isArray(ks) && ks.length) globalMap[gid] = ks.join('+')
    }
    if (Object.keys(globalMap).length) tauri.setGlobalShortcuts(globalMap).catch(() => {})
  } catch { /* ignore */ }

  document.addEventListener('keydown', handleGlobalKeydown)
  try { tauri.setTitlebarMode(currentMode.value === 'dark') } catch {}
})

onUnmounted(() => {
  if (stopPolling) stopPolling()
  delete (window as any).__toggleQuickPaste
  delete (window as any).__toggleWindow
  delete (window as any).__toggleTheme
  document.removeEventListener('keydown', handleGlobalKeydown)
})

function handleGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (showQuickPaste.value) { showQuickPaste.value = false; return }
    if (showModalType.value) { showModalType.value = ''; return }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault(); showQuickPaste.value = !showQuickPaste.value
  }
}

function switchSub(sub: string) {
  currentSub.value = sub
  router.push(`/app/${sub}`)
  if (sub === 'devices') device.loadDevices()
}

function openModal(type: string) { showModalType.value = type }
function closeModal() { showModalType.value = '' }

function onPreviewImage(item: any) { previewItem.value = item; previewType.value = 'image' }
function onPreviewText(item: any) { previewItem.value = item; previewType.value = 'text' }
function onPreviewFile(item: any) {
  // Document types open in drawer, others in modal
  const docExtensions = ['md', 'markdown', 'mdx', 'txt', 'log', 'json', 'yaml', 'yml', 'xml', 'toml',
    'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'cs',
    'html', 'css', 'scss', 'less', 'sql', 'sh', 'bash', 'rb', 'php',
    'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'pptx', 'pdf', 'csv', 'tsv',
    'ini', 'env', 'vue', 'svelte', 'dockerfile', 'makefile']
  let ext = ''
  try {
    const meta = JSON.parse(item.content)
    if (meta.name) {
      ext = meta.name.split('.').pop()?.toLowerCase() || ''
    } else if (Array.isArray(meta) && meta[0]) {
      // Path array format: ["D:\\path\\to\\file.pptx"]
      ext = meta[0].split(/[/\\]/).pop()?.split('.').pop()?.toLowerCase() || ''
    } else if (meta.paths && Array.isArray(meta.paths) && meta.paths[0]) {
      ext = meta.paths[0].split(/[/\\]/).pop()?.split('.').pop()?.toLowerCase() || ''
    }
  } catch {
    // Plain filename or path string
    const raw = (item.content || '').split(/[/\\]/).pop() || item.content || ''
    ext = raw.split('.').pop()?.toLowerCase() || ''
  }
  if (docExtensions.includes(ext)) {
    drawerItem.value = item; showDrawer.value = true
  } else {
    previewItem.value = item; previewType.value = 'file'
  }
}
function closePreview() { previewItem.value = null; previewType.value = '' }
function onShowPinDialog() { openPinDialog() }
function onShowPinSetup() { openPinSetupPrompt() }
async function onToggleSensitive(item: any) {
  try {
    const newVal = !item.metadata?.sensitive
    await toggleSensitive(item.id, newVal)
    // Update local item metadata
    const target = clip.items.value.find(i => i.id === item.id)
    if (target) { (target as any).metadata = { ...(target as any).metadata, sensitive: newVal } }
    toast.show(newVal ? (t('sens_locked') || '已标记为敏感') : (t('sens_unlocked') || '已取消敏感标记'), 'success')
  } catch (e: any) {
    toast.show(e.message || t('sens_toggle_fail') || '操作失败', 'error')
  }
}
function closeDrawer() { showDrawer.value = false; drawerItem.value = null }

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
  confirmMessage.value = msg; confirmCallback = cb; showModalType.value = 'confirm'
}
function handleLogout() {
  notif.reset()
  configStore.logout()
  ws.disconnect()
  router.replace('/auth')
}
function confirmAction() {
  if (confirmCallback) { confirmCallback(); confirmCallback = null }
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
      @toggle="sidebarOpen = !sidebarOpen"
      @navigate="switchSub"
      @logout="handleLogout"
    />

    <main class="main-content">
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
      <SettingsView v-else-if="currentSub === 'settings'" @open-modal="openModal" />
      <ProfileView v-else-if="currentSub === 'profile'" />
      <DevicesView v-else-if="currentSub === 'devices'" @open-modal="openModal" />
      <NotificationsView v-else-if="currentSub === 'notifications'" />
      <SubscriptionView v-else-if="currentSub === 'subscription'" @open-modal="openModal" />
    </main>
  </div>

  <QuickPastePanel :open="showQuickPaste" @close="showQuickPaste = false" />

  <ModalManager
    v-if="modalManagerActive"
    :show-modal-type="showModalType"
    :show-forgot-pwd="showForgotPwd"
    :preview-item="previewItem"
    :preview-type="previewType"
    :confirm-message="confirmMessage"
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
        <span>{{ pinNoPinSet ? (t('pin_setup_title') || '请先设置 PIN') : (t('pin_title') || 'PIN 验证') }}</span>
      </div>
      <p v-if="pinNoPinSet" class="pin-dialog-hint">{{ t('pin_setup_hint') || '查看/复制敏感数据需要先设置 PIN' }}</p>
      <p v-else class="pin-dialog-hint">{{ t('pin_hint') || '请输入 PIN 以查看/复制敏感数据' }}</p>
      <!-- Countdown timer (shown during PIN verification) -->
      <div v-if="!pinNoPinSet && pinCountdown > 0" class="pin-countdown">{{ t('pin_countdown', { s: pinCountdown }) || `PIN 验证剩余 ${pinCountdown} 秒` }}</div>
      <!-- PIN input (hidden when no PIN set) -->
      <input v-if="!pinNoPinSet" v-model="pinInput" type="password" inputmode="numeric" maxlength="6" class="pin-input" :placeholder="t('pin_placeholder') || '输入 PIN'" @keyup.enter="verifyPin" />
      <div v-if="pinError" class="pin-error">{{ pinError }}</div>
      <div class="pin-dialog-actions">
        <!-- Plain HTML buttons to avoid Button component rendering issues -->
        <button class="pin-btn-cancel" @click="closePinDialog">{{ t('cancel_btn') }}</button>
        <template v-if="pinNoPinSet">
          <button class="pin-btn-primary" @click="goToSettings">{{ t('pin_go_settings') || '前往设置' }}</button>
        </template>
        <template v-else>
          <button class="pin-btn-primary" :class="{ 'pin-btn-primary--active': pinInput && !pinVerifying }" @click="verifyPin">{{ pinVerifying ? (t('verifying') || '验证中...') : (t('pin_verify_btn') || '验证') }}</button>
        </template>
      </div>
    </div>
  </div>

  <DocumentDrawer v-if="showDrawer" :open="showDrawer" :item="drawerItem" @close="closeDrawer" />

  <!-- First-run experience -->
  <OnboardingView v-if="showOnboarding" @complete="onOnboardingComplete" />
  <CoachMarks v-if="showCoachMarks && !showOnboarding" @complete="onCoachMarksComplete" />

  <!-- Satisfaction Survey (shows after 7 days, once per 30 days) -->
  <SatisfactionSurvey />
</template>

<style scoped>
.app-shell { display: flex; height: 100vh; height: 100dvh; overflow: hidden; background: var(--bg-base); }
.main-content { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.btn-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--radius-sm); background: transparent; border: none; color: var(--text-secondary); cursor: pointer; }
.btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }

/* PIN Verification Dialog */
.pin-overlay {
  position: fixed; inset: 0; z-index: 10000;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-modal-overlay); animation: fadeIn 0.15s ease;
}
.pin-dialog {
  background: var(--bg-surface); border: 1px solid var(--border-default);
  border-radius: var(--radius-xl); padding: 28px; max-width: 380px; width: 100%;
  box-shadow: var(--shadow-modal); animation: slideUp 0.2s ease;
}
.pin-dialog-header { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600; margin-bottom: 8px; }
.pin-dialog-hint { font-size: 13px; color: var(--text-secondary); margin-bottom: 20px; line-height: 1.5; }
.pin-input { width: 100%; height: 40px; text-align: center; font-size: 18px; letter-spacing: 6px; }
.pin-error { font-size: 12px; color: var(--danger); margin-top: 8px; text-align: center; }
.pin-dialog-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
.pin-btn-cancel {
  padding: 8px 18px; border-radius: var(--radius-md); border: 1px solid var(--border-default);
  background: var(--bg-surface); color: var(--text-secondary); font-size: 13px;
  cursor: pointer; transition: all 0.15s; white-space: nowrap;
}
.pin-btn-cancel:hover { background: var(--bg-hover); color: var(--text-primary); }
.pin-btn-primary {
  padding: 8px 18px; border-radius: var(--radius-md); border: none;
  background: var(--accent); color: white; font-size: 13px; font-weight: 500;
  cursor: pointer; transition: all 0.15s; white-space: nowrap;
}
.pin-btn-primary:hover { opacity: 0.9; }
.pin-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.pin-btn-primary--active { opacity: 1; }
.pin-countdown { font-size: 12px; color: var(--text-tertiary); text-align: center; margin-top: 8px; }

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
</style>
