import { ref, computed } from 'vue'
import { listen } from '@tauri-apps/api/event'
import * as tauri from '@/lib/tauri'
import { api, apiBlob, apiForm } from '@/api/client'
import { useItemPassword } from '@/composables/useItemPassword'
import { useConfigStore } from '@/stores/configStore'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { enqueue, initOfflineSync, getQueueSize } from '@/utils/offlineQueue'
import { chunkedUpload, shouldUseChunkedUpload } from '@/utils/chunkedUpload'

const { t } = useI18n()
const toast = useSonner()

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
  favoritedAt?: number
  contentSize?: number
  metadata?: any
  // === 高级搜索 / 条目级密码 字段 ===
  sourceDeviceId?: string
  tags?: string[]
  isProtected?: boolean
  // === 归档字段 ===
  isArchived?: boolean
  // === 用户侧自动过期字段 ===
  expiresAt?: string | null
}

// === SINGLETON STATE - module-level refs shared across all callers ===
type ClipboardFilter = 'all' | 'text' | 'images' | 'links' | 'files' | 'favorites'
const VALID_FILTERS: ClipboardFilter[] = ['all', 'text', 'images', 'links', 'files', 'favorites']
const CLIPBOARD_FILTER_KEY = 'clipsync-clipboard-filter'

function loadSavedFilter(): ClipboardFilter {
  try {
    const saved = localStorage.getItem(CLIPBOARD_FILTER_KEY)
    if (saved && VALID_FILTERS.includes(saved as ClipboardFilter)) return saved as ClipboardFilter
  } catch { /* ignore */ }
  return 'all'
}

const items = ref<ClipItem[]>([])
const searchQuery = ref('')
const activeFilter = ref<ClipboardFilter>(loadSavedFilter())
const batchMode = ref(false)
const polling = ref(false)
const loading = ref(false)
// 分页状态 — 解决"删除后刷新总是固定 50 条"的感知问题。
// 后端是硬删（已验证），但前端每次只拉 page1(limit50)，删除可见项后旧条目滚入 page1，
// 让人以为删除没生效。改为：展示服务器总数 + "加载更多"按钮拉取后续分页。
const currentPage = ref(1)
const pageSize = ref(50)
// 当前视图：'all' = 主列表（默认隐藏已归档），'archive' = 仅归档视图。
// 用 module-level ref 让 setFilter/loadMore/clearAdvancedFilters 自动沿用当前视图，
// 避免切到归档视图后切换分类竟把非归档数据拉进来。
const currentView = ref<'all' | 'archive'>('all')
const totalItems = ref(0)
// 主剪贴板视图（非归档）的总数，用于侧边栏计数稳定显示：
// 归档视图拉取时只更新 totalItems，不覆盖 mainTotalItems，避免侧边栏「剪贴板」数字跳到归档数量。
const mainTotalItems = ref(0)
const loadingMore = ref(false)
const hasMore = computed(() => totalItems.value > 0 && items.value.length < totalItems.value)

// === 高级搜索筛选（device / date range）===
// 与 activeFilter/searchQuery 同理，使用 module-level ref 让筛选面板双向绑定，
// 并由 loadClipboardItems 读取它们拼接到后端查询参数。
const advancedFilters = ref<{
  deviceId: string
  dateFrom: string
  dateTo: string
}>({
  deviceId: '',
  dateFrom: '',
  dateTo: '',
})
// 设备列表（用于筛选下拉），懒加载 + 内存缓存，避免每次打开筛选面板都打 /api/devices
let devicesCache: { id: string; name: string; platform?: string }[] = []

let lastImageSize = 0
// 图片按 PNG content hash 去重（不是 Rust raw-DIB hash），避免某些剪贴板源
// （WeChat 截图、部分 GPU 驱动）的 raw bytes 碰撞导致后续截图被静默丢弃。
let lastImageHash = ''
let lastBrowserText = ''
const recentUploadHashes = new Map<string, number>()
const HASH_TTL = 30000 // 30s dedup window — covers monitor event + fallback poll + any retries

// === ClipSync 内部复制去重（精确内容匹配） ===
// 用户铁律：从 ClipSync UI 复制任何条目，都不应再次产生重复记录。
// 策略1: 时间戳跳过（复制后短时间内不处理剪贴板变化）
// 策略2: 精确内容匹配（复制时记录会写入剪贴板的内容/文件路径，monitor 检测到匹配内容时跳过）
let skipPollUntil = 0
// 初始加载后跳过轮询，防止系统剪贴板内容被重新上传
let initialLoadDone = false

// === 剪贴板事件上传队列（并发控制核心）===
// 问题：Rust monitor 每 700ms 轮询并立即 emit 事件；之前用 isProcessingEvent 布尔锁直接
// 丢弃并发事件，导致用户快速连续复制多个文件时只有一个能上传。
// 方案：所有事件/轮询检测到的内容先捕获并入队，队列串行消费，确保每个文件/图片/文本
// 都按序上传，互不抢占。
interface ClipboardTask {
  type: 'file' | 'image' | 'text'
  payload: any
}

const clipboardQueue: ClipboardTask[] = []
let isProcessingQueue = false

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

// === 剪贴板上传队列（并发控制核心）===
// 用真正的队列取代原来的 isProcessingEvent 丢弃策略，确保快速连续复制时每个文件/文本/图片
// 都能串行上传，而不是被并发锁直接丢弃。

