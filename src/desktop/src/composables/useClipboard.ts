import { ref, computed } from 'vue'
import { listen } from '@tauri-apps/api/event'
import * as tauri from '@/lib/tauri'
import { api, apiBlob, apiForm } from '@/api/client'
import { useConfigStore } from '@/stores/configStore'
import { useI18n } from '@/composables/useI18n'
import { enqueue, initOfflineSync, getQueueSize } from '@/utils/offlineQueue'
import { chunkedUpload, shouldUseChunkedUpload } from '@/utils/chunkedUpload'

const { t } = useI18n()

export interface ClipItem {
  id: string
  type: 'text' | 'image' | 'file' | 'link'
  content: string
  preview?: string
  source?: string
  deviceName?: string
  timestamp: number
  selected?: boolean
  isFavorite?: boolean
}

// === SINGLETON STATE - module-level refs shared across all callers ===
const items = ref<ClipItem[]>([])
const searchQuery = ref('')
const activeFilter = ref<'all' | 'text' | 'images' | 'links' | 'files' | 'favorites'>('all')
const batchMode = ref(false)
const polling = ref(false)
const loading = ref(false)

let firstTauriPollDone = false
let lastImageSize = 0
let lastBrowserText = ''
const recentUploadHashes = new Map<string, number>()
const HASH_TTL = 30000 // 30s dedup window — clipboard monitor fires every 700ms, need wide window

// === ClipSync 内部复制去重（精确内容匹配） ===
// 用户铁律：从 ClipSync UI 复制任何条目，都不应再次产生重复记录。
// 策略1: 时间戳跳过（复制后短时间内不处理剪贴板变化）
// 策略2: 精确内容匹配（复制时记录会写入剪贴板的内容/文件路径，monitor 检测到匹配内容时跳过）
let skipPollUntil = 0
// 初始加载后跳过轮询，防止系统剪贴板内容被重新上传
let initialLoadDone = false
let isProcessingEvent = false // Lock to prevent parallel processing of clipboard events

// 记录从 ClipSync UI 复制出去的内容：文件路径 或 文本/链接内容
const copiedFilePaths = new Map<string, number>()
const copiedTexts = new Map<string, number>()
const copiedItems = new Map<string, { type: string; content: string; timestamp: number }>()
const COPIED_CONTENT_TTL = 15000

function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/')
}

