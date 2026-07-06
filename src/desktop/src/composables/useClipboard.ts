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

async function loadClipboardItems() {
  const res = await api('GET', '/api/clipboard')
  if (res.ok && Array.isArray(res.data?.items)) {
    // 合并服务器数据和本地数据，避免丢失本地项
    const serverIds = new Set(res.data.items.map((i: any) => i.id))
    const localOnly = items.value.filter(i => !serverIds.has(i.id) && !i.id.startsWith('text-') && !i.id.startsWith('img-') && !i.id.startsWith('file-') && !i.id.startsWith('browser-'))
    const serverItems = res.data.items.map((i: any) => ({
      id: i.id || `srv-${Date.now()}`,
      type: i.type || 'text',
      content: i.content || '',
      preview: i.preview,
      source: i.sourceDevice?.name || i.deviceName || 'Server',
      timestamp: new Date(i.createdAt || Date.now()).getTime(),
    }))
    items.value = [...localOnly, ...serverItems]
  }
}

async function uploadToServer(content: string, type: string = 'text') {
  const hash = simpleHash(content)
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) return
  recentUploadHashes.set(hash, Date.now())
  // 获取设备ID（从服务器获取或使用默认值）
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
  if (!deviceId) return // 没有有效设备ID，跳过上传
  const res = await api('POST', '/api/clipboard', {
    content,
    contentEncrypted: content,
    sourceDeviceId: deviceId,
    type,
    preview: content.slice(0, 200),
  })
  if (res.ok) await loadClipboardItems()
}

async function uploadImageToServer(dataUrl: string) {
  const hash = dataUrl.slice(0, 200)
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) return
  recentUploadHashes.set(hash, Date.now())
  const base64 = dataUrl.split(',')[1]
  const deviceId = localStorage.getItem('clipsync-device-id') || '00000000-0000-0000-0000-000000000000'
  const res = await api('POST', '/api/clipboard', {
    type: 'image',
    content: dataUrl,
    contentEncrypted: dataUrl,
    sourceDeviceId: deviceId,
    mimeType: 'image/png',
    size: base64?.length || 0,
    preview: dataUrl,
  })
  if (res.ok) await loadClipboardItems()
}

async function uploadFileToServer(payload: string) {
  const hash = simpleHash(payload)
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) return
  recentUploadHashes.set(hash, Date.now())
  const deviceId = localStorage.getItem('clipsync-device-id') || '00000000-0000-0000-0000-000000000000'
  const res = await api('POST', '/api/clipboard', {
    type: 'file',
    content: payload,
    contentEncrypted: payload,
    sourceDeviceId: deviceId,
    preview: payload.slice(0, 200),
  })
  if (res.ok) await loadClipboardItems()
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
      if (!items.value.some(i => i.type === 'file' && i.content === payload)) {
        items.value.unshift({ id: `file-${Date.now()}`, type: 'file', content: payload, source: 'Desktop', timestamp: Date.now() })
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
          items.value.unshift({ id: `img-${Date.now()}`, type: 'image', content: imgData, preview: imgData, source: 'Desktop', timestamp: Date.now() })
          await uploadImageToServer(imgData)
        }
      }
      return
    }

    const text = await tauri.getClipboardContent().catch(() => '')
    if (text && text.trim()) {
      const isUrl = /^https?:\/\/\S+$/.test(text.trim())
      const itemType = isUrl ? 'link' : 'text'
      // 去重：检查 text 和 link 两种类型
      if (!items.value.some(i => (i.type === 'text' || i.type === 'link') && i.content === text)) {
        items.value.unshift({ id: `text-${Date.now()}`, type: itemType, content: text, source: 'Desktop', timestamp: Date.now() })
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
          // 去重：检查 text 和 link 两种类型
          if (!items.value.some(i => (i.type === 'text' || i.type === 'link') && i.content === clipText)) {
            items.value.unshift({ id: `browser-${Date.now()}`, type: itemType, content: clipText, source: 'Browser', timestamp: Date.now() })
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
        // 文件类型：解析路径并使用 Tauri 文件复制
        try {
          const paths = JSON.parse(item.content)
          if (Array.isArray(paths) && paths.length > 0) {
            await tauri.setClipboardFiles(paths)
            return true
          }
        } catch { /* 解析失败，使用文本复制 */ }
      }
      if (item.type === 'image' && item.preview) {
        // 图片类型：使用图片复制
        await tauri.setClipboardContent(item.preview)
        return true
      }
      // 文本/链接类型：直接复制内容
      await tauri.setClipboardContent(item.content)
      return true
    } catch { return false }
  }

  async function batchDelete(): Promise<number> {
    const selected = items.value.filter(i => i.selected)
    const ids = selected.map(i => i.id).filter(id => !id.startsWith('local-'))
    if (ids.length > 0) await api('DELETE', '/api/clipboard', { ids })
    const count = selected.length
    items.value = items.value.filter(i => !i.selected)
    return count
  }

  async function deleteSingle(item: ClipItem) {
    if (!item.id.startsWith('local-')) await api('DELETE', `/api/clipboard/${item.id}`)
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
