<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import * as tauri from '@/lib/tauri'
import { useConfigStore } from '@/stores/configStore'
import { usePrivacy } from '@/composables/usePrivacy'
import {
  Upload, Plus, Search, Trash2, Copy, Image as ImageIcon, Link,
  ExternalLink, FileText, Folder, FolderOpen, FolderPlus, FolderX, FolderSearch, FolderInput, FolderOutput, FolderSync,
  ClipboardList, Star, Bookmark, Archive, Heart, Zap, Shield, Globe, Code2, Music, Video, Settings, Palette,
  Check, X, Lock, Tag, Unlock, ShieldCheck, Filter, KeyRound, Calendar as CalendarIcon,
} from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Checkbox from '@/components/ui/checkbox/Checkbox.vue'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import Badge from '@/components/ui/badge/Badge.vue'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { getFavoriteCollections, addCollectionItem, createFavoriteCollection, createSharedLink, uploadSharedFile, setItemTags } from '@/api/client'
import { api } from '@/api/client'
import { useItemPassword } from '@/composables/useItemPassword'
import ItemPasswordDialog from '@/components/clipboard/ItemPasswordDialog.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { parseDate, type DateValue } from '@internationalized/date'

const emit = defineEmits<{
  'toggle-quick-paste': []
  'preview-image': [item: ClipItem]
  'preview-text': [item: ClipItem]
  'preview-file': [item: ClipItem]
  'version-history': [item: ClipItem]
  'show-pin-dialog': []
  'show-pin-setup': []
  'toggle-sensitive': [item: ClipItem]
}>()

const { t } = useI18n()
const toast = useSonner()
const clip = useClipboard()
const configStore = useConfigStore()
const router = useRouter()

const itemPw = useItemPassword()

// === 高级搜索筛选面板 ===
const showFilterPanel = ref(false)
const devices = ref<{ id: string; name: string; platform?: string }[]>([])
const deviceLoading = ref(false)
async function toggleFilterPanel() {
  showFilterPanel.value = !showFilterPanel.value
  if (showFilterPanel.value && devices.value.length === 0 && !deviceLoading.value) {
    deviceLoading.value = true
    try { devices.value = await clip.loadDevices() } catch { /* ignore */ } finally { deviceLoading.value = false }
  }
}

// 设备筛选：当前选中设备的名称（用于 CustomSelect 触发器展示）
const deviceLabel = computed(() => {
  const id = clip.advancedFilters.value.deviceId
  if (!id) return t('filter_all_devices')
  const d = devices.value.find(x => x.id === id)
  return d ? d.name : t('filter_all_devices')
})
function onDeviceChange(v: string) {
  clip.advancedFilters.value.deviceId = v
  clip.loadClipboardItems({ page: 1 })
}

// 日期筛选：字符串 YYYY-MM-DD <-> @internationalized/date DateValue
const dateFromValue = computed<DateValue | undefined>({
  get: () => {
    const str = clip.advancedFilters.value.dateFrom
    if (!str) return undefined
    try { return parseDate(str) } catch { return undefined }
  },
  set: (val) => {
    clip.advancedFilters.value.dateFrom = val ? val.toString() : ''
    clip.loadClipboardItems({ page: 1 })
  },
})
const dateToValue = computed<DateValue | undefined>({
  get: () => {
    const str = clip.advancedFilters.value.dateTo
    if (!str) return undefined
    try { return parseDate(str) } catch { return undefined }
  },
  set: (val) => {
    clip.advancedFilters.value.dateTo = val ? val.toString() : ''
    clip.loadClipboardItems({ page: 1 })
  },
})

// 展示内容：受保护且已解锁时返回会话明文，否则返回原内容（列表只返回 preview，受保护项 preview 为掩码串）
function displayContent(item: ClipItem): string {
  if (itemPw.isItemProtected(item) && itemPw.isUnlocked(item.id)) {
    return itemPw.getUnlockedPlaintext(item.id) ?? item.content
  }
  return item.content
}

// 复制/查看前检查条目级密码：受保护未解锁则弹出解锁框
function requireUnlocked(item: ClipItem): boolean {
  if (itemPw.isItemProtected(item) && !itemPw.isUnlocked(item.id)) {
    openItemPassword(item)
    return false
  }
  return true
}

// === 条目级密码对话框 ===
const pwDialogOpen = ref(false)
const pwDialogItem = ref<ClipItem | null>(null)
function openItemPassword(item: ClipItem) {
  if (item.type === 'image' || item.type === 'file') {
    toast.show(t('item_password_unsupported'), 'info')
    return
  }
  pwDialogItem.value = item
  pwDialogOpen.value = true
}
function onItemPasswordUpdated(_item: ClipItem) {
  toast.show(t('item_password_updated'), 'success')
}

// === 条目标签编辑 ===
const tagEditorItemId = ref<string | null>(null)
const tagInput = ref('')
function openTagEditor(item: ClipItem) {
  tagEditorItemId.value = item.id
  tagInput.value = (item.tags || []).join(', ')
}
async function saveItemTags(item: ClipItem) {
  const tags = tagInput.value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10)
  const res = await setItemTags(item.id, tags)
  if (res) {
    item.tags = tags
    if (!item.metadata) item.metadata = {}
    item.metadata.tags = tags
    toast.show(t('item_tags_saved'), 'success')
  } else {
    toast.show(t('item_tags_save_failed'), 'error')
  }
  tagEditorItemId.value = null
}
function closeTagEditor() { tagEditorItemId.value = null }
// 用 computed 包裹 ref，确保 Vue 3 模板正确追踪响应式依赖
const filteredItems = computed(() => clip.filteredItems.value)
const allItems = computed(() => clip.items.value)
const activeFilter = computed(() => clip.activeFilter.value)
const selectedCount = computed(() => clip.selectedCount.value)
const isLoading = computed(() => clip.loading.value)
// 分页：后端硬删正确，但前端之前只拉 page1(50)，删除后旧条目滚入 page1 让人以为删除没生效。
// 现在暴露总数 + 是否还有更多 + 加载更多，让删除语义清晰可见。
const totalItems = computed(() => clip.totalItems.value)
const hasMore = computed(() => clip.hasMore.value)
const loadingMore = computed(() => clip.loadingMore.value)
const remaining = computed(() => Math.max(0, totalItems.value - filteredItems.value.length))

// 滚动到底部自动加载更多（无限滚动）
let scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null
function onClipboardScroll(e: Event) {
  if (scrollDebounceTimer) return
  scrollDebounceTimer = setTimeout(() => { scrollDebounceTimer = null }, 150)
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
    clip.loadMore()
  }
}

// allSelected 用本地 computed，同理避免 ref 解包问题
const allSelected = computed(() => clip.allSelected.value)

const searchInput = ref('')
const showQuickPaste = ref(false)
const focusedIndex = ref(0)

// Privacy: usePrivacy composable
const privacy = usePrivacy()
// Track which item is currently peeked (temporarily revealed)
const peekItemId = ref<string | null>(null)

// Collections (for "add to collection" dropdown)
const collections = ref<any[]>([])
const addToColItemId = ref<string | null>(null)

const collectionIconMap: Record<string, any> = {
  folder: Folder,
  'folder-open': FolderOpen,
  folderPlus: FolderPlus,
  folderX: FolderX,
  folderSearch: FolderSearch,
  folderInput: FolderInput,
  folderOutput: FolderOutput,
  folderSync: FolderSync,
  star: Star,
  bookmark: Bookmark,
  archive: Archive,
  trash: Trash2,
  heart: Heart,
  zap: Zap,
  shield: Shield,
  globe: Globe,
  code: Code2,
  image: ImageIcon,
  fileText: FileText,
  music: Music,
  video: Video,
  settings: Settings,
  palette: Palette,
}

interface CollectionTreeNode {
  id: string
  name: string
  icon: string
  path: string
  depth: number
  children: CollectionTreeNode[]
}

function buildCollectionTree(flat: any[]): CollectionTreeNode[] {
  const sorted = [...flat].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.path).localeCompare(String(b.path)))
  const nodes = new Map<string, CollectionTreeNode>()
  const roots: CollectionTreeNode[] = []
  for (const c of sorted) {
    if (!c?.id) continue
    const path = String(c.path || 'root.' + String(c.id).replace(/-/g, '_'))
    const parts = path.split('.')
    const node: CollectionTreeNode = {
      id: c.id,
      name: c.name || 'Untitled',
      icon: c.icon || 'folder',
      path,
      depth: parts.length,
      children: [],
    }
    nodes.set(c.id, node)
  }
  for (const node of nodes.values()) {
    const parts = node.path.split('.')
    if (parts.length <= 1) {
      roots.push(node)
    } else {
      const parentPath = parts.slice(0, -1).join('.')
      let found = false
      for (const candidate of nodes.values()) {
        if (candidate.path === parentPath) {
          candidate.children.push(node)
          found = true
          break
        }
      }
      if (!found) roots.push(node)
    }
  }
  return roots
}

