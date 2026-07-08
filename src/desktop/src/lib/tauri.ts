import { invoke } from '@tauri-apps/api/core'
import type { AppConfig, ClipboardImageInfo } from '@/types'

// ===== Config =====
export const getConfig = () => invoke<AppConfig>('get_config')
export const updateConfig = (config: AppConfig) => invoke('update_config', { config })

// ===== Clipboard =====
export const getClipboardContent = () => invoke<string>('get_clipboard_content')
export const setClipboardContent = (content: string) => invoke('set_clipboard_content', { content })
export const getClipboardFiles = () => invoke<string[]>('get_clipboard_files')
export const setClipboardFiles = (paths: string[]) => invoke('set_clipboard_files', { paths })
export const copyLocalFiles = (paths: string[]) => invoke<string>('copy_local_files', { paths })
export const saveAndCopyFile = (base64Data: string, filename: string) =>
  invoke<string>('save_and_copy_file', { base64Data, filename })
export const checkClipboardImageInfo = () => invoke<ClipboardImageInfo>('check_clipboard_image_info')
export const getClipboardImage = () => invoke<string>('get_clipboard_image')
export const convertBmpToPng = (bmpDataUrl: string) => invoke<string>('convert_bmp_to_png', { bmpDataUrl })

// ===== Auth =====
export const login = (phone: string, code: string) => invoke<{ token: string; user: { id: string } }>('login', { phone, code })
export const sendVerificationCode = (phone: string) => invoke('send_verification_code', { phone })

// ===== App =====
export const openUrl = (url: string) => invoke('open_url', { url })
export const checkForUpdates = () => invoke<{ hasUpdate: boolean; version?: string }>('check_for_updates')

// ===== Autostart =====
export const enableAutostart = () => invoke('enable_autostart')
export const disableAutostart = () => invoke('disable_autostart')
export const isAutostartEnabled = () => invoke<boolean>('is_autostart_enabled')

// ===== Shortcuts =====
export const registerShortcut = (shortcut: string) => invoke('register_shortcut', { shortcut })
export const unregisterAllShortcuts = () => invoke('unregister_all_shortcuts')
// Re-register all global shortcuts from a map: { quickPaste, toggleWindow }
export const setGlobalShortcuts = (shortcuts: Record<string, string>) =>
  invoke('set_global_shortcuts', { shortcuts })
// Toggle main window visibility (show/hide to tray)
export const toggleWindow = () => invoke('toggle_window')

// ===== UI =====
export const setTitlebarMode = (isDark: boolean) => invoke('set_titlebar_mode', { isDark })

// ===== Image Viewer =====
export const openImageViewer = (imageDataUrl: string, title: string) =>
  invoke('open_image_viewer', { imageDataUrl, title })

// ===== File Explorer =====
// 在资源管理器中选中并显示文件/文件夹
export const revealInFolder = (path: string) =>
  invoke('revealInFolder', { path })