function extractFilenameFromPreview(preview: string): string {
  const match = preview.match(/\[文件\]\s+(.+?)\s*(?:\(|$)/)
  return match ? match[1].trim() : preview.trim()
}

function skipNextPolls(ms = 6000) {
  skipPollUntil = Date.now() + ms
}

function cleanupCopiedContent() {
  const now = Date.now()
  for (const [k, t] of copiedFilePaths) {
    if (now - t > COPIED_CONTENT_TTL) copiedFilePaths.delete(k)
  }
  for (const [k, t] of copiedTexts) {
    if (now - t > COPIED_CONTENT_TTL) copiedTexts.delete(k)
  }
  for (const [k, t] of copiedItems) {
    if (now - t.timestamp > COPIED_CONTENT_TTL) copiedItems.delete(k)
  }
}

// 复制时记录该条目对应的真实剪贴板内容，用于 monitor 去重
function markContentCopiedFromClipSync(item: ClipItem) {
  const now = Date.now()
  copiedItems.set(item.id, { type: item.type, content: item.content, timestamp: now })
  if (item.type === 'file') {
    try {
      const parsed = JSON.parse(item.content)
      const paths = Array.isArray(parsed) ? parsed : parsed?.paths
      if (Array.isArray(paths)) {
        paths.forEach((p: string) => copiedFilePaths.set(normalizePath(p), now))
      }
    } catch { /* ignore */ }
  } else if (item.type === 'text' || item.type === 'link') {
    copiedTexts.set(item.content, now)
  }
  cleanupCopiedContent()
}

// 检查 monitor/poll 检测到的内容是否正是刚从 ClipSync 内部复制出去的
function isClipboardChangeFromInternalCopy(payload: any, contentType?: string): boolean {
  cleanupCopiedContent()
  if (contentType === 'file') {
    const paths = payload?.filePaths as string[] | undefined
    if (paths?.some(p => copiedFilePaths.has(normalizePath(p)))) {
      console.log('[Clipboard] skip file upload: path matches internal copy', paths)
      return true
    }
    // Fallback: 路径未精确匹配（大小写/规范化差异），用文件名兜底
    const preview = payload?.content as string | undefined
    if (preview) {
      const filename = extractFilenameFromPreview(preview)
      for (const [id, info] of copiedItems) {
        if (info.type !== 'file') continue
        try {
          const parsed = JSON.parse(info.content)
          const name = parsed?.name || (Array.isArray(parsed) ? parsed[0]?.split(/[/\\]/).pop() : '')
          if (name && filename && (filename === name || filename.includes(name))) {
            console.log('[Clipboard] skip file upload: filename matches internal copy', filename)
            return true
          }
        } catch { /* ignore */ }
      }
    }
  }
  if (!contentType) {
    const text = payload?.content as string | undefined
    if (text ? copiedTexts.has(text) : false) {
      console.log('[Clipboard] skip text upload: content matches internal copy')
      return true
    }
  }
  return false
}

const filteredItems = computed(() => {
  let result = items.value
  if (activeFilter.value !== 'all') {
    result = result.filter(i => {
      if (activeFilter.value === 'favorites') return (i as any).isFavorite
      if (activeFilter.value === 'text') return i.type === 'text'
      if (activeFilter.value === 'images') return i.type === 'image'
      if (activeFilter.value === 'links') return i.type === 'link'
      if (activeFilter.value === 'files') return i.type === 'file'
      return true
    })
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(i => i.content.toLowerCase().includes(q) || (i.source || '').toLowerCase().includes(q))
  }
  return result
})

const selectedCount = computed(() => items.value.filter(i => i.selected).length)
const allSelected = computed(() => filteredItems.value.length > 0 && filteredItems.value.every(i => i.selected))

function toggleSelectAll() {
  const shouldSelect = !allSelected.value
  // 不可变更新：替换整个 items 数组中 filteredItems 对应项的引用，
  // 确保 Vue 3 检测到变化并触发所有依赖它的 computed/子组件重渲染。
  // （直接修改 i.selected 属性在边界情况下可能不触发 Checkbox 重渲染）
  const selectedIds = new Set(filteredItems.value.map(i => i.id))
  items.value = items.value.map(item =>
    selectedIds.has(item.id) ? { ...item, selected: shouldSelect } : item
  )
}

function clearSelection() {
  items.value.forEach(i => { i.selected = false })
}

// === 本地内容缓存（后端 contentPreview 为空，需要前端自己存） ===
// 增强版：TTL 过期 + LRU 淘汰 + 更大容量
const CONTENT_CACHE_KEY = 'clipsync-content-cache-v2'
const CONTENT_CACHE_MAX = 100 // 最多缓存100条
const CONTENT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000 // 7天过期

interface CacheEntry { v: string; t: number } // value + timestamp

function loadContentCache(): Map<string, CacheEntry> {
  try {
    const raw = localStorage.getItem(CONTENT_CACHE_KEY)
    if (!raw) return new Map()
    const arr: [string, CacheEntry][] = JSON.parse(raw)
    const cache = new Map(arr)
    // 清理过期条目
    const now = Date.now()
    for (const [k, v] of cache) {
      if (now - v.t > CONTENT_CACHE_TTL) cache.delete(k)
    }
    return cache
  } catch { return new Map() }
}

function saveContentCache(cache: Map<string, CacheEntry>) {
  // LRU 淘汰：按时间戳排序，删除最旧的条目
  if (cache.size > CONTENT_CACHE_MAX) {
    const entries = [...cache.entries()].sort((a, b) => a[1].t - b[1].t)
    const toKeep = entries.slice(entries.length - CONTENT_CACHE_MAX)
    cache = new Map(toKeep)
  }
  try {
    localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify([...cache]))
  } catch (e: any) {
    // localStorage 配额超限 — 淘汰最旧的半数后重试
    const entries = [...cache.entries()].sort((a, b) => a[1].t - b[1].t)
    const reduced = new Map(entries.slice(Math.floor(entries.length / 2)))
    try {
      localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify([...reduced]))
    } catch { /* 彻底放弃 */ }
  }
}

function cacheContent(id: string, content: string) {
  if (!content || !id) return
  try {
    const cache = loadContentCache()
    const isImageBase64 = content.startsWith('data:image')
    cache.set(id, { v: isImageBase64 ? content : content.slice(0, 5000), t: Date.now() })
    saveContentCache(cache)
  } catch { /* 绝不允许缓存异常影响图片渲染 */ }
}

function getCachedContent(id: string): string {
  const cache = loadContentCache()
  const entry = cache.get(id)
  if (!entry) return ''
  // LRU 更新：重新写入以刷新时间戳
  entry.t = Date.now()
  return entry.v
}

