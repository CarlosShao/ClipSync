// === 剪贴板上传（文本 / 图片 / 文件）与离线兜底 ===
import { api, apiForm } from '@/api/client'
import * as tauri from '@/lib/tauri'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { enqueue } from '@/utils/offlineQueue'
import { logger } from '@/utils/logger'
import { CHUNK_SIZE, chunkedUpload } from '@/utils/chunkedUpload'
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

// === 跨设备文件自动同步路由阈值（D1 升级）===
// 二进制文件 ≤10MB：multipart 直传 POST /api/media/file（服务端落盘 + 自建剪贴板
// 条目 + WS 广播，前端不再 POST /api/clipboard 造重复条目）；
// 二进制文件 >10MB：先建条目（localOnly:true），再 chunkedUpload 分片上传，
// complete 请求带 clipboardItemId 让服务端 S2 UPDATE 该条目并广播（条目转正）。
// 文本文件 ≤5MB（readFileContent 通道）保持明文随条目上传，DocPreview 预览依赖。
export const FILE_MULTIPART_UPLOAD_LIMIT = 10 * 1024 * 1024

/**
 * 套餐文件大小上限（对齐 useFileUpload.planMaxBytes 与服务端
 * subscription_plans.max_file_size_mb / chunked-upload init 的 DB 校验）：
 * Free 128MB / Pro 256MB / Enterprise 1GB。超限捕获文件标 localOnly 并提示。
 */
export function planMaxUploadBytes(): number {
  try {
    const plan = useConfigStore().user?.plan || 'Free'
    if (plan === 'Pro' || plan === 'pro' || plan === '专业版') return 256 * 1024 * 1024
    if (plan === 'Enterprise' || plan === 'enterprise' || plan === '企业版') return 1024 * 1024 * 1024
    return 128 * 1024 * 1024
  } catch {
    return 128 * 1024 * 1024
  }
}

/** 从文件名扩展名猜 MIME（剪贴板捕获的文件没有 File.type，只能按扩展名推断）。 */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  apk: 'application/vnd.android.package-archive',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/javascript',
  py: 'text/x-python',
  java: 'text/x-java-source',
  c: 'text/plain',
  cpp: 'text/plain',
  h: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  sh: 'text/x-sh',
  sql: 'application/sql',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

export function guessMimeFromName(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '')
  const ext = m ? m[1].toLowerCase() : ''
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

/** base64 → 字节（data URL 走 fetch 解码，避免逐字符循环解码 10MB 级字符串）。 */
async function base64ToBytes(b64: string): Promise<Uint8Array> {
  const res = await fetch(`data:application/octet-stream;base64,${b64}`)
  return new Uint8Array(await res.arrayBuffer())
}

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

/**
 * 分片读取本机文件并组装 File（>10MB 捕获文件的分片上传桥，D1）。
 * read_file_content_base64 硬上限 10MB，大文件必须经 read_file_range_base64
 * 按 CHUNK_SIZE 切片读取；每次解码后立即释放 base64 字符串，
 * 全程最多持有「整份文件字节 + 一份 base64 切片」的内存。
 */
