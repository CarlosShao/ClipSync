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
  return api('POST', '/api/clipboard', { content, type, preview: preview || content.slice(0, 200) })
}

export function deleteClips(ids: string[]) {
  return api('DELETE', '/api/clipboard', { ids })
}

export function deleteClip(id: string) {
  return api(`/api/clipboard/${id}`, 'DELETE')
}