function flattenCollectionTree(nodes: CollectionTreeNode[], result: CollectionTreeNode[] = []): CollectionTreeNode[] {
  for (const n of nodes) {
    result.push(n)
    flattenCollectionTree(n.children, result)
  }
  return result
}

const collectionTreeNodes = computed(() => flattenCollectionTree(buildCollectionTree(collections.value || [])))

// Favorite success popover (方案 A: inline collection picker, no navigation)
const favPopoverItemId = ref<string | null>(null)
const favPopoverFlipped = ref(false) // true = show above the item instead of below
let favPopoverTimer: ReturnType<typeof setTimeout> | null = null
const favNewName = ref('')
const showFavNewInput = ref(false)
let creatingCollection = false  // prevent double-click race condition

async function loadCollections() {
  const data = await getFavoriteCollections()
  if (data) collections.value = data.collections
}
onMounted(() => {
  loadCollections()
  // 从收藏页/其他视图切回剪贴板时，items 可能被收藏数据填充，必须重新按当前分类刷新。
  clip.loadClipboardItems()
})

function showFavPopover(itemId: string) {
  if (favPopoverTimer) clearTimeout(favPopoverTimer)
  favPopoverItemId.value = itemId
  showFavNewInput.value = false
  favNewName.value = ''
  // Check if the item is near the bottom of the viewport → flip popover above
  favPopoverFlipped.value = false
  nextTick(() => {
    const wrap = document.querySelector(`.add-col-wrap[data-item-id="${itemId}"]`)
    if (wrap) {
      const rect = wrap.getBoundingClientRect()
      const viewportH = window.innerHeight || document.documentElement.clientHeight
      if (rect.bottom > viewportH * 0.6) favPopoverFlipped.value = true
    }
  })
  startFavPopoverTimer()
}
function startFavPopoverTimer() {
  if (favPopoverTimer) clearTimeout(favPopoverTimer)
  favPopoverTimer = setTimeout(() => { favPopoverItemId.value = null }, 4000)
}
function dismissFavPopover() {
  if (favPopoverTimer) clearTimeout(favPopoverTimer)
  favPopoverItemId.value = null
  showFavNewInput.value = false
  favNewName.value = ''
}
function onFavPopoverEnter() {
  if (favPopoverTimer) clearTimeout(favPopoverTimer)
}
function onFavPopoverLeave() {
  startFavPopoverTimer()
}

// Privacy: usePrivacy composable
// 缓存敏感内容判定结果（依赖隐私模式 + 内容），减少列表重渲染时的重复计算
const sensitivityCache = new Map<string, boolean>()
const MAX_SENSITIVITY_CACHE = 2000
function isItemSensitive(item: ClipItem): boolean {
  const key = `${item.id}:${item.content.length}:${configStore.privacyMode ? 1 : 0}:${item.metadata?.sensitive ? 1 : 0}`
  const cached = sensitivityCache.get(key)
  if (cached !== undefined) return cached
  const result = privacy.isItemSensitive(item)
  if (sensitivityCache.size > MAX_SENSITIVITY_CACHE) {
    const firstKey = sensitivityCache.keys().next().value
    if (firstKey !== undefined) sensitivityCache.delete(firstKey)
  }
  sensitivityCache.set(key, result)
  return result
}
function showPeek(itemId: string) {
  if (privacy.startPeek(itemId)) {
    peekItemId.value = itemId
  } else {
    if (!privacy.pinSet.value) {
      emit('show-pin-setup')
    } else {
      emit('show-pin-dialog')
    }
  }
}
async function copyWithPinCheck(item: ClipItem) {
  if (!requireUnlocked(item)) return
  if (privacy.isItemSensitive(item) && !privacy.canCopySensitive()) {
    if (!privacy.pinSet.value) {
      emit('show-pin-setup')
    } else {
      emit('show-pin-dialog')
    }
    return
  }
  clip.copyItem(item)
  privacy.scheduleClipboardClear()
  toast.show(t('copied'), 'success')
}

function onDblClick(item: ClipItem) {
  if (!requireUnlocked(item)) return
  if (privacy.isItemSensitive(item) && !privacy.canCopySensitive()) {
    if (!privacy.pinSet.value) {
      emit('show-pin-setup')
    } else {
      emit('show-pin-dialog')
    }
    return
  }
  clip.copyItem(item)
  privacy.scheduleClipboardClear()
}
function onCopyItem(item: ClipItem) {
  if (!requireUnlocked(item)) return
  if (privacy.isItemSensitive(item) && !privacy.canCopySensitive()) {
    emit('show-pin-dialog')
    return
  }
  clip.copyItem(item)
  privacy.scheduleClipboardClear()
  toast.show(t('copied'), 'success')
}

function onToggleSensitive(item: ClipItem) {
  // Unlocking a sensitive item requires PIN verification.
  // Locking (marking as sensitive) is always allowed.
  const isLocked = (item as any).metadata?.sensitive === true
  if (isLocked && !privacy.canCopySensitive()) {
    if (!privacy.pinSet.value) {
      emit('show-pin-setup')
    } else {
      emit('show-pin-dialog')
    }
    return
  }
  emit('toggle-sensitive', item)
}

async function pickCollection(itemId: string, colId: string) {
  const ok = await addCollectionItem(colId, itemId)
  if (ok) {
    toast.show(t('fav_moved'), 'success')
    await loadCollections()
  }
  dismissFavPopover()
}
async function createAndMove(itemId: string) {
  if (creatingCollection) return
  if (!favNewName.value.trim()) return
  creatingCollection = true
  try {
    const data = await createFavoriteCollection(favNewName.value.trim(), 'folder')
    if (data?.collection) {
      collections.value.push(data.collection)
      await addCollectionItem(data.collection.id, itemId)
      toast.show(t('clip_col_created'), 'success')
      await loadCollections()
    } else {
      toast.show(t('fav_create_fail'), 'error')
    }
  } finally {
    creatingCollection = false
    dismissFavPopover()
  }
}

function toggleAddToCol(itemId: string) {
  addToColItemId.value = addToColItemId.value === itemId ? null : itemId
}
async function addToCollection(colId: string, itemId: string) {
  const ok = await addCollectionItem(colId, itemId)
  if (ok) toast.show(t('fav_added'), 'success')
  addToColItemId.value = null
}

// Star button: favorite immediately, then optionally move to collection
function handleFavorite(item: ClipItem) {
  if (item.isFavorite) {
    clip.toggleFavorite(item)
    addToColItemId.value = null
    dismissFavPopover()
  } else {
    clip.toggleFavorite(item)
    if (collections.value.length > 0) {
      addToColItemId.value = item.id
    } else {
      addToColItemId.value = null
      showFavPopover(item.id)
    }
  }
}

// Click outside to close dropdown (item stays favorited in default area)
function handleDocClick(e: MouseEvent) {
  if (addToColItemId.value) {
    const target = e.target as HTMLElement
    if (!target.closest('.add-col-wrap')) {
      addToColItemId.value = null
      toast.show(t('clip_favorited'), 'info')
    }
  }
}
onMounted(() => document.addEventListener('click', handleDocClick))
onUnmounted(() => document.removeEventListener('click', handleDocClick))

// Read user's saved in-app shortcuts from localStorage (falls back to defaults)
function savedAppKeys(id: string): string[] | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem('clipsync-custom-shortcuts') || '{}')
    const ks = saved[id]
    return Array.isArray(ks) && ks.length ? ks : undefined
  } catch { return undefined }
}

// Match a KeyboardEvent against a saved shortcut (last element = main key, rest = modifiers)
function matchShortcut(saved: string[] | undefined, e: KeyboardEvent): boolean {
  if (!saved || !saved.length) return false
  const mainKey = saved[saved.length - 1]
  const needCtrl = saved.includes('Ctrl')
  const needAlt = saved.includes('Alt')
  const needShift = saved.includes('Shift')
  const pressedMain = e.key.length === 1 ? e.key.toUpperCase() : e.key
  return pressedMain.toLowerCase() === mainKey.toLowerCase()
    && (needCtrl === (e.ctrlKey || e.metaKey))
    && needAlt === e.altKey
    && needShift === e.shiftKey
}