async function loadClipboardItems() {
  loading.value = true
  try {
  const res = await api('GET', '/api/clipboard')
  console.log('[Clipboard] loadClipboardItems:', res.ok, 'items:', res.data?.items?.length)
  if (res.ok && Array.isArray(res.data?.items)) {
    const serverIds = new Set(res.data.items.map((i: any) => i.id))
    // Build set of server content previews for dedup
    const serverContentPreviews = new Set(res.data.items.map((i: any) => (i.contentPreview || '').slice(0, 100)))
    // 保留有本地 content 的项，但排除与服务端重复的（乐观更新项）
    const localWithContent = items.value.filter(i => {
      if (serverIds.has(i.id)) return false
      if (!i.content || !i.content.trim()) return false
      // File items with local-/file- prefix are optimistic updates — always replace with server data
      if (i.type === 'file' && (i.id.startsWith('local-') || i.id.startsWith('file-'))) return false
      // Check if this local item matches a server item by content preview
      const localPreview = i.content.slice(0, 100)
      if (serverContentPreviews.has(localPreview)) return false
      // Also check by filename for file items
      if (i.type === 'file') {
        try {
          const meta = JSON.parse(i.content)
          if (meta.name && serverContentPreviews.has(meta.name)) return false
        } catch { /* not JSON */ }
      }
      return true
    })
    const serverItems = res.data.items.map((i: any) => {
      const cached = getCachedContent(i.id)
      const isImage = (i.contentType || i.type) === 'image'
      let content: string
      if (isImage) {
        content = cached || ''
        // 图片异步加载：不在这里触发，统一放到下面的队列
      } else {
        const existing = items.value.find(e => e.id === i.id && e.content)
        content = existing?.content || cached || i.contentPreview || i.content || ''
        // For file items: reconstruct content with paths from metadata if available
        if ((i.contentType || i.type) === 'file') {
          try {
            const meta = JSON.parse(i.metadata || '{}')
            if (meta.paths && Array.isArray(meta.paths) && meta.paths.length > 0) {
              content = JSON.stringify({ name: meta.originalName || content, paths: meta.paths })
            }
          } catch { /* no metadata or not JSON */ }
        }
        // For file items: ensure content is a displayable filename, not raw content
        // BUT preserve paths field if it was reconstructed from metadata
        const hasPaths = (() => { try { const p = JSON.parse(content); return p && typeof p === 'object' && Array.isArray(p.paths) } catch { return false } })()
        if ((i.contentType || i.type) === 'file' && content.length > 200 && !hasPaths) {
          // content is too long to be a filename — extract from metadata
          try {
            const meta = JSON.parse(i.metadata || '{}')
            if (meta.originalName) content = meta.originalName
            else if (meta.name) content = meta.name
          } catch { /* not JSON */ }
          // Still too long? Use contentPreview as filename
          if (content.length > 200 && i.contentPreview) {
            content = i.contentPreview.split(/[/\\]/).pop() || i.contentPreview
          }
        }
      }
      const preview = isImage ? (cached || '') : (content.slice(0, 200))
      return {
        id: i.id,
        type: (i.contentType || i.type || 'text') as ClipItem['type'],
        content,
        // 未缓存图片：preview 留空（异步队列会从服务端拉取并填充），
        // 不要用 'loading' 字符串当 src，否则会显示破图。
        preview: preview || (isImage ? '' : ''),
        source: i.sourceDevice?.name || i.deviceName || 'Server',
        timestamp: new Date(i.createdAt || Date.now()).getTime(),
        selected: false,
        isFavorite: !!i.isFavorite,
      }
    })
    items.value = [...localWithContent, ...serverItems]
    console.log('[Clipboard] items set to', items.value.length, 'filteredItems:', filteredItems.value.length)

    // 队列化加载图片：每批 3 张，间隔 200ms，避免并发过高被限流
    const imageQueue = serverItems.filter((i: ClipItem) => i.type === 'image' && !getCachedContent(i.id) && i.id)
    loadImagesFromQueue(imageQueue)
  } else {
    console.warn('[Clipboard] loadClipboardItems failed:', res.status, res.error)
  }
  } finally {
    loading.value = false
  }
}

// 图片异步加载队列（防并发 + 防竞态 + 429 保护）
let imageLoadVersion = 0
let imageLoadPaused = false  // 429 时暂停队列，避免无效重试堆积
async function loadImagesFromQueue(queue: ClipItem[]) {
  const version = ++imageLoadVersion  // 每次新加载递增，旧回调自动失效
  imageLoadPaused = false
  const DELAY = 800  // 每个请求间隔 800ms，避免触发 429
  for (let idx = 0; idx < queue.length; idx++) {
    // 版本检查：如果又有新的 loadClipboardItems 调用，放弃旧队列
    if (version !== imageLoadVersion || imageLoadPaused) return
    const item = queue[idx]
    try {
      const fullRes = await api('GET', `/api/clipboard/${item.id}`)
      if (version !== imageLoadVersion || imageLoadPaused) return  // 竞态检查

      // 429 保护：暂停队列，等待 60 秒后重试
      if (fullRes.status === 429) {
        console.warn(`[Clipboard] 429 on image load ${item.id}, pausing queue for 60s`)
        imageLoadPaused = true
        setTimeout(() => { imageLoadPaused = false }, 60000)
        return
      }

      if (fullRes.ok && fullRes.data?.contentEncrypted) {
        const raw = fullRes.data.contentEncrypted
        const isDataUrl = raw.startsWith('data:')
        let renderSrc: string
        if (isDataUrl) {
          renderSrc = raw
        } else {
          try {
            const imgRes = await apiBlob('GET', `/api/media/${item.id}/preview`)
            if (imgRes && imgRes.ok) {
              const blob = await imgRes.blob()
              renderSrc = URL.createObjectURL(blob)
            } else {
              renderSrc = ''
            }
          } catch {
            renderSrc = ''
          }
        }
        // 先更新预览图/内容——这是用户能看到图片的关键步骤，
        // 绝不能因为后面的缓存写入失败而被跳过（之前 quota 异常就跳过了这一步）。
        const current = items.value.find(x => x.id === item.id)
        if (current) {
          current.content = isDataUrl ? raw : ''
          current.preview = renderSrc
        }
        // 缓存放到最后，且 cacheContent 内部已 try/catch，绝不会回滚上面的显示。
        if (isDataUrl) cacheContent(item.id, raw)
      } else {
        console.warn(`[Clipboard] Failed to load image ${item.id}:`, fullRes.status, fullRes.error)
      }
    } catch (e) {
      console.warn(`[Clipboard] Image fetch error ${item.id}:`, e)
    }
    if (version !== imageLoadVersion || imageLoadPaused) return
    if (idx < queue.length - 1) {
      await new Promise(r => setTimeout(r, DELAY))
    }
  }
}

