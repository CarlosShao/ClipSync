import { ref, computed } from 'vue'
import * as tauri from '@/lib/tauri'
import { api, apiBlob } from '@/api/client'
import { useConfigStore } from '@/stores/configStore'
import { useI18n } from '@/composables/useI18n'

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
}

// === SINGLETON STATE - module-level refs shared across all callers ===
const items = ref<ClipItem[]>([])
const searchQuery = ref('')
const activeFilter = ref<'all' | 'text' | 'images' | 'links' | 'files'>('all')
const batchMode = ref(false)
const polling = ref(false)

let firstTauriPollDone = false
let lastImageSize = 0
let lastBrowserText = ''
const recentUploadHashes = new Map<string, number>()
const HASH_TTL = 10000

// === ClipSync 内部复制去重（双重策略） ===
// 策略1: 时间戳跳过（防止复制后立即被轮询捡到）
// 策略2: ID 追踪（用户建议：复制时记录 DB ID，加载/上传时检查）
let skipPollUntil = 0
// 初始加载后跳过轮询，防止系统剪贴板内容被重新上传
let initialLoadDone = false
// 记录从 ClipSync UI 复制的条目 ID（不依赖内容一致性）
const recentlyCopiedIds = new Set<string>()
let copiedIdsCleanupTimer: ReturnType<typeof setTimeout> | null = null

function skipNextPolls(ms = 6000) {
  skipPollUntil = Date.now() + ms
}

// 用户建议的 ID 去重：复制时记录该条的 ID
function markIdCopied(id: string) {
  recentlyCopiedIds.add(id)
  // 8 秒后清除（覆盖轮询间隔 + 网络延迟）
  if (copiedIdsCleanupTimer) clearTimeout(copiedIdsCleanupTimer)
  copiedIdsCleanupTimer = setTimeout(() => recentlyCopiedIds.clear(), 8000)
}

// 检查某个 ID 是否是刚从 ClipSync 内部复制的
function wasRecentlyCopied(id: string): boolean {
  return recentlyCopiedIds.has(id)
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
const CONTENT_CACHE_KEY = 'clipsync-content-cache'
const CONTENT_CACHE_MAX = 50 // 最多缓存50条（图片大，减少条目数）

function loadContentCache(): Map<string, string> {
  try {
    const raw = localStorage.getItem(CONTENT_CACHE_KEY)
    return raw ? new Map(JSON.parse(raw)) : new Map()
  } catch { return new Map() }
}

function saveContentCache(cache: Map<string, string>) {
  // 超过上限时删除最大的条目（图片最大，优先淘汰），保留较小的
  if (cache.size > CONTENT_CACHE_MAX) {
    const entries = [...cache.entries()].sort((a, b) => a[1].length - b[1].length) // 小的在前
    cache = new Map(entries.slice(0, CONTENT_CACHE_MAX))
  }
  try {
    localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify([...cache]))
  } catch (e: any) {
    // localStorage 配额超限（图片 data URL 很大，50 条易超 ~5MB 配额）。
    // 绝不能抛异常——否则会跳过调用方设置预览图的代码，导致图片永远显示破图。
    // 策略：淘汰最大的半数条目后重试；仍失败则静默放弃（图片改为走服务端重新拉取）。
    const quota = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014)
    if (quota && cache.size > 1) {
      const entries = [...cache.entries()].sort((a, b) => a[1].length - b[1].length)
      const reduced = entries.slice(0, Math.max(1, Math.ceil(cache.size / 2)))
      try {
        localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify(reduced))
      } catch { /* 彻底放弃，不影响图片显示 */ }
    }
  }
}

function cacheContent(id: string, content: string) {
  if (!content || !id) return
  try {
    const cache = loadContentCache()
    // 图片不截断（base64 通常 50KB-200KB），文本截断到 5KB
    const isImageBase64 = content.startsWith('data:image')
    cache.set(id, isImageBase64 ? content : content.slice(0, 5000))
    saveContentCache(cache)
  } catch { /* 绝不允许缓存异常影响图片渲染 */ }
}

