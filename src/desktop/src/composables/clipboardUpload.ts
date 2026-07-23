// === 剪贴板上传（文本 / 图片 / 文件）与离线兜底 ===
import { api } from '@/api/client'
import * as tauri from '@/lib/tauri'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { enqueue } from '@/utils/offlineQueue'
import { logger } from '@/utils/logger'
import { items, recentUploadHashes, HASH_TTL, type ClipItem } from './clipboardState'
import { cacheContent } from './clipboardCache'

const { t } = useI18n()
const toast = useSonner()

export function simpleHash(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i)
    hash |= 0
  }
  return hash.toString(36)
}

/** Try API call; on network failure, enqueue for later sync. */
export async function apiOrEnqueue(
  method: string,
  path: string,
  body: any,
  offlineType: 'create' | 'delete',
  offlinePayload: any,
) {
  try {
    const res = await api(method, path, body)
    if (res.ok) return res
    // Non-network error (4xx/5xx) — don't enqueue, just return failure
    return res
  } catch (e: any) {
    const msg = String(e?.message || e)
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('offline')) {
      console.warn(`[Clipboard] Network unavailable, enqueueing ${offlineType}`)
      enqueue({ type: offlineType, payload: offlinePayload })
    }
    return { ok: false, status: 0, error: msg }
  }
}

/** Resize image if longest edge exceeds maxPx. Returns original dataUrl if already small enough. */
export function resizeImageIfNeeded(dataUrl: string, maxPx = 1080): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      const longest = Math.max(w, h)
      if (longest <= maxPx) {
        resolve(dataUrl)
        return
      }
      const scale = maxPx / longest
      const nw = Math.round(w * scale)
      const nh = Math.round(h * scale)
      const canvas = document.createElement('canvas')
      canvas.width = nw
      canvas.height = nh
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(dataUrl)
        return
      }
      ctx.drawImage(img, 0, 0, nw, nh)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

// 文本同步大小上限：比后端 express.json 的 10MB 小 1MB 留余量，避免 413 Payload Too Large
const MAX_TEXT_UPLOAD_SIZE = 9 * 1024 * 1024

export async function uploadToServer(content: string, type: ClipItem['type'] = 'text') {
  const hash = simpleHash(content)
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) return
  recentUploadHashes.set(hash, Date.now())

  // 超大文本提前拒绝，避免卡主线程 + 413 异常被闷掉
  if (content.length > MAX_TEXT_UPLOAD_SIZE) {
    console.warn('[Clipboard] text too large, skipping upload:', content.length)
    toast.show(t('text_too_large', { n: Math.round(MAX_TEXT_UPLOAD_SIZE / 1024 / 1024) }), 'warning')
    return
  }

  // 立即添加到本地列表（乐观更新）
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  items.value.unshift({ id: localId, type, content, source: 'Desktop', timestamp: Date.now(), selected: false })
  // 获取设备ID
  let deviceId = localStorage.getItem('clipsync-device-id')
  if (!deviceId) {
    try {
      const devRes = await api('GET', '/api/devices')
      const devList = devRes.data?.devices || devRes.data
      if (devRes.ok && Array.isArray(devList) && devList.length > 0) {
        deviceId = devList[0].id || devList[0].device_id
        localStorage.setItem('clipsync-device-id', deviceId!)
      }
    } catch {
      /* ignore */
    }
  }
  if (!deviceId) return
  const uploadPayload = {
    content,
    contentEncrypted: content,
    sourceDeviceId: deviceId,
    contentType: type,
    contentPreview: content.slice(0, 5000),
    contentSize: content.length,
  }
  try {
    const res = await apiOrEnqueue('POST', '/api/clipboard', uploadPayload, 'create', uploadPayload)
    // 上传成功后：用服务器返回的 id 替换本地临时 id，并缓存内容
    if (res.ok && res.data?.id) {
      const localItem = items.value.find((i) => i.id === localId)
      if (localItem) {
        localItem.id = res.data.id
        cacheContent(res.data.id, content)
      }
      return
    }
    // 上传失败：从本地列表移除乐观项，避免残留脏数据
    items.value = items.value.filter((i) => i.id !== localId)
    if (res.status === 413) {
      toast.show(t('text_too_large', { n: Math.round(MAX_TEXT_UPLOAD_SIZE / 1024 / 1024) }), 'warning')
    } else {
      toast.show(t('text_upload_failed') + (res.error ? `: ${res.error}` : ''), 'error')
    }
  } catch (e: any) {
    // 网络/未知异常：同样移除乐观项并提示
    items.value = items.value.filter((i) => i.id !== localId)
    toast.show(t('text_upload_failed') + (e?.message ? `: ${e.message}` : ''), 'error')
  }
}

