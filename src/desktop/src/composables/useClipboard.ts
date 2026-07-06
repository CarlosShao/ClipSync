import { ref, computed } from 'vue'
import * as tauri from '@/lib/tauri'
import { api } from '@/api/client'

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
  filteredItems.value.forEach(i => { i.selected = shouldSelect })
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
  // 超过上限时删除最早的
  if (cache.size > CONTENT_CACHE_MAX) {
    const entries = [...cache.entries()]
    cache = new Map(entries.slice(entries.length - CONTENT_CACHE_MAX))
  }
  localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify([...cache]))
}

function cacheContent(id: string, content: string) {
  if (!content || !id) return
  const cache = loadContentCache()
  // 图片不截断（base64 通常 50KB-200KB），文本截断到 5KB
  const isImageBase64 = content.startsWith('data:image')
  cache.set(id, isImageBase64 ? content : content.slice(0, 5000))
  saveContentCache(cache)
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
      // 图片特殊处理：contentPreview 是 "[Image N bytes]"，不是真实内容
      // 列表接口不返回 contentEncrypted，所以图片 content 只能从本地缓存或单条API获取
      const cached = getCachedContent(i.id)
      const isImage = (i.contentType || i.type) === 'image'
      let content: string
      if (isImage) {
        content = cached || '' // 无缓存则显示空，下面异步加载
        // 异步加载：如果图片没有缓存，从单条 API 获取完整内容
        if (!cached && i.id) {
          api('GET', `/api/clipboard/${i.id}`).then(fullRes => {
            if (fullRes.ok && fullRes.data?.contentEncrypted) {
              cacheContent(i.id, fullRes.data.contentEncrypted)
              // 更新列表中对应项的 content 和 preview
              const item = items.value.find(x => x.id === i.id)
              if (item) { item.content = fullRes.data.contentEncrypted; item.preview = fullRes.data.contentEncrypted }
            }
          }).catch(() => {})
        }
      } else {
        const existing = items.value.find(e => e.id === i.id && e.content)
        content = existing?.content || cached || i.contentPreview || i.content || ''
      }
      const preview = isImage ? (cached || '') : (content.slice(0, 200))
      return {
        id: i.id,
        type: (i.contentType || i.type || 'text') as ClipItem['type'],
        content,
        preview,
        source: i.sourceDevice?.name || i.deviceName || 'Server',
        timestamp: new Date(i.createdAt || Date.now()).getTime(),
      }
    })
    items.value = [...localWithContent, ...serverItems]
  }
}

async function uploadToServer(content: string, type: ClipItem['type'] = 'text') {
  const hash = simpleHash(content)
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) return
  recentUploadHashes.set(hash, Date.now())
  // 立即添加到本地列表（乐观更新）
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  items.value.unshift({ id: localId, type, content, source: 'Desktop', timestamp: Date.now() })
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
  items.value.unshift({ id: localId, type: 'image', content: dataUrl, preview: dataUrl, source: 'Desktop', timestamp: Date.now() })
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
  items.value.unshift({ id: localId, type: 'file', content: payload, source: 'Desktop', timestamp: Date.now() })
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
      await api('DELETE', '/api/clipboard', { ids: serverIds }).catch(() => {})
    }
    // 乐观删除：从本地列表移除选中项
    const selectedIds = new Set(selected.map(i => i.id))
    items.value = items.value.filter(i => !selectedIds.has(i.id))
    return count
  }

  async function deleteSingle(item: ClipItem) {
    if (!item.id.startsWith('local-') && !item.id.startsWith('text-') && !item.id.startsWith('img-')) {
      await api('DELETE', `/api/clipboard/${item.id}`).catch(() => {})
    }
    items.value = items.value.filter(i => i.id !== item.id)
  }

  function setFilter(f: typeof activeFilter.value) { activeFilter.value = f }
  function setSearch(q: string) { searchQuery.value = q }
  function toggleBatch() { batchMode.value = !batchMode.value; if (!batchMode.value) clearSelection() }

  return {
    items, filteredItems, searchQuery, activeFilter, batchMode, polling,
    selectedCount, allSelected, startPolling, copyItem,
    toggleSelectAll, clearSelection, batchDelete, deleteSingle, loadClipboardItems,
    setFilter, setSearch, toggleBatch,
    refresh: loadClipboardItems,
  }
}