function enqueueClipboardTask(task: ClipboardTask) {
  if (task.type === 'file') {
    const paths = task.payload as string[]
    const normalized = JSON.stringify(paths.map(normalizePath))
    if (clipboardQueue.some(t => t.type === 'file' && JSON.stringify((t.payload as string[]).map(normalizePath)) === normalized)) {
      console.log('[Clipboard] queue: skip duplicate file task', paths)
      return
    }
  } else if (task.type === 'text') {
    const text = task.payload as string
    if (clipboardQueue.some(t => t.type === 'text' && t.payload === text)) {
      console.log('[Clipboard] queue: skip duplicate text task')
      return
    }
  } else if (task.type === 'image') {
    const p = task.payload as { dataUrl?: string; hash?: string }
    const key = p.hash || p.dataUrl
    if (key && clipboardQueue.some(t => t.type === 'image' && ((t.payload as { dataUrl?: string; hash?: string }).hash || (t.payload as { dataUrl?: string }).dataUrl) === key)) {
      console.log('[Clipboard] queue: skip duplicate image task')
      return
    }
  }
  clipboardQueue.push(task)
  console.log('[Clipboard] queue: task enqueued', task.type, 'length:', clipboardQueue.length)
  processClipboardQueue().catch(e => console.warn('[Clipboard] processClipboardQueue error:', e))
}

async function processClipboardQueue() {
  if (isProcessingQueue) return
  isProcessingQueue = true
  try {
    while (clipboardQueue.length > 0) {
      const task = clipboardQueue.shift()
      if (!task) continue
      console.log('[Clipboard] queue: processing task', task.type, 'remaining:', clipboardQueue.length)
      try {
        if (task.type === 'file') {
          const paths = task.payload as string[]
          const payload = JSON.stringify(paths)
          const payloadHash = simpleHash(payload)
          const alreadyUploading = recentUploadHashes.has(payloadHash) &&
            Date.now() - (recentUploadHashes.get(payloadHash) || 0) < HASH_TTL
          if (!alreadyUploading && !items.value.some(i => i.type === 'file' && i.content === payload)) {
            await uploadFileToServer(payload)
          } else {
            console.log('[Clipboard] queue: skip file already uploading or exists', paths)
          }
        } else if (task.type === 'text') {
          const text = task.payload as string
          const isUrl = /^https?:\/\/\S+$/.test(text.trim())
          const itemType = isUrl ? 'link' : 'text'
          // 先从 copiedTexts/copiedItems 判断：这是自己刚复制出去的内容，必须跳过。
          // 不能仅靠 items.value.some(i.content === text) 去重，因为列表里可能是预览内容，
          // 而剪贴板/服务端已经是完整内容，导致复制长文本后又被当作新内容重复上传。
          if (isClipboardChangeFromInternalCopy({ content: text }, undefined)) {
            console.log('[Clipboard] queue: skip text from internal copy')
            continue
          }
          if (!items.value.some(i => (i.type === 'text' || i.type === 'link') && i.content === text)) {
            await uploadToServer(text, itemType)
          } else {
            console.log('[Clipboard] queue: skip text already exists')
          }
      } else if (task.type === 'image') {
        const { dataUrl, hash } = task.payload as { dataUrl: string; size: number; hash?: string }
        if (dataUrl) {
          await uploadImageToServer(dataUrl, hash)
        }
      }
      } catch (e) {
        console.warn('[Clipboard] queue: task error', task.type, e)
      }
    }
  } finally {
    isProcessingQueue = false
    // 处理期间可能有新任务入队，触发再消费
    if (clipboardQueue.length > 0) {
      processClipboardQueue().catch(e => console.warn('[Clipboard] processClipboardQueue restart error:', e))
    }
  }
}

