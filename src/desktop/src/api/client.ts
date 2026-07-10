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

  // 429 指数退避重试： capped delay to avoid 30s+ waits
  const MAX_RETRIES = 2
  const BASE_DELAYS = [1000, 2000] // ms
  const MAX_RETRY_DELAY = 5000 // cap at 5 seconds

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${config.serverUrl}${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'include',
      })

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = res.headers.get('Retry-After')
        const serverDelay = retryAfter ? parseInt(retryAfter) * 1000 : BASE_DELAYS[attempt]
        const delay = Math.min(serverDelay, MAX_RETRY_DELAY)
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

/**
 * 二进制响应请求（图片/文件预览）。与 api() 共用同一套鉴权与 CSRF 头，
 * 但返回原始 Response 以便调用方取 blob。
 * 关键：/api/media 等路由挂了 csrfProtection，裸 fetch 只带 Bearer 会被拒 → 图片 404。
 */
/**
 * FormData 上传请求（multipart/form-data）。Content-Type 由浏览器自动设置（含 boundary）。
 */
export async function apiForm<T = any>(
  path: string,
  formData: FormData,
): Promise<ApiResponse<T>> {
  const config = useConfigStore()
  const headers: Record<string, string> = {}
  // 注意：不设置 Content-Type，让浏览器自动设置 multipart boundary
  const token = config.config.token
  if (token) headers['Authorization'] = `Bearer ${token}`
  const csrf = await getCsrfToken()
  if (csrf) headers['X-CSRF-Token'] = csrf
  try {
    const res = await fetch(`${config.serverUrl}${path}`, {
      method: 'POST', headers, body: formData, credentials: 'include',
    })
    const text = await res.text()
    let json: any
    try { json = JSON.parse(text) } catch { json = { message: text } }
    if (!res.ok) return { ok: false, status: res.status, error: json?.error || json?.message || `HTTP ${res.status}`, data: json }
    return { ok: true, status: res.status, data: json }
  } catch (e: any) {
    return { ok: false, status: 0, error: String(e.message || e) }
  }
}

export async function apiBlob(
  method: string,
  path: string,
): Promise<Response | null> {
  const config = useConfigStore()
  const headers: Record<string, string> = {}
  const token = config.config.token
  if (token) headers['Authorization'] = `Bearer ${token}`
  const csrf = await getCsrfToken()
  if (csrf) headers['X-CSRF-Token'] = csrf
  try {
    return await fetch(`${config.serverUrl}${path}`, {
      method, headers, credentials: 'include',
    })
  } catch {
    return null
  }
}
