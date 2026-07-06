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
    if (!res || !res.token) {
      throw new Error('Login failed: no token returned')
    }
    config.value.token = res.token
    // 兼容两种返回格式: { user: { id } } 或 { user_id }
    const userId = res.user?.id || (res as any).user_id || ''
    config.value.user_id = userId
    // Persist token for router guard
    localStorage.setItem('clipsync-token', res.token)
    await save({ token: res.token, user_id: userId })
    // 自动注册当前设备
    try {
      await fetch(`${config.value.server_url || ''}/api/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${res.token}` },
        body: JSON.stringify({ name: 'Desktop', type: 'desktop' }),
      })
    } catch { /* 设备注册失败不影响登录 */ }
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
