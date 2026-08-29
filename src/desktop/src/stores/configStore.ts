import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AppConfig } from '@/types'
import * as tauri from '@/lib/tauri'
import { api, storeRefreshToken } from '@/api/client'
import { useClipboard } from '@/composables/useClipboard'
import { clearQueue } from '@/utils/offlineQueue'

const isDev = import.meta.env.DEV
// A1：服务器地址默认值。只在"拿不到配置"时生效，绝不覆盖用户已保存的值
// （空字符串是合法的"未连接"态）。
const DEFAULT_SERVER_URL = 'http://localhost:3001'

export const useConfigStore = defineStore('config', () => {
  // 同步从 localStorage 恢复 token，避免 HomeView onMounted 先于 App onMounted 导致 api() 无 token → 401
  const savedToken = typeof localStorage !== 'undefined' ? localStorage.getItem('clipsync-token') : null
  const config = ref<AppConfig>({
    // 开发环境：相对路径，走 Vite proxy (/api → http://localhost:3001)
    // 生产环境（Tauri）：显式指向 Docker 后端
    server_url: isDev ? '' : DEFAULT_SERVER_URL,
    token: savedToken || null,
    device_id: null,
    user_id: null,
    quick_paste_shortcut: 'Ctrl+Shift+V',
    toggle_window_shortcut: 'Ctrl+Alt+Space',
    toggle_ai_panel_shortcut: 'Ctrl+Shift+A',
  })

  const user = ref({ name: '', email: '', phone: '', plan: 'Free' as string })
  const autostart = ref(false)
  const syncInterval = ref(0) // 0=realtime
  const maxHistory = ref(500)
  const reduceMotion = ref(false)
  const autoSync = ref(true) // 自动同步剪贴板（默认开启）
  const imageCompress = ref(false) // 图片压缩（默认关闭）
  const privacyMode = ref(false) // 隐私模式：自动隐藏敏感内容
  const autoBlur = ref(false) // 窗口失焦时自动隐藏敏感内容

  // === 外观个性化（设置→外观）：全部为纯前端 CSS 变量驱动 ===
  const fontScale = ref(1) // 界面字号缩放（0.9/1/1.1/1.25），作用于 html 根字号（rem 类跟随）
  const fontFamily = ref('default') // 界面字体预设 key（default/yahei/serif/kai）
  const frosted = ref(false) // 毛玻璃：主表面半透明 + #app backdrop 虚化
  const surfaceOpacity = ref(85) // 毛玻璃开启时的表面不透明度（40-100%）
  const bgImage = ref('') // 自定义背景图 dataURL（canvas 降采样后存储）
  const bgDim = ref(0) // 背景图压暗（0-60%），保证内容可读性

  const isLoggedIn = computed(() => !!config.value.token)
  const serverUrl = computed(() => config.value.server_url)

  async function load() {
    try {
      const c = await tauri.getConfig()
      config.value = c
      // A1：不再根据构建模式强制覆写 server_url。只有配置里根本没有这个字段
      // （旧版本持久化的文件）时才回落默认值；空字符串 = 用户主动清空 = 未连接。
      if (c.server_url == null) {
        config.value.server_url = isDev ? '' : DEFAULT_SERVER_URL
      } else if (isDev && (!c.server_url || c.server_url === DEFAULT_SERVER_URL)) {
        // dev 补充：Rust 端 AppConfig::default() 会给出 http://localhost:3001，
        // 它与"用户显式保存的值"无法区分。dev 下默认值/空值一律走 Vite proxy（同源，
        // 避免 1420→3001 跨域预检被 CORS 拦截）；仅当用户配置了其它地址时才直连。
        config.value.server_url = ''
      }
      const auto = await tauri.isAutostartEnabled().catch(() => false)
      autostart.value = auto
    } catch {
      // 非 Tauri 环境（浏览器 dev）：dev 走 Vite proxy 相对路径，其它回落默认值
      config.value.server_url = isDev ? '' : DEFAULT_SERVER_URL
    }
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
      if (typeof prefs.privacyMode === 'boolean') privacyMode.value = prefs.privacyMode
      if (typeof prefs.autoBlur === 'boolean') autoBlur.value = prefs.autoBlur
      if (typeof prefs.fontScale === 'number') fontScale.value = prefs.fontScale
      if (typeof prefs.fontFamily === 'string') fontFamily.value = prefs.fontFamily
      if (typeof prefs.frosted === 'boolean') frosted.value = prefs.frosted
      if (typeof prefs.surfaceOpacity === 'number') surfaceOpacity.value = prefs.surfaceOpacity
      if (typeof prefs.bgDim === 'number') bgDim.value = prefs.bgDim
      if (typeof prefs.bgImage === 'string') bgImage.value = prefs.bgImage
    } catch {
      /* ignore corrupt data */
    }
    // 恢复外观偏好后立即落到 <html>（字号/字体/毛玻璃/背景图）
    applyAppearance()

    // A9：把"自动同步"开关真正接到原生剪贴板监听上。
    // Rust 侧 start/stop 都幂等，所以这里可以无条件调用。
    await syncClipboardMonitor()

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
    } catch {
      /* ignore */
    }
  }

  // 统一登录收尾：持久化 token + refresh token + 注册设备 + 拉取用户资料。
  // 供 login(验证码/密码) 与 二维码配对兑换 复用
  async function completeLogin(authToken: string, userId: string, refreshToken?: string | null) {
    config.value.token = authToken
    config.value.user_id = userId
    localStorage.setItem('clipsync-token', authToken)
    storeRefreshToken(refreshToken || null)
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
    // 兼容两种返回格式: { user: { id } } 或 { user_id }；refreshToken 由 Rust login 命令整体透传后端响应
    const userId = res.user?.id || (res as any).user_id || ''
    await completeLogin(res.token, userId, (res as any).refreshToken)
  }

  function logout() {
    localStorage.removeItem('clipsync-token')
    // 清除 refresh token / csrf / 墓碑同步游标，避免下个账号继承旧凭证与同步点
    storeRefreshToken(null)
    localStorage.removeItem('clipsync-csrf')
    localStorage.removeItem('clipsync-last-sync-at')
    // 清除剪贴板内容缓存与 tab 状态，避免切换账号后旧数据/图片残留内存和磁盘
    localStorage.removeItem('clipsync-content-cache-v2')
    localStorage.removeItem('clipsync-clipboard-filter')
    // 登出时清理离线队列，避免上一个账号的离线操作被下一个登录账号刷出（跨用户清理）
    clearQueue()
    user.value = { name: '', email: '', phone: '', plan: 'Free' }
    config.value.token = null
    config.value.user_id = null
    config.value.device_id = null
    // 释放剪贴板图片的 blob URL，防止旧账号图片常驻 WebView 内存（泄漏修复）
    try {
      useClipboard().resetImages()
    } catch {
      /* composable 尚未初始化则忽略 */
    }
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
      privacyMode: privacyMode.value,
      autoBlur: autoBlur.value,
      fontScale: fontScale.value,
      fontFamily: fontFamily.value,
      frosted: frosted.value,
      surfaceOpacity: surfaceOpacity.value,
      bgDim: bgDim.value,
      // bgImage 单独存（dataURL 可达数百 KB，避免 prefs JSON 膨胀影响其它字段读写）
      bgImage: bgImage.value,
    }
    localStorage.setItem('clipsync-prefs', JSON.stringify(prefs))
  }

  // 注册当前设备到后端（使用正确字段名 deviceName/deviceType/platform，避免前后端不匹配）
  // 走统一 api()：自动带 Bearer + 超时 + 401 刷新，无需手工拼 fetch
  async function registerCurrentDevice(authToken: string) {
    const platform = /Mac/i.test(navigator.userAgent)
      ? 'macos'
      : /Linux/i.test(navigator.userAgent)
        ? 'linux'
        : 'windows'
    try {
      await api('POST', '/api/devices', { deviceName: 'Desktop', deviceType: 'desktop', platform })
    } catch {
      /* 设备注册失败不影响登录 */
    }
  }

  // A9：autoSync 开关 → 原生剪贴板监听的启停。
  // Rust 侧 start/stop 都幂等（已运行/已停止直接返回），浏览器 dev 下 invoke 失败静默忽略。
  async function syncClipboardMonitor() {
    try {
      if (autoSync.value) await tauri.startClipboardMonitor()
      else await tauri.stopClipboardMonitor()
    } catch {
      /* 非 Tauri 环境（浏览器 dev）没有这些命令 */
    }
  }

  function toggleAutoSync(val?: boolean) {
    autoSync.value = val ?? !autoSync.value
    savePrefs()
    // A9：切换即时生效 —— 关掉之后真的不会再采集到任何条目
    void syncClipboardMonitor()
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

  function togglePrivacyMode(val?: boolean) {
    privacyMode.value = val ?? !privacyMode.value
    savePrefs()
  }

  function toggleAutoBlur(val?: boolean) {
    autoBlur.value = val ?? !autoBlur.value
    savePrefs()
  }

  async function toggleAutostart(val?: boolean) {
    const next = val ?? !autostart.value
    try {
      if (next) await tauri.enableAutostart()
      else await tauri.disableAutostart()
      autostart.value = next
    } catch {
      /* ignore Tauri API failure, still persist preference */
    }
    savePrefs()
  }

  // === 外观个性化：应用与设置 ===
  const FONT_STACKS: Record<string, string> = {
    yahei: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
    serif: 'Georgia, "Noto Serif SC", "Source Han Serif SC", "SimSun", serif',
    kai: '"KaiTi", "Kaiti SC", "STKaiti", serif',
  }

  /**
   * 把外观偏好落到 <html> 上。全部走 inline CSS 变量/行内样式：
   * inline 优先级高于任何主题选择器，且不与主题定义形成循环引用 ——
   * 半透明表面用「移除行内 → 读主题解析色 → 写 color-mix」三步实现，
   * 拖滑杆反复调用也不会叠乘透明度。
   */
  function applyAppearance() {
    const root = document.documentElement
    // 1) 字号：根字号缩放，Tailwind rem 工具类全部跟随
    root.style.fontSize = `${Math.round(14 * fontScale.value)}px`
    // 2) 字体：body 的 font-family 已改为 var(--font-ui, 默认栈)
    const stack = FONT_STACKS[fontFamily.value]
    if (stack) root.style.setProperty('--font-ui', stack)
    else root.style.removeProperty('--font-ui')
    // 3) 背景图与压暗
    root.style.setProperty('--app-bg-image', bgImage.value ? `url("${bgImage.value}")` : 'none')
    root.style.setProperty('--app-bg-dim', String(bgDim.value / 100))
    // 4) 毛玻璃：表面半透明（40-100%）
    root.classList.toggle('frosted', frosted.value)
    const alpha = frosted.value ? Math.min(Math.max(surfaceOpacity.value, 40), 100) : 100
    for (const v of ['--bg-base', '--bg-surface', '--bg-sidebar']) {
      root.style.removeProperty(v)
      if (alpha >= 100) continue
      const solid = getComputedStyle(root).getPropertyValue(v).trim()
      if (!solid) continue
      root.style.setProperty(v, `color-mix(in srgb, ${solid} ${alpha}%, transparent)`)
    }
  }

  function setFontScale(v: number) {
    fontScale.value = v
    savePrefs()
    applyAppearance()
  }
  function setFontFamily(v: string) {
    fontFamily.value = v
    savePrefs()
    applyAppearance()
  }
  function setFrosted(val?: boolean) {
    frosted.value = val ?? !frosted.value
    savePrefs()
    applyAppearance()
  }
  function setSurfaceOpacity(v: number) {
    surfaceOpacity.value = v
    savePrefs()
    applyAppearance()
  }
  function setBgImage(dataUrl: string) {
    bgImage.value = dataUrl
    savePrefs()
    applyAppearance()
  }
  function setBgDim(v: number) {
    bgDim.value = v
    savePrefs()
    applyAppearance()
  }

  // 主题切换（html.class 变化）会改写主题变量的解析值，半透明覆盖需要重算
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => applyAppearance()).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
  }

  // 初始化时应用 reduceMotion 与外观偏好（load() 恢复 prefs 后会再次执行）
  if (typeof window !== 'undefined') {
    document.documentElement.classList.toggle('reduce-motion', reduceMotion.value)
    applyAppearance()
  }

  // 拉取用户资料并填充 user state（phone/email/nickname/avatarUrl/plan）
  // 走统一 api()：401 时自动刷新重试，刷新失败统一登出
  async function fetchUserProfile() {
    try {
      if (!config.value.token) return
      const res = await api('GET', '/api/auth/me')
      if (!res.ok || !res.data) return
      const data = res.data as any
      user.value.name = data.nickname || user.value.name
      user.value.email = data.email || user.value.email
      user.value.phone = data.phone || user.value.phone
      user.value.plan = data.plan || user.value.plan
      // avatarUrl 存到 localStorage 供 ProfileView 使用
      if (data.avatarUrl) localStorage.setItem('clipsync-avatar', data.avatarUrl)
    } catch {
      /* 静默失败，user 保持默认值 */
    }
  }

  // 更新用户资料（昵称/头像）→ 同步调 API + 本地 state
  async function updateUserProfile(partial: { displayName?: string; avatarUrl?: string }) {
    if (!config.value.token) return false
    try {
      const body: Record<string, any> = {}
      if (partial.displayName !== undefined) body.nickname = partial.displayName
      if (partial.avatarUrl !== undefined) body.avatarUrl = partial.avatarUrl
      const res = await api('PUT', '/api/auth/profile', body)
      if (res.ok) {
        if (partial.displayName !== undefined) user.value.name = partial.displayName
        if (partial.avatarUrl !== undefined) {
          localStorage.setItem('clipsync-avatar', partial.avatarUrl)
        }
        return true
      }
      return false
    } catch {
      return false
    }
  }

  // 修改密码（已登录状态，需要旧密码 + 新密码）
  async function changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
    if (!config.value.token) return { ok: false, error: 'Not logged in' }
    try {
      const res = await api('POST', '/api/auth/change-password', { oldPassword, newPassword })
      if (res.ok) return { ok: true }
      return { ok: false, error: res.error || `HTTP ${res.status}` }
    } catch (e: any) {
      return { ok: false, error: e.message || 'Network error' }
    }
  }

  return {
    config,
    user,
    autostart,
    syncInterval,
    maxHistory,
    reduceMotion,
    autoSync,
    imageCompress,
    privacyMode,
    autoBlur,
    fontScale,
    fontFamily,
    frosted,
    surfaceOpacity,
    bgImage,
    bgDim,
    setFontScale,
    setFontFamily,
    setFrosted,
    setSurfaceOpacity,
    setBgImage,
    setBgDim,
    applyAppearance,
    isLoggedIn,
    serverUrl,
    load,
    save,
    savePrefs,
    login,
    completeLogin,
    registerCurrentDevice,
    fetchUserProfile,
    updateUserProfile,
    changePassword,
    toggleAutostart,
    toggleAutoSync,
    toggleImageCompress,
    toggleReduceMotion,
    togglePrivacyMode,
    toggleAutoBlur,
    logout,
  }
})
