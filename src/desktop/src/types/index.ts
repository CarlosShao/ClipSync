export interface AppConfig {
  server_url: string
  token: string | null
  device_id: string | null
  user_id: string | null
  quick_paste_shortcut: string | null
}

export type ThemeStyle =
  | 'vercel'
  | 'clipsync'
  | 'notion'
  | 'linear'
  | 'apple'
  | 'raycast'
  | 'arc'

export type ThemeMode = 'light' | 'dark'

export interface ClipboardImageInfo {
  available: boolean
  size: number
}

export type AuthView =
  | 'login-phone'
  | 'login-password'
  | 'register'
  | 'set-password'
  | 'forgot-password'
