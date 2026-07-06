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
    csrfExpiresAt = Date.now() + 300_000 // 缓存 5 分钟，减少 ~50% 的请求量（之前 4.5s）
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

  // 429 指数退避重试： honoring server Retry-After header
  const MAX_RETRIES = 3
  const BASE_DELAYS = [1000, 2000, 4000] // ms

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${config.serverUrl}${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'include',
      })

      if (res.status === 429 && attempt < MAX_RETRIES) {
        // 优先使用服务端 Retry-After 头
        const retryAfter = res.headers.get('Retry-After')
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : BASE_DELAYS[attempt]
        console.warn(`[API] 429 on ${method} ${path} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying after ${delay}ms`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }

      const text = await res.text()
      let json: any
      try { json = JSON.parse(text) } catch { json = { message: text } }

      if (!res.ok) return { ok: false, status: res.status, error: json?.error || json?.message || `HTTP ${res.status}`, data: json }
      return { ok: true, status: res.status, data: json }
    } catch (e: any) {
      // 网络错误不重试（非 429）
      return { ok: false, status: 0, error: String(e.message || e) }
    }
  }

  // 重试耗尽
  return { ok: false, status: 429, error: 'Too many requests after retries, please wait and try again.' }
}