const filteredItems = computed(() => {
  let result = items.value
  if (activeFilter.value !== 'all') {
    result = result.filter(i => {
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
// 设计约束：
// 1. 只缓存文本/链接内容，不缓存图片 base64（图片走 blob URL + 服务端，避免 localStorage 和内存爆炸）。
// 2. 启动时自动清理旧版遗留的大体积图片 base64。
// 3. 限制总大小，防止单条过长或累计过多撑爆 WebView 内存。
const CONTENT_CACHE_KEY = 'clipsync-content-cache-v2'
const CONTENT_CACHE_MAX = 100 // 最多缓存条数
const CONTENT_CACHE_MAX_TOTAL_SIZE = 500 * 1024 // 总大小上限 500KB
const CONTENT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000 // 7天过期

interface CacheEntry { v: string; t: number } // value + timestamp

function loadContentCache(): Map<string, CacheEntry> {
  try {
    const raw = localStorage.getItem(CONTENT_CACHE_KEY)
    if (!raw) return new Map()

    // 旧版迁移：如果缓存整体超过 1MB，说明存了大量图片 base64，直接清空重建，
    // 避免首次启动就把几十 MB 数据读进 WebView 内存。
    if (raw.length > 1024 * 1024) {
      console.warn('[Clipboard] Old content cache too large, clearing:', (raw.length / 1024 / 1024).toFixed(2), 'MB')
      localStorage.removeItem(CONTENT_CACHE_KEY)
      return new Map()
    }

    const arr: [string, CacheEntry][] = JSON.parse(raw)
    const cache = new Map(arr)
    const now = Date.now()
    let dirty = false
    for (const [k, v] of cache) {
      // 清理过期条目
      if (now - v.t > CONTENT_CACHE_TTL) {
        cache.delete(k)
        dirty = true
        continue
      }
      // 清理旧版遗留的大体积图片 base64
      if (v.v && v.v.startsWith('data:image') && v.v.length > 1024) {
        cache.delete(k)
        dirty = true
      }
    }
    if (dirty) saveContentCache(cache)
    return cache
  } catch { return new Map() }
}

function saveContentCache(cache: Map<string, CacheEntry>) {
  // 先按总大小淘汰：value 越长越先淘汰，直到总大小低于上限
  let entries = [...cache.entries()].sort((a, b) => a[1].t - b[1].t)
  let totalSize = entries.reduce((sum, [, e]) => sum + (e.v?.length || 0), 0)
  while (totalSize > CONTENT_CACHE_MAX_TOTAL_SIZE && entries.length > 0) {
    const removed = entries.shift()
    if (removed) totalSize -= removed[1].v.length
  }
  // 再按条数淘汰
  while (entries.length > CONTENT_CACHE_MAX) {
    entries.shift()
  }
  cache = new Map(entries)
  try {
    localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify([...cache]))
  } catch (e: any) {
    // localStorage 配额超限 — 淘汰最旧的半数后重试
    const reduced = entries.slice(Math.floor(entries.length / 2))
    try {
      localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify(reduced))
    } catch { /* 彻底放弃 */ }
  }
}

function cacheContent(id: string, content: string) {
  if (!content || !id) return
  try {
    // 图片 base64 不再进缓存：避免单张截图 1-3MB 把 localStorage / 内存撑爆。
    // 图片显示依赖 blob URL 或按需从服务端拉取，已足够。
    if (content.startsWith('data:image')) return
    const cache = loadContentCache()
    cache.set(id, { v: content.slice(0, 5000), t: Date.now() })
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

async function loadClipboardItems(opts?: { page?: number; append?: boolean; all?: boolean; favorite?: boolean; view?: 'all' | 'archive' }) {
  const page = opts?.page ?? 1
  const append = opts?.append ?? false
  const loadAll = opts?.all ?? false
  const loadFavorites = opts?.favorite ?? false
  // 视图：归档视图(view=archive)只拉 archived=TRUE 的条目；默认沿用 currentView，
  // 保证分类切换/加载更多时不丢失归档上下文。
  const view = opts?.view || currentView.value
  currentView.value = view
  if (!append) currentPage.value = page
  if (append) loadingMore.value = true; else loading.value = true
  const limit = loadAll ? 500 : (loadFavorites ? 200 : pageSize.value)
  const favParam = loadFavorites ? '&favorites=true' : ''
  const viewParam = view === 'archive' ? '&view=archive' : ''
  // 按当前分类筛选：后端直接过滤并返回该类型总数，避免"图片分类下显示全部总数"的 bug。
  // 注意 filter 值与后端 content_type 的映射：images -> image，links -> link，files -> file。
  const filterToContentType: Record<string, string> = { text: 'text', images: 'image', links: 'link', files: 'file' }
  const contentType = (!loadAll && !loadFavorites) ? (filterToContentType[activeFilter.value] || '') : ''
  const typeParam = contentType ? `&contentType=${encodeURIComponent(contentType)}` : ''
  // 高级筛选参数：deviceId / dateFrom / dateTo，全部走后端精确过滤。
  // 注意：加载"全部/收藏"时仍可叠加这些筛选；但 all=true 模式用来表示"不按分类裁剪"，
  // 与高级筛选是正交的，故始终附加。
  const af = advancedFilters.value
  const advParts: string[] = []
  if (af.deviceId && af.deviceId.trim()) advParts.push(`deviceId=${encodeURIComponent(af.deviceId.trim())}`)
  if (af.dateFrom && af.dateFrom.trim()) advParts.push(`dateFrom=${encodeURIComponent(af.dateFrom.trim())}`)
  if (af.dateTo && af.dateTo.trim()) advParts.push(`dateTo=${encodeURIComponent(af.dateTo.trim())}`)
  const advParamStr = advParts.length > 0 ? `&${advParts.join('&')}` : ''
  try {
  const res = await api('GET', `/api/clipboard?page=${page}&limit=${limit}${loadAll ? '&all=true' : ''}${favParam}${typeParam}${advParamStr}${viewParam}`)
  if (res.ok && Array.isArray(res.data?.items)) {
    totalItems.value = res.data?.pagination?.total ?? res.data.items.length
    // 仅在主视图（all）更新侧边栏计数，归档视图不覆盖主视图总数
    if (view !== 'archive') {
      mainTotalItems.value = totalItems.value
    }
    const serverIds = new Set(res.data.items.map((i: any) => i.id))
    // Build set of server content previews for dedup
    const serverContentPreviews = new Set(res.data.items.map((i: any) => (i.contentPreview || '').slice(0, 100)))
    // 整表刷新时只保留本地乐观更新项（临时 ID），避免切换分类/收藏夹后旧分类的服务器条目
    // 因为不在新分类第一页而被残留到列表最前面，导致“切到全部后链接/收藏数据置顶”的错乱。
    const localWithContent = items.value.filter(i => {
      // 仅保留本地临时 ID 的乐观项；正式服务器 ID 的条目应当完全由本次接口返回决定顺序与内容。
      const isLocal = i.id.startsWith('local-') || i.id.startsWith('text-') || i.id.startsWith('img-') || i.id.startsWith('browser-')
      if (!isLocal) return false
      if (serverIds.has(i.id)) return false
      if (!i.content || !i.content.trim()) return false
      // File items with local-/file- prefix are optimistic updates — always replace with server data
      if (i.type === 'file' && (i.id.startsWith('local-') || i.id.startsWith('file-'))) return false
      // Check if this local item matches a server item by content preview
      const localPreview = i.content.slice(0, 100)
      if (serverContentPreviews.has(localPreview)) return false
      return true
    })
    const serverItems = res.data.items.map((i: any) => {
      const isImage = (i.contentType || i.type) === 'image'
      // 复用已在列表里加载好的图片预览（blob URL），避免刷新时重新拉取并生成新 blob
      // 造成内存膨胀/闪烁。仅当服务端条目与本地已加载条目 ID 一致时复用。
      const existingImage = isImage ? items.value.find(e => e.id === i.id && e.type === 'image') : undefined
      const existingPreview = existingImage?.preview || ''
      const cachedContent = getCachedContent(i.id)
      let content: string
      if (isImage) {
        content = cachedContent || ''
        // 图片异步加载：不在这里触发，统一放到下面的队列
      } else {
        const existing = items.value.find(e => e.id === i.id && e.content)
        content = existing?.content || cachedContent || i.contentPreview || i.content || ''
        // For file items: reconstruct content with paths from metadata if available
        if ((i.contentType || i.type) === 'file') {
          try {
            // metadata may be a JSON string (from API) or already-parsed object (from pg driver)
            const rawMeta = typeof i.metadata === 'string' ? i.metadata : JSON.stringify(i.metadata || {})
            const meta = JSON.parse(rawMeta || '{}')
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
            const rawMeta = typeof i.metadata === 'string' ? i.metadata : JSON.stringify(i.metadata || {})
            const meta = JSON.parse(rawMeta || '{}')
            if (meta.originalName) content = meta.originalName
            else if (meta.name) content = meta.name
          } catch { /* not JSON */ }
          // Still too long? Use contentPreview as filename
          if (content.length > 200 && i.contentPreview) {
            content = i.contentPreview.split(/[/\\]/).pop() || i.contentPreview
          }
        }
      }
      const preview = isImage ? (cachedContent || existingPreview || '') : content
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
        favoritedAt: i.favoritedAt ? new Date(i.favoritedAt).getTime() : undefined,
        metadata: (() => {
          // 从服务端 protectionLevel 同步元数据标记
          const meta = i.metadata && typeof i.metadata === 'object' ? { ...i.metadata } : {}
          if (i.protectionLevel === 'advanced') meta.protected = true
          else if (i.protectionLevel === 'pin') meta.sensitive = true
          return meta
        })(),
        contentSize: i.contentSize,
        // === 高级搜索 / 条目级密码 ===
        sourceDeviceId: i.sourceDevice?.id || i.sourceDeviceId || undefined,
        tags: (i.metadata && Array.isArray(i.metadata.tags)) ? i.metadata.tags : undefined,
        isProtected: !!(i.metadata && i.metadata.protected === true) || !!(i.metadata && i.metadata.sensitive === true) || (i.protectionLevel && i.protectionLevel !== 'none'),
        // === 归档字段：后端 archived 标志映射到本地条目 ===
        isArchived: !!i.archived,
        expiresAt: i.expires_at ?? null,
      }
    })
    if (append) {
      // 追加模式（加载更多）：把本页服务端条目中本地还没有的追加进去，避免重复。
      const existingIds = new Set(items.value.map(i => i.id))
      const merged = items.value.slice()
      for (const s of serverItems) {
        if (!existingIds.has(s.id)) merged.push(s)
      }
      // 释放被移除条目的 blob URL（追加模式通常不会移除，但保持一致性）
      releaseRemovedObjectUrls(merged)
      items.value = merged
    } else {
      // 整表刷新：先释放不再出现的旧图片 blob，再替换
      releaseRemovedObjectUrls([...localWithContent, ...serverItems])
      items.value = [...localWithContent, ...serverItems]
    }

    // 队列化加载图片：每批 3 张，间隔 200ms，避免并发过高被限流。
    // 已带有预览（blob/data URL）的条目跳过，避免重复拉取并生成新 blob。
    const imageQueue = serverItems.filter((i: ClipItem) => i.type === 'image' && !i.preview && !getCachedContent(i.id) && i.id)
    loadImagesFromQueue(imageQueue)
  } else {
    return
  }
  } finally {
    if (append) loadingMore.value = false; else loading.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  const next = currentPage.value + 1
  await loadClipboardItems({ page: next, append: true })
  currentPage.value = next
}

// === 高级搜索：设备列表（用于筛选下拉）===
async function loadDevices(): Promise<{ id: string; name: string; platform?: string }[]> {
  if (devicesCache.length > 0) return devicesCache
  try {
    const res = await api('GET', '/api/devices')
    const list = res.data?.devices || res.data
    if (res.ok && Array.isArray(list)) {
      devicesCache = list.map((d: any) => ({
        id: d.id,
        name: d.device_name || d.deviceName || d.id,
        platform: d.platform,
      }))
    }
  } catch (e: any) {
    console.warn('[Clipboard] loadDevices failed:', e?.message || e)
  }
  return devicesCache
}

// === 条目级内容更新（标签 / 条目级密码 protection 标记 / 内容本身）===
// 后端 PUT /api/clipboard/:id 做浅合并：只接受 metadata 白名单字段
// (protected/protectedAt/tags) 与可选的 content/contentPreview/contentSize。
async function updateItemContent(
  itemId: string,
  payload: {
    metadata?: Record<string, any>
    content?: string
    contentPreview?: string
    contentSize?: number
  },
): Promise<boolean> {
  try {
    const res = await api('PUT', `/api/clipboard/${itemId}`, payload)
    if (!res.ok) {
      console.warn('[Clipboard] updateItemContent failed:', res.status, res.error)
      return false
    }
    // 乐观更新：把返回的最新值同步到本地列表对应条目，避免整表刷新闪烁。
    const updated = res.data
    if (updated) {
      const item = items.value.find(i => i.id === itemId)
      if (item) {
        if (updated.metadata !== undefined) {
          item.metadata = updated.metadata
          const meta = updated.metadata
          item.tags = Array.isArray(meta?.tags) ? meta.tags : item.tags
          item.isProtected = !!(meta && meta.protected === true)
        }
        if (updated.contentPreview !== undefined) item.preview = updated.contentPreview
        if (updated.contentSize !== undefined) item.contentSize = updated.contentSize
        if (updated.sourceDeviceId !== undefined) item.sourceDeviceId = updated.sourceDeviceId
      }
    }
    return true
  } catch (e: any) {
    console.warn('[Clipboard] updateItemContent error:', e?.message || e)
    return false
  }
}

// === 清空高级筛选并重新拉取 ===
function clearAdvancedFilters() {
  advancedFilters.value = { deviceId: '', dateFrom: '', dateTo: '' }
  loadClipboardItems({ page: 1, append: false })
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
          // 用 setItemPreview 自动回收被替换的旧 blob URL，避免内存泄漏
          setItemPreview(current, renderSrc)
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

// 文本同步大小上限：比后端 express.json 的 10MB 小 1MB 留余量，避免 413 Payload Too Large
const MAX_TEXT_UPLOAD_SIZE = 9 * 1024 * 1024

async function uploadToServer(content: string, type: ClipItem['type'] = 'text') {
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
    } catch { /* ignore */ }
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
      const localItem = items.value.find(i => i.id === localId)
      if (localItem) {
        localItem.id = res.data.id
        cacheContent(res.data.id, content)
      }
      return
    }
    // 上传失败：从本地列表移除乐观项，避免残留脏数据
    items.value = items.value.filter(i => i.id !== localId)
    if (res.status === 413) {
      toast.show(t('text_too_large', { n: Math.round(MAX_TEXT_UPLOAD_SIZE / 1024 / 1024) }), 'warning')
    } else {
      toast.show(t('text_upload_failed') + (res.error ? `: ${res.error}` : ''), 'error')
    }
  } catch (e: any) {
    // 网络/未知异常：同样移除乐观项并提示
    items.value = items.value.filter(i => i.id !== localId)
    toast.show(t('text_upload_failed') + (e?.message ? `: ${e.message}` : ''), 'error')
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

async function uploadImageToServer(dataUrl: string, contentHash?: string) {
  // Dedup by FULL-CONTENT hash, NOT a 200-char prefix. Two screenshots of the same
  // window have identical PNG file headers and identical first compressed bytes, so a
  // prefix key collides and silently drops every subsequent screenshot within 30s.
  // Prefer the Rust FNV content hash (passed through from the clipboard monitor);
  // fall back to a full string hash when it is unavailable.
  const dedupKey = (contentHash && contentHash.length > 0) ? contentHash : simpleHash(dataUrl)
  if (recentUploadHashes.has(dedupKey) && Date.now() - (recentUploadHashes.get(dedupKey) || 0) < HASH_TTL) return
  recentUploadHashes.set(dedupKey, Date.now())
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
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) {
    console.log('[Clipboard] uploadFileToServer: skip duplicate hash', hash)
    return
  }
  recentUploadHashes.set(hash, Date.now())

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

// === 图片 Object URL 生命周期管理（修复内存泄漏）===
// loadImagesFromQueue 用 URL.createObjectURL(blob) 生成预览图，但浏览器不会自动回收 blob，
// 必须显式 revokeObjectURL。否则列表刷新/加载更多/删除图片时，旧 blob 持续占用 WebView 内存
// （实测空闲 ~147MB，同类应用约 60MB，差距主要来自未释放的图片对象）。
// 用 id→url 映射精确跟踪每个图片条目的 blob，替换/删除/登出时释放。
const imageObjectUrls = new Map<string, string>()

function isBlobUrl(s: any): s is string {
  return typeof s === 'string' && s.startsWith('blob:')
}

/** 给条目设置预览图，自动回收被替换掉的旧 blob URL */
function setItemPreview(item: ClipItem, url: string) {
  if (item.preview && isBlobUrl(item.preview)) {
    const old = imageObjectUrls.get(item.id)
    if (old && old !== url) {
      URL.revokeObjectURL(old)
      imageObjectUrls.delete(item.id)
    }
  }
  item.preview = url
  if (isBlobUrl(url)) {
    imageObjectUrls.set(item.id, url)
  } else if (imageObjectUrls.has(item.id)) {
    // 预览被换成 data URL 或清空，解除跟踪
    imageObjectUrls.delete(item.id)
  }
}

/** 列表即将被替换/过滤前调用：释放不再被任何条目引用的 blob URL */
function releaseRemovedObjectUrls(nextItems: ClipItem[]) {
  const liveUrls = new Set<string>()
  for (const it of nextItems) {
    if (isBlobUrl(it.preview)) liveUrls.add(it.preview)
  }
  for (const [id, url] of imageObjectUrls) {
    if (!liveUrls.has(url)) {
      URL.revokeObjectURL(url)
      imageObjectUrls.delete(id)
    }
  }
}

/** 强制释放所有图片 blob URL（切换账号 / 清空列表时调用） */
function releaseAllObjectUrls() {
  for (const [, url] of imageObjectUrls) {
    try { URL.revokeObjectURL(url) } catch { /* 已失效则忽略 */ }
  }
  imageObjectUrls.clear()
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
    // 策略1: 时间戳跳过（复制后 3 秒内不处理，由 copyItem 设置）
    if (Date.now() < skipPollUntil) return

    if (!initialLoadDone) {
      // 第一次轮询：只记录当前剪贴板状态，不上传，避免启动时把当前已有内容重新上传。
      initialLoadDone = true
      const imgInfo = await tauri.checkClipboardImageInfo().catch(() => ({ available: false, size: 0, hash: '' }))
      if (imgInfo.available) {
        // 用 PNG 内容哈希（与事件/兜底轮询同一套算法）作为启动基线，避免不同哈希族导致
        // 启动时的剪贴板图片被误判为新图而重传。
        const initData = await tauri.getClipboardImage().catch(() => '')
        if (initData) {
          lastImageHash = simpleHash(initData)
          lastImageSize = imgInfo.size
        }
      }
      return
    }

    // 优先尝试 Tauri API
    const files = await tauri.getClipboardFiles().catch(() => [] as string[])
    if (files.length > 0) {
      console.log('[Clipboard] poll detected files:', files)
      // 精确匹配：如果这是刚从 ClipSync 内部复制出去的文件路径，直接跳过
      if (isClipboardChangeFromInternalCopy({ filePaths: files }, 'file')) return
      enqueueClipboardTask({ type: 'file', payload: files })
      return
    }

    // Fallback 兜底轮询：事件驱动可能丢事件或 Rust raw-hash 误判，所以每隔 10s
    // 直接拉取当前剪贴板 PNG 并用自己的 PNG content hash 去重。
    const imgInfo = await tauri.checkClipboardImageInfo().catch(() => ({ available: false, size: 0, hash: '' }))
    if (imgInfo.available) {
      const imgData = await tauri.getClipboardImage().catch((e: any) => {
        console.warn('[Clipboard] fallback poll getClipboardImage failed:', e)
        return ''
      })
      if (imgData) {
        const pngHash = simpleHash(imgData)
        if (pngHash !== lastImageHash) {
          lastImageSize = imgInfo.size
          lastImageHash = pngHash
          enqueueClipboardTask({ type: 'image', payload: { dataUrl: imgData, size: imgInfo.size, hash: pngHash } })
        } else {
          console.log('[Clipboard] fallback poll: PNG hash matches last image, skipping')
        }
      }
      return
    }

    const text = await tauri.getClipboardContent().catch(() => '')
    if (text && text.trim()) {
      // 精确匹配：如果这是刚从 ClipSync 内部复制出去的文本，直接跳过
      if (isClipboardChangeFromInternalCopy({ content: text }, undefined)) return
      enqueueClipboardTask({ type: 'text', payload: text })
      return
    }

    // Fallback: 浏览器 Clipboard API (非 Tauri 环境)
    if (typeof navigator !== 'undefined' && navigator.clipboard && !(window as any).__TAURI__) {
      try {
        const clipText = await navigator.clipboard.readText().catch(() => '')
        if (clipText && clipText.trim() && clipText !== lastBrowserText) {
          lastBrowserText = clipText
          enqueueClipboardTask({ type: 'text', payload: clipText })
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

      const contentType = payload?.contentType as string | undefined

      if (contentType === 'file') {
        // File event from Rust: content is preview text, filePaths is the array
        const filePaths = payload?.filePaths as string[] | undefined
        if (filePaths && filePaths.length > 0) {
          // If this file path was just copied from ClipSync UI, skip it
          if (isClipboardChangeFromInternalCopy(payload, 'file')) return

          console.log('[Clipboard] enqueue file event:', filePaths)
          enqueueClipboardTask({ type: 'file', payload: filePaths })
        }
      } else if (contentType === 'image') {
        // Image event from Rust. The monitor snapshots the PNG dataUrl AT DETECTION TIME
        // and ships it in payload.dataUrl. Use it directly — do NOT re-read the live
        // clipboard: rapid successive screenshots would all resolve to the last clipboard
        // image and only the last one would sync. Fall back to getClipboardImage() only
        // for older monitor builds that don't snapshot.
        if (Date.now() < skipPollUntil) return
        const size = (payload?.size as number | undefined) ?? 0
        const captured = (payload?.dataUrl as string | undefined) || ''
        console.log('[Clipboard] event: image received, size=', size, 'hasData=', !!captured)
        let imgData = captured
        if (!imgData) {
          imgData = await tauri.getClipboardImage().catch((e: any) => {
            console.error('[Clipboard] getClipboardImage failed:', e)
            return ''
          })
        }
        if (imgData) {
          // Dedup by the FULL PNG content hash (simpleHash over the entire dataUrl).
          // We deliberately do NOT use the Rust `eventHash` here: the monitor's PNG hash
          // (FNV-1a over bytes) is a different hash family than the JS simpleHash used by
          // the 10s fallback poll (readAndUpload), so mixing them would let the fallback
          // re-enqueue an already-synced image. One consistent hash across both paths is
          // what guarantees consecutive different screenshots all sync and none is re-uploaded.
          const dedupHash = simpleHash(imgData)
          if (dedupHash !== lastImageHash) {
            lastImageSize = size
            lastImageHash = dedupHash
            enqueueClipboardTask({ type: 'image', payload: { dataUrl: imgData, size, hash: dedupHash } })
          } else {
            console.log('[Clipboard] event: hash matches last image, skipping duplicate')
          }
        } else {
          console.warn('[Clipboard] Image data empty — capture failed')
        }
      } else if (!contentType) {
        // Text event from Rust: content is the clipboard text
        const text = payload?.content as string | undefined
        if (text && text.trim()) {
          // If this text was just copied from ClipSync UI, skip it
          if (isClipboardChangeFromInternalCopy(payload, undefined)) return
          enqueueClipboardTask({ type: 'text', payload: text })
        }
      }
    } catch (e) {
      console.warn('[Clipboard] Event handler error:', e)
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
    // The Rust thread polls the clipboard sequence number every 100ms and reads
    // bytes only when the OS reports a genuine change. Image PNG encoding runs in
    // a dedicated worker thread so rapid consecutive screenshots are not dropped
    // while the loop is blocked compressing the previous one.
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
      // === 条目级密码保护：受保护且未解锁的条目禁止复制 ===
      // 受保护且已解锁的条目：用会话内存中的明文（服务端存的是密文，不能从 /content 拉）。
      const itemPw = useItemPassword()
      if (itemPw.isItemProtected(item)) {
        if (!itemPw.isUnlocked(item.id)) {
          console.warn('[Clipboard] copy blocked: item is password protected and locked')
          return false
        }
      }

      // 精确内容去重：复制时记录会写入剪贴板的实际内容/路径，monitor 检测到相同内容时跳过
      // 窗口只开 3s：足够 monitor 下一次轮询跳过自身复制，同时不会误杀紧接着的外部复制。
      skipNextPolls(3000)
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
          // 优先写入实际图片格式
          try {
            const resp = await fetch(dataUrl)
            const blob = await resp.blob()
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          } catch {
            await tauri.setClipboardContent(dataUrl)
          }
          // 写入后记录当前剪贴板图片的哈希，避免兜底轮询把它当作新截图重新上传
          try {
            const info = await tauri.checkClipboardImageInfo()
            lastImageSize = info.size
            lastImageHash = info.hash || ''
          } catch { /* ignore */ }
          return true
        }
        return false
      }

      // 文本/链接/代码：item.content 可能是服务端返回的 contentPreview（<=5000 字符）。
      // 如果已知 contentSize 且当前 content 不完整，先从服务器拉取完整内容再写入剪贴板。
      // 老数据 contentSize 可能为 0，对非空服务端条目也尝试拉取，确保不会只复制 200 字符预览。
      let textContent = item.content
      const isLocalItem = /^local-|^text-|^file-|^img-|^browser-/.test(item.id)
      const contentSize = item.contentSize || 0
      // 受保护且已解锁：服务端存的是密文，必须用会话内存里的明文，绝不向 /content 拉取。
      if (itemPw.isItemProtected(item) && itemPw.isUnlocked(item.id)) {
        textContent = itemPw.getUnlockedPlaintext(item.id) ?? item.content
      }
      const needsFetch = !isLocalItem && !itemPw.isItemProtected(item) && textContent.length > 0 &&
        (contentSize === 0 || textContent.length < contentSize)
      if (needsFetch) {
        try {
          const full = await api<{ contentEncrypted: string }>('GET', `/api/clipboard/${item.id}/content`)
          if (full.ok && full.data?.contentEncrypted) {
            textContent = full.data.contentEncrypted
            cacheContent(item.id, textContent)
          }
        } catch (e: any) {
          console.warn('[Clipboard] failed to fetch full text content for copy:', e?.message || e)
        }
      }
      // 记录实际写入剪贴板的内容，用于 monitor 去重。
      // 必须在这里重新记录，因为上面可能已经把 item.content（预览）替换成了完整内容；
      // 如果只按 item.content 去重，剪贴板里的完整文本和记录的预览不一致，会导致重复同步。
      const now = Date.now()
      copiedTexts.set(textContent, now)
      copiedItems.set(item.id, { type: item.type, content: textContent, timestamp: now })
      cleanupCopiedContent()

      await tauri.setClipboardContent(textContent)
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
    let res: any = { ok: true, status: 200 }
    if (serverIds.length > 0) {
      res = await apiOrEnqueue('DELETE', '/api/clipboard', { ids: serverIds }, 'delete', { ids: serverIds })
      if (!res.ok && res.status !== 0) {
        console.error('[Clipboard] batchDelete server error:', res.status, res.error)
        throw new Error(res.error || `删除失败 (HTTP ${res.status})`)
      }
    }
    // 仅在服务端确认成功后才从本地列表移除选中项
    const selectedIds = new Set(selected.map(i => i.id))
    const nextItems = items.value.filter(i => !selectedIds.has(i.id))
    // 释放被删除条目占用的图片 blob URL
    releaseRemovedObjectUrls(nextItems)
    items.value = nextItems
    // 同步本地总数（后端是硬删）。不减会导致 hasMore/remaining 计算偏差，
    // 出现"加载更多"按钮卡在末尾删不掉项的情况。
    if (serverIds.length > 0 && (res.ok || res.status === 0)) {
      totalItems.value = Math.max(0, totalItems.value - serverIds.length)
      if (currentView.value !== 'archive') {
        mainTotalItems.value = Math.max(0, mainTotalItems.value - serverIds.length)
      }
    }
    // 批量删除后跳过轮询，防止系统剪贴板内容被重新上传
    skipNextPolls(3000)
    return count
  }

  async function deleteSingle(item: ClipItem) {
    const isLocal = item.id.startsWith('local-') || item.id.startsWith('text-') || item.id.startsWith('img-')
    let res: any = { ok: true, status: 200 }
    if (!isLocal) {
      res = await apiOrEnqueue('DELETE', `/api/clipboard/${item.id}`, undefined, 'delete', { id: item.id })
      if (!res.ok && res.status !== 0) {
        console.error('[Clipboard] deleteSingle server error:', res.status, res.error)
        throw new Error(res.error || `删除失败 (HTTP ${res.status})`)
      }
    }
    // 仅在服务端确认成功（或是本地临时项）后才从本地列表移除
    const nextItems = items.value.filter(i => i.id !== item.id)
    // 释放被删除条目占用的图片 blob URL
    releaseRemovedObjectUrls(nextItems)
    items.value = nextItems
    // 同步本地总数（后端是硬删），保持 hasMore/remaining 计算正确
    if (!isLocal && res && (res.ok || res.status === 0)) {
      totalItems.value = Math.max(0, totalItems.value - 1)
      if (currentView.value !== 'archive') {
        mainTotalItems.value = Math.max(0, mainTotalItems.value - 1)
      }
    }
    // 删除后跳过轮询，防止系统剪贴板内容被重新上传
    skipNextPolls(3000)
  }

  async function toggleFavorite(item: ClipItem) {
    // 乐观更新
    const prev = (item as any).isFavorite
    const prevFavAt = (item as any).favoritedAt
    ;(item as any).isFavorite = !prev
    ;(item as any).favoritedAt = !prev ? Date.now() : undefined
    const res = await api('PUT', `/api/clipboard/${item.id}/favorite`)
    if (!res.ok) {
      // 回滚
      ;(item as any).isFavorite = prev
      ;(item as any).favoritedAt = prevFavAt
      console.warn('[Clipboard] toggleFavorite failed:', res.error)
    }
  }

  /**
   * 归档条目：调用 PUT /api/clipboard/:id { archived: true }。
   * 乐观更新本地 isArchived 并从当前列表移除（后端 view=all 默认排除 archived，
   * 移除可避免"归档后还留在主列表"的感知错位）。失败回滚。
   */
  async function archiveItem(item: ClipItem): Promise<boolean> {
    const prev = item.isArchived
    item.isArchived = true
    try {
      const res = await api('PUT', `/api/clipboard/${item.id}`, { archived: true })
      if (!res.ok) {
        item.isArchived = prev
        console.warn('[Clipboard] archiveItem failed:', res.error)
        return false
      }
      // 从当前视图移除（归档视图由 view=archive 单独拉取）
      const next = items.value.filter(i => i.id !== item.id)
      releaseRemovedObjectUrls(next)
      items.value = next
      if (totalItems.value > 0) totalItems.value = Math.max(0, totalItems.value - 1)
      if (currentView.value !== 'archive') {
        mainTotalItems.value = Math.max(0, mainTotalItems.value - 1)
      }
      skipNextPolls(3000)
      return true
    } catch (e: any) {
      item.isArchived = prev
      console.warn('[Clipboard] archiveItem error:', e?.message || e)
      return false
    }
  }

  /**
   * 取消归档：调用 PUT /api/clipboard/:id { archived: false }。
   * 乐观更新并从当前（归档）视图移除；失败回滚。
   */
  async function unarchiveItem(item: ClipItem): Promise<boolean> {
    const prev = item.isArchived
    item.isArchived = false
    try {
      const res = await api('PUT', `/api/clipboard/${item.id}`, { archived: false })
      if (!res.ok) {
        item.isArchived = prev
        console.warn('[Clipboard] unarchiveItem failed:', res.error)
        return false
      }
      const next = items.value.filter(i => i.id !== item.id)
      releaseRemovedObjectUrls(next)
      items.value = next
      if (totalItems.value > 0) totalItems.value = Math.max(0, totalItems.value - 1)
      mainTotalItems.value += 1
      skipNextPolls(3000)
      return true
    } catch (e: any) {
      item.isArchived = prev
      console.warn('[Clipboard] unarchiveItem error:', e?.message || e)
      return false
    }
  }

  /**
   * 设置/清除用户侧自动过期：调用 PUT /api/clipboard/:id { expiresAt }。
   * iso 为 null 表示清除过期；否则传 ISO 字符串。乐观更新本地 expiresAt，失败回滚。
   */
  async function setExpiry(item: ClipItem, iso: string | null): Promise<boolean> {
    const prev = item.expiresAt
    item.expiresAt = iso
    try {
      const res = await api('PUT', `/api/clipboard/${item.id}`, { expiresAt: iso })
      if (!res.ok) {
        item.expiresAt = prev
        console.warn('[Clipboard] setExpiry failed:', res.error)
        return false
      }
      skipNextPolls(3000)
      return true
    } catch (e: any) {
      item.expiresAt = prev
      console.warn('[Clipboard] setExpiry error:', e?.message || e)
      return false
    }
  }

  function setFilter(f: ClipboardFilter) {
    if (activeFilter.value === f) return
    activeFilter.value = f
    try { localStorage.setItem(CLIPBOARD_FILTER_KEY, f) } catch { /* ignore */ }
    // 切换分类后必须按新分类重新从后端拉取，否则总数/剩余数都是按全部类型算的。
    loadClipboardItems({ page: 1, append: false })
  }
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

  // 检测内容是否包含敏感信息（API key、密码、token、私钥等）
  function isSensitiveContent(text: string): boolean {
    if (!text || text.length > 5000) return false
    const t = text.trim()
    // AI/Cloud API keys with known prefixes
    if (/\b(AKIA|AIza|sk-or-v1-|sk-proj-|sk-ant-|sk-)[A-Za-z0-9]{16,}\b/.test(t)) return true
    // GitHub personal access token
    if (/\bghp_[A-Za-z0-9]{36}\b/.test(t)) return true
    // Stripe secret key
    if (/\bsk_live_[A-Za-z0-9]{24,}\b/.test(t)) return true
    // Slack token
    if (/\bxox[baprs]-[A-Za-z0-9-]+/.test(t)) return true
    // Generic Bearer / Authorization tokens
    if (/Bearer\s+[A-Za-z0-9_\-\.]{20,}/i.test(t)) return true
    // Private keys
    if (/-----BEGIN\s+(RSA|EC|OPENSSH|DSA|PGP)\s+PRIVATE\s+Key-----/.test(t)) return true
    // Password patterns
    if (/^(password|passwd|pwd|secret|api[_-]?key)\s*[:=]\s*.{4,}$/im.test(t)) return true
    // Long base64-looking secrets (32+ chars)
    if (/\b[A-Za-z0-9_\-]{40,}\b/.test(t) && /[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t)) return true
    // Connection strings with embedded passwords
    if (/(mongodb|mysql|postgres|redis|amqp):\/\/[^:]+:([^@]+)@/.test(t)) return true
    return false
  }

  const offlineQueueSize = computed(() => getQueueSize())

  /** 清空所有图片 blob URL（登出 / 切换账号时调用，防止旧账号图片常驻内存） */
  function resetImages() {
    releaseAllObjectUrls()
  }

  /** 清空本地内容缓存（调试用 / 设置页清理按钮用） */
  function clearContentCache() {
    try {
      localStorage.removeItem(CONTENT_CACHE_KEY)
    } catch { /* ignore */ }
  }

  // 把任意文本写入剪贴板，复用与 copyItem 文本路径相同的去重逻辑：
  // 记录内容 + 暂停 monitor 轮询 3s，避免 ClipSync 自身写入被 monitor 当成新剪贴同步。
  async function copyText(text: string): Promise<boolean> {
    try {
      if (!text) return false
      skipNextPolls(3000)
      const now = Date.now()
      copiedTexts.set(text, now)
      cleanupCopiedContent()
      await tauri.setClipboardContent(text)
      return true
    } catch (e: any) {
      console.warn('[Clipboard] copyText failed:', e?.message || e)
      return false
    }
  }

  return {
    items, filteredItems, searchQuery, activeFilter, batchMode, polling, loading,
    offlineQueueSize,
    totalItems, mainTotalItems, hasMore, loadingMore, loadMore, currentPage, pageSize,
    selectedCount, allSelected, startPolling, copyItem, copyText,
    toggleSelectAll, clearSelection, batchDelete, deleteSingle, toggleFavorite,
    archiveItem, unarchiveItem, setExpiry,
    loadClipboardItems, setFilter, setSearch, toggleBatch, uploadFileItem,
    refresh: loadClipboardItems,
    resetImages,
    clearContentCache,
    isSensitiveContent,
    // === 高级搜索 / 条目级密码 ===
    advancedFilters, loadDevices, updateItemContent, clearAdvancedFilters,
  }
}

