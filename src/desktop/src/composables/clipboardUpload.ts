// === 剪贴板上传（文本 / 图片 / 文件）与离线兜底 ===
import { api } from '@/api/client'
import * as tauri from '@/lib/tauri'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { enqueue } from '@/utils/offlineQueue'
import { logger } from '@/utils/logger'
import { items, recentUploadHashes, HASH_TTL, totalItems, mainTotalItems, currentView, type ClipItem } from './clipboardState'
import { cacheContent } from './clipboardCache'
import { trimToMaxHistory } from './clipboardLoad'
import { useConfigStore } from '@/stores/configStore'

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

import { sha256DataUrl as computeDataUrlSha256 } from '@/utils/hash'

/**
 * SHA-256 hex of the *decoded bytes* of a data URL. Used as the canonical
 * image dedup key so it matches the same image pasted into the AI chat.
 * We hash the ORIGINAL data URL, not the resized upload payload.
 */
export async function sha256DataUrl(dataUrl: string): Promise<string | null> {
  try {
    const hash = await computeDataUrlSha256(dataUrl)
    return hash || null
  } catch (e) {
    console.warn('[clipboardUpload] sha256DataUrl failed', e)
    return null
  }
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
    // status === 0 表示 fetch 抛错（断网 / CORS / DNS 失败），需要入队离线同步。
    // 4xx/5xx 属于服务端业务错误，不入队。
    if (res.status === 0) {
      const msg = String(res.error || 'network error')
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('offline')) {
        console.warn(`[Clipboard] Network unavailable, enqueueing ${offlineType}`)
        enqueue({ type: offlineType, payload: offlinePayload })
      }
    }
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

/** 读取 data URL 的 MIME（用于上传 payload 的 mimeType，避免压缩后类型与声明不符）。 */
export function dataUrlMime(dataUrl: string, fallback = 'image/png'): string {
  const m = /^data:([^;,]+)/.exec(dataUrl || '')
  return m ? m[1] : fallback
}

/** 图片压缩开关（configStore.imageCompress）。只在调用时才取 store，避免模块级循环依赖。 */
function imageCompressEnabled(): boolean {
  try {
    return useConfigStore().imageCompress === true
  } catch {
    return false
  }
}

/**
 * 上传前的图片预处理，消费「图片压缩」设置（B8③）：
 * - 开：等比缩到最长边 1080 后以 webp/0.8 重编码（保留 alpha，体积显著下降）
 * - 关：仅在超尺寸时等比缩放，不重编码（保持原始编码与画质）
 * 注意：返回的 data URL 只用于上传；imageHash 仍按**原始**字节计算，
 * 保证服务端去重与「同一张图粘贴进 AI 聊天」的哈希一致。
 */
export async function prepareImageForUpload(dataUrl: string, maxPx = 1080): Promise<string> {
  const resized = await resizeImageIfNeeded(dataUrl, maxPx)
  if (!imageCompressEnabled()) return resized
  try {
    const quality = 0.8
    const compressed = await reencodeDataUrl(resized, 'image/webp', quality)
    // 极端情况下（编码失败 / 压缩后反而更大）退回缩放结果，绝不上传坏图
    if (!compressed || compressed.length > resized.length) return resized
    return compressed
  } catch {
    return resized
  }
}

function reencodeDataUrl(dataUrl: string, mime: string, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('canvas unavailable'))
          return
        }
        ctx.drawImage(img, 0, 0)
        resolve(canvas.toDataURL(mime, quality))
      } catch (e) {
        reject(e)
      }
    }
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = dataUrl
  })
}

// 文本同步大小上限：比后端 express.json 的 10MB 小 1MB 留余量，避免 413 Payload Too Large
const MAX_TEXT_UPLOAD_SIZE = 9 * 1024 * 1024

// 富文本捕获（Windows "HTML Format"）上限：html 超 2MB 时丢弃只留纯文本，
// 防止 metadata.html 拖垮请求体（后端 express.json 10MB 上限）与 DB 行体积。
const CAPTURED_HTML_LIMIT = 2 * 1024 * 1024

