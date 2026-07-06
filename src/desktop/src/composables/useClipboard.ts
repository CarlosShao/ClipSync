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

// 来自 ClipSync 内部复制的内容，轮询时跳过，避免重复添加
const recentCopiedContent = new Set<string>()
let recentCopiedClearTimer: ReturnType<typeof setTimeout> | null = null

function markCopied(content: string) {
  // 记录内容前200字符（避免图片base64太大）
  recentCopiedContent.add(content.slice(0, 200))
  // 3秒后自动清除（给轮询足够时间跳过）
  if (recentCopiedClearTimer) clearTimeout(recentCopiedClearTimer)
  recentCopiedClearTimer = setTimeout(() => recentCopiedContent.clear(), 3000)
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
const CONTENT_CACHE_MAX = 200 // 最多缓存200条

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
  cache.set(id, content.slice(0, 5000)) // 每条最多缓存5KB
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
      // 优先级：本地实时内容 > 本地缓存 > contentPreview
      const existing = items.value.find(e => e.id === i.id && e.content)
      const content = existing?.content || getCachedContent(i.id) || i.contentPreview || i.content || ''
      const preview = existing?.preview || content.slice(0, 200)
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
    if (localItem) localItem.id = res.data.id
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
    if (localItem) localItem.id = res.data.id
  }
}

function simpleHash(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) { hash = ((hash << 5) - hash) + s.charCodeAt(i); hash |= 0 }
  return hash.toString(36)
}

async function readAndUpload() {
  try {
    // 优先尝试 Tauri API
    const files = await tauri.getClipboardFiles().catch(() => [] as string[])
    if (files.length > 0) {
      const payload = JSON.stringify(files)
      // 跳过来自 ClipSync 内部复制的内容
      if (recentCopiedContent.has(payload.slice(0, 200))) return
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
          // 跳过来自 ClipSync 内部复制的图片
          if (recentCopiedContent.has(imgData.slice(0, 200))) { lastImageSize = imgInfo.size; return }
          lastImageSize = imgInfo.size
          await uploadImageToServer(imgData)
        }
      }
      return
    }

    const text = await tauri.getClipboardContent().catch(() => '')
    if (text && text.trim()) {
      // 跳过来自 ClipSync 内部复制的文本
      if (recentCopiedContent.has(text.slice(0, 200))) return
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
          // 跳过来自 ClipSync 内部复制的文本
          if (recentCopiedContent.has(clipText.slice(0, 200))) { lastBrowserText = clipText; return }
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
      if (item.type === 'file') {
        try {
          const paths = JSON.parse(item.content)
          if (Array.isArray(paths) && paths.length > 0) {
            markCopied(paths.join(','))
            await tauri.setClipboardFiles(paths)
            return true
          }
        } catch { /* 解析失败，使用文本复制 */ }
      }
      if (item.type === 'image' && item.preview) {
        markCopied(item.preview)
        await tauri.setClipboardContent(item.preview)
        return true
      }
      markCopied(item.content)
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

