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

// Detect standalone QuickPaste mode.
// Rust injects window.__QP_STANDALONE__=true via .eval() AFTER window creation,
// so we cannot check it synchronously during setup(). Instead:
// 1. Check immediately (in case it's already set)
// 2. Poll for up to 1s with 50ms intervals (for late-arriving eval injection)
const isQuickPasteStandalone = ref(false)

onMounted(async () => {
  // Poll for __QP_STANDALONE__ flag (injected by Rust via eval after window creation)
  const check = () => {
    isQuickPasteStandalone.value = !!(window as any).__QP_STANDALONE__
    return isQuickPasteStandalone.value
  }
  if (!check()) {
    // Retry every 50ms for up to 1 second (gives time for eval + Vue mount)
    let attempts = 0
    const timer = setInterval(() => {
      attempts++
      if (check() || attempts > 20) clearInterval(timer)
    }, 50)
  }

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