export async function uploadImageToServer(dataUrl: string, contentHash?: string) {
  // Dedup by FULL-CONTENT hash, NOT a 200-char prefix. Two screenshots of the same
  // window have identical PNG file headers and identical first compressed bytes, so a
  // prefix key collides and silently drops every subsequent screenshot within 30s.
  // Prefer the Rust FNV content hash (passed through from the clipboard monitor);
  // fall back to a full string hash when it is unavailable.
  const dedupKey = contentHash && contentHash.length > 0 ? contentHash : simpleHash(dataUrl)
  if (recentUploadHashes.has(dedupKey) && Date.now() - (recentUploadHashes.get(dedupKey) || 0) < HASH_TTL) return
  recentUploadHashes.set(dedupKey, Date.now())
  // Resize large images (>1080p) before upload to save bandwidth
  const resized = await resizeImageIfNeeded(dataUrl)
  const base64 = resized.split(',')[1]
  // 乐观更新
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  items.value.unshift({
    id: localId,
    type: 'image',
    content: resized,
    preview: resized,
    source: 'Desktop',
    timestamp: Date.now(),
    selected: false,
  })
  const deviceId = localStorage.getItem('clipsync-device-id')
  if (!deviceId) return
  const uploadPayload = {
    contentType: 'image',
    contentEncrypted: resized,
    sourceDeviceId: deviceId,
    mimeType: 'image/png',
    size: base64?.length || 0,
    contentPreview: `[Image ${base64?.length || 0} bytes]`,
  }
  const res = await apiOrEnqueue('POST', '/api/clipboard', uploadPayload, 'create', uploadPayload)
  if (res.ok && res.data?.id) {
    const localItem = items.value.find((i) => i.id === localId)
    if (localItem) {
      localItem.id = res.data.id
      cacheContent(res.data.id, dataUrl)
    }
  }
}

export async function uploadFileToServer(payload: string) {
  const hash = simpleHash(payload)
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) {
    logger.debug('[Clipboard] uploadFileToServer: skip duplicate hash', hash)
    return
  }
  recentUploadHashes.set(hash, Date.now())

  // Parse file paths from payload
  let filePaths: string[]
  try {
    filePaths = JSON.parse(payload)
  } catch {
    filePaths = [payload]
  }

  // Try to read actual file content via Tauri (for preview support)
  let fileContent = payload // fallback: store path array
  let fileName = filePaths[0] || 'Unknown'
  try {
    const name = filePaths[0].split(/[/\\]/).pop() || filePaths[0]
    fileName = name
    const content = await tauri.readFileContent(filePaths[0])
    if (content && content.length > 0) {
      fileContent = content
    }
  } catch {
    /* file not readable (binary, permission, etc.) — keep path array */
  }

  // 乐观更新
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  items.value.unshift({
    id: localId,
    type: 'file',
    content: JSON.stringify({
      name: fileName,
      size: `${(fileContent.length / 1024).toFixed(1)} KB`,
      type: 'text/plain',
    }),
    source: 'Desktop',
    timestamp: Date.now(),
    selected: false,
  })

  const deviceId = localStorage.getItem('clipsync-device-id')
  if (!deviceId) return
  const uploadPayload = {
    contentType: 'file',
    content: JSON.stringify({ name: fileName, paths: filePaths }),
    contentEncrypted: fileContent,
    sourceDeviceId: deviceId,
    contentPreview: fileName,
    metadata: { paths: filePaths, originalName: fileName },
  }
  const res = await apiOrEnqueue('POST', '/api/clipboard', uploadPayload, 'create', uploadPayload)
  if (res.ok && res.data?.id) {
    const localItem = items.value.find((i) => i.id === localId)
    if (localItem) {
      if (res.data.duplicate) {
        // 后端判定为重复条目：直接移除本地乐观项，避免 UI 出现两条同名记录
        logger.debug('[Clipboard] server reported duplicate, removing optimistic local item')
        items.value = items.value.filter((i) => i.id !== localId)
      } else {
        localItem.id = res.data.id
        // Update content to include paths field (for hasLocalPath detection)
        localItem.content = JSON.stringify({ name: fileName, paths: filePaths })
        cacheContent(res.data.id, fileContent)
      }
    }
  }
}