// Filter options for segmented control
const filterOptions = [
  { value: 'all', label: t('tab_all') },
  { value: 'text', label: t('tab_text') },
  { value: 'images', label: t('tab_images') },
  { value: 'links', label: t('tab_links') },
  { value: 'files', label: t('tab_files') },
] as const
const confirmOpen = ref(false)
const confirmMessage = ref('')
const confirmCallback = ref<(() => void) | null>(null)
const confirmVariant = ref<'default' | 'destructive'>('destructive')

// File upload
const fileInputRef = ref<HTMLInputElement>()

function triggerFileUpload() {
  fileInputRef.value?.click()
}

async function handleFileUpload(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files?.length) return
  const files = Array.from(input.files)
  // Reset input so same file can be selected again
  input.value = ''

  for (const file of files) {
    // Size limit is enforced server-side by uploadFileItem, but do a client-side pre-check
    const planMaxBytes = (() => {
      const plan = configStore.user.plan || 'Free'
      if (plan === 'Pro' || plan === 'pro' || plan === '专业版') return 256 * 1024 * 1024
      if (plan === 'Enterprise' || plan === 'enterprise' || plan === '企业版') return 1024 * 1024 * 1024
      return 128 * 1024 * 1024 // Free default: 128MB
    })()
    if (file.size > planMaxBytes) {
      const maxMb = Math.round(planMaxBytes / 1024 / 1024)
      toast.show(`${file.name}: ${t('file_exceeds_plan', { size: file.size < 1024*1024 ? `${(file.size/1024).toFixed(0)}KB` : `${(file.size/1024/1024).toFixed(1)}MB`, limit: `${maxMb}MB`, plan: '' })}`, 'error')
      continue
    }
    try {
      await clip.uploadFileItem(file)
    } catch (err: any) {
      toast.show(`${file.name}: ${err.message || t('upload_fail')}`, 'error')
    }
  }

  if (files.length > 0) {
    const okCount = files.length - (toast as any).lastErrorCount || 0
    if (okCount > 0) toast.show(t('upload_success'), 'success')
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleGlobalKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleGlobalKeydown)
})

// ===== Quick Paste =====
function toggleQuickPaste() {
  showQuickPaste.value = !showQuickPaste.value
  emit('toggle-quick-paste')
}

// ===== Confirm Dialog =====
function showConfirm(message: string, cb: () => void, variant: 'default' | 'destructive' = 'destructive') {
  confirmMessage.value = message
  confirmCallback.value = cb
  confirmVariant.value = variant
  confirmOpen.value = true
}

function onConfirmDialog() {
  if (confirmCallback.value) confirmCallback.value()
  confirmOpen.value = false
  confirmCallback.value = null
}

function onCancelDialog() {
  confirmOpen.value = false
  confirmCallback.value = null
}

// ===== Clipboard Operations =====
function handleBatchDelete() {
  if (clip.selectedCount.value === 0) { toast.show(t('batch_none'), 'warning'); return }
  const count = clip.selectedCount.value
  const favCount = clip.items.value.filter(i => i.selected && (i as any).isFavorite).length
  const msg = favCount > 0 ? t('confirm_delete_fav_batch', { n: favCount }) : t('confirm_batch_delete', { n: count })
  showConfirm(msg, async () => {
    try {
      // Unfavorite selected items first
      const favItems = clip.items.value.filter(i => i.selected && (i as any).isFavorite)
      for (const fi of favItems) clip.toggleFavorite(fi)
      await clip.batchDelete()
      toast.show(t('batch_deleted', { n: count }), 'success')
    } catch (err: any) {
      toast.show(err.message || t('del_fail'), 'error')
    }
  })
}

function openLink(item: ClipItem) {
  const url = item.content.trim()
  if (url) {
    tauri.openUrl(url).catch(() => window.open(url, '_blank'))
    toast.show(t('link_opened'), 'success')
  }
}

/** Check if a file item has a local path (for copy/reveal buttons).
 *  Checks item.content first, then falls back to item.metadata.paths.
 *  Handles: JSON path arrays, {name,paths} objects, plain path strings, content with embedded paths */
function hasLocalPath(item: ClipItem): boolean {
  // Strategy A: check item.content (reconstructed by useClipboard.ts or raw from server)
  const content = String(item.content || '')
  try {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') return true
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.paths) && parsed.paths.length > 0) return true
  } catch { /* not JSON */ }

  // Strategy B: plain string path
  if (/^[A-Za-z]:[\\/]/.test(content)) return true
  if (/\b[A-Za-z]:[\\/][\w\s\\/.]+\.\w{1,5}\b/.test(content)) return true

  // Strategy C: check metadata directly (useClipboard.ts may not have reconstructed content)
  try {
    const meta = JSON.parse((item as any).metadata || '{}')
    if (Array.isArray(meta.paths) && meta.paths.length > 0 && typeof meta.paths[0] === 'string') return true
  } catch { /* no metadata */ }

  return false
}

async function revealFileFolder(item: ClipItem) {
  try {
    const data = JSON.parse(item.content)
    // paths 字段：{"name":"file.md","paths":["D:\\..."]} → clipboard monitor 上传
    if (data.paths && Array.isArray(data.paths) && data.paths[0]) {
      tauri.revealInFolder(data.paths[0]).catch(() => {
        const dir = data.paths[0].replace(/[/\\][^/\\]+$/, '')
        tauri.openUrl(dir).catch(() => toast.show(t('err_open_folder'), 'error'))
      })
      return
    }
    // path 字段：{"name":"...","path":"D:\\..."}
    if (data.path && typeof data.path === 'string' && data.path.length > 0) {
      tauri.revealInFolder(data.path).catch(() => {
        const dir = data.path.replace(/[/\\][^/\\]+$/, '')
        tauri.openUrl(dir).catch(() => toast.show(t('err_open_folder'), 'error'))
      })
      return
    }
    // 路径数组：["D:\\path\\to\\file"]
    if (Array.isArray(data) && data.length > 0) {
      tauri.revealInFolder(data[0]).catch(() => {
        const dir = data[0].replace(/[/\\][^/\\]+$/, '')
        tauri.openUrl(dir).catch(() => toast.show(t('err_open_folder'), 'error'))
      })
      return
    }
  } catch { /* ignore */ }
  toast.show(t('err_no_path'), 'warning')
}

async function shareItem(item: ClipItem) {
  // 敏感内容需要先验证 PIN（与复制/查看同等级安全策略）
  if (privacy.isItemSensitive(item) && !privacy.canCopySensitive()) {
    if (!privacy.pinSet.value) {
      emit('show-pin-setup')
    } else {
      emit('show-pin-dialog')
    }
    return
  }

  const payload = await buildSharePayload(item)
  if (!payload) {
    toast.show(t('shared_link_create_err'), 'error')
    return
  }

  try {
    const created = await createSharedLink({
      content: payload.content,
      title: payload.title,
      contentType: payload.contentType,
      fileKey: payload.fileKey,
      fileName: payload.fileName,
      fileSize: payload.fileSize,
    })
    if (!created) {
      toast.show(t('shared_link_create_err'), 'error')
      return
    }
    const ok = await clip.copyText(created.url)
    toast.show(ok ? t('shared_link_copied') : t('shared_link_copy_err'), ok ? 'success' : 'error')
  } catch (e: any) {
    console.warn('[Clipboard] share failed', e)
    toast.show(t('shared_link_create_err'), 'error')
  }
}

function extractFilePath(content: string): string | null {
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.paths) && parsed.paths[0]) return parsed.paths[0]
      if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed[0]
    }
  } catch { /* not JSON */ }
  const raw = content.trim()
  if (raw.startsWith('["') && raw.includes('\\')) {
    try {
      const paths = JSON.parse(raw)
      if (Array.isArray(paths) && paths[0]) return paths[0]
    } catch { /* ignore */ }
  }
  if (raw.includes('\\') || raw.includes('/')) return raw
  return null
}

function base64ToBlob(base64: string, type = 'application/octet-stream'): Blob {
  const byteCharacters = atob(base64)
  const byteArrays: Uint8Array[] = []
  for (let offset = 0; offset < byteCharacters.length; offset += 512) {
    const slice = byteCharacters.slice(offset, offset + 512)
    const byteNumbers = new Array(slice.length)
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i)
    }
    byteArrays.push(new Uint8Array(byteNumbers))
  }
  return new Blob(byteArrays, { type })
}

