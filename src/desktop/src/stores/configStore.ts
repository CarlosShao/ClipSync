import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AppConfig } from '@/types'
import * as tauri from '@/lib/tauri'

const isDev = import.meta.env.DEV

export const useConfigStore = defineStore('config', () => {
  // 同步从 localStorage 恢复 token，避免 HomeView onMounted 先于 App onMounted 导致 api() 无 token → 401
  const savedToken = typeof localStorage !== 'undefined' ? localStorage.getItem('clipsync-token') : null
  const config = ref<AppConfig>({
    // 开发环境：相对路径，走 Vite proxy (/api → http://localhost:3001)
    // 生产环境（Tauri）：显式指向 Docker 后端
    server_url: isDev ? '' : 'http://localhost:3001',
    token: savedToken || null,
    device_id: null,
    user_id: null,
    quick_paste_shortcut: 'Ctrl+Shift+V',
  })

  const user = ref({ name: '', email: '', phone: '', plan: 'Free' as string })
  const autostart = ref(false)
  const syncInterval = ref(0) // 0=realtime
  const maxHistory = ref(500)
  const reduceMotion = ref(false)
  const autoSync = ref(true)   // 自动同步剪贴板（默认开启）
  const imageCompress = ref(false) // 图片压缩（默认关闭）

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
    // 从 localStorage 恢复 token（Tauri getConfig 可能不包含 token）
    if (!config.value.token) {
      const savedToken = localStorage.getItem('clipsync-token')
      if (savedToken) {
        config.value.token = savedToken
      }
    }
    // 从 localStorage 恢复用户偏好设置（跨会话持久化）
    try {
      const prefs = JSON.parse(localStorage.getItem('clipsync-prefs') || '{}')
      if (typeof prefs.syncInterval === 'number') syncInterval.value = prefs.syncInterval
      if (typeof prefs.maxHistory === 'number') maxHistory.value = prefs.maxHistory
      if (typeof prefs.reduceMotion === 'boolean') reduceMotion.value = prefs.reduceMotion
      if (typeof prefs.autoSync === 'boolean') autoSync.value = prefs.autoSync
      if (typeof prefs.imageCompress === 'boolean') imageCompress.value = prefs.imageCompress
      if (typeof prefs.autostart === 'boolean') autostart.value = prefs.autostart
    } catch { /* ignore corrupt data */ }

    // 有 token 时立即从后端拉取用户资料（name/email/phone/plan/avatar）
    // 否则重开 app 后所有 profile 字段永远显示 "Not set"
    if (config.value.token) {
      await fetchUserProfile()
    }
  }

  async function save(partial: Partial<AppConfig>) {
    const updated = { ...config.value, ...partial }
    try {
      await tauri.updateConfig(updated)
      config.value = updated
    } catch { /* ignore */ }
  }

  // 统一登录收尾：持久化 token + 注册设备 + 拉取用户资料。供 login(验证码) 与 二维码配对兑换 复用
  async function completeLogin(authToken: string, userId: string) {
    config.value.token = authToken
    config.value.user_id = userId
    localStorage.setItem('clipsync-token', authToken)
    await save({ token: authToken, user_id: userId })
    await registerCurrentDevice(authToken)
    // 登录成功后立即拉取用户资料（phone/email/nickname/avatarUrl）
    await fetchUserProfile()
  }

  async function login(phone: string, code: string) {
    const res = await tauri.login(phone, code)
    if (!res || !res.token) {
      throw new Error('Login failed: no token returned')
    }
    // 兼容两种返回格式: { user: { id } } 或 { user_id }
    const userId = res.user?.id || (res as any).user_id || ''
    await completeLogin(res.token, userId)
  }

  function logout() {
    localStorage.removeItem('clipsync-token')
    user.value = { name: '', email: '', phone: '', plan: 'Free' }
    config.value.token = null
    config.value.user_id = null
    config.value.device_id = null
    // 清除 Rust 端持久化的认证态（clear_auth 命令只清 token/device_id/user_id，
    // 不会动 server_url/快捷键）。不再用 save({token:null})，避免 update_config
    // 整体覆盖语义误伤其它字段。
    tauri.clearAuth().catch(() => {})
  }

  // 保存用户偏好到 localStorage（跨会话持久化）
  function savePrefs() {
    const prefs = {
      syncInterval: syncInterval.value,
      maxHistory: maxHistory.value,
      reduceMotion: reduceMotion.value,
      autoSync: autoSync.value,
      imageCompress: imageCompress.value,
      autostart: autostart.value,
    }
    localStorage.setItem('clipsync-prefs', JSON.stringify(prefs))
  }

  // 注册当前设备到后端（使用正确字段名 deviceName/deviceType/platform，避免前后端不匹配）
  async function registerCurrentDevice(authToken: string) {
    const serverUrl = config.value.server_url || ''
    const platform = /Mac/i.test(navigator.userAgent)
      ? 'macos'
      : /Linux/i.test(navigator.userAgent)
        ? 'linux'
        : 'windows'
    try {
      await fetch(`${serverUrl}/api/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ deviceName: 'Desktop', deviceType: 'desktop', platform }),
      })
    } catch { /* 设备注册失败不影响登录 */ }
  }

  function toggleAutoSync(val?: boolean) {
    autoSync.value = val ?? !autoSync.value
    savePrefs()
  }

  function toggleImageCompress(val?: boolean) {
    imageCompress.value = val ?? !imageCompress.value
    savePrefs()
  }

  function toggleReduceMotion(val?: boolean) {
    reduceMotion.value = val ?? !reduceMotion.value
    savePrefs()
    // 应用减少动画：给 html 添加/移除 class，供 CSS 使用
    document.documentElement.classList.toggle('reduce-motion', reduceMotion.value)
  }

  async function toggleAutostart(val?: boolean) {
    const next = val ?? !autostart.value
    try {
      if (next) await tauri.enableAutostart()
      else await tauri.disableAutostart()
      autostart.value = next
    } catch { /* ignore Tauri API failure, still persist preference */ }
    savePrefs()
  }

  // 初始化时应用 reduceMotion 状态（在 load() 恢复 prefs 之后会再次执行）
  if (typeof window !== 'undefined') {
    document.documentElement.classList.toggle('reduce-motion', reduceMotion.value)
  }

  // 拉取用户资料并填充 user state（phone/email/nickname/avatarUrl/plan）
  async function fetchUserProfile() {
    try {
      const serverUrl = config.value.server_url || ''
      const token = config.value.token
      if (!token) return
      const res = await fetch(`${serverUrl}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (!res.ok) return
      const data = await res.json()
      if (data) {
        user.value.name = data.nickname || user.value.name
        user.value.email = data.email || user.value.email
        user.value.phone = data.phone || user.value.phone
        user.value.plan = data.plan || user.value.plan
        // avatarUrl 存到 localStorage 供 ProfileView 使用
        if (data.avatarUrl) localStorage.setItem('clipsync-avatar', data.avatarUrl)
      }
    } catch { /* 静默失败，user 保持默认值 */ }
  }

  // 更新用户资料（昵称/头像）→ 同步调 API + 本地 state
  async function updateUserProfile(partial: { displayName?: string; avatarUrl?: string }) {
    const serverUrl = config.value.server_url || ''
    const token = config.value.token
    if (!token) return false
    try {
      const body: Record<string, any> = {}
      if (partial.displayName !== undefined) body.nickname = partial.displayName
      if (partial.avatarUrl !== undefined) body.avatarUrl = partial.avatarUrl
      const res = await fetch(`${serverUrl}/api/auth/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        if (partial.displayName !== undefined) user.value.name = partial.displayName
        if (partial.avatarUrl !== undefined) {
          localStorage.setItem('clipsync-avatar', partial.avatarUrl)
        }
        return true
      }
      return false
    } catch { return false }
  }

  // 修改密码（已登录状态，需要旧密码 + 新密码）
  async function changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
    const serverUrl = config.value.server_url || ''
    const token = config.value.token
    if (!token) return { ok: false, error: 'Not logged in' }
    try {
      const res = await fetch(`${serverUrl}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      const data = await res.json()
      if (res.ok) return { ok: true }
      return { ok: false, error: data.error || `HTTP ${res.status}` }
    } catch (e: any) {
      return { ok: false, error: e.message || 'Network error' }
    }
  }

  return {
    config, user, autostart, syncInterval, maxHistory, reduceMotion,
    autoSync, imageCompress,
    isLoggedIn, serverUrl, load, save, savePrefs, login, completeLogin, registerCurrentDevice,
    fetchUserProfile, updateUserProfile, changePassword,
    toggleAutostart, toggleAutoSync, toggleImageCompress, toggleReduceMotion, logout,
  }
})