async function uploadToServer(content: string, type: ClipItem['type'] = 'text') {
  const hash = simpleHash(content)
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) return
  recentUploadHashes.set(hash, Date.now())
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
    } catch { /* ignore */ }
  }
  if (!deviceId) return
  const uploadPayload = {
    content,
    contentEncrypted: content,
    sourceDeviceId: deviceId,
    contentType: type,
    contentPreview: content.slice(0, 200),
  }
  const res = await apiOrEnqueue('POST', '/api/clipboard', uploadPayload, 'create', uploadPayload)
  // 上传成功后：用服务器返回的 id 替换本地临时 id，并缓存内容
  if (res.ok && res.data?.id) {
    const localItem = items.value.find(i => i.id === localId)
    if (localItem) {
      localItem.id = res.data.id
      cacheContent(res.data.id, content)
    }
  }
}

/** Resize image if longest edge exceeds maxPx. Returns original dataUrl if already small enough. */
function resizeImageIfNeeded(dataUrl: string, maxPx = 1080): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      const longest = Math.max(w, h)
      if (longest <= maxPx) { resolve(dataUrl); return }
      const scale = maxPx / longest
      const nw = Math.round(w * scale)
      const nh = Math.round(h * scale)
      const canvas = document.createElement('canvas')
      canvas.width = nw
      canvas.height = nh
      const ctx = canvas.getContext('2d')
      if (!ctx) { resolve(dataUrl); return }
      ctx.drawImage(img, 0, 0, nw, nh)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

async function uploadImageToServer(dataUrl: string) {
  const hash = dataUrl.slice(0, 200)
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) return
  recentUploadHashes.set(hash, Date.now())
  // Skip clipboard polling to prevent duplicate events from the monitor
  skipNextPolls(15000)
  // Resize large images (>1080p) before upload to save bandwidth
  const resized = await resizeImageIfNeeded(dataUrl)
  const base64 = resized.split(',')[1]
  // 乐观更新
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  items.value.unshift({ id: localId, type: 'image', content: resized, preview: resized, source: 'Desktop', timestamp: Date.now(), selected: false })
  const deviceId = localStorage.getItem('clipsync-device-id')
  if (!deviceId) return
  const uploadPayload = {
    contentType: 'image',
    content: resized,
    contentEncrypted: resized,
    sourceDeviceId: deviceId,
    mimeType: 'image/png',
    size: base64?.length || 0,
    contentPreview: `[Image ${base64?.length || 0} bytes]`,
  }
  const res = await apiOrEnqueue('POST', '/api/clipboard', uploadPayload, 'create', uploadPayload)
  if (res.ok && res.data?.id) {
    const localItem = items.value.find(i => i.id === localId)
    if (localItem) {
      localItem.id = res.data.id
      cacheContent(res.data.id, dataUrl)
    }
  }
}

async function uploadFileToServer(payload: string) {
  const hash = simpleHash(payload)
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) return
  recentUploadHashes.set(hash, Date.now())

  // Skip clipboard polling for 8s to prevent duplicate events from the monitor
  // (monitor fires every 700ms while file is in clipboard)
  skipNextPolls(15000)

  // Parse file paths from payload
  let filePaths: string[] = []
  try { filePaths = JSON.parse(payload) } catch { filePaths = [payload] }

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
  } catch { /* file not readable (binary, permission, etc.) — keep path array */ }

  // 乐观更新
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  items.value.unshift({
    id: localId, type: 'file',
    content: JSON.stringify({ name: fileName, size: `${(fileContent.length / 1024).toFixed(1)} KB`, type: 'text/plain' }),
    source: 'Desktop', timestamp: Date.now(), selected: false,
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
    const localItem = items.value.find(i => i.id === localId)
    if (localItem) {
      if (res.data.duplicate) {
        // 后端判定为重复条目：直接移除本地乐观项，避免 UI 出现两条同名记录
        console.log('[Clipboard] server reported duplicate, removing optimistic local item')
        items.value = items.value.filter(i => i.id !== localId)
      } else {
        localItem.id = res.data.id
        // Update content to include paths field (for hasLocalPath detection)
        localItem.content = JSON.stringify({ name: fileName, paths: filePaths })
        cacheContent(res.data.id, fileContent)
      }
    }
  }
}

