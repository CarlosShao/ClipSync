import { invoke } from '@tauri-apps/api/core'
import type { AppConfig, ClipboardImageInfo } from '@/types'

/// set_global_shortcuts 逐项回传的注册结果（A8）
export interface ShortcutRegistration {
  /** 是否成功注册（含被备选键替代的情况） */
  ok: boolean
  /** 用户选择的键位 */
  requested: string
  /** 实际生效的键位；注册失败时为 null */
  effective: string | null
  /** 是否因为首选键被占用而回退到了备选键 */
  fallback: boolean
  /** fallback 时为失败原因，否则为空串 */
  reason: string
}

/// check_for_updates 的返回结构（A7）
export interface UpdateCheckResult {
  hasUpdate: boolean
  version?: string
  notes?: string
  date?: string
}

// ===== Config =====
export const getConfig = () => invoke<AppConfig>('get_config')
export const updateConfig = (config: AppConfig) => invoke('update_config', { config })
// 清除认证状态（退出登录时调用，与 updateConfig 分离以免保存设置误删会话）
export const clearAuth = () => invoke('clear_auth')

// ===== Clipboard =====
export const getClipboardContent = () => invoke<string>('get_clipboard_content')
export const setClipboardContent = (content: string) => invoke('set_clipboard_content', { content })
export const getClipboardFiles = () => invoke<string[]>('get_clipboard_files')
export const setClipboardFiles = (paths: string[]) => invoke('set_clipboard_files', { paths })
export const readFileContent = (path: string) => invoke<string>('read_file_content', { path })
export const readFileContentBase64 = (path: string) => invoke<string>('read_file_content_base64', { path })
export const copyLocalFiles = (paths: string[]) => invoke<string>('copy_local_files', { paths })
export const saveAndCopyFile = (base64Data: string, filename: string) =>
  invoke<string>('save_and_copy_file', { base64Data, filename })
export const checkClipboardImageInfo = () => invoke<ClipboardImageInfo>('check_clipboard_image_info')
export const getClipboardImage = () => invoke<string>('get_clipboard_image')
export const convertBmpToPng = (bmpDataUrl: string) => invoke<string>('convert_bmp_to_png', { bmpDataUrl })

// ===== Auth =====
export const login = (phone: string, code: string) =>
  invoke<{ token: string; user: { id: string } }>('login', { phone, code })
export const sendVerificationCode = (phone: string) => invoke('send_verification_code', { phone })

// ===== App =====
export const openUrl = (url: string) => invoke('open_url', { url })
// A7：只做检查，不下载不安装。未配置 pubkey 时 Rust 会 reject（前端据此提示"更新服务未配置"）
export const checkForUpdates = () => invoke<UpdateCheckResult>('check_for_updates')
// A7：用户在确认框点"立即安装"后调用：下载 → 安装 → 重启
export const installUpdate = () => invoke('install_update')

// ===== Autostart =====
export const enableAutostart = () => invoke('enable_autostart')
export const disableAutostart = () => invoke('disable_autostart')
export const isAutostartEnabled = () => invoke<boolean>('is_autostart_enabled')

// ===== Shortcuts =====
export const registerShortcut = (shortcut: string) => invoke('register_shortcut', { shortcut })
export const unregisterAllShortcuts = () => invoke('unregister_all_shortcuts')
// Re-register all global shortcuts from a map: { quickPaste, toggleWindow, toggleAiPanel }
// A8：返回逐项"实际生效键位"，请求键被占用时会回退到备选键并在结果里说明原因
export const setGlobalShortcuts = (shortcuts: Record<string, string>) =>
  invoke<Record<string, ShortcutRegistration>>('set_global_shortcuts', { shortcuts })
// Toggle main window visibility (show/hide to tray)
export const toggleWindow = () => invoke('toggle_window')

// ===== Clipboard monitor =====
// A9：由"自动同步"开关驱动的原生剪贴板监听启停（Rust 侧幂等）
export const startClipboardMonitor = () => invoke('start_clipboard_monitor')
export const stopClipboardMonitor = () => invoke('stop_clipboard_monitor')

// ===== UI =====
export const setTitlebarMode = (isDark: boolean) => invoke('set_titlebar_mode', { isDark })

// ===== Image Viewer =====
export const openImageViewer = (imageDataUrl: string, title: string) =>
  invoke('open_image_viewer', { imageDataUrl, title })

// ===== File Explorer =====
// 在资源管理器中选中并显示文件/文件夹
export const revealInFolder = (path: string) => invoke('reveal_in_folder', { path })
