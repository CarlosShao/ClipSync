import { api } from './client'

export interface ServerClipItem {
  id: string
  type: string
  content: string
  preview?: string
  sourceDevice?: { name: string }
  deviceName?: string
  createdAt: string
}

export function fetchClips() {
  return api<{ items: ServerClipItem[] }>('GET', '/api/clipboard')
}

export function uploadClip(content: string, type: string, preview?: string) {
  return api('POST', '/api/clipboard', { content, type, preview: preview || content.slice(0, 5000) })
}

export function deleteClips(ids: string[]) {
  return api('DELETE', '/api/clipboard', { ids })
}

export function deleteClip(id: string) {
  return api(`/api/clipboard/${id}`, 'DELETE')
}

// 归档/取消归档：复用后端 PUT /api/clipboard/:id 的 archived 字段
export function setArchive(id: string, archived: boolean) {
  return api('PUT', `/api/clipboard/${id}`, { archived })
}

/** Get clipboard item content only (lightweight, for preview) */
export async function getClipboardItemContent(id: string): Promise<string | null> {
  const res = await api<{ contentEncrypted: string }>('GET', `/api/clipboard/${id}/content`)
  return res.ok ? res.data?.contentEncrypted || null : null
}

export interface FrequentItem {
  id: string
  contentType: string
  contentPreview: string
  contentSize: number
  createdAt: string
  usageCount: number
  lastUsedAt: string | null
}

/** 记录用户粘贴了某条（用于预测粘贴的智能建议）。失败静默，不阻断复制。 */
export function recordUse(id: string) {
  return api('POST', `/api/clipboard/${id}/use`)
}

/** 拉取按使用频率衰减加权排序的「热门」条目，作为智能建议候选。 */
export function fetchFrequent(limit = 3) {
  return api<{ items: FrequentItem[] }>('GET', `/api/clipboard/frequent?limit=${limit}`)
}
