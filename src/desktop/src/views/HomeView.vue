<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useConfigStore } from '@/stores/configStore'
import { useTheme, currentMode } from '@/composables/useTheme'
import { useI18n } from '@/composables/useI18n'
import { useClipboard } from '@/composables/useClipboard'
import { useDevice } from '@/composables/useDevice'
import { useWebSocket } from '@/composables/useWebSocket'
import { useNotifications } from '@/composables/useNotifications'
import * as tauri from '@/lib/tauri'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import ClipboardView from '@/components/clipboard/ClipboardView.vue'
import QuickPastePanel from '@/components/QuickPastePanel.vue'
import SettingsView from '@/components/settings/SettingsView.vue'
import ProfileView from '@/components/settings/ProfileView.vue'
import DevicesView from '@/components/settings/DevicesView.vue'
import SharedLinksView from '@/components/settings/SharedLinksView.vue'
import SubscriptionView from '@/components/settings/SubscriptionView.vue'
import NotificationsView from '@/components/settings/NotificationsView.vue'
import ModalManager from '@/components/modals/ModalManager.vue'
import DocumentDrawer from '@/components/DocumentDrawer.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import OnboardingView from '@/components/OnboardingView.vue'
import CoachMarks from '@/components/CoachMarks.vue'
import SatisfactionSurvey from '@/components/SatisfactionSurvey.vue'
import { perfFirstDataLoad } from '@/utils/perfMonitor'

const configStore = useConfigStore()
const { t } = useI18n()
const clip = useClipboard()
const device = useDevice()
const ws = useWebSocket()
const notif = useNotifications()
const { toggleMode } = useTheme()
const route = useRoute()
const router = useRouter()

const sidebarOpen = ref(true)
const currentSub = ref('clipboard')  // will be synced with route
const showQuickPaste = ref(false)

// Avatar URL from localStorage (set by profile save / login)
const userAvatarUrl = typeof localStorage !== 'undefined' ? localStorage.getItem('clipsync-avatar') || undefined : undefined

// Sync route param to currentSub
if (route.params.sub) currentSub.value = route.params.sub as string

// Modal state
const showModalType = ref('')
const showForgotPwd = ref(false)
const previewItem = ref<any>(null)
const previewType = ref('')
const showDrawer = ref(false)
const drawerItem = ref<any>(null)
const confirmMessage = ref('')
let confirmCallback: (() => void) | null = null
const showOnboarding = ref(!localStorage.getItem('clipsync-onboarded'))
const showCoachMarks = ref(false)

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
      :items-count="clip.items.value.length"
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
        v-if="currentSub === 'clipboard'"
        @toggle-quick-paste="showQuickPaste = !showQuickPaste"
        @toggle-theme="toggleMode"
        @preview-image="onPreviewImage"
        @preview-text="onPreviewText"
        @preview-file="onPreviewFile"
      />
      <SettingsView v-else-if="currentSub === 'settings'" @open-modal="openModal" />
      <ProfileView v-else-if="currentSub === 'profile'" />
      <DevicesView v-else-if="currentSub === 'devices'" @open-modal="openModal" />
      <SharedLinksView v-else-if="currentSub === 'shared-links'" />
      <NotificationsView v-else-if="currentSub === 'notifications'" />
      <SubscriptionView v-else-if="currentSub === 'subscription'" @open-modal="openModal" />
    </main>
  </div>

  <QuickPastePanel :open="showQuickPaste" @close="showQuickPaste = false" />

  <ModalManager
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
  />

  <DocumentDrawer :open="showDrawer" :item="drawerItem" @close="closeDrawer" />

  <ToastContainer />

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
</style>
