import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AppConfig } from '@/types'
import * as tauri from '@/lib/tauri'

const isDev = import.meta.env.DEV

export const useConfigStore = defineStore('config', () => {
  const config = ref<AppConfig>({
    // 开发环境：相对路径，走 Vite proxy (/api → http://localhost:3001)
    // 生产环境（Tauri）：显式指向 Docker 后端
    server_url: isDev ? '' : 'http://localhost:3001',
    token: null,
    device_id: null,
    user_id: null,
    quick_paste_shortcut: 'Ctrl+Shift+V',
  })

  const user = ref({ name: '', email: '', phone: '', plan: 'Free' as string })
  const autostart = ref(false)
  const syncInterval = ref(0) // 0=realtime
  const maxHistory = ref(500)
  const reduceMotion = ref(false)

  const isLoggedIn = computed(() => !!config.value.token)
  const serverUrl = computed(() => config.value.server_url)

  async function load() {
    try {
      const c = await tauri.getConfig()
      config.value = c
      const auto = await tauri.isAutostartEnabled().catch(() => false)
      autostart.value = auto
    } catch { /* defaults */ }
    // 根据构建模式强制设置正确的 server_url
    config.value.server_url = import.meta.env.DEV ? '' : 'http://localhost:3001'
  }

  async function save(partial: Partial<AppConfig>) {
    const updated = { ...config.value, ...partial }
    try {
      await tauri.updateConfig(updated)
      config.value = updated
    } catch { /* ignore */ }
  }

  async function login(phone: string, code: string) {
    const res = await tauri.login(phone, code)
    config.value.token = res.token
    config.value.user_id = res.user.id
    // Persist token for router guard
    if (res.token) localStorage.setItem('clipsync-token', res.token)
    await save({ token: res.token, user_id: res.user.id })
  }

  async function toggleAutostart(val?: boolean) {
    const next = val ?? !autostart.value
    try {
      if (next) await tauri.enableAutostart()
      else await tauri.disableAutostart()
      autostart.value = next
    } catch { /* ignore */ }
  }

  function logout() {
    localStorage.removeItem('clipsync-token')
    save({ token: null, user_id: null })
  }

  return {
    config, user, autostart, syncInterval, maxHistory, reduceMotion,
    isLoggedIn, serverUrl, load, save, login, toggleAutostart, logout,
  }
})
