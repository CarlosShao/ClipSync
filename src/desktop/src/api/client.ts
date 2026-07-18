import { ref } from 'vue'
import { useConfigStore } from '@/stores/configStore'

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
  } catch { /* ignore */ }
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
    if (csrfToken) {
      try { localStorage.setItem(CSRF_STORAGE_KEY, JSON.stringify({ token: csrfToken, exp: csrfExpiresAt })) } catch { /* ignore */ }
    }
    return csrfToken
  } catch { return null }
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
  // 写请求附加幂等键，并在重试中复用同一把键（C3）
  const idemKey = genIdempotencyKey()
  if (method === 'POST' || method === 'PUT') headers['Idempotency-Key'] = idemKey

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
  const idemKey = genIdempotencyKey()
  const MAX_RETRIES = 2
  const BASE_DELAYS = [1000, 2000]
  const MAX_RETRY_DELAY = 5000

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
        method: 'POST', headers, body: formData, credentials: 'include',
      })
      const text = await res.text()
      let json: any
      try { json = JSON.parse(text) } catch { json = { message: text } }
      // 429 退避重试（复用同一幂等键）
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = res.headers.get('Retry-After')
        const delay = Math.min(retryAfter ? parseInt(retryAfter) * 1000 : BASE_DELAYS[attempt], MAX_RETRY_DELAY)
        console.warn(`[API] 429 on ${path} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying after ${delay}ms`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (!res.ok) return { ok: false, status: res.status, error: json?.error || json?.message || `HTTP ${res.status}`, data: json }
      return { ok: true, status: res.status, data: json }
    } catch (e: any) {
      // 网络层错误才重试；否则直接返回失败
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, BASE_DELAYS[attempt]))
        continue
      }
      return { ok: false, status: 0, error: String(e.message || e) }
    }
  }
  return { ok: false, status: 429, error: 'Upload failed after retries, please try again.' }
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

// ============================================
// Favorites API
// ============================================

export async function getFavoriteCollections(): Promise<{ collections: any[] } | null> {
  const res = await api('GET', '/api/favorites/collections')
  return res.ok ? res.data : null
}

/** Run ltree hierarchy migration on the database (idempotent). */
export async function migrateHierarchy(): Promise<boolean> {
  const res = await api('POST', '/api/favorites/migrate-hierarchy')
  return res.ok
}

export async function createFavoriteCollection(name: string, icon?: string, parentId?: string): Promise<{ collection: any } | null> {
  const body: any = { name, icon }
  if (parentId) body.parentId = parentId
  const res = await api('POST', '/api/favorites/collections', body)
  return res.ok ? res.data : null
}

export async function updateFavoriteCollection(id: string, data: { name?: string; icon?: string; sortOrder?: number }): Promise<{ collection: any } | null> {
  const res = await api('PUT', `/api/favorites/collections/${id}`, data)
  return res.ok ? res.data : null
}

export async function deleteFavoriteCollection(id: string): Promise<boolean> {
  const res = await api('DELETE', `/api/favorites/collections/${id}`)
  return res.ok
}

export async function moveCollection(id: string, parentId: string | null): Promise<{ collection: any } | null> {
  const res = await api('PUT', `/api/favorites/collections/${id}/move`, { parentId })
  return res.ok ? res.data : null
}

export async function reorderCollections(orders: { id: string; sortOrder: number }[]): Promise<boolean> {
  const res = await api('PUT', '/api/favorites/collections/reorder', { orders })
  return res.ok
}

export async function addCollectionItem(collectionId: string, itemId: string): Promise<boolean> {
  const res = await api('POST', `/api/favorites/collections/${collectionId}/items`, { itemId })
  return res.ok
}

export async function removeCollectionItem(collectionId: string, itemId: string): Promise<boolean> {
  const res = await api('DELETE', `/api/favorites/collections/${collectionId}/items/${itemId}`)
  return res.ok
}

export async function getCollectionItems(collectionId: string): Promise<{ items: any[] } | null> {
  const res = await api('GET', `/api/favorites/collections/${collectionId}/items`)
  return res.ok ? res.data : null
}

export async function setItemTags(itemId: string, tags: string[], tagColors?: Record<string, string>): Promise<{ tags: string[]; tagColors: Record<string, string> } | null> {
  const body: any = { tags }
  if (tagColors) body.tagColors = tagColors
  const res = await api('PUT', `/api/favorites/${itemId}/tags`, body)
  return res.ok ? res.data : null
}