// 跨设备文件字节上限（决策 D3）：5MB 原文件 ≈ 6.7MB base64，
// 仍在后端 express.json / contentEncrypted 的 10MB 上限内。
export const FILE_BYTES_UPLOAD_LIMIT = 5 * 1024 * 1024

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const DEVICE_ID_KEY = 'clipsync-device-id'

function guessPlatform(): string {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('win')) return 'windows'
  if (ua.includes('mac')) return 'macos'
  if (ua.includes('linux')) return 'linux'
  return 'windows'
}

/**
 * 确保本地已缓存当前设备的 deviceId。
 * 离线队列里的 create payload 必须带有效的 deviceId，否则恢复网络后 flush 会 404。
 * 因此登录成功 / 应用启动时就要把 deviceId 准备好，不能等第一次上传时才现取。
 */
export async function ensureDeviceId(): Promise<string | null> {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY)
  if (deviceId) return deviceId

  try {
    // 先尝试拉取已有设备
    const devRes = await api('GET', '/api/devices')
    const devList = devRes.data?.devices || devRes.data
    if (devRes.ok && Array.isArray(devList) && devList.length > 0) {
      deviceId = devList[0].id || devList[0].device_id
      if (deviceId) {
        localStorage.setItem(DEVICE_ID_KEY, deviceId)
        return deviceId
      }
    }
  } catch {
    /* ignore, try register */
  }

  // 没有已有设备：注册本机
  try {
    const platform = guessPlatform()
    const registerRes = await api('POST', '/api/devices', {
      deviceName: 'Desktop',
      deviceType: 'desktop',
      platform,
      platformVersion: '',
      appVersion: '0.1.0',
    })
    if (registerRes.ok && registerRes.data?.id) {
      const did = registerRes.data.id
      localStorage.setItem(DEVICE_ID_KEY, did)
      return did
    }
    // 设备名冲突时后端返回 409 并带已有 deviceId
    if (registerRes.status === 409 && registerRes.data?.deviceId) {
      const did = registerRes.data.deviceId
      localStorage.setItem(DEVICE_ID_KEY, did)
      return did
    }
  } catch {
    /* ignore */
  }

  console.warn('[Clipboard] Failed to ensure deviceId')
  return null
}

