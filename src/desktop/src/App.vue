<script setup lang="ts">
import { onMounted, ref, defineAsyncComponent } from 'vue'
import { useConfigStore } from '@/stores/configStore'
import { useCollectionStore } from '@/stores/collectionStore'
import { useTheme } from '@/composables/useTheme'
import { useI18n } from '@/composables/useI18n'
import { Toaster } from 'vue-sonner'
import * as tauri from '@/lib/tauri'

const QuickPasteStandalone = defineAsyncComponent(() => import('@/views/QuickPasteStandalone.vue'))

console.log('[BOOT] A pre-stores')
const configStore = useConfigStore()
console.log('[BOOT] B configStore')
const collectionStore = useCollectionStore()
console.log('[BOOT] C collectionStore')
const { resolvedMode } = useTheme()
console.log('[BOOT] D useTheme')
const { setLang } = useI18n()
console.log('[BOOT] E useI18n')

// Detect standalone QuickPaste mode via URL parameter.
// Rust creates QP window with ?mode=qp → window.location.search is available
// SYNCHRONOUSLY before Vue mounts — zero race condition.
const isQuickPasteStandalone = ref(typeof window !== 'undefined' && window.location.search.includes('mode=qp'))

onMounted(async () => {
  console.log('[BOOT] F onMounted start')
  await configStore.load()
  console.log('[BOOT] G configStore.loaded')
  // Initialize collection store early so that AI-triggered data refreshes
  // are captured even when FavoritesView is not mounted (e.g. user on AI page).
  collectionStore.init().catch((e) => {
    console.warn('[App] collectionStore.init failed:', e)
  })
  console.log('[BOOT] H collectionStore.init called')
  // Sync titlebar color on mount
  try {
    tauri.setTitlebarMode(resolvedMode.value === 'dark')
  } catch (e) {
    console.warn('[App] setTitlebarMode failed:', e)
  }
  // QP standalone mode: strip body/html background so the transparent
  // Tauri window doesn't show as a colored rectangle (the "frame" bug)
  if (isQuickPasteStandalone.value) {
    document.documentElement.classList.add('qp-mode')
  }
  console.log('[BOOT] I onMounted end')
})
</script>

<template>
  <!-- Standalone QuickPaste floating window: render only the paste panel -->
  <QuickPasteStandalone v-if="isQuickPasteStandalone" />
  <!-- Normal app shell -->
  <template v-else>
    <router-view />
    <Toaster
      position="top-right"
      :rich-colors="true"
      :close-button="true"
      close-button-position="top-right"
      :duration="3000"
      :expand="true"
      :visible-toasts="3"
    />
  </template>
</template>