export async function deleteTag(tagName: string): Promise<boolean> {
  const res = await api('DELETE', `/api/favorites/tags/${encodeURIComponent(tagName)}`)
  return res.ok
}

export interface FavoriteTag {
  name: string
  color: string | null
}
export async function getAllFavoriteTags(): Promise<FavoriteTag[]> {
  const res = await api('GET', '/api/favorites/tags')
  return res.ok ? (res.data?.tags || []) : []
}

/** Toggle manual sensitive flag on a clipboard item */
export async function toggleSensitive(itemId: string, sensitive: boolean): Promise<{ id: string; sensitive: boolean } | null> {
  const res = await api('PUT', `/api/clipboard/${itemId}/sensitive`, { sensitive })
  return res.ok ? res.data : null
}

// ============================================
// Templates API（模板库，变量解析在前端完成）
// ============================================

export async function getTemplates(): Promise<{ data: any[] } | null> {
  const res = await api('GET', '/api/templates')
  return res.ok ? res.data : null
}

export async function createTemplate(name: string, content: string): Promise<any | null> {
  const res = await api('POST', '/api/templates', { name, content })
  return res.ok ? res.data : null
}

export async function updateTemplate(id: string, data: { name?: string; content?: string }): Promise<any | null> {
  const res = await api('PUT', `/api/templates/${id}`, data)
  return res.ok ? res.data : null
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const res = await api('DELETE', `/api/templates/${id}`)
  return res.ok
}

// ============================================
// Template Variables API（全局变量默认值，后端按用户隔离存储）
// ============================================

export async function getTemplateVariables(): Promise<{ data: any[] } | null> {
  const res = await api('GET', '/api/template-variables')
  return res.ok ? res.data : null
}

export async function upsertTemplateVariable(name: string, value: string): Promise<any | null> {
  const res = await api('PUT', '/api/template-variables', { name, value })
  return res.ok ? res.data : null
}

export async function deleteTemplateVariable(name: string): Promise<boolean> {
  const res = await api('DELETE', `/api/template-variables/${encodeURIComponent(name)}`)
  return res.ok
}

// ============================================
// Shared Links API（剪贴板内容对外分享链接）
// ============================================

// 公开分享链接的基础域名（可由构建期环境变量覆盖）
export const SHARE_LINK_BASE: string =
  (import.meta.env.VITE_SHARE_BASE_URL as string | undefined) || 'https://clipsync.io/s/'

export interface SharedLink {
  id: string
  title: string
  url: string
  contentType?: string
  preview?: string
  views: number
  createdAt: string
  expiresAt?: string | null
}

export async function getSharedLinks(): Promise<SharedLink[] | null> {
  const res = await api<{ links: SharedLink[] }>('GET', '/api/shared-links')
  return res.ok ? res.data?.links ?? [] : null
}

export async function createSharedLink(payload: {
  content: string
  title?: string
  contentType?: string
  expiresInHours?: number
}): Promise<SharedLink | null> {
  const res = await api<SharedLink>('POST', '/api/shared-links', payload)
  return res.ok ? (res.data ?? null) : null
}

export async function deleteSharedLink(id: string): Promise<boolean> {
  const res = await api('DELETE', `/api/shared-links/${id}`)
  return res.ok
}

/** Send PIN reset verification code (phone) */
export async function sendPinResetCode(phone: string): Promise<boolean> {
  const res = await api('POST', '/api/auth/send-reset-pin-code', { phone })
  return res.ok
}

/** Send PIN reset verification code (email) */
export async function sendPinResetEmailCode(email: string): Promise<boolean> {
  const res = await api('POST', '/api/auth/send-reset-pin-email-code', { email })
  return res.ok
}

/** Verify code and reset PIN (backend validates identity, frontend stores new PIN) */
export async function resetPinViaCode(phoneOrEmail: string, code: string, method: 'phone' | 'email'): Promise<boolean> {
  const body: any = { code }
  if (method === 'phone') body.phone = phoneOrEmail
  else body.email = phoneOrEmail
  const res = await api('POST', '/api/auth/reset-pin', body)
  return res.ok
}

/** Get clipboard item content only (lightweight, for preview) */
export async function getClipboardItemContent(id: string): Promise<string | null> {
  const res = await api<{ contentEncrypted: string }>('GET', `/api/clipboard/${id}/content`)
  return res.ok ? (res.data?.contentEncrypted || null) : null
}
