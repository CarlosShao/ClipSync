import { useConfigStore } from '@/stores/configStore'
import { useSonner } from '@/composables/useSonner'

const CSRF_STORAGE_KEY = 'clipsync-csrf'
let csrfToken: string | null = null
let csrfExpiresAt = 0

// 持久化 CSRF token 到 localStorage，跨整页跳转 / 应用重启保持热状态。
// 否则每次登录后 window.location.href 整页跳转会重置模块缓存，首张截图必须
// 多付一次 GET /api/csrf-token 冷往返（叠加服务冷启动 ≈ 4s，见 client.ts 旧注释"之前 4.5s"）。
function loadCsrfFromStorage() {
  try {
    const raw = localStorage.getItem(CSRF_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { token: string; exp: number }
    if (parsed.token && Date.now() < parsed.exp) {
      csrfToken = parsed.token
      csrfExpiresAt = parsed.exp
    }
  } catch (e) {
    console.warn('[API] CSRF cache load failed:', e)
  }
}
loadCsrfFromStorage()

// 生成幂等键（C3 修复）：写请求携带 Idempotency-Key，网络重试复用同一把键，
// 服务端据此去重，避免重复创建剪贴板条目/上传重复文件。
function genIdempotencyKey(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }
}

export async function getCsrfToken(): Promise<string | null> {
  if (csrfToken && Date.now() < csrfExpiresAt) return csrfToken
  // 未登录时跳过 CSRF（登录/注册/忘记密码不需要）
  const config = useConfigStore()
  if (!config.config.token) return null
  try {
    const res = await fetch(`${config.serverUrl}/api/csrf-token`, {
      credentials: 'include',
      headers: { Authorization: `Bearer ${config.config.token}` },
    })
    const data = await res.json()
    csrfToken = data.token || null
    csrfExpiresAt = Date.now() + 300_000 // 缓存 5 分钟，减少 ~50% 的请求量（之前 4.5s）
    if (csrfToken) {
      try {
        localStorage.setItem(CSRF_STORAGE_KEY, JSON.stringify({ token: csrfToken, exp: csrfExpiresAt }))
      } catch (e) {
        console.warn('[API] CSRF cache persist failed:', e)
      }
    }
    return csrfToken
  } catch (e) {
    console.warn('[API] CSRF token fetch failed:', e)
    return null
  }
}

/** Warm up the CSRF token after login so the first clipboard sync doesn't pay a cold round-trip. */
export async function prefetchCsrf(): Promise<void> {
  await getCsrfToken()
}

export interface ApiResponse<T = any> {
  ok: boolean
  data?: T
  error?: string
  status: number
  /** 429 限流时后端 Retry-After 头解析出的剩余秒数（真实限流结束时间） */
  retryAfter?: number
}

// ============================================
// 会话刷新（旋转式 refresh token）+ 401 统一出口
// ============================================

const REFRESH_KEY = 'clipsync-refresh-token'

/** 登录/配对成功后持久化 refresh token；登出/失效时传 null 清除 */
export function storeRefreshToken(rt: string | null | undefined) {
  try {
    if (rt) localStorage.setItem(REFRESH_KEY, rt)
    else localStorage.removeItem(REFRESH_KEY)
  } catch {
    /* ignore */
  }
}

function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY)
  } catch {
    return null
  }
}

// 匿名鉴权端点：401 不触发刷新/登出（登录/注册/配对失败属正常业务错误）
const ANON_AUTH_PREFIXES = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/send-code',
  '/api/auth/refresh',
  '/api/auth/set-password',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/verify',
  '/api/auth/2fa/verify-login',
  '/api/devices/pairing',
]
function isAnonAuthPath(p: string): boolean {
  return ANON_AUTH_PREFIXES.some((x) => p.startsWith(x))
}

// 单飞：并发 401 只发起一次刷新，其余请求共享同一 promise
let refreshInflight: Promise<string | null> | null = null

