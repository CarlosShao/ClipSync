<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useConfigStore } from '@/stores/configStore'
import { useTheme, currentMode } from '@/composables/useTheme'
import { useI18n } from '@/composables/useI18n'
import { useClipboard } from '@/composables/useClipboard'
import { useDevice } from '@/composables/useDevice'
import { useWebSocket } from '@/composables/useWebSocket'
import * as tauri from '@/lib/tauri'
import { listen } from '@tauri-apps/api/event'

import AppSidebar from '@/components/layout/AppSidebar.vue'
import ClipboardView from '@/components/clipboard/ClipboardView.vue'
import QuickPastePanel from '@/components/QuickPastePanel.vue'
import SettingsView from '@/components/settings/SettingsView.vue'
import ProfileView from '@/components/settings/ProfileView.vue'
import DevicesView from '@/components/settings/DevicesView.vue'
import SharedLinksView from '@/components/settings/SharedLinksView.vue'
import SubscriptionView from '@/components/settings/SubscriptionView.vue'
import ModalManager from '@/components/modals/ModalManager.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'

const configStore = useConfigStore()
const { t } = useI18n()
const clip = useClipboard()
const device = useDevice()
const ws = useWebSocket()
const { toggleMode } = useTheme()
const route = useRoute()
const router = useRouter()

const sidebarOpen = ref(true)
const currentSub = ref('clipboard')  // will be synced with route
const showQuickPaste = ref(false)

// Sync route param to currentSub
if (route.params.sub) currentSub.value = route.params.sub as string

// Modal state
const showModalType = ref('')
const showForgotPwd = ref(false)
const previewItem = ref<any>(null)
const previewType = ref('')
const confirmMessage = ref('')
let confirmCallback: (() => void) | null = null

let stopPolling: (() => void) | null = null
let stopShortcutListener: (() => void) | null = null

onMounted(async () => {
  stopPolling = clip.startPolling(1500)
  device.loadDevices()
  ws.connect()
  // WebSocket 新剪贴通知 → 刷新列表
  ws.onMessage((data) => {
    if (data?.type === 'new_clip' || data?.action === 'sync' || data?.event === 'clipboard_update') {
      clip.refresh()
    }
  })

  stopShortcutListener = await listen('global-shortcut', () => { showQuickPaste.value = !showQuickPaste.value })

  document.addEventListener('keydown', handleGlobalKeydown)
  try { tauri.setTitlebarMode(currentMode.value === 'dark') } catch {}
})

onUnmounted(() => {
  if (stopPolling) stopPolling()
  if (stopShortcutListener) stopShortcutListener()
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
function closePreview() { previewItem.value = null; previewType.value = '' }

function showConfirm(msg: string, cb: () => void) {
  confirmMessage.value = msg; confirmCallback = cb; showModalType.value = 'confirm'
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
      @toggle="sidebarOpen = !sidebarOpen"
      @navigate="switchSub"
      @logout="configStore.logout()"
    />

    <div v-if="!sidebarOpen" class="sidebar-collapsed">
      <button class="btn-icon" @click="sidebarOpen = true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="9" y1="18" x2="15" y2="12" /><line x1="15" y1="12" x2="9" y2="6" />
        </svg>
      </button>
    </div>

    <main class="main-content">
      <ClipboardView
        v-if="currentSub === 'clipboard'"
        @toggle-quick-paste="showQuickPaste = !showQuickPaste"
        @toggle-theme="toggleMode"
        @preview-image="onPreviewImage"
        @preview-text="onPreviewText"
      />
      <SettingsView v-else-if="currentSub === 'settings'" @open-modal="openModal" />
      <ProfileView v-else-if="currentSub === 'profile'" />
      <DevicesView v-else-if="currentSub === 'devices'" @open-modal="openModal" />
      <SharedLinksView v-else-if="currentSub === 'shared-links'" />
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

  <ToastContainer />
</template>

<style scoped>
.app-shell { display: flex; height: 100vh; height: 100dvh; overflow: hidden; background: var(--bg-base); }
.sidebar-collapsed { width: 40px; flex-shrink: 0; display: flex; align-items: flex-start; justify-content: center; padding-top: 14px; border-right: 1px solid var(--border-default); background: var(--bg-sidebar); }
.main-content { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.btn-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--radius-sm); background: transparent; border: none; color: var(--text-secondary); cursor: pointer; }
.btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
</style>