export async function uploadToServer(content: string, type: ClipItem['type'] = 'text', html?: string) {
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
  // 归档视图下跳过乐观插入：新条目未归档，不应出现在归档列表中
  const isArchiveView = currentView.value === 'archive'
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  // 富文本增强：捕获到 HTML 片段时随条目放入 metadata.html（超限丢弃，只留纯文本）
  const keptHtml = html && html.length > 0 && html.length <= CAPTURED_HTML_LIMIT ? html : undefined
  if (!isArchiveView) {
    items.value.unshift({
      id: localId,
      type,
      content,
      source: 'Desktop',
      timestamp: Date.now(),
      selected: false,
      ...(keptHtml ? { metadata: { html: keptHtml } } : {}),
    })
    // 同步即时更新顶部计数：乐观插入即 +1（刷新时 loadClipboardItems 会用服务器真实
    // total 重设，自动纠正，不会重复计数）。否则同步后数字要等刷新/加载更多才变化。
    totalItems.value += 1
    mainTotalItems.value += 1
    trimToMaxHistory()
  }
  // 获取设备ID
  const deviceId = await ensureDeviceId()
  if (!deviceId) {
    console.warn('[Clipboard] uploadToServer: no deviceId, dropping text')
    if (!isArchiveView) {
      items.value = items.value.filter((i) => i.id !== localId)
      totalItems.value = Math.max(0, totalItems.value - 1)
      mainTotalItems.value = Math.max(0, mainTotalItems.value - 1)
    }
    return
  }
  const uploadPayload: Record<string, any> = {
    content,
    contentEncrypted: content,
    sourceDeviceId: deviceId,
    contentType: type,
    contentPreview: content.slice(0, 5000),
    contentSize: content.length,
  }
  if (keptHtml) uploadPayload.metadata = { html: keptHtml }
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
    // 上传失败：从本地列表移除乐观项，避免残留脏数据，并回滚计数
    if (!isArchiveView) {
      items.value = items.value.filter((i) => i.id !== localId)
      totalItems.value = Math.max(0, totalItems.value - 1)
      mainTotalItems.value = Math.max(0, mainTotalItems.value - 1)
    }
    if (res.status === 413) {
      toast.show(t('text_too_large', { n: Math.round(MAX_TEXT_UPLOAD_SIZE / 1024 / 1024) }), 'warning')
    } else {
      toast.show(t('text_upload_failed') + (res.error ? `: ${res.error}` : ''), 'error')
    }
  } catch (e: any) {
    // 网络/未知异常：同样移除乐观项并提示，回滚计数
    if (!isArchiveView) {
      items.value = items.value.filter((i) => i.id !== localId)
      totalItems.value = Math.max(0, totalItems.value - 1)
      mainTotalItems.value = Math.max(0, mainTotalItems.value - 1)
    }
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
  // 上传前预处理：消费「图片压缩」设置（开=重编码 0.8；关=仅超尺寸裁边）
  const resized = await prepareImageForUpload(dataUrl)
  const base64 = resized.split(',')[1]

  // 归档视图下跳过乐观插入：新条目未归档，不应出现在归档列表中
  const isArchiveView = currentView.value === 'archive'
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  if (!isArchiveView) {
    // 乐观更新
    items.value.unshift({
      id: localId,
      type: 'image',
      content: resized,
      preview: resized,
      source: 'Desktop',
      timestamp: Date.now(),
      selected: false,
    })
    totalItems.value += 1
    mainTotalItems.value += 1
    trimToMaxHistory()
  }

  const deviceId = await ensureDeviceId()
  if (!deviceId) {
    console.warn('[Clipboard] uploadImageToServer: no deviceId, dropping image')
    if (!isArchiveView) {
      items.value = items.value.filter((i) => i.id !== localId)
      totalItems.value = Math.max(0, totalItems.value - 1)
      mainTotalItems.value = Math.max(0, mainTotalItems.value - 1)
    }
    return
  }
  // Hash the ORIGINAL image bytes (not the resized upload) so server-side
  // duplicate detection matches the same image when pasted into the AI chat.
  const imageHash = await sha256DataUrl(dataUrl)
  const uploadPayload: any = {
    contentType: 'image',
    contentEncrypted: resized,
    sourceDeviceId: deviceId,
    // 压缩后可能是 webp，mimeType 必须跟着实际编码，不能继续写死 image/png
    mimeType: dataUrlMime(resized),
    size: base64?.length || 0,
    contentPreview: `[Image ${base64?.length || 0} bytes]`,
    imageHash,
  }
  const res = await apiOrEnqueue('POST', '/api/clipboard', uploadPayload, 'create', uploadPayload)
  if (res.ok && res.data?.id) {
    const localItem = items.value.find((i) => i.id === localId)
    if (localItem) {
      localItem.id = res.data.id
      cacheContent(res.data.id, dataUrl)
    }
    return
  }
  // 上传失败：从本地列表移除乐观项，避免残留脏数据，并回滚计数
  if (!isArchiveView) {
    items.value = items.value.filter((i) => i.id !== localId)
    totalItems.value = Math.max(0, totalItems.value - 1)
    mainTotalItems.value = Math.max(0, mainTotalItems.value - 1)
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

  const fileName = filePaths[0].split(/[/\\]/).pop() || filePaths[0] || 'Unknown'

  // === 跨设备文件捕获（B7 / 决策 D3）===
  // 1) 文本文件：沿用既有 readFileContent 通道（保住 DocPreview 的纯文本预览）
  // 2) 二进制文件：readFileContentBase64 读原字节，≤5MB 才随条目上传，
  //    对端即可下载还原；超限 / 读不到 → 标记 localOnly（"仅本机可用"）。
  // 只处理单文件：多文件复制没有打包协议，跨设备还原无从谈起，一律标仅本机。
  let fileContent = payload // fallback: store path array
  let textReadOk = false
  let uploadedBase64 = ''
  let uploadedBytes = 0
  try {
    const text = await tauri.readFileContent(filePaths[0])
    if (text && text.length > 0) {
      fileContent = text
      textReadOk = true
    }
  } catch {
    /* 非 UTF-8（二进制）/ 超 5MB / 无权限 — 走下面的二进制通道 */
  }
  // 只有「文本读不出来」的纯二进制文件才走 base64 通道：
  // 文本文件必须继续按明文存，否则 DocPreview 的纯文本预览会被 base64 糊掉（回归）。
  if (!textReadOk && filePaths.length === 1) {
    try {
      const b64 = await tauri.readFileContentBase64(filePaths[0])
      if (b64) {
        // base64 长度 × 3/4 ≈ 原始字节数（含 padding 误差，够用于阈值判断）
        const bytes = Math.floor((b64.length * 3) / 4)
        if (bytes > 0 && bytes <= FILE_BYTES_UPLOAD_LIMIT) {
          uploadedBase64 = b64
          uploadedBytes = bytes
        } else {
          logger.debug('[Clipboard] file too large for cross-device upload, local only', fileName, bytes)
        }
      }
    } catch (e: any) {
      logger.debug('[Clipboard] binary read failed, local only', fileName, e?.message || e)
    }
  }
  // 真实字节优先：有二进制捕获时上传它，否则退回文本/路径数组
  const storedContent = uploadedBase64 || fileContent
  const displaySize = uploadedBase64
    ? formatBytes(uploadedBytes)
    : `${(fileContent.length / 1024).toFixed(1)} KB`

  // 归档视图下跳过乐观插入：新条目未归档，不应出现在归档列表中
  const isArchiveView = currentView.value === 'archive'
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  if (!isArchiveView) {
    // 乐观更新
    items.value.unshift({
      id: localId,
      type: 'file',
      content: JSON.stringify({
        name: fileName,
        size: displaySize,
        type: uploadedBase64 ? 'application/octet-stream' : 'text/plain',
      }),
      source: 'Desktop',
      timestamp: Date.now(),
      selected: false,
      metadata: {
        paths: filePaths,
        originalName: fileName,
        localOnly: !uploadedBase64 && !textReadOk,
      },
    })
    totalItems.value += 1
    mainTotalItems.value += 1
    trimToMaxHistory()
  }

  const deviceId = await ensureDeviceId()
  if (!deviceId) {
    console.warn('[Clipboard] uploadFileToServer: no deviceId, dropping file')
    if (!isArchiveView) {
      items.value = items.value.filter((i) => i.id !== localId)
      totalItems.value = Math.max(0, totalItems.value - 1)
      mainTotalItems.value = Math.max(0, mainTotalItems.value - 1)
    }
    return
  }
  // metadata 只放**轻量标记**（paths / 名称 / 编码标记），绝不放 base64 本体：
  // GET /api/clipboard 列表接口会 SELECT metadata，塞进 6MB 会把整个列表请求拖垮。
  // 字节本体走 contentEncrypted（text 列，列表接口不查）。
  const uploadPayload = {
    contentType: 'file',
    content: JSON.stringify({ name: fileName, paths: filePaths }),
    contentEncrypted: storedContent,
    sourceDeviceId: deviceId,
    contentPreview: fileName,
    metadata: {
      paths: filePaths,
      originalName: fileName,
      // 对端据此判断"能否还原文件"：base64 = 字节已随条目上传，可直接下载还原
      fileEncoding: uploadedBase64 ? 'base64' : 'text',
      fileSize: uploadedBytes || fileContent.length,
      // 文本文件（明文已随条目上传）也算"非仅本机"：内容在对端可见可复制，
      // 只有"还原成原文件"做不到。仅二进制且未捕获成功时才标仅本机。
      localOnly: !uploadedBase64 && !textReadOk,
    },
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
        localItem.metadata = uploadPayload.metadata
        cacheContent(res.data.id, storedContent)
      }
    }
    return
  }
  // 上传失败：从本地列表移除乐观项，避免残留脏数据，并回滚计数
  if (!isArchiveView) {
    items.value = items.value.filter((i) => i.id !== localId)
    totalItems.value = Math.max(0, totalItems.value - 1)
    mainTotalItems.value = Math.max(0, mainTotalItems.value - 1)
  }
}
