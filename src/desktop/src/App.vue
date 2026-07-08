<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useConfigStore } from '@/stores/configStore'
import { useTheme } from '@/composables/useTheme'
import { useI18n } from '@/composables/useI18n'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import * as tauri from '@/lib/tauri'

const configStore = useConfigStore()
const { currentMode } = useTheme()
const { setLang } = useI18n()

// Detect standalone QuickPaste mode (set by Rust initialization_script)
const isQuickPasteStandalone = ref(typeof window !== 'undefined' && !!(window as any).__QP_STANDALONE__)

onMounted(async () => {
  await configStore.load()
  // Sync titlebar color on mount
  try { tauri.setTitlebarMode(currentMode.value === 'dark') } catch {}
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
// Conditional import — only loaded when in QP standalone mode
import { defineAsyncComponent } from 'vue'
export default {
  components: {
    QuickPasteStandalone: defineAsyncComponent(() =>
      import('@/views/QuickPasteStandalone.vue')
    ),
  },
}
</script>
