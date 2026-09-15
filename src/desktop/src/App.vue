<script setup lang="ts">
import { onMounted, ref, computed, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import { useConfigStore } from '@/stores/configStore'
import { useCollectionStore } from '@/stores/collectionStore'
import { useTheme } from '@/composables/useTheme'
import { useI18n } from '@/composables/useI18n'
import { Toaster } from 'vue-sonner'
import TitleBar from '@/components/layout/TitleBar.vue'
import * as tauri from '@/lib/tauri'

const QuickPasteStandalone = defineAsyncComponent(() => import('@/views/QuickPasteStandalone.vue'))

const configStore = useConfigStore()
const collectionStore = useCollectionStore()
const { resolvedMode } = useTheme()
const { setLang } = useI18n()

// Detect standalone QuickPaste mode via URL parameter.
// Rust creates QP window with ?mode=qp → window.location.search is available
// SYNCHRONOUSLY before Vue mounts — zero race condition.
const isQuickPasteStandalone = ref(typeof window !== 'undefined' && window.location.search.includes('mode=qp'))
// decorations:false 后登录页也需要窗口控制与拖拽区（主视图的标题栏由 HomeView 自己渲染）
const route = useRoute()
const showAuthTitlebar = computed(
  () => !isQuickPasteStandalone.value && route.path.startsWith('/auth'),
)

onMounted(async () => {
  await configStore.load()
  // Initialize collection store early so that AI-triggered data refreshes
  // are captured even when FavoritesView is not mounted (e.g. user on AI page).
  collectionStore.init().catch((e) => {
    console.warn('[App] collectionStore.init failed:', e)
  })
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
})
</script>

<template>
  <!-- Standalone QuickPaste floating window: render only the paste panel -->
  <QuickPasteStandalone v-if="isQuickPasteStandalone" />
  <!-- Normal app shell -->
  <template v-else>
    <TitleBar v-if="showAuthTitlebar" minimal />
    <router-view />
    <!-- Clearline toast：右下角堆叠，入场从右缘滑入（动画与卡片化样式见 globals.css 的 sonner 覆盖段） -->
    <Toaster
      position="bottom-right"
      :rich-colors="true"
      :close-button="true"
      close-button-position="top-right"
      :duration="3000"
      :expand="true"
      :visible-toasts="4"
      :offset="20"
    />
  </template>
</template>
