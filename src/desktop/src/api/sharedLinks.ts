// ============================================
// Shared Links API（剪贴板内容对外分享链接）
// 注意：分享 URL 由后端根据请求 origin 或 SHARE_LINK_BASE_URL 环境变量生成，
// 前端不要自己拼域名，避免本地开发时指向错误的 clipsync.io。
// ============================================
import { api } from './client'
import { useConfigStore } from '@/stores/configStore'

export interface SharedLink {
  id: string
  title: string
  url: string
  contentType?: string
  fileName?: string
  fileSize?: number
  preview?: string
  views: number
  createdAt: string
  expiresAt?: string | null
}

export interface SharedFileUploadResult {
  fileKey: string
  fileName: string
  fileSize: number
}

export async function getSharedLinks(): Promise<SharedLink[] | null> {
  const res = await api<{ links: SharedLink[] }>('GET', '/api/shared-links')
  return res.ok ? res.data?.links ?? [] : null
}

export async function uploadSharedFile(
  file: File,
): Promise<{ ok: true; fileKey: string; fileName: string; fileSize: number } | { ok: false; error: string }> {
  const config = useConfigStore()
  const formData = new FormData()
  formData.append('file', file)
  const headers: Record<string, string> = {}
  const token = config.config.token
  if (token) headers['Authorization'] = `Bearer ${token}`
  try {
    const res = await fetch(`${config.serverUrl}/api/shared-links/upload-file`, {
      method: 'POST',
      body: formData,
      headers,
    })
    if (!res.ok) {
      let errorText = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as { error?: string; message?: string }
        if (body?.error || body?.message) errorText = body.error || body.message || errorText
      } catch { /* response body not JSON */ }
      return { ok: false, error: errorText }
    }
    const data = (await res.json()) as SharedFileUploadResult
    return { ok: true, ...data }
  } catch (e: any) {
    console.warn('[client] upload shared file failed', e?.message || e)
    return { ok: false, error: e?.message || 'network error' }
  }
}

export async function createSharedLink(payload: {
  content: string
  title?: string
  contentType?: string
  expiresInHours?: number
  fileKey?: string
  fileName?: string
  fileSize?: number
}): Promise<SharedLink | null> {
  const res = await api<SharedLink>('POST', '/api/shared-links', payload)
  return res.ok ? (res.data ?? null) : null
}

export async function deleteSharedLink(id: string): Promise<boolean> {
  const res = await api('DELETE', `/api/shared-links/${id}`)
  return res.ok
}