function simpleHash(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) { hash = ((hash << 5) - hash) + s.charCodeAt(i); hash |= 0 }
  return hash.toString(36)
}

/** Try API call; on network failure, enqueue for later sync. */
async function apiOrEnqueue(method: string, path: string, body: any, offlineType: 'create' | 'delete', offlinePayload: any) {
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

async function readAndUpload() {
  try {
    // 策略1: 时间戳跳过（复制后 6 秒内不处理）
    if (Date.now() < skipPollUntil) return
    if (isProcessingEvent) return // Prevent parallel processing with event handler
    // 初始加载后跳过一轮轮询，防止系统剪贴板内容被重新上传
    if (!initialLoadDone) { initialLoadDone = true; return }

    // 优先尝试 Tauri API
    const files = await tauri.getClipboardFiles().catch(() => [] as string[])
    if (files.length > 0) {
      console.log('[Clipboard] poll detected files:', files)
      // 精确匹配：如果这是刚从 ClipSync 内部复制出去的文件路径，直接跳过
      if (isClipboardChangeFromInternalCopy({ filePaths: files }, 'file')) return
      const payload = JSON.stringify(files)
      const payloadHash = simpleHash(payload)
      // Check both item content AND recent upload hashes to prevent duplicates
      const alreadyUploading = recentUploadHashes.has(payloadHash) &&
        Date.now() - (recentUploadHashes.get(payloadHash) || 0) < HASH_TTL
      if (!alreadyUploading && !items.value.some(i => i.type === 'file' && i.content === payload)) {
        await uploadFileToServer(payload)
      }
      return
    }

    const imgInfo = await tauri.checkClipboardImageInfo().catch(() => ({ available: false, size: 0 }))
    if (imgInfo.available && imgInfo.size !== lastImageSize) {
      if (firstTauriPollDone || !items.value.some(i => i.type === 'image')) {
        const imgData = await tauri.getClipboardImage().catch(() => '')
        if (imgData) {
          lastImageSize = imgInfo.size
          await uploadImageToServer(imgData)
        }
      }
      return
    }

    const text = await tauri.getClipboardContent().catch(() => '')
    if (text && text.trim()) {
      // 精确匹配：如果这是刚从 ClipSync 内部复制出去的文本，直接跳过
      if (isClipboardChangeFromInternalCopy({ content: text }, undefined)) return
      const isUrl = /^https?:\/\/\S+$/.test(text.trim())
      const itemType = isUrl ? 'link' : 'text'
      if (!items.value.some(i => (i.type === 'text' || i.type === 'link') && i.content === text)) {
        await uploadToServer(text, itemType)
      }
      return
    }

    // Fallback: 浏览器 Clipboard API (非 Tauri 环境)
    if (typeof navigator !== 'undefined' && navigator.clipboard && !(window as any).__TAURI__) {
      try {
        const clipText = await navigator.clipboard.readText().catch(() => '')
        if (clipText && clipText.trim() && clipText !== lastBrowserText) {
          lastBrowserText = clipText
          const isUrl = /^https?:\/\/\S+$/.test(clipText.trim())
          const itemType = isUrl ? 'link' : 'text'
          if (!items.value.some(i => (i.type === 'text' || i.type === 'link') && i.content === clipText)) {
            await uploadToServer(clipText, itemType)
          }
        }
      } catch { /* clipboard API 权限不足 */ }
    }

    for (const [h, t] of recentUploadHashes) {
      if (Date.now() - t > HASH_TTL * 3) recentUploadHashes.delete(h)
    }
  } catch (e) {
    console.warn('[Clipboard] Poll error:', e)
  }
}

export function useClipboard() {
  // === Event-driven clipboard handler (from Rust clipboard_monitor.rs) ===
  let unlistenEvent: (() => void) | null = null

  async function handleClipboardEvent(payload: any) {
    try {
      if (Date.now() < skipPollUntil) return
      if (isProcessingEvent) return // Prevent parallel processing
      isProcessingEvent = true

      const contentType = payload?.contentType as string | undefined

      if (contentType === 'file') {
        // File event from Rust: content is preview text, filePaths is the array
        const filePaths = payload?.filePaths as string[] | undefined
        console.log('[Clipboard] file event:', filePaths)
        if (filePaths && filePaths.length > 0) {
          // If this file path was just copied from ClipSync UI, skip it
          if (isClipboardChangeFromInternalCopy(payload, 'file')) return

          const filePayload = JSON.stringify(filePaths)
          const payloadHash = simpleHash(filePayload)
          // Check both item content AND recent upload hashes to prevent duplicates
          const alreadyUploading = recentUploadHashes.has(payloadHash) &&
            Date.now() - (recentUploadHashes.get(payloadHash) || 0) < HASH_TTL
          if (!alreadyUploading && !items.value.some(i => i.type === 'file' && i.content === filePayload)) {
            await uploadFileToServer(filePayload)
          }
        }
      } else if (contentType === 'image') {
        // Image event from Rust: lightweight size-only notification.
        // If any file/text was recently copied by the user, skip this event
        // (image copy currently not tracked precisely, but copy action sets skipPollUntil)
        if (Date.now() < skipPollUntil) return
        // Fetch actual image data via Tauri command (heavy, but only on real change).
        const size = payload?.size as number | undefined
        if (size && size !== lastImageSize) {
          lastImageSize = size
          const imgData = await tauri.getClipboardImage().catch((e: any) => {
            console.error('[Clipboard] getClipboardImage failed:', e)
            return ''
          })
          if (imgData) {
            await uploadImageToServer(imgData)
          } else {
            console.warn('[Clipboard] Image conversion returned empty — DIB-to-PNG may have failed')
          }
        }
      } else if (!contentType) {
        // Text event from Rust: content is the clipboard text
        // If this text was just copied from ClipSync UI, skip it
        if (isClipboardChangeFromInternalCopy(payload, undefined)) return
        const text = payload?.content as string | undefined
        if (text && text.trim()) {
          const isUrl = /^https?:\/\/\S+$/.test(text.trim())
          const itemType = isUrl ? 'link' : 'text'
          if (!items.value.some(i => (i.type === 'text' || i.type === 'link') && i.content === text)) {
            await uploadToServer(text, itemType)
          }
        }
      }
    } catch (e) {
      console.warn('[Clipboard] Event handler error:', e)
    } finally {
      isProcessingEvent = false
    }
  }

  /** Auto-resume pending chunked uploads after page refresh */
  function resumePendingUploads() {
    try {
      const raw = localStorage.getItem('clipsync-chunked-upload')
      if (!raw) return
      const state = JSON.parse(raw)
      if (!state?.uploadId || !state?.filename) return

      // Check if session is still valid on server
      api('GET', `/api/upload/status/${state.uploadId}`).then(res => {
        if (res.ok && res.data?.missingChunks?.length > 0) {
          console.log(`[Clipboard] Resuming upload: ${state.filename} (${res.data.uploadedChunks?.length || 0}/${state.totalChunks} chunks)`)
          // Find the item in the list and update its display
          const item = items.value.find(i => i.content?.includes(state.filename))
          if (item) {
            const pct = Math.round(((res.data.uploadedChunks?.length || 0) / state.totalChunks) * 100)
            item.content = `${state.filename} (${pct}%) — resuming...`
          }
          // Note: actual resume requires the File object which is lost on refresh.
          // User needs to re-select the file to resume. Log this for now.
          console.log('[Clipboard] Upload session found but File object lost on refresh. Re-select file to resume.')
        } else {
          // Session expired or complete — clean up
          localStorage.removeItem('clipsync-chunked-upload')
        }
      }).catch(() => {
        localStorage.removeItem('clipsync-chunked-upload')
      })
    } catch { /* ignore */ }
  }

  function startPolling(interval = 1500) {
    polling.value = true
    initialLoadDone = false
    // Initialize offline queue: auto-flush on reconnect/focus
    initOfflineSync((count) => {
      console.log(`[Clipboard] Offline sync restored: ${count} actions synced`)
      loadClipboardItems() // Refresh list after offline sync
    })
    loadClipboardItems()

    // Auto-resume pending chunked uploads on page load
    resumePendingUploads()

    // --- Primary: event-driven via Rust clipboard monitor ---
    // The Rust thread polls clipboard every 700ms and emits `clipboard-changed`
    // events for text/files/images. This replaces the old 1500ms JS polling.
    // IMPORTANT: must await to prevent parallel processing of events (causes duplicates)
    listen<any>('clipboard-changed', async (event) => {
      await handleClipboardEvent(event.payload)
    }).then(unlisten => {
      unlistenEvent = unlisten
      console.log('[Clipboard] Listening for native clipboard-changed events')
    }).catch(err => {
      console.warn('[Clipboard] Failed to attach event listener, falling back to polling:', err)
    })

    // --- Fallback: slow polling (every 10s) as safety net ---
    // If the Rust monitor is not running or events are missed, this ensures
    // clipboard changes are still detected. Dedup logic in readAndUpload()
    // prevents duplicate uploads when both events and poll fire.
    const fallbackId = setInterval(readAndUpload, 10000)

    return () => {
      polling.value = false
      unlistenEvent?.()
      unlistenEvent = null
      clearInterval(fallbackId)
    }
  }

  async function copyItem(item: ClipItem) {
    try {
      // 精确内容去重：复制时记录会写入剪贴板的实际内容/路径，monitor 检测到相同内容时跳过
      skipNextPolls(15000)
      markContentCopiedFromClipSync(item)

      if (item.type === 'file') {
        try {
          const parsed = JSON.parse(item.content)
          // 路径数组 ["D:\\path\\to\\file"] → 复制文件到剪贴板
          if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
            await tauri.setClipboardFiles(parsed)
            return true
          }
          // 带 paths 字段的元数据 {"name":"...","paths":["D:\\..."]} → 复制文件到剪贴板
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.paths) && parsed.paths.length > 0) {
            await tauri.setClipboardFiles(parsed.paths)
            return true
          }
          // 纯元数据对象（服务器上传的文件）→ 复制文件名
          if (parsed && typeof parsed === 'object' && parsed.name) {
            await tauri.setClipboardContent(parsed.name)
            return true
          }
          return false
        } catch { /* 解析失败 */ }
        return false
      }
      if (item.type === 'image') {
        // 图片：优先用本地完整 data URL，否则从服务器获取完整内容
        let dataUrl = item.content || item.preview || ''
        if (!dataUrl || dataUrl.startsWith('[Image')) {
          try {
            const full = await api('GET', `/api/clipboard/${item.id}`)
            dataUrl = full.data?.contentEncrypted || full.data?.contentPreview || dataUrl
          } catch { /* ignore */ }
        }
        if (dataUrl && !dataUrl.startsWith('[Image')) {
          // 更新 lastImageSize 避免下一轮轮询重新走图片检测分支
          try {
            const info = await tauri.checkClipboardImageInfo()
            lastImageSize = info.size
          } catch {
            lastImageSize = dataUrl.length
          }
          // 优先写入实际图片格式
          try {
            const resp = await fetch(dataUrl)
            const blob = await resp.blob()
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
            return true
          } catch {
            await tauri.setClipboardContent(dataUrl)
            return true
          }
        }
        return false
      }
      await tauri.setClipboardContent(item.content)
      return true
    } catch (e: any) {
      console.warn('[Clipboard] copyItem failed:', e?.message || e)
      return false
    }
  }

  async function batchDelete(): Promise<number> {
    const selected = items.value.filter(i => i.selected)
    const count = selected.length
    // 只删服务器上的（过滤掉所有本地临时 id）
    const serverIds = selected.map(i => i.id).filter(id => !id.startsWith('local-') && !id.startsWith('text-') && !id.startsWith('img-') && !id.startsWith('file-') && !id.startsWith('browser-'))
    if (serverIds.length > 0) {
      const res = await apiOrEnqueue('DELETE', '/api/clipboard', { ids: serverIds }, 'delete', { ids: serverIds })
      if (!res.ok && res.status !== 0) {
        console.error('[Clipboard] batchDelete server error:', res.status, res.error)
        throw new Error(res.error || `删除失败 (HTTP ${res.status})`)
      }
    }
    // 仅在服务端确认成功后才从本地列表移除选中项
    const selectedIds = new Set(selected.map(i => i.id))
    items.value = items.value.filter(i => !selectedIds.has(i.id))
    // 批量删除后跳过轮询，防止系统剪贴板内容被重新上传
    skipNextPolls(10000)
    return count
  }

  async function deleteSingle(item: ClipItem) {
    const isLocal = item.id.startsWith('local-') || item.id.startsWith('text-') || item.id.startsWith('img-')
    if (!isLocal) {
      const res = await apiOrEnqueue('DELETE', `/api/clipboard/${item.id}`, undefined, 'delete', { id: item.id })
      if (!res.ok && res.status !== 0) {
        console.error('[Clipboard] deleteSingle server error:', res.status, res.error)
        throw new Error(res.error || `删除失败 (HTTP ${res.status})`)
      }
    }
    // 仅在服务端确认成功（或是本地临时项）后才从本地列表移除
    items.value = items.value.filter(i => i.id !== item.id)
    // 删除后跳过轮询，防止系统剪贴板内容被重新上传
    skipNextPolls(10000)
  }

  async function toggleFavorite(item: ClipItem) {
    // 乐观更新
    const prev = (item as any).isFavorite
    ;(item as any).isFavorite = !prev
    const res = await api('PUT', `/api/clipboard/${item.id}/favorite`)
    if (!res.ok) {
      // 回滚
      ;(item as any).isFavorite = prev
      console.warn('[Clipboard] toggleFavorite failed:', res.error)
    }
  }

  function setFilter(f: typeof activeFilter.value) { activeFilter.value = f }
  function setSearch(q: string) { searchQuery.value = q }
  function toggleBatch() { batchMode.value = !batchMode.value; if (!batchMode.value) clearSelection() }

  /** 从文件选择器上传文件到剪贴板 */
  async function uploadFileItem(file: File): Promise<void> {
    // 按套餐分级限制上传大小（2026-07-07 调整）
    // Free: 128MB, Pro: 256MB, Enterprise: 1GB
    const configStore = useConfigStore()
    const planLimits: Record<string, number> = {
      'Free': 128, 'free': 128, '免费版': 128,
      'Pro': 256, 'pro': 256, '专业版': 256,
      'Enterprise': 1024, 'enterprise': 1024, '企业版': 1024,
    }
    const userPlan = configStore.user.plan || 'Free'
    const maxMb = planLimits[userPlan] || 128 // 默认免费版 128MB
    const maxBytes = maxMb * 1024 * 1024

    if (file.size > maxBytes) {
      const sizeStr = file.size < 1024 * 1024
        ? `${(file.size / 1024).toFixed(0)} KB`
        : `${(file.size / 1024 / 1024).toFixed(1)} MB`
      throw new Error(`${t('file_exceeds_plan', { size: sizeStr, limit: `${maxMb}MB`, plan: userPlan })}`)
    }
    const sizeStr = file.size < 1024 * 1024
      ? `${(file.size / 1024).toFixed(1)} KB`
      : `${(file.size / 1024 / 1024).toFixed(1)} MB`
    // 上传文件不包含本地路径（文件已上传到服务器，其他设备从服务器访问）
    const displayContent = JSON.stringify({ name: file.name, size: sizeStr, type: file.type || 'unknown' })

    // 乐观更新
    const localId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    items.value.unshift({
      id: localId,
      type: 'file',
      content: displayContent,
      source: 'Desktop',
      timestamp: Date.now(),
    })

    let deviceId: string | null = localStorage.getItem('clipsync-device-id')
    if (!deviceId) {
      try {
        const devRes = await api('GET', '/api/devices')
        const devList = devRes.data?.devices || devRes.data
        if (devRes.ok && Array.isArray(devList) && devList.length > 0) {
          deviceId = devList[0].id || devList[0].device_id || null
          if (deviceId) localStorage.setItem('clipsync-device-id', deviceId)
        }
      } catch { /* ignore */ }
    }
    if (!deviceId) throw new Error('No device ID')

    // 判断文件类型走不同上传路径
    if (file.type.startsWith('image/')) {
      // 图片 → 转 base64 data URL，大图压缩后上传
      const reader = new FileReader()
      const rawDataUrl: string = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsDataURL(file)
      })
      const dataUrl = await resizeImageIfNeeded(rawDataUrl)
      const res = await api('POST', '/api/clipboard', {
        contentType: 'image',
        content: dataUrl,
        contentEncrypted: dataUrl,
        sourceDeviceId: deviceId,
        mimeType: file.type,
        size: file.size,
        contentPreview: `[Image ${file.name}]`,
      })
      if (res.ok && res.data?.id) {
        const item = items.value.find(i => i.id === localId)
        if (item) { item.id = res.data.id; item.type = 'image'; item.content = dataUrl; item.preview = dataUrl }
        cacheContent(res.data.id, dataUrl)
      }
    } else if (shouldUseChunkedUpload(file)) {
      // Large file (>10MB) → 先创建条目，再分片上传，支持断点续传
      try {
        // Step 1: 在服务器创建条目（元数据）
        const createRes = await api('POST', '/api/clipboard', {
          contentType: 'file',
          content: displayContent,
          contentEncrypted: displayContent,
          sourceDeviceId: deviceId,
          mimeType: file.type,
          size: file.size,
          contentPreview: `${file.name} (${sizeStr})`,
        })
        const serverId = createRes.data?.id
        if (serverId) {
          const item = items.value.find(i => i.id === localId)
          if (item) item.id = serverId
        }
        // Step 2: 分片上传（localStorage 保存进度，支持刷新后恢复）
        await chunkedUpload(file, (progress) => {
          const item = items.value.find(i => i.id === (serverId || localId))
          if (item && !progress.done) {
            item.content = `${file.name} (${progress.percent}%)`
          }
        })
        // Step 3: 上传完成，更新最终内容
        const finalItem = items.value.find(i => i.id === (serverId || localId))
        if (finalItem) finalItem.content = displayContent
      } catch (e: any) {
        console.error('[Clipboard] Chunked upload failed:', e)
        throw e
      }
    } else {
      // Small file → upload via media/file endpoint (saves to disk, enables preview)
      const formData = new FormData()
      formData.append('file', file)
      formData.append('sourceDeviceId', deviceId)

      const res = await apiForm('/api/media/file', formData)
      if (res.ok && res.data?.id) {
        const item = items.value.find(i => i.id === localId)
        if (item) {
          item.id = res.data.id
          // Update content with server metadata for display
          item.content = JSON.stringify({
            name: file.name,
            size: sizeStr,
            type: file.type || 'unknown',
            serverFilename: res.data.contentEncrypted,
          })
          cacheContent(res.data.id, item.content)
        }
      } else {
        throw new Error(res.error || 'Upload failed')
      }
      return // early return, already handled
    }
  }

  const offlineQueueSize = computed(() => getQueueSize())

  return {
    items, filteredItems, searchQuery, activeFilter, batchMode, polling, loading,
    offlineQueueSize,
    selectedCount, allSelected, startPolling, copyItem,
    toggleSelectAll, clearSelection, batchDelete, deleteSingle, toggleFavorite,
    loadClipboardItems, setFilter, setSearch, toggleBatch, uploadFileItem,
    refresh: loadClipboardItems,
  }
}

