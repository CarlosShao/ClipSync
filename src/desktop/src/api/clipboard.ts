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