async function buildSharePayload(item: ClipItem): Promise<{ content: string; title: string; contentType: string; fileKey?: string; fileName?: string; fileSize?: number } | null> {
  const isLocalItem = /^local-|^text-|^file-|^img-|^browser-/.test(item.id)
  const contentSize = item.contentSize || 0

  // 文本 / 链接：确保拿到完整内容，不分享被截断的预览
  if (item.type === 'text' || item.type === 'link') {
    let textContent = item.content
    const needsFetch = !isLocalItem && textContent.length > 0 && (contentSize === 0 || textContent.length < contentSize)
    if (needsFetch) {
      try {
        const full = await api<{ contentEncrypted: string }>('GET', `/api/clipboard/${item.id}/content`)
        if (full.ok && full.data?.contentEncrypted) {
          textContent = full.data.contentEncrypted
        }
      } catch (e: any) {
        console.warn('[Clipboard] failed to fetch full content for share:', e?.message || e)
      }
    }
    if (!textContent) return null
    return {
      content: textContent,
      title: textContent.slice(0, 60),
      contentType: item.type,
    }
  }

  // 图片：优先用本地 data URL，否则从服务器拉完整内容
  if (item.type === 'image') {
    let imgData = item.content || item.preview || ''
    if (!imgData || imgData.startsWith('[Image')) {
      try {
        const full = await api('GET', `/api/clipboard/${item.id}`)
        imgData = full.data?.contentEncrypted || full.data?.contentPreview || ''
      } catch (e: any) {
        console.warn('[Clipboard] failed to fetch image for share:', e?.message || e)
      }
    }
    if (!imgData || imgData.startsWith('[Image')) return null
    return {
      content: imgData,
      title: item.metadata?.originalName || item.metadata?.name || 'Image',
      contentType: 'image',
    }
  }

  // 文件：读取真实文件、上传到后端，生成可下载的分享链接
  if (item.type === 'file') {
    const filePath = extractFilePath(item.content)
    if (!filePath) {
      console.warn('[Clipboard] share file: no file path found in item.content')
      return null
    }
    let base64: string
    try {
      base64 = await tauri.readFileContentBase64(filePath)
    } catch (e: any) {
      console.warn('[Clipboard] failed to read file for share:', e?.message || e)
      return null
    }
    const fileName = formatContent(item) || filePath.split(/[/\\]/).pop() || 'file'
    const blob = base64ToBlob(base64)
    const file = new File([blob], fileName)
    if (file.size > 50 * 1024 * 1024) {
      toast.show(t('shared_link_file_too_large'), 'warning')
      return null
    }
    const uploaded = await uploadSharedFile(file)
    if (!uploaded.ok) {
      console.warn('[Clipboard] failed to upload file for share:', uploaded.error)
      toast.show(uploaded.error, 'error')
      return null
    }
    return {
      content: '',
      title: fileName,
      contentType: 'file',
      fileKey: uploaded.fileKey,
      fileName: uploaded.fileName,
      fileSize: uploaded.fileSize,
    }
  }

  return null
}

function handleSingleDelete(item: ClipItem) {
  const isFav = (item as any).isFavorite
  const msg = isFav ? t('confirm_delete_fav') : t('confirm_delete')
  showConfirm(msg, async () => {
    try {
      // If favorited, unfavorite first
      if (isFav) clip.toggleFavorite(item)
      await clip.deleteSingle(item)
      toast.show(t('deleted'), 'success')
    } catch (err: any) {
      toast.show(err.message || t('del_fail'), 'error')
    }
  })
}

function handleGlobalKeydown(e: KeyboardEvent) {
  // ESC: close modals / quick paste
  if (e.key === 'Escape') {
    if (showQuickPaste.value) { showQuickPaste.value = false; return }
    if (confirmOpen.value) { confirmOpen.value = false; return }
  }
  // Ctrl+K or Cmd+K: toggle quick paste
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault()
    toggleQuickPaste()
    return
  }
  // Ctrl+F or Cmd+F: focus search box (in-app shortcut, honors customization)
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    const def = savedAppKeys('search') || ['Ctrl', 'F']
    if (matchShortcut(def, e)) {
      e.preventDefault()
      const el = document.querySelector('.search-field input') as HTMLInputElement | null
      el?.focus()
      el?.select()
    }
    return
  }

  // Row navigation + copy/delete: only when clipboard table is active and not typing in a field
  const target = e.target as HTMLElement | null
  const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  if (typing || showQuickPaste.value || confirmOpen.value) return

  const list = clip.filteredItems.value
  if (!list.length) return
  if (focusedIndex.value >= list.length) focusedIndex.value = list.length - 1

  // Arrow navigation
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    focusedIndex.value = (focusedIndex.value + 1) % list.length
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    focusedIndex.value = (focusedIndex.value - 1 + list.length) % list.length
    return
  }
  // Copy selected (Enter) — honors customization
  if (matchShortcut(savedAppKeys('copyClip') || ['Enter'], e)) {
    e.preventDefault()
    const item = list[focusedIndex.value]
    if (item) copyWithPinCheck(item)
    return
  }
  // Delete selected (Delete) — honors customization
  if (matchShortcut(savedAppKeys('deleteClip') || ['Delete'], e)) {
    e.preventDefault()
    const item = list[focusedIndex.value]
    if (item) handleSingleDelete(item)
    return
  }
}

// ===== Helpers =====
function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return t('just_now')
  if (diff < 3600000) return Math.floor(diff / 60000) + t('m_ago')
  if (diff < 86400000) return Math.floor(diff / 3600000) + t('h_ago')
  return Math.floor(diff / 86400000) + t('d_ago')
}

function getTypeLabel(type: string): string {
  const map: Record<string, string> = {
    text: 'TXT', image: 'IMG', file: 'FILE', link: 'URL',
  }
  return map[type] || type.toUpperCase()
}

function formatContent(item: ClipItem): string {
  const content = displayContent(item)
  // 文件类型：始终尝试显示文件名
  if (item.type === 'file') {
    try {
      const parsed = JSON.parse(content)
      // { name, size, type } 格式
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.name) {
        return String(parsed.name)
      }
      // { name, paths } 格式
      if (parsed && typeof parsed === 'object' && parsed.paths && Array.isArray(parsed.paths) && parsed.paths[0]) {
        return parsed.paths[0].split(/[/\\]/).pop() || parsed.paths[0]
      }
      // 路径数组格式 ["D:\\path\\file"]
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
        return parsed[0].split(/[/\\]/).pop() || parsed[0]
      }
    } catch { /* not JSON */ }

    // 内容可能是文件路径数组字符串（旧格式）
    const raw = content.trim()
    if (raw.startsWith('["') && raw.includes('\\')) {
      try {
        const paths = JSON.parse(raw)
        if (Array.isArray(paths) && paths[0]) return paths[0].split(/[/\\]/).pop() || paths[0]
      } catch { /* ignore */ }
    }

    // 内容是文件路径（含反斜杠）
    if (raw.includes('\\') || raw.includes('/')) {
      const segments = raw.split(/[/\\]/)
      const last = segments[segments.length - 1]
      if (last && last.includes('.')) return last
    }

    // 旧逻辑会在这里截断文件名；现在预览由 CSS 控制，不再做字符截断。
    return raw || 'Unknown file'
  }

  // 非文件类型：不再硬截断字符，视觉行数由 CSS line-clamp 控制
  return content
}

