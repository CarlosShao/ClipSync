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

function toggleSelectAll() {
  const allSelected = filteredItems.value.every(i => i.selected)
  filteredItems.value.forEach(i => { i.selected = !allSelected })
}

function clearSelection() {
  items.value.forEach(i => { i.selected = false })
}

async function loadClipboardItems() {
  const res = await api('GET', '/api/clipboard')
  if (res.ok && Array.isArray(res.data?.items)) {
    items.value = res.data.items.map((i: any) => ({
      id: i.id || `srv-${Date.now()}`,
      type: i.type || 'text',
      content: i.content || '',
      preview: i.preview,
      source: i.sourceDevice?.name || i.deviceName || 'Server',
      timestamp: new Date(i.createdAt || Date.now()).getTime(),
    }))
  }
}

async function uploadToServer(content: string, type: string = 'text') {
  const hash = simpleHash(content)
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) return
  recentUploadHashes.set(hash, Date.now())
  await api('POST', '/api/clipboard', { content, type, preview: content.slice(0, 200) })
  await loadClipboardItems()
}

async function uploadImageToServer(dataUrl: string) {
  const hash = dataUrl.slice(0, 200)
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) return
  recentUploadHashes.set(hash, Date.now())
  const base64 = dataUrl.split(',')[1]
  await api('POST', '/api/clipboard', { type: 'image', content: dataUrl, mimeType: 'image/png', size: base64?.length || 0, preview: dataUrl })
  await loadClipboardItems()
}

async function uploadFileToServer(payload: string) {
  const hash = simpleHash(payload)
  if (recentUploadHashes.has(hash) && Date.now() - (recentUploadHashes.get(hash) || 0) < HASH_TTL) return
  recentUploadHashes.set(hash, Date.now())
  await api('POST', '/api/clipboard', { type: 'file', content: payload })
  await loadClipboardItems()
}

function simpleHash(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) { hash = ((hash << 5) - hash) + s.charCodeAt(i); hash |= 0 }
  return hash.toString(36)
}

async function readAndUpload() {
  try {
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
      if (!items.value.some(i => i.type === 'text' && i.content === text)) {
        const isUrl = /^https?:\/\/\S+$/.test(text.trim())
        items.value.unshift({ id: `text-${Date.now()}`, type: isUrl ? 'link' : 'text', content: text, source: 'Desktop', timestamp: Date.now() })
        await uploadToServer(text, isUrl ? 'link' : 'text')
      }
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
    selectedCount, startPolling, copyItem,
    toggleSelectAll, clearSelection, batchDelete, deleteSingle, loadClipboardItems,
    setFilter, setSearch, toggleBatch,
    refresh: loadClipboardItems,
  }
}