function getCachedContent(id: string): string {
  const cache = loadContentCache()
  return cache.get(id) || ''
}

async function loadClipboardItems() {
  const res = await api('GET', '/api/clipboard')
  if (res.ok && Array.isArray(res.data?.items)) {
    const serverIds = new Set(res.data.items.map((i: any) => i.id))
    // 保留有本地 content 的项（上传后等待服务器同步的）
    const localWithContent = items.value.filter(i =>
      !serverIds.has(i.id) && i.content && i.content.trim()
    )
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
      }
    })
    items.value = [...localWithContent, ...serverItems]

    // 队列化加载图片：每批 3 张，间隔 200ms，避免并发过高被限流
    const imageQueue = serverItems.filter((i: ClipItem) => i.type === 'image' && !getCachedContent(i.id) && i.id)
    loadImagesFromQueue(imageQueue)
  }
}

// 图片异步加载队列（防并发 + 防竞态）
let imageLoadVersion = 0
async function loadImagesFromQueue(queue: ClipItem[]) {
  const version = ++imageLoadVersion  // 每次新加载递增，旧回调自动失效
  const BATCH = 3
  const DELAY = 200
  for (let idx = 0; idx < queue.length; idx += BATCH) {
    // 版本检查：如果又有新的 loadClipboardItems 调用，放弃旧队列
    if (version !== imageLoadVersion) return
    const batch = queue.slice(idx, idx + BATCH)
    await Promise.all(batch.map(async (item) => {
      try {
        const fullRes = await api('GET', `/api/clipboard/${item.id}`)
        if (version !== imageLoadVersion) return  // 竞态检查
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
    }))
    if (version !== imageLoadVersion) return
    if (idx + BATCH < queue.length) {
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
  const res = await api('POST', '/api/clipboard', {
    content,
    contentEncrypted: content,
    sourceDeviceId: deviceId,
    contentType: type,
    contentPreview: content.slice(0, 200),
  })
  // 上传成功后：用服务器返回的 id 替换本地临时 id，并缓存内容
  if (res.ok && res.data?.id) {
    const localItem = items.value.find(i => i.id === localId)
    if (localItem) {
      localItem.id = res.data.id
      cacheContent(res.data.id, content)
    }
  }
}

async function uploadImageToServer(dataUrl: string) {
  const hash = dataUrl.slice(0, 200)
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) return
  recentUploadHashes.set(hash, Date.now())
  const base64 = dataUrl.split(',')[1]
  // 乐观更新
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  items.value.unshift({ id: localId, type: 'image', content: dataUrl, preview: dataUrl, source: 'Desktop', timestamp: Date.now(), selected: false })
  const deviceId = localStorage.getItem('clipsync-device-id')
  if (!deviceId) return
  const res = await api('POST', '/api/clipboard', {
    contentType: 'image',
    content: dataUrl,
    contentEncrypted: dataUrl,
    sourceDeviceId: deviceId,
    mimeType: 'image/png',
    size: base64?.length || 0,
    contentPreview: `[Image ${base64?.length || 0} bytes]`,
  })
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
  // 乐观更新
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  items.value.unshift({ id: localId, type: 'file', content: payload, source: 'Desktop', timestamp: Date.now(), selected: false })
  const deviceId = localStorage.getItem('clipsync-device-id')
  if (!deviceId) return
  const res = await api('POST', '/api/clipboard', {
    contentType: 'file',
    content: payload,
    contentEncrypted: payload,
    sourceDeviceId: deviceId,
    contentPreview: payload.slice(0, 200),
  })
  if (res.ok && res.data?.id) {
    const localItem = items.value.find(i => i.id === localId)
    if (localItem) {
      localItem.id = res.data.id
      cacheContent(res.data.id, payload)
    }
  }
}

function simpleHash(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) { hash = ((hash << 5) - hash) + s.charCodeAt(i); hash |= 0 }
  return hash.toString(36)
}

async function readAndUpload() {
  try {
    // 策略1: 时间戳跳过（复制后 6 秒内不处理）
    if (Date.now() < skipPollUntil) return
    // 初始加载后跳过一轮轮询，防止系统剪贴板内容被重新上传
    if (!initialLoadDone) { initialLoadDone = true; return }

    // 优先尝试 Tauri API
    const files = await tauri.getClipboardFiles().catch(() => [] as string[])
    if (files.length > 0) {
      const payload = JSON.stringify(files)
      if (!items.value.some(i => i.type === 'file' && i.content === payload)) {
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
  function startPolling(interval = 1500) {
    polling.value = true
    initialLoadDone = false
    loadClipboardItems()

    const id = setInterval(() => {
      if (!firstTauriPollDone) {
        tauri.checkClipboardImageInfo().then(info => { lastImageSize = info.size }).catch(() => {})
        firstTauriPollDone = true
        return
      }
      readAndUpload()
    }, interval)

    return () => { polling.value = false; clearInterval(id) }
  }

  async function copyItem(item: ClipItem) {
    try {
      // 双重去重：时间戳跳过 + ID 标记
      skipNextPolls(6000)
      markIdCopied(item.id)

      if (item.type === 'file') {
        try {
          const paths = JSON.parse(item.content)
          if (Array.isArray(paths) && paths.length > 0) {
            await tauri.setClipboardFiles(paths)
            return true
          }
        } catch { /* 解析失败，使用文本复制 */ }
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
    } catch { return false }
  }

  async function batchDelete(): Promise<number> {
    const selected = items.value.filter(i => i.selected)
    const count = selected.length
    // 只删服务器上的（过滤掉所有本地临时 id）
    const serverIds = selected.map(i => i.id).filter(id => !id.startsWith('local-') && !id.startsWith('text-') && !id.startsWith('img-') && !id.startsWith('file-') && !id.startsWith('browser-'))
    if (serverIds.length > 0) {
      const res = await api('DELETE', '/api/clipboard', { ids: serverIds })
      if (!res.ok) {
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
      const res = await api('DELETE', `/api/clipboard/${item.id}`)
      if (!res.ok) {
        console.error('[Clipboard] deleteSingle server error:', res.status, res.error)
        throw new Error(res.error || `删除失败 (HTTP ${res.status})`)
      }
    }
    // 仅在服务端确认成功（或是本地临时项）后才从本地列表移除
    items.value = items.value.filter(i => i.id !== item.id)
    // 删除后跳过轮询，防止系统剪贴板内容被重新上传
    skipNextPolls(10000)
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
    // Tauri 的 File 对象包含 .path 属性（本地完整路径）
    const filePath = (file as any).path || ''
    const displayContent = JSON.stringify({ name: file.name, size: sizeStr, type: file.type || 'unknown', path: filePath })

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
      // 图片 → 转 base64 data URL 上传
      const reader = new FileReader()
      const dataUrl: string = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsDataURL(file)
      })
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
    } else {
      // 非图片文件 → JSON 内容上传
      const res = await api('POST', '/api/clipboard', {
        contentType: 'file',
        content: displayContent,
        contentEncrypted: displayContent,
        sourceDeviceId: deviceId,
        mimeType: file.type,
        size: file.size,
        contentPreview: `${file.name} (${sizeStr})`,
      })
      if (res.ok && res.data?.id) {
        const item = items.value.find(i => i.id === localId)
        if (item) { item.id = res.data.id; cacheContent(res.data.id, displayContent) }
      }
    }
  }

  return {
    items, filteredItems, searchQuery, activeFilter, batchMode, polling,
    selectedCount, allSelected, startPolling, copyItem,
    toggleSelectAll, clearSelection, batchDelete, deleteSingle, loadClipboardItems,
    setFilter, setSearch, toggleBatch, uploadFileItem,
    refresh: loadClipboardItems,
  }
}