// 内容类型检测（带缓存，避免长文本列表渲染时反复正则扫描）
const contentTypeCache = new Map<string, 'code' | 'url' | 'text'>()
const MAX_CONTENT_TYPE_CACHE = 2000
function detectContentType(content: string): 'code' | 'url' | 'text' {
  if (!content) return 'text'
  const cached = contentTypeCache.get(content)
  if (cached !== undefined) return cached
  const trimmed = content.trim()
  // URL 检测
  if (/^https?:\/\/\S+$/.test(trimmed)) {
    if (contentTypeCache.size > MAX_CONTENT_TYPE_CACHE) {
      const firstKey = contentTypeCache.keys().next().value
      if (firstKey !== undefined) contentTypeCache.delete(firstKey)
    }
    contentTypeCache.set(content, 'url')
    return 'url'
  }
  // 代码检测：常见代码模式
  if (/[{}\[\]];?\s*$/.test(trimmed) ||
      /\b(function|const|let|var|class|import|export|return|if|for|while|async|await)\s/.test(trimmed) ||
      /^\s*(def |class |import |from |public |private |protected )/.test(trimmed) ||
      /=>\s*[{(]/.test(trimmed) ||
      /^\s*<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>/i.test(trimmed) ||
      /:\s*(string|number|boolean|void|any|null|undefined)\s/.test(trimmed)) {
    if (contentTypeCache.size > MAX_CONTENT_TYPE_CACHE) {
      const firstKey = contentTypeCache.keys().next().value
      if (firstKey !== undefined) contentTypeCache.delete(firstKey)
    }
    contentTypeCache.set(content, 'code')
    return 'code'
  }
  if (contentTypeCache.size > MAX_CONTENT_TYPE_CACHE) {
    const firstKey = contentTypeCache.keys().next().value
    if (firstKey !== undefined) contentTypeCache.delete(firstKey)
  }
  contentTypeCache.set(content, 'text')
  return 'text'
}

// 提取 URL 域名
function extractDomain(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname
  } catch {
    return url.slice(0, 30)
  }
}
</script>

<template>
  <!-- Clipboard View -->
  <div class="clipboard-page">
    <!-- Toolbar -->
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="toolbar-title">{{ t('nav_clipboard') }}</span>
        <Badge variant="secondary" class="count-badge">{{ totalItems }} {{ t('items_c') }}</Badge>
      </div>
      <div class="toolbar-spacer" />
      <div class="toolbar-right">
        <Button variant="outline" size="sm" @click="triggerFileUpload">
          <Upload :size="15" />
          <span>{{ t('upload_file') }}</span>
        </Button>
        <input ref="fileInputRef" type="file" style="display:none" multiple @change="handleFileUpload" />
        <Button variant="default" size="sm" @click="toggleQuickPaste">
          <Plus :size="15" />
          <span>{{ t('new_clip') }}</span>
        </Button>
      </div>
    </div>

    <!-- Filter / Segmented Control -->
    <div class="filter-row">
      <div class="segment-control">
        <button
          v-for="opt in filterOptions"
          :key="opt.value"
          class="segment-btn"
          :class="{ active: activeFilter === opt.value }"
          @click="clip.setFilter(opt.value)"
        >{{ opt.label }}</button>
      </div>
      <div class="tab-spacer" />
      <div class="search-field">
        <Search :size="14" class="search-field-icon" />
        <Input v-model="searchInput" type="text" :placeholder="t('search_ph')" class="search-input" :aria-label="t('search_ph')" @input="clip.setSearch(searchInput)" />
      </div>
      <Button variant="ghost" size="icon-sm" :class="{ 'text-primary': showFilterPanel }" @click="toggleFilterPanel" :title="t('adv_filter')">
        <Filter :size="16" />
      </Button>
      <Button v-if="selectedCount > 0" variant="ghost" size="icon-sm" class="batch-del-btn" @click="handleBatchDelete" :title="t('batch_select')">
        <Trash2 :size="15" />
        <span style="margin-left:2px;font-size:11px;">{{ selectedCount }}</span>
      </Button>
    </div>

    <!-- 高级搜索筛选面板 -->
    <div v-if="showFilterPanel" class="adv-filter-panel">
      <div class="adv-filter-grid">
        <div class="adv-filter-field">
          <label>{{ t('filter_device') }}</label>
          <CustomSelect v-model="clip.advancedFilters.value.deviceId" class="adv-filter-select-cs">
            {{ deviceLabel }}
            <template #options>
              <CustomSelectOption value="" :selected="clip.advancedFilters.value.deviceId === ''" @select="onDeviceChange('')">{{ t('filter_all_devices') }}</CustomSelectOption>
              <CustomSelectOption
                v-for="d in devices"
                :key="d.id"
                :value="d.id"
                :selected="clip.advancedFilters.value.deviceId === d.id"
                @select="onDeviceChange(d.id)"
              >{{ d.name }}</CustomSelectOption>
            </template>
          </CustomSelect>
        </div>
        <div class="adv-filter-field">
          <label>{{ t('filter_from') }}</label>
          <Popover>
            <PopoverTrigger as-child>
              <Button variant="outline" class="font-normal h-9 px-3 gap-2 min-w-[90px] rounded-md">
                <CalendarIcon class="h-4 w-4 shrink-0" />
                <span class="truncate">{{ clip.advancedFilters.value.dateFrom || t('filter_from') }}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent class="w-80 p-4">
              <Calendar v-model="dateFromValue" />
            </PopoverContent>
          </Popover>
        </div>
        <div class="adv-filter-field">
          <label>{{ t('filter_to') }}</label>
          <Popover>
            <PopoverTrigger as-child>
              <Button variant="outline" class="font-normal h-9 px-3 gap-2 min-w-[90px] rounded-md">
                <CalendarIcon class="h-4 w-4 shrink-0" />
                <span class="truncate">{{ clip.advancedFilters.value.dateTo || t('filter_to') }}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent class="w-80 p-4">
              <Calendar v-model="dateToValue" />
            </PopoverContent>
          </Popover>
        </div>
        <div class="adv-filter-field">
          <label>{{ t('filter_tag') }}</label>
          <Input
            v-model="clip.advancedFilters.value.tag"
            class="h-10 text-sm px-4 w-40"
            :placeholder="t('filter_tag_ph')"
            @keyup.enter="clip.loadClipboardItems({ page: 1 })"
            @blur="clip.loadClipboardItems({ page: 1 })"
          />
        </div>
      </div>
      <div class="adv-filter-actions">
        <Button variant="ghost" size="default" class="min-w-[100px] rounded-md px-5" @click="clip.clearAdvancedFilters()">{{ t('filter_clear') }}</Button>
        <Button variant="outline" size="default" class="min-w-[100px] rounded-md px-5" @click="showFilterPanel = false">{{ t('filter_close') }}</Button>
      </div>
    </div>

    <!-- Confirm Dialog -->
    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="t('confirm_t')"
      :message="confirmMessage"
      :confirm-text="t('confirm_t')"
      :cancel-text="t('cancel_btn')"
      :confirm-variant="confirmVariant"
      @confirm="onConfirmDialog"
      @cancel="onCancelDialog"
    />

    <!-- 条目级密码对话框 -->
    <ItemPasswordDialog
      v-model:open="pwDialogOpen"
      :item="pwDialogItem"
      @updated="onItemPasswordUpdated"
    />

    <!-- Clipboard Table (shadcn-vue Data Table style) -->
    <div class="clipboard-view" role="region" :aria-label="t('nav_clipboard')" @scroll="onClipboardScroll">
      <!-- Skeleton Loading -->
      <div v-if="isLoading && filteredItems.length === 0" class="skeleton-wrap" :aria-label="t('ver_loading')" role="status">
        <div v-for="n in 6" :key="n" class="skeleton-row">
          <div class="sk sk-checkbox" />
          <div class="sk sk-content" />
          <div class="sk sk-source" />
          <div class="sk sk-badge" />
          <div class="sk sk-time" />
          <div class="sk sk-actions" />
        </div>
      </div>

      <div v-else-if="filteredItems.length > 0" class="table-wrapper">
        <Table role="table" :aria-label="t('nav_clipboard')">
        <TableHeader>
          <TableRow>
            <TableHead class="w-12">
              <Checkbox :model-value="allSelected" @update:model-value="() => clip.toggleSelectAll()" />
            </TableHead>
            <TableHead>{{ t('head_content') }}</TableHead>
            <TableHead class="w-[160px]">{{ t('head_source') }}</TableHead>
            <TableHead class="w-[64px]">{{ t('head_type') }}</TableHead>
            <TableHead class="w-[90px]">{{ t('head_time') }}</TableHead>
            <TableHead class="w-[120px] text-center">{{ t('head_actions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow
            v-for="(item, idx) in filteredItems"
            :key="item.id"
            :data-state="item.selected ? 'selected' : undefined"
            :class="{ focused: idx === focusedIndex }"
            @mouseenter="focusedIndex = idx"
            @click="focusedIndex = idx"
            @dblclick="onDblClick(item)"
          >
            <TableCell class="w-12">
              <Checkbox :model-value="item.selected" @update:model-value="(v: boolean | string) => (item.selected = v === true)" />
            </TableCell>
            <TableCell class="cell-content">
              <div class="cell-content-inner">
                <!-- 条目级密码保护遮罩：受保护且未解锁时覆盖所有内容 -->
                <template v-if="itemPw.isItemProtected(item) && !itemPw.isUnlocked(item.id)">
                  <div class="cell-protected-mask">
                    <Lock :size="14" />
                    <span>{{ t('item_protected_mask') }}</span>
                    <Button variant="outline" size="sm" class="h-7 px-2 text-[11px]" @click.stop="openItemPassword(item)">{{ t('item_unlock') }}</Button>
                  </div>
                </template>
                <!-- 图片预览 -->
                <span v-else-if="item.type === 'image'" class="cell-img-preview">
                  <img v-if="item.preview && item.preview !== 'loading'" :src="item.preview" alt="" class="cell-thumb" />
                  <div v-else class="cell-thumb cell-thumb-placeholder">
                    <ImageIcon :size="14" style="opacity:0.4" />
                  </div>
                  <div v-if="isItemSensitive(item) && peekItemId !== item.id" class="cell-mask-overlay">
                    <span>{{ t('content_masked') }}</span>
                    <Button variant="outline" size="sm" class="h-7 px-2 text-[11px]" @click.stop="showPeek(item.id)">{{ t('peek_content') }}</Button>
                  </div>
                </span>
                <!-- URL 链接样式 -->
                <span v-else-if="item.type === 'link' || detectContentType(displayContent(item)) === 'url'" class="cell-link-preview">
                  <template v-if="isItemSensitive(item) && peekItemId !== item.id">
                    <div class="cell-text-mask"><span>{{ t('content_masked') }}</span><Button variant="outline" size="sm" class="h-7 px-2 text-[11px]" @click.stop="showPeek(item.id)">{{ t('peek_content') }}</Button></div>
                  </template>
                  <template v-else>
                    <ExternalLink :size="12" class="cell-link-icon" />
                    <span class="cell-link-content">
                      <span class="cell-link-text">{{ displayContent(item) }}</span>
                      <span class="cell-link-domain">{{ extractDomain(displayContent(item)) }}</span>
                    </span>
                  </template>
                </span>
                <!-- 文件类型（必须在 code/url 检测之前，否则 JSON 路径数组会被误判为 code） -->
                <span v-else-if="item.type === 'file'" class="cell-text">
                  <template v-if="isItemSensitive(item) && peekItemId !== item.id">
                    <div class="cell-text-mask"><span>{{ t('content_masked') }}</span><Button variant="outline" size="sm" class="h-7 px-2 text-[11px]" @click.stop="showPeek(item.id)">{{ t('peek_content') }}</Button></div>
                  </template>
                  <template v-else>
                    <span v-if="item.id.startsWith('local-') || item.id.startsWith('file-')" class="syncing-label">
                      <span class="syncing-dot" /> {{ formatContent(item) }}
                    </span>
                    <span v-else>{{ formatContent(item) }}</span>
                  </template>
                </span>
                <!-- 代码样式 -->
                <span v-else-if="detectContentType(displayContent(item)) === 'code'" class="cell-code-preview">
                  <template v-if="isItemSensitive(item) && peekItemId !== item.id">
                    <div class="cell-text-mask"><span>{{ t('content_masked') }}</span><Button variant="outline" size="sm" class="h-7 px-2 text-[11px]" @click.stop="showPeek(item.id)">{{ t('peek_content') }}</Button></div>
                  </template>
                  <template v-else><code>{{ displayContent(item) }}</code></template>
                </span>
                <!-- 普通文本 -->
                <span v-else class="cell-text">
                  <template v-if="isItemSensitive(item) && peekItemId !== item.id">
                    <div class="cell-text-mask"><span>{{ t('content_masked') }}</span><Button variant="outline" size="sm" class="h-7 px-2 text-[11px]" @click.stop="showPeek(item.id)">{{ t('peek_content') }}</Button></div>
                  </template>
                  <template v-else>{{ formatContent(item) }}</template>
                </span>
              </div>
            </TableCell>
            <TableCell class="cell-source">{{ item.source || 'Desktop' }}</TableCell>
            <TableCell>
              <Badge variant="outline" class="type-badge-new" :data-type="item.type">
                <span class="type-dot" />
                {{ getTypeLabel(item.type) }}
              </Badge>
            </TableCell>
            <TableCell class="cell-time">{{ timeAgo(item.timestamp) }}</TableCell>
            <TableCell>
              <div class="cell-actions">
                <Button v-if="item.type !== 'file' || hasLocalPath(item)" variant="ghost" size="icon-sm" class="btn-action-hide" @click="onCopyItem(item)" :title="t('copy')">
                  <Copy :size="14" />
                </Button>
                <Button variant="ghost" size="icon-sm" class="btn-action-hide" @click="shareItem(item)" :title="t('shared_link')">
                  <Link :size="14" />
                </Button>
                <Button v-if="item.type === 'image'" variant="ghost" size="icon-sm" class="btn-action-hide" @click="emit('preview-image', item)" :title="t('preview')">
                  <ImageIcon :size="14" />
                </Button>
                <Button v-else-if="item.type === 'link'" variant="ghost" size="icon-sm" class="btn-action-hide" @click="openLink(item)" :title="t('link_opened')">
                  <ExternalLink :size="14" />
                </Button>
                <Button v-else-if="item.type === 'text'" variant="ghost" size="icon-sm" class="btn-action-hide" @click="emit('preview-text', item)" :title="t('preview')">
                  <FileText :size="14" />
                </Button>
                <Button v-else-if="item.type === 'file'" variant="ghost" size="icon-sm" class="btn-action-hide" @click="emit('preview-file', item)" :title="t('preview')">
                  <FileText :size="14" />
                </Button>
                <Button v-if="item.type === 'file' && hasLocalPath(item)" variant="ghost" size="icon-sm" class="btn-action-hide" @click="revealFileFolder(item)" :title="t('show_in_folder')">
                  <Folder :size="14" />
                </Button>
                <!-- Manual sensitive lock/unlock -->
                <Button variant="ghost" size="icon-sm" class="btn-action-hide" :class="{ 'sensitive-locked': (item as any).metadata?.sensitive }" @click="onToggleSensitive(item)" :title="(item as any).metadata?.sensitive ? t('sens_unlock') : t('sens_lock')">
                  <Lock :size="14" />
                </Button>
                <!-- 条目级密码保护（仅文本/链接/代码支持） -->
                <Button v-if="item.type === 'text' || item.type === 'link'" variant="ghost" size="icon-sm" class="btn-action-hide" :class="{ 'pw-locked': itemPw.isItemProtected(item) }" @click="openItemPassword(item)" :title="itemPw.isItemProtected(item) ? (itemPw.isUnlocked(item.id) ? t('item_password_managed') : t('item_password_unlock')) : t('item_password_set')">
                  <KeyRound v-if="!itemPw.isItemProtected(item) || !itemPw.isUnlocked(item.id)" :size="14" />
                  <Unlock v-else :size="14" />
                </Button>
                <!-- 标签 -->
                <Button variant="ghost" size="icon-sm" class="btn-action-hide" :class="{ 'tag-active': item.tags && item.tags.length }" @click="openTagEditor(item)" :title="t('item_tags')">
                  <Tag :size="14" />
                </Button>
                <!-- Star: favorite immediately, show popover or dropdown -->
                <div class="add-col-wrap" :data-item-id="item.id">
                  <Button variant="ghost" size="icon-sm" class="btn-action-hide" :class="{ 'favorited': item.isFavorite }" @click.stop="handleFavorite(item)" :title="item.isFavorite ? t('unfavorite') : t('favorite')">
                    <Star :size="14" :fill="item.isFavorite ? 'currentColor' : 'none'" />
                  </Button>
                  <!-- Popover: inline collection picker (no navigation needed) -->
                  <div v-if="favPopoverItemId === item.id" class="fav-popover" :class="{ 'fav-popover--flipped': favPopoverFlipped }" @click.stop @mouseenter="onFavPopoverEnter" @mouseleave="onFavPopoverLeave">
                    <div class="fav-popover-msg">✓ {{ t('fav_popper_msg') }}</div>
                    <div class="fav-popover-cols">
                      <Button v-for="node in collectionTreeNodes" :key="node.id" variant="ghost" size="sm" class="fav-popover-col w-full justify-start" :style="{ paddingLeft: (node.depth - 2) * 16 + 8 + 'px' }" @click="pickCollection(item.id, node.id)">
                        <component :is="collectionIconMap[node.icon] || Folder" :size="14" />
                        <span>{{ node.name }}</span>
                      </Button>
                    </div>
                    <template v-if="!showFavNewInput">
                      <Button variant="outline" size="sm" class="w-full justify-start gap-1" @click="showFavNewInput = true">
                        <Plus :size="12" /> {{ t('fav_new_col') }}
                      </Button>
                    </template>
                    <template v-else>
                      <div class="flex items-center gap-1">
                        <Input v-model="favNewName" class="h-8 flex-1 px-2 text-xs" :placeholder="t('fav_new_col_placeholder')" maxlength="100"
                          @keydown.enter="createAndMove(item.id)" @keydown.esc="dismissFavPopover()" />
                        <Button variant="default" size="icon-sm" @click="createAndMove(item.id)" :title="t('confirm_t')"><Check :size="12" /></Button>
                        <Button variant="ghost" size="icon-sm" @click="dismissFavPopover()" :title="t('fav_cancel')"><X :size="12" /></Button>
                      </div>
                    </template>
                  </div>
                  <!-- Dropdown: shown when collections exist -->
                  <div v-if="addToColItemId === item.id && collections.length > 0" class="add-col-dropdown">
                    <div class="add-col-dropdown-title">收藏到</div>
                    <Button v-for="node in collectionTreeNodes" :key="node.id" variant="ghost" size="sm" class="add-col-option w-full justify-start" :style="{ paddingLeft: (node.depth - 2) * 16 + 8 + 'px' }" @click="addToCollection(node.id, item.id)">
                      <component :is="collectionIconMap[node.icon] || Folder" :size="14" />
                      <span>{{ node.name }}</span>
                    </Button>
                  </div>
                </div>
                <Button variant="ghost" size="icon-sm" class="btn-action-hide danger" @click="handleSingleDelete(item)" :title="t('delete')">
                  <Trash2 :size="14" />
                </Button>
                <!-- 标签编辑弹出层 -->
                <div v-if="tagEditorItemId === item.id" class="tag-popover" @click.stop>
                  <div class="tag-popover-title">{{ t('item_tags_edit') }}</div>
                  <Input v-model="tagInput" class="h-9 px-3 text-xs" :placeholder="t('item_tags_ph')" maxlength="200" @keydown.enter="saveItemTags(item)" @keydown.esc="closeTagEditor()" />
                  <div class="tag-popover-actions">
                    <Button variant="outline" size="sm" class="min-w-[60px] rounded-md" @click="closeTagEditor()">{{ t('cancel') }}</Button>
                    <Button variant="default" size="sm" class="min-w-[60px] rounded-md" @click="saveItemTags(item)">{{ t('save') }}</Button>
                  </div>
                </div>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
        </Table>

        <!-- 加载更多（分页）：后端硬删正确，但历史可能超过 50 条；暴露总数+加载更多，
             删除后旧条目滚入 page1 的"看起来没删"问题便一目了然。 -->
        <div v-if="hasMore" class="load-more-wrap">
          <Button variant="outline" size="sm" :disabled="loadingMore" @click="clip.loadMore()">
            <span v-if="loadingMore">{{ t('loading_more') }}</span>
            <span v-else>{{ t('load_more') }}（{{ remaining }}）</span>
          </Button>
        </div>
      </div>

      <!-- Empty State -->
      <div v-else class="empty-state">
        <div class="empty-icon-wrap">
          <ClipboardList :size="48" style="color:var(--text-tertiary)" />
        </div>
        <h3 class="empty-title">{{ t('empty_title') }}</h3>
        <p class="empty-desc">{{ t('empty_desc') }}</p>
        <div class="empty-hints">
          <div class="empty-hint">
            <Copy :size="14" class="empty-hint-icon" />
            <span>{{ t('empty_hint_copy') }}</span>
          </div>
          <div class="empty-hint">
            <svg class="empty-hint-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8"/></svg>
            <span>{{ t('empty_hint_shortcut') }}</span>
          </div>
          <div class="empty-hint">
            <Upload :size="14" class="empty-hint-icon" />
            <span>{{ t('empty_hint_upload') }}</span>
          </div>
        </div>
        <p class="empty-action">{{ t('empty_action') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== CLIPBOARD PAGE ===== */
.clipboard-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ===== TOOLBAR ===== */
.toolbar { display: flex; align-items: center; gap: 16px; height: 56px; padding: 0 24px; background: var(--bg-surface); flex-shrink: 0; }
.toolbar-left { display: flex; align-items: center; gap: 8px; }
.toolbar-title { font-weight: 600; font-size: 16px; letter-spacing: -0.01em; }
.count-badge { padding: 2px 10px !important; }
.toolbar-spacer { flex: 1; }
.toolbar-right { display: flex; align-items: center; gap: 8px; }
/* Ensure toolbar buttons have comfortable padding like the reference */
.toolbar-right :deep(button) { padding-left: 18px !important; padding-right: 18px !important; }

/* ===== FILTER / SEGMENTED CONTROL ===== */
.filter-row { display: flex; align-items: center; gap: 12px; padding: 12px 24px; flex-shrink: 0; }

/* Pill / segmented control container */
.segment-control {
  display: inline-flex;
  background: var(--bg-hover);
  padding: 3px;
  border-radius: var(--radius-md);
  gap: 2px;
}
.segment-btn {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  padding: 4px 16px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
  line-height: 1.4;
}
.segment-btn:hover { color: var(--text-primary); background: var(--bg-active); }
.segment-btn.active {
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: var(--shadow-card);
  font-weight: 600;
}

.tab-spacer { flex: 1; }

/* Search field (always visible) */
.search-field { position: relative; display: inline-flex; align-items: center; }
.search-field-icon { position: absolute; left: 10px; color: var(--text-tertiary); pointer-events: none; }
.search-input {
  width: 200px; height: 34px; padding: 0 12px 0 32px;
  border: 1px solid var(--border-default); border-radius: var(--radius-md);
  font-size: 13px; background: var(--bg-surface); color: var(--text-primary);
  outline: none; transition: border-color 0.15s;
}
.search-input:focus { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-light); }

/* Batch delete button */
.batch-del-btn { color: var(--danger); }
.batch-del-btn:hover { background: var(--danger-bg); }

/* ===== CLIPBOARD TABLE ===== */
.clipboard-view { flex: 1; overflow-y: auto; padding: 0; }
.table-wrapper { border: none; border-radius: 0; overflow: visible; }

/* 加载更多（分页） */
.load-more-wrap { display: flex; justify-content: center; padding: 16px 0 28px; }
.load-more-wrap :deep(button) { padding-left: 22px !important; padding-right: 22px !important; }

.clipboard-view :deep(table) { border-collapse: separate; border-spacing: 0; width: 100%; }
.clipboard-view :deep(thead tr) { border-bottom: 1px solid var(--border-default); }
.clipboard-view :deep(thead th) {
  padding: 10px 16px; text-align: center; font-weight: 500; font-size: 12px;
  color: var(--text-tertiary); background: var(--bg-surface);
  position: sticky; top: 0; z-index: 1;
}
.clipboard-view :deep(tbody tr) { border-bottom: 1px solid var(--border-subtle); transition: background .12s ease; }
.clipboard-view :deep(tbody tr:hover) { background: var(--bg-hover); }
/* Keyboard-focused row (arrow nav / copyClip / deleteClip in-app shortcuts) */
.clipboard-view :deep(tbody tr.focused) { background: var(--accent-light); box-shadow: inset 3px 0 0 var(--accent); }
.clipboard-view :deep(tbody tr.focused:hover) { background: var(--accent-light); }
.clipboard-view :deep(tbody tr:last-child) { border-bottom-color: transparent; }
.clipboard-view :deep(tbody td) { padding: 8px 16px; vertical-align: middle; }

/* Cell styles */
.cell-content { overflow: hidden; max-width: 0; }
.cell-content-inner { display: flex; align-items: center; gap: 8px; }

/* Syncing indicator */
.syncing-label { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); }
.syncing-dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--warning);
  animation: syncPulse 1.2s ease-in-out infinite; flex-shrink: 0;
}
@keyframes syncPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

/* 普通文本 */
.cell-text {
  font-size: 13px; line-height: 1.45; color: var(--text-primary);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  overflow: hidden; text-overflow: ellipsis; word-break: break-word;
}

/* 图片预览 */
.cell-img-preview { display: flex; align-items: center; gap: 10px; flex-shrink: 0; position: relative; }
.cell-thumb { width: 48px; height: 34px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); }
.cell-thumb-placeholder { width: 48px; height: 34px; display: flex; align-items: center; justify-content: center; background: var(--bg-hover); border-radius: var(--radius-sm); }

/* Privacy: sensitive content mask overlay */
.cell-mask-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 6px; background: var(--bg-hover); border-radius: var(--radius-sm); font-size: 11px; color: var(--text-tertiary); z-index: 1; }
.cell-text-mask { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-tertiary); }

