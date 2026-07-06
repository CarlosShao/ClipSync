import { ref } from 'vue'
import { useConfigStore } from '@/stores/configStore'

let csrfToken: string | null = null
let csrfExpiresAt = 0

async function getCsrfToken(): Promise<string | null> {
  if (csrfToken && Date.now() < csrfExpiresAt) return csrfToken
  // 未登录时跳过 CSRF（登录/注册/忘记密码不需要）
  const config = useConfigStore()
  if (!config.config.token) return null
  try {
    const res = await fetch(`${config.serverUrl}/api/csrf-token`, {
      credentials: 'include',
      headers: { 'Authorization': `Bearer ${config.config.token}` },
    })
    const data = await res.json()
    csrfToken = data.token || null
    csrfExpiresAt = Date.now() + 4500
    return csrfToken
  } catch { return null }
}

export interface ApiResponse<T = any> {
  ok: boolean
  data?: T
  error?: string
  status: number
}

export async function api<T = any>(
  method: string,
  path: string,
  body?: any,
): Promise<ApiResponse<T>> {
  const config = useConfigStore()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  
  const token = config.config.token
  if (token) headers['Authorization'] = `Bearer ${token}`
  const csrf = await getCsrfToken()
  if (csrf) headers['X-CSRF-Token'] = csrf

  try {
    const res = await fetch(`${config.serverUrl}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'include',
    })
    if (res.status === 429) return { ok: false, status: 429, error: 'Too many requests, please wait and try again.' }

    const text = await res.text()
    let json: any
    try { json = JSON.parse(text) } catch { json = { message: text } }

    if (!res.ok) return { ok: false, status: res.status, error: json?.error || json?.message || `HTTP ${res.status}`, data: json }
    return { ok: true, status: res.status, data: json }
  } catch (e: any) {
    return { ok: false, status: 0, error: String(e.message || e) }
  }
}