export async function refreshAccessToken(): Promise<string | null> {
  if (refreshInflight) return refreshInflight
  refreshInflight = (async () => {
    const config = useConfigStore()
    const rt = getRefreshToken()
    if (!rt || !config.config.token) return null
    try {
      const res = await fetch(`${config.serverUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
        credentials: 'include',
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return null
      const data = await res.json()
      if (!data?.token) return null
      config.config.token = data.token
      localStorage.setItem('clipsync-token', data.token)
      storeRefreshToken(data.refreshToken || null)
      return data.token as string
    } catch {
      return null
    }
  })()
  try {
    return await refreshInflight
  } finally {
    refreshInflight = null
  }
}

// 会话彻底失效：清全部凭证 + 广播事件（router 监听后跳 /auth）
function forceLogout() {
  try {
    localStorage.removeItem('clipsync-token')
    localStorage.removeItem(REFRESH_KEY)
    localStorage.removeItem(CSRF_STORAGE_KEY)
  } catch {
    /* ignore */
  }
  csrfToken = null
  csrfExpiresAt = 0
  try {
    const config = useConfigStore()
    config.config.token = null
  } catch {
    /* store 未初始化则忽略 */
  }
  try {
    window.dispatchEvent(new CustomEvent('clipsync:auth-expired'))
  } catch {
    /* ignore */
  }
}

export async function api<T = any>(method: string, path: string, body?: any): Promise<ApiResponse<T>> {
  const config = useConfigStore()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  const csrf = await getCsrfToken()
  if (csrf) headers['X-CSRF-Token'] = csrf
  // 写请求附加幂等键，并在重试中复用同一把键（C3）
  const idemKey = genIdempotencyKey()
  if (method === 'POST' || method === 'PUT') headers['Idempotency-Key'] = idemKey

  // 429 指数退避重试： capped delay to avoid 30s+ waits
  const MAX_RETRIES = 2
  const BASE_DELAYS = [1000, 2000] // ms
  const MAX_RETRY_DELAY = 5000 // cap at 5 seconds
  let lastRetryAfter: number | undefined
  // 防抖：同一限流窗口内只弹一次倒计时 toast（多个并发请求共享）
  let rateLimitToastShown = false
  // 401 静默刷新只尝试一次，防止 refresh 成功但重试仍 401 时无限循环
  let authRetried = false
  // 请求超时：后端悬挂/断网时 30s 强制中止，避免 UI loading 态永久挂起
  const REQUEST_TIMEOUT_MS = 30_000

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Authorization 每轮重建：401 刷新后 config.config.token 已更新，重试必须带新 token
    const token = config.config.token
    if (token) headers['Authorization'] = `Bearer ${token}`

    try {
      const res = await fetch(`${config.serverUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'include',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = res.headers.get('Retry-After')
        const retryAfterSec = retryAfter ? parseInt(retryAfter, 10) : undefined
        if (retryAfterSec && retryAfterSec > 0) lastRetryAfter = retryAfterSec
        const serverDelay = retryAfter ? parseInt(retryAfter) * 1000 : BASE_DELAYS[attempt]
        const delay = Math.min(serverDelay, MAX_RETRY_DELAY)
        console.warn(
          `[API] 429 on ${method} ${path} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying after ${delay}ms`,
        )
        // 第一次 429 就立即弹倒计时 toast，不等重试耗尽
        if (!rateLimitToastShown && retryAfterSec && retryAfterSec > 0) {
          rateLimitToastShown = true
          useSonner().rateLimited(retryAfterSec)
        }
        await new Promise((r) => setTimeout(r, delay))
        continue
      }

      const text = await res.text()
      let json: any
      try {
        json = JSON.parse(text)
      } catch {
        json = { message: text }
      }

      if (res.status === 401) {
        // 匿名端点（登录/注册/配对）401 属业务错误，不触发刷新/登出
        if (!isAnonAuthPath(path)) {
          if (!authRetried) {
            authRetried = true
            const newToken = await refreshAccessToken()
            if (newToken) continue // 带新 token 重试原请求
          }
          forceLogout()
        }
        return {
          ok: false,
          status: 401,
          error: json?.error || json?.message || 'Session expired',
          data: json,
        }
      }

      if (!res.ok)
        return {
          ok: false,
          status: res.status,
          error: json?.error || json?.message || `HTTP ${res.status}`,
          data: json,
        }
      return { ok: true, status: res.status, data: json }
    } catch (e: any) {
      // 网络错误不重试（非 429）；超时/断网归入 status 0
      return { ok: false, status: 0, error: String(e.message || e) }
    }
  }

  // 重试耗尽（429 仍受限）
  return { ok: false, status: 429, error: 'Too many requests after retries, please wait and try again.', retryAfter: lastRetryAfter }
}

/**
 * 二进制响应请求（图片/文件预览）。与 api() 共用同一套鉴权与 CSRF 头，
 * 但返回原始 Response 以便调用方取 blob。
 * 关键：/api/media 等路由挂了 csrfProtection，裸 fetch 只带 Bearer 会被拒 → 图片 404。
 */
/**
 * FormData 上传请求（multipart/form-data）。Content-Type 由浏览器自动设置（含 boundary）。
 */
export async function apiForm<T = any>(path: string, formData: FormData): Promise<ApiResponse<T>> {
  const config = useConfigStore()
  const idemKey = genIdempotencyKey()
  const MAX_RETRIES = 2
  const BASE_DELAYS = [1000, 2000]
  const MAX_RETRY_DELAY = 5000
  // 401 刷新只尝试一次
  let authRetried = false

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const headers: Record<string, string> = {}
    // 注意：不设置 Content-Type，让浏览器自动设置 multipart boundary
    const token = config.config.token
    if (token) headers['Authorization'] = `Bearer ${token}`
    const csrf = await getCsrfToken()
    if (csrf) headers['X-CSRF-Token'] = csrf
    // 写请求幂等键：重试复用同一把键，服务端据此去重（C3）
    headers['Idempotency-Key'] = idemKey
    try {
      const res = await fetch(`${config.serverUrl}${path}`, {
        method: 'POST',
        headers,
        body: formData,
        credentials: 'include',
        // 上传耗时远高于普通请求（大图片压缩后 multipart），放宽到 10 分钟
        signal: AbortSignal.timeout(600_000),
      })
      const text = await res.text()
      let json: any
      try {
        json = JSON.parse(text)
      } catch {
        json = { message: text }
      }
      // 429 退避重试（复用同一幂等键）
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = res.headers.get('Retry-After')
        const delay = Math.min(retryAfter ? parseInt(retryAfter) * 1000 : BASE_DELAYS[attempt], MAX_RETRY_DELAY)
        console.warn(`[API] 429 on ${path} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying after ${delay}ms`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      // 401：静默刷新一次后重试；失败则强制登出
      if (res.status === 401) {
        if (!isAnonAuthPath(path)) {
          if (!authRetried) {
            authRetried = true
            const newToken = await refreshAccessToken()
            if (newToken) continue
          }
          forceLogout()
        }
        return { ok: false, status: 401, error: json?.error || 'Session expired', data: json }
      }
      if (!res.ok)
        return {
          ok: false,
          status: res.status,
          error: json?.error || json?.message || `HTTP ${res.status}`,
          data: json,
        }
      return { ok: true, status: res.status, data: json }
    } catch (e: any) {
      // 网络层错误才重试；否则直接返回失败
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, BASE_DELAYS[attempt]))
        continue
      }
      return { ok: false, status: 0, error: String(e.message || e) }
    }
  }
  return { ok: false, status: 429, error: 'Upload failed after retries, please try again.' }
}