/* URL 链接样式 */
.cell-link-preview {
  display: flex; align-items: flex-start; gap: 8px; width: 100%;
  padding: 5px 9px; border-radius: var(--radius-sm);
  background: var(--bg-hover); border: 1px solid var(--border-subtle);
  transition: background 0.15s;
}
.cell-link-preview:hover { background: var(--bg-active); }
.cell-link-icon { flex-shrink: 0; margin-top: 2px; color: var(--info); }
.cell-link-content { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.cell-link-text {
  font-size: 13px; color: var(--info); word-break: break-all;
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical;
  overflow: hidden; text-overflow: ellipsis; line-height: 1.4;
}
.cell-link-domain { font-size: 11px; color: var(--text-tertiary); }

/* 代码样式 */
.cell-code-preview {
  display: block; width: 100%;
  padding: 5px 9px; border-radius: var(--radius-sm);
  background: var(--bg-hover); border: 1px solid var(--border-subtle);
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
  font-size: 12px; line-height: 1.45; color: var(--text-secondary);
  white-space: pre-wrap; word-break: break-all;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  overflow: hidden;
}

.cell-source { color: var(--text-secondary); font-size: 13px; white-space: nowrap; }

/* Type badge (shadcn Badge + colored dot) */
.type-badge-new {
  gap: 6px; font-size: 11px; font-weight: 600; letter-spacing: .02em;
  text-transform: uppercase;
  padding-left: 8px; padding-right: 9px;
}
.type-dot { width: 6px; height: 6px; border-radius: 9999px; background: var(--text-tertiary); flex-shrink: 0; }
.type-badge-new[data-type="image"] .type-dot { background: var(--success); }
.type-badge-new[data-type="link"] .type-dot { background: var(--info); }
.type-badge-new[data-type="file"] .type-dot { background: var(--warning); }
.type-badge-new[data-type="text"] .type-dot { background: var(--text-tertiary); }

.cell-time { color: var(--text-tertiary); font-size: 12px; white-space: nowrap; }

/* Action buttons (always visible) */
.cell-actions { display: flex; align-items: center; gap: 2px; justify-content: flex-end; }
.cell-actions .btn-action-hide { opacity: 1; color: var(--text-tertiary); border-radius: var(--radius-sm); transition: background .15s ease, color .15s ease; }
.cell-actions .btn-action-hide:hover { background: var(--bg-active); color: var(--text-primary); }
.cell-actions .btn-action-hide.danger { color: var(--danger); }
.cell-actions .btn-action-hide.danger:hover { background: var(--danger-bg); }
.cell-actions .btn-action-hide.favorited { color: var(--warning); }
.cell-actions .btn-action-hide.sensitive-locked { color: var(--danger); }
.cell-actions .btn-action-hide.sensitive-locked:hover { background: var(--danger-bg); }

/* ===== EMPTY STATE ===== */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 80px 20px; text-align: center; }
.empty-icon-wrap { width: 64px; height: 64px; border-radius: 16px; background: var(--bg-hover); display: flex; align-items: center; justify-content: center; margin-bottom: 16px; }
.empty-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.empty-desc { font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.empty-hints { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
.empty-hint { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); }
.empty-hint-icon { flex-shrink: 0; color: var(--text-tertiary); }
.empty-action { font-size: 13px; color: var(--accent); margin-top: 16px; font-weight: 500; }

/* ===== SKELETON LOADING ===== */
.skeleton-wrap { padding: 0; }
.skeleton-row { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid var(--border-subtle); }
.sk { border-radius: var(--radius-sm); background: var(--bg-hover); animation: skeleton-pulse 1.5s ease-in-out infinite; }
.sk-checkbox { width: 18px; height: 18px; flex-shrink: 0; border-radius: 4px; }
.sk-content { flex: 1; height: 20px; max-width: 40%; }
.sk-source { width: 80px; height: 14px; flex-shrink: 0; }
.sk-badge { width: 52px; height: 22px; flex-shrink: 0; border-radius: 9999px; }
.sk-time { width: 48px; height: 14px; flex-shrink: 0; }
.sk-actions { width: 100px; height: 14px; flex-shrink: 0; }
@keyframes skeleton-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* Icon-only toolbar buttons */
.btn-icon { color: var(--text-secondary); }
.btn-icon.active { color: var(--accent); background: var(--accent-light); }

/* Add to collection dropdown */
.add-col-wrap { position: relative; display: inline-flex; }
.add-col-dropdown {
  position: absolute; top: 100%; right: 0; margin-top: 4px;
  background: var(--bg-surface); border: 1px solid var(--border-default);
  border-radius: var(--radius-md); box-shadow: var(--shadow-modal);
  padding: 4px; z-index: 50; min-width: 160px;
}
.add-col-option {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 10px; border: none; background: none;
  text-align: left; font-size: 12px; color: var(--text-primary); cursor: pointer;
  border-radius: var(--radius-sm); white-space: nowrap;
}
.add-col-option:hover { background: var(--bg-hover); }
.add-col-dropdown-title {
  padding: 4px 10px 2px; font-size: 11px; color: var(--text-tertiary);
  border-bottom: 1px solid var(--border-subtle); margin-bottom: 2px;
}

/* Favorite popover (方案 A: inline collection picker, no navigation) */
.fav-popover {
  position: absolute; top: 100%; right: 0; margin-top: 6px;
  background: var(--bg-surface); border: 1px solid var(--border-default);
  border-radius: var(--radius-md); box-shadow: var(--shadow-modal);
  padding: 10px 12px; z-index: 50; min-width: 200px; max-width: 280px;
  animation: favPopIn 0.2s ease;
}
.fav-popover--flipped {
  position: absolute; bottom: 100%; right: 0; margin-bottom: 6px;
}
.fav-popover-msg { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; white-space: nowrap; }
.fav-popover-cols { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.fav-popover-col {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 5px 10px; border: none; border-radius: var(--radius-sm);
  background: transparent; font-size: 12px; color: var(--text-primary);
  cursor: pointer; text-align: left; white-space: nowrap; transition: all 0.12s;
}
.fav-popover-col:hover { background: var(--accent-bg); color: var(--accent); }
/* fav-popover 内的操作按钮已统一改用 shadcn Button / Input 组件 */

@keyframes favPopIn {
  from { opacity: 0; transform: translateY(-4px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* ===== 高级搜索筛选面板 ===== */
.filter-active { border-color: var(--color-primary, #6366f1) !important; color: var(--color-primary, #6366f1) !important; }
.adv-filter-panel {
  display: flex; align-items: flex-end; gap: 20px; flex-wrap: wrap;
  padding: 20px 24px; margin: 0 12px 8px; background: var(--bg-surface);
  border: 1px solid var(--border-default); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
.adv-filter-grid { display: flex; gap: 24px; flex-wrap: wrap; flex: 1; align-items: flex-end; }
.adv-filter-field { display: flex; flex-direction: column; gap: 8px; }
.adv-filter-field label { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
.adv-filter-select-cs { min-width: 150px; max-width: 200px; }
.adv-filter-actions { display: flex; gap: 12px; align-items: flex-end; }
.cell-protected-mask {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  background: color-mix(in srgb, var(--color-primary, #6366f1) 10%, transparent);
  border: 1px dashed color-mix(in srgb, var(--color-primary, #6366f1) 40%, transparent);
  border-radius: var(--radius-md); font-size: 13px; color: var(--text-secondary);
}

/* ===== 条目操作按钮状态 ===== */
.pw-locked { color: var(--color-primary, #6366f1) !important; }
.tag-active { color: var(--color-primary, #6366f1) !important; }

/* ===== 标签编辑弹出层 ===== */
.tag-popover {
  position: absolute; right: 8px; bottom: 40px; z-index: 50;
  width: 240px; padding: 12px; background: var(--bg-surface);
  border: 1px solid var(--border-default); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal); animation: favPopIn 0.12s ease;
}
.tag-popover-title { font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
.tag-popover-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
