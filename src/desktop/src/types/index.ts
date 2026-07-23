export interface AppConfig {
  server_url: string
  token: string | null
  device_id: string | null
  user_id: string | null
  quick_paste_shortcut: string | null
}

export type ThemeStyle = 'vercel' | 'clipsync' | 'notion' | 'linear' | 'apple' | 'raycast' | 'arc'

export type ThemeMode = 'light' | 'dark'

export interface ClipboardImageInfo {
  available: boolean
  size: number
  /** Content hash (FNV-1a, string form of u64) — used to dedup images by content, not byte length */
  hash?: string
}

export type AuthView = 'login-phone' | 'login-password' | 'register' | 'set-password' | 'forgot-password'

// 模板库条目：后端仅持久化 name + content（含 {{变量}} 占位符），变量解析在前端完成
export interface ClipboardTemplate {
  id: string
  name: string
  content: string
  created_at: string
  updated_at: string
}

// 模板全局变量：name → value，后端按用户隔离存储（template_variables 表）
export interface TemplateVariable {
  id: string
  name: string
  value: string
  created_at: string
  updated_at: string
}
