<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useConfigStore } from '@/stores/configStore'
import { useTheme } from '@/composables/useTheme'
import { useI18n } from '@/composables/useI18n'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import * as tauri from '@/lib/tauri'

const configStore = useConfigStore()
const { currentMode } = useTheme()
const { setLang } = useI18n()

// Detect standalone QuickPaste mode via URL parameter.
// Rust creates QP window with ?mode=qp → window.location.search is available
// SYNCHRONOUSLY before Vue mounts — zero race condition.
const isQuickPasteStandalone = ref(
  typeof window !== 'undefined' && window.location.search.includes('mode=qp')
)

onMounted(async () => {
  await configStore.load()
  // Sync titlebar color on mount
  try { tauri.setTitlebarMode(currentMode.value === 'dark') } catch {}
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
    <router-view />
    <ToastContainer />
  </template>
</template>

<script lang="ts">
import { defineAsyncComponent } from 'vue'
export default {
  components: {
    QuickPasteStandalone: defineAsyncComponent(() =>
      import('@/views/QuickPasteStandalone.vue')
    ),
  },
}
</script>