// 单次 blob 拉取（内部）：供 apiBlob 的 401 重试复用
async function fetchBlob(method: string, path: string, timeoutMs: number): Promise<Response | null> {
  const config = useConfigStore()
  const headers: Record<string, string> = {}
  const token = config.config.token
  if (token) headers['Authorization'] = `Bearer ${token}`
  const csrf = await getCsrfToken()
  if (csrf) headers['X-CSRF-Token'] = csrf
  try {
    return await fetch(`${config.serverUrl}${path}`, {
      method,
      headers,
      credentials: 'include',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    console.warn('[API] blob fetch failed:', e)
    return null
  }
}

export async function apiBlob(method: string, path: string): Promise<Response | null> {
  let res = await fetchBlob(method, path, 60_000)
  // 401：静默刷新一次后重试；刷新失败（含已登出）直接返回原响应/空
  if (res && res.status === 401 && !isAnonAuthPath(path)) {
    const newToken = await refreshAccessToken()
    if (newToken) {
      res = await fetchBlob(method, path, 60_000)
    } else {
      forceLogout()
    }
  }
  return res
}

// ============================================
// 业务域 API（已拆分至独立文件，此处 re-export 保持既有 import 兼容）
// ============================================
export {
  getFavoriteCollections,
  migrateHierarchy,
  createFavoriteCollection,
  updateFavoriteCollection,
  deleteFavoriteCollection,
  moveCollection,
  reorderCollections,
  addCollectionItem,
  removeCollectionItem,
  getCollectionItems,
  setItemTags,
  deleteTag,
  getAllFavoriteTags,
  toggleSensitive,
} from './favorites'
export type { FavoriteTag } from './favorites'

export {
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getTemplateVariables,
  upsertTemplateVariable,
  deleteTemplateVariable,
} from './templates'

export { getSharedLinks, uploadSharedFile, createSharedLink, deleteSharedLink } from './sharedLinks'
export type { SharedLink, SharedFileUploadResult } from './sharedLinks'

export { sendPinResetCode, sendPinResetEmailCode, resetPinViaCode } from './auth'

export { getClipboardItemContent } from './clipboard'