async function readFileAsFile(path: string, fileName: string, mime: string, size: number): Promise<File> {
  const parts: BlobPart[] = []
  for (let start = 0; start < size; start += CHUNK_SIZE) {
    const len = Math.min(CHUNK_SIZE, size - start)
    const b64 = await tauri.readFileRangeBase64(path, start, len)
    parts.push(await base64ToBytes(b64))
  }
  return new File(parts, fileName, { type: mime })
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
  const extMatch = /\.([A-Za-z0-9]+)$/.exec(fileName)
  const ext = extMatch ? extMatch[1].toLowerCase() : ''
  const isSingleFile = filePaths.length === 1

  // === 跨设备文件捕获（B7 / D3 基础上的 D1 升级）===
  // ① 文本文件（readFileContent 通道）：明文随条目上传，保住 DocPreview 的纯文本预览
  // ② 二进制文件：不再 base64 内嵌，按大小路由 ——
  //    ≤10MB → multipart POST /api/media/file（服务端落盘 + 自建条目 + WS 广播）；
  //    >10MB → 先建条目（localOnly:true）再 chunkedUpload，complete 带 clipboardItemId
  //            让服务端 S2 UPDATE 该条目并广播（见 FILE_MULTIPART_UPLOAD_LIMIT 注释）
  // ③ 超套餐上限 / 读不到 / 多文件 → localOnly（"仅本机可用"），多文件为已知限制
  let fileContent = payload // fallback: store path array
  let textReadOk = false
  try {
    const text = await tauri.readFileContent(filePaths[0])
    if (text && text.length > 0) {
      fileContent = text
      textReadOk = true
    }
  } catch {
    /* 非 UTF-8（二进制）/ 超 5MB / 无权限 — 走下面的二进制通道 */
  }

  const isBinaryCapture = isSingleFile && !textReadOk
  const isArchiveView = currentView.value === 'archive'
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

  const deviceId = await ensureDeviceId()

  /** 从本地列表移除乐观项并回滚计数（上传失败 / 重复时用） */
  const removeOptimistic = () => {
    if (!isArchiveView) {
      items.value = items.value.filter((i) => i.id !== localId)
      totalItems.value = Math.max(0, totalItems.value - 1)
      mainTotalItems.value = Math.max(0, mainTotalItems.value - 1)
    }
  }

  // ============ 二进制分支 ============
  if (isBinaryCapture) {
    const mime = guessMimeFromName(fileName)
    const sizeDisplayJson = (size: number) =>
      JSON.stringify({ name: fileName, size: formatBytes(size), type: mime })

    // 先拿真实大小：套餐校验必须在读字节之前，避免超限大文件白读一次内存。
    // stat 失败时退而尝试 base64 读（≤10MB 才会成功，顺带拿到大小）。
    let fileSize = -1
    let cachedB64 = ''
    try {
      fileSize = await tauri.getFileSize(filePaths[0])
    } catch {
      logger.debug('[Clipboard] get_file_size failed', fileName)
    }
    if (fileSize < 0) {
      try {
        cachedB64 = await tauri.readFileContentBase64(filePaths[0])
        if (cachedB64) fileSize = Math.floor((cachedB64.length * 3) / 4)
      } catch {
        logger.debug('[Clipboard] binary read failed, local only', fileName)
      }
    }

    // 统一 metadata（对齐消费方契约，D1 设计第 5 条）：
    // 上传成功后条目 localOnly=false；本地乐观项在上传完成前也标 localOnly=true
    const baseMeta = {
      originalName: fileName,
      mimeType: mime,
      extension: ext,
      fileSize: fileSize > 0 ? fileSize : 0,
      source: 'auto-sync',
      paths: filePaths,
      localOnly: true,
      fileEncoding: 'server',
    }
    const displayJson = sizeDisplayJson(fileSize > 0 ? fileSize : 0)

    // 乐观插入（条目内容 = {name,size,type} JSON；路径只放 metadata.paths，
    // 避免手机端把 content 探测成本机路径而隐藏下载入口，F4 降级判定）
    if (!isArchiveView) {
      items.value.unshift({
        id: localId,
        type: 'file',
        content: displayJson,
        source: 'Desktop',
        timestamp: Date.now(),
        selected: false,
        metadata: { ...baseMeta },
      })
      totalItems.value += 1
      mainTotalItems.value += 1
      trimToMaxHistory()
    }

    if (!deviceId) {
      console.warn('[Clipboard] uploadFileToServer: no deviceId, dropping file')
      removeOptimistic()
      return
    }

    /** 建一条 localOnly:true 的占位条目（超套餐 / 捕获失败 / 上传失败兜底共用）。 */
    const createLocalOnlyEntry = async () => {
      const uploadPayload = {
        contentType: 'file',
        content: displayJson,
        contentEncrypted: displayJson,
        sourceDeviceId: deviceId,
        contentPreview: fileName,
        contentSize: fileSize > 0 ? fileSize : 0,
        metadata: { ...baseMeta },
      }
      const res = await apiOrEnqueue('POST', '/api/clipboard', uploadPayload, 'create', uploadPayload)
      if (res.ok && res.data?.id) {
        const localItem = items.value.find((i) => i.id === localId)
        if (res.data.duplicate) {
          // 服务端 5 分钟窗口判定重复：移除本地乐观项，避免两条同名记录
          removeOptimistic()
        } else if (localItem) {
          localItem.id = res.data.id
          cacheContent(res.data.id, displayJson)
        }
        return
      }
      removeOptimistic()
    }

    // ---- 套餐限制（Free 128MB / Pro 256MB / Enterprise 1GB）：超限 localOnly + 提示 ----
    const planLimit = planMaxUploadBytes()
    if (fileSize > planLimit) {
      console.warn('[Clipboard] file exceeds plan limit, local only', fileName, fileSize, planLimit)
      const maxMb = Math.round(planLimit / 1024 / 1024)
      toast.show(
        `${fileName}: ${t('file_exceeds_plan', { size: formatBytes(fileSize), limit: `${maxMb}MB`, plan: '' })}`,
        'error',
      )
      await createLocalOnlyEntry()
      return
    }

    // ---- 二进制 ≤10MB：multipart 直传 /api/media/file ----
    // 服务端 media.js 落盘后自建剪贴板条目并 WS 广播 new_clipboard（列表经 refresh 自动出现），
    // 因此这里绝不 POST /api/clipboard —— 重复创建会造出第二条同名条目。
    if (fileSize >= 0 && fileSize <= FILE_MULTIPART_UPLOAD_LIMIT) {
      try {
        const b64 = cachedB64 || (await tauri.readFileContentBase64(filePaths[0]))
        if (b64) {
          const bytes = await base64ToBytes(b64)
          const file = new File([bytes], fileName, { type: mime })
          const formData = new FormData()
          formData.append('file', file, fileName)
          formData.append('sourceDeviceId', deviceId)
          const res = await apiForm('/api/media/file', formData)
          if (res.ok && res.data?.id) {
            const localItem = items.value.find((i) => i.id === localId)
            if (localItem) {
              localItem.id = res.data.id
              // media.js 响应字段是 filename（服务端落盘名），不是 contentEncrypted
              // —— 按实际响应解析（useClipboard 旧分支在这里读错字段）
              localItem.content = JSON.stringify({
                name: fileName,
                size: formatBytes(fileSize),
                type: mime,
                serverFilename: res.data.filename || '',
              })
              localItem.metadata = { ...baseMeta, localOnly: false }
              cacheContent(res.data.id, localItem.content)
            }
            return
          }
          logger.debug('[Clipboard] media/file upload rejected:', res.status, res.error)
        }
      } catch (e: any) {
        logger.debug('[Clipboard] multipart upload failed', fileName, e?.message || e)
      }
      // 兜底：脚本扩展名被服务端过滤 / 读文件失败 / 网络错误 → 建仅本机占位条目
      await createLocalOnlyEntry()
      toast.show(`${fileName}: ${t('upload_fail')}`, 'error')
      return
    }

    // ---- 二进制 >10MB：两步（S2 契约）----
    // ① POST /api/clipboard 创建条目（localOnly:true，metadata 携带统一字段）
    // ② chunkedUpload 分片上传，complete body 附 clipboardItemId —— 服务端 S2
    //    提供时不建新条目，改为 UPDATE 该条目并广播（条目转正 localOnly=false）
    if (fileSize > FILE_MULTIPART_UPLOAD_LIMIT) {
      const entryPayload = {
        contentType: 'file',
        content: displayJson,
        contentEncrypted: displayJson,
        sourceDeviceId: deviceId,
        contentPreview: fileName,
        contentSize: fileSize,
        metadata: { ...baseMeta },
      }
      const createRes = await api('POST', '/api/clipboard', entryPayload)
      if (!createRes.ok || !createRes.data?.id) {
        removeOptimistic()
        toast.show(`${fileName}: ${createRes.error || t('upload_fail')}`, 'error')
        return
      }
      if (createRes.data.duplicate) {
        removeOptimistic()
        return
      }
      const serverId: string = createRes.data.id
      const localItem = items.value.find((i) => i.id === localId)
      if (localItem) {
        localItem.id = serverId
        cacheContent(serverId, displayJson)
      }
      try {
        const file = await readFileAsFile(filePaths[0], fileName, mime, fileSize)
        await chunkedUpload(
          file,
          (progress) => {
            // 进度只写本地条目内容；服务端条目的 PUT metadata 白名单不含 uploadProgress，
            // 逐片 PUT 既会被白名单丢弃又打爆接口（设计第 6 条按此省略，见交付报告）
            const it = items.value.find((x) => x.id === serverId)
            if (it && !progress.done) it.content = `${fileName} (${progress.percent}%)`
          },
          undefined,
          { clipboardItemId: serverId },
        )
        // 完成：本地条目转正（权威状态由服务端 S2 广播 + WS refresh 到达后重建）
        const fin = items.value.find((x) => x.id === serverId)
        if (fin) {
          fin.content = displayJson
          fin.metadata = { ...baseMeta, localOnly: false }
        }
      } catch (e: any) {
        // 分片失败：服务端条目保持 localOnly:true（占位与实际状态一致），提示后不再重试
        console.warn('[Clipboard] chunked upload failed, entry stays localOnly', fileName, e?.message || e)
        toast.show(`${fileName}: ${e?.message || t('upload_fail')}`, 'error')
      }
      return
    }

    // ---- 大小完全未知（stat 与 base64 读取都失败）：标仅本机 ----
    await createLocalOnlyEntry()
    return
  }

  // ============ 传统通道：文本文件（明文内嵌）/ 多文件（保持现状）============
  const displaySize = `${(fileContent.length / 1024).toFixed(1)} KB`
  if (!isArchiveView) {
    // 乐观更新
    items.value.unshift({
      id: localId,
      type: 'file',
      content: JSON.stringify({
        name: fileName,
        size: displaySize,
        type: 'text/plain',
      }),
      source: 'Desktop',
      timestamp: Date.now(),
      selected: false,
      metadata: {
        paths: filePaths,
        originalName: fileName,
        localOnly: !textReadOk,
      },
    })
    totalItems.value += 1
    mainTotalItems.value += 1
    trimToMaxHistory()
  }

  if (!deviceId) {
    console.warn('[Clipboard] uploadFileToServer: no deviceId, dropping file')
    removeOptimistic()
    return
  }
  // metadata 只放轻量标记（paths / 名称 / 编码标记），绝不放文本本体之外的大块内容：
  // GET /api/clipboard 列表接口会 SELECT metadata，塞进兆级字体会拖垮整个列表请求。
  // 文本本体走 contentEncrypted（text 列，列表接口不查）。
  const uploadPayload = {
    contentType: 'file',
    content: JSON.stringify({ name: fileName, paths: filePaths }),
    contentEncrypted: fileContent,
    sourceDeviceId: deviceId,
    contentPreview: fileName,
    metadata: {
      paths: filePaths,
      originalName: fileName,
      mimeType: 'text/plain',
      extension: ext,
      fileSize: fileContent.length,
      source: 'auto-sync',
      // 文本文件（明文已随条目上传）算"非仅本机"：内容在对端可见可复制，
      // 只有"还原成原文件"做不到。多文件（首个文件读不成文本）才标仅本机。
      localOnly: !textReadOk,
      fileEncoding: 'text',
    },
  }
  const res = await apiOrEnqueue('POST', '/api/clipboard', uploadPayload, 'create', uploadPayload)
  if (res.ok && res.data?.id) {
    const localItem = items.value.find((i) => i.id === localId)
    if (localItem) {
      if (res.data.duplicate) {
        // 后端判定为重复条目：直接移除本地乐观项，避免 UI 出现两条同名记录
        logger.debug('[Clipboard] server reported duplicate, removing optimistic local item')
        removeOptimistic()
      } else {
        localItem.id = res.data.id
        // Update content to include paths field (for hasLocalPath detection)
        localItem.content = JSON.stringify({ name: fileName, paths: filePaths })
        localItem.metadata = uploadPayload.metadata
        cacheContent(res.data.id, fileContent)
      }
    }
    return
  }
  // 上传失败：从本地列表移除乐观项，避免残留脏数据，并回滚计数
  removeOptimistic()
}
