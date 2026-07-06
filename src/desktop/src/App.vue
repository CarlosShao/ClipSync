<script setup lang="ts">
import { onMounted } from 'vue'
import { useConfigStore } from '@/stores/configStore'
import { useTheme } from '@/composables/useTheme'
import { useI18n } from '@/composables/useI18n'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import * as tauri from '@/lib/tauri'

const configStore = useConfigStore()
const { currentMode } = useTheme()
const { setLang } = useI18n()

onMounted(async () => {
  await configStore.load()
  // Sync titlebar color on mount
  try { tauri.setTitlebarMode(currentMode.value === 'dark') } catch {}
})
</script>

<template>
  <router-view />
  <ToastContainer />
</template>
