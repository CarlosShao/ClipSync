<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick, h, Teleport } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useConfigStore } from '@/stores/configStore'
import { usePrivacy } from '@/composables/usePrivacy'
import { Star, Search, Copy, Image as ImageIcon, LayoutGrid, List, ExternalLink, FileText, Folder, FolderPlus, FolderInput, Plus, X, Check, CheckSquare, Square, ArrowUpDown, Tag, ClipboardList, ChevronRight, Lock, Bookmark, Archive, Trash2, Palette, Edit } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import Badge from '@/components/ui/badge/Badge.vue'
import Checkbox from '@/components/ui/checkbox/Checkbox.vue'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { createFavoriteCollection, deleteFavoriteCollection, addCollectionItem, removeCollectionItem, setItemTags, getAllFavoriteTags, deleteTag, getCollectionItems, type FavoriteTag } from '@/api/client'
import { useCollections, type CollectionNode } from '@/composables/useCollections'
import { useItemPassword } from '@/composables/useItemPassword'
import ProtectionDialog from '@/components/clipboard/ProtectionDialog.vue'
import { TAG_PRESET_COLORS, getTagDisplayColor, tagColorStyle } from '@/utils/favorites/tagColors'
import { COLLECTION_ICON_MAP, renderCollectionIcon } from '@/utils/favorites/collectionIcons'

const emit = defineEmits<{
  'preview-image': [item: ClipItem]
  'preview-text': [item: ClipItem]
  'preview-file': [item: ClipItem]
  'show-pin-dialog': []
  'show-pin-setup': []
  'toggle-sensitive': [item: ClipItem]
}>()

const { t } = useI18n()
const toast = useSonner()
const clip = useClipboard()
const router = useRouter()
const route = useRoute()
const configStore = useConfigStore()
const itemPw = useItemPassword()

// --- State ---
const searchInput = ref('')
const sortBy = ref<'time' | 'type'>('time')
const sortAsc = ref(false)
const batchMode = ref(false)
const selectedIds = ref<Set<string>>(new Set())
const viewMode = ref<'grid' | 'list'>('grid')
const collapsedGroups = ref<Set<string>>(new Set())

// Pick collection mode (navigated from ClipboardView favorite popover)
const pickItemId = ref<string | null>(null)
watch(
  () => route.query.pickCollection,
  (val) => {
    if (val === 'true' && route.query.itemId) {
      pickItemId.value = route.query.itemId as string
    }
  },
)
function clearPickMode() {
  pickItemId.value = null
  const q = { ...route.query }
  delete q.pickCollection
  delete q.itemId
  router.replace({ query: q })
}

function toggleGroup(key: string) {
  if (collapsedGroups.value.has(key)) collapsedGroups.value.delete(key)
  else collapsedGroups.value.add(key)
  // Force reactivity
  collapsedGroups.value = new Set(collapsedGroups.value)
}

// Collections — useCollections composable manages tree state
const collections = useCollections()

// New collection input state
const showNewCollectionInput = ref(false)
const newCollectionName = ref('')
const newCollectionIcon = ref('folder')
const newCollectionInputRef = ref<HTMLInputElement | null>(null)
const isCreatingCollection = ref(false)
const newCollectionParentId = ref<string | undefined>(undefined)

// Rename input state
const renameInputRef = ref<HTMLInputElement | null>(null)

watch(
  () => collections.renamingNodeId.value,
  (id) => {
    if (id) {
      nextTick(() => {
        renameInputRef.value?.focus()
        renameInputRef.value?.select()
      })
    }
  },
)

function showNewCollectionInputAtTop(parentId?: string) {
  showNewCollectionInput.value = true
  newCollectionParentId.value = parentId
  newCollectionName.value = ''
  newCollectionIcon.value = 'folder'
  nextTick(() => {
    newCollectionInputRef.value?.focus()
  })
}

// Watch signal from context menu "新建子收藏夹"
watch(
  () => collections.newSubCollectionParentId.value,
  (parentId) => {
    if (parentId) {
      showNewCollectionInputAtTop(parentId)
      collections.newSubCollectionParentId.value = null
    }
  },
)

async function confirmNewCollection() {
  if (isCreatingCollection.value) return
  if (!newCollectionName.value.trim()) {
    cancelNewCollection()
    return
  }
  isCreatingCollection.value = true
  try {
    await handleCreateCollection()
  } finally {
    isCreatingCollection.value = false
  }
}

function cancelNewCollection() {
  showNewCollectionInput.value = false
  newCollectionName.value = ''
  isCreatingCollection.value = false
  newCollectionParentId.value = undefined
}

function onNewCollectionBlur() {
  if (!showNewCollectionInput.value) return
  if (newCollectionName.value.trim()) {
    confirmNewCollection()
  } else {
    cancelNewCollection()
  }
}

// Tags
const allTags = ref<FavoriteTag[]>([])
const _tagColorMap = ref<Record<string, string>>({})
const tagColorMap = computed(() => _tagColorMap.value)

// 当 allTags 从服务器加载后，同步到 _tagColorMap
watch(
  allTags,
  (tags) => {
    for (const t of tags) {
      if (t.color) _tagColorMap.value[t.name] = t.color
    }
  },
  { immediate: true },
)
const activeTagFilter = ref<string | null>(null)
const editingTagsItemId = ref<string | null>(null)
const tagInputValue = ref('')
const editingTagColor = ref<string>('')
const colorPickerTag = ref<string>('')
const colorPickerColor = ref<string>('')
const colorPickerPos = ref({ top: '0px', left: '0px' })

// Tag delete confirmation dialog
const showTagDeleteConfirm = ref(false)
const pendingDeleteTag = ref('')
const pendingDeleteTagMessage = ref('')

// 删除收藏夹前的二次确认（防止误删父级）
const showCollectionDeleteConfirm = ref(false)
const pendingDeleteCollectionId = ref('')
const pendingDeleteCollectionMessage = ref('')

// Debounce helper
function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  let timer: any
  return ((...args: any[]) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}
const debouncedLoadTags = debounce(() => loadTags(), 300)

// Add to collection dropdown
const addToColItemId = ref<string | null>(null)

// Privacy: usePrivacy composable
const privacy = usePrivacy()
function isItemSensitive(item: ClipItem): boolean {
  // Check if item is sensitive (PIN protection) or password-protected (advanced encryption)
  return privacy.isItemSensitive(item) || itemPw.isItemProtected(item)
}
function showPeek(item: ClipItem) {
  // Password-protected item — open protection dialog to unlock
  if (itemPw.isItemProtected(item) && !itemPw.isUnlocked(item.id)) {
    openProtectionDialog(item)
    return
  }

  // Sensitive item — use PIN verification
  if (privacy.startPeek(item.id)) {
    // Peek revealed successfully
  } else if (!privacy.pinSet.value) {
    emit('show-pin-setup')
  } else {
    emit('show-pin-dialog')
  }
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

async function onCopyItem(item: ClipItem) {
  // Check if item is password-protected and not unlocked
  if (itemPw.isItemProtected(item) && !itemPw.isUnlocked(item.id)) {
    // Password-protected item - need to unlock first
    // This will be handled by the protection dialog
    toast.show(t('protection_locked'), 'info')
    return
  }

  // Sensitive item - check PIN verification
  if (privacy.isItemSensitive(item) && !privacy.canCopySensitive()) {
    emit('show-pin-dialog')
    return
  }

  await clip.copyItem(item)
  privacy.scheduleClipboardClear()
  toast.show(t('copied'), 'success')
}

// === 统一保护级别对话框 ===
const protectionDialogOpen = ref(false)
const protectionDialogItem = ref<ClipItem | null>(null)
function openProtectionDialog(item: ClipItem) {
  protectionDialogItem.value = item
  protectionDialogOpen.value = true
}
function onProtectionProtected(level: string) {
  // 更新本地条目元数据，让 UI 立即反映保护状态
  if (protectionDialogItem.value) {
    const item = clip.items.value.find((i) => i.id === protectionDialogItem.value!.id)
    if (item) {
      if (!item.metadata) item.metadata = {}
      item.isProtected = true
      if (level === 'advanced') {
        item.metadata.protected = true
      } else if (level === 'pin') {
        item.metadata.sensitive = true
      }
    }
  }
  toast.show(t('protection_applied'), 'success')
}
function onProtectionUnprotected() {
  if (protectionDialogItem.value) {
    const item = clip.items.value.find((i) => i.id === protectionDialogItem.value!.id)
    if (item) {
      if (item.metadata) {
        item.metadata.protected = false
        item.metadata.sensitive = false
      }
      item.isProtected = false
      itemPw.lockItem(protectionDialogItem.value.id)
    }
  }
  toast.show(t('protection_removed'), 'success')
}
function onProtectionUnlocked(content: string) {
  if (protectionDialogItem.value) {
    itemPw.setUnlocked(protectionDialogItem.value.id, content)
    // FavoritesView 用 formatContent 直接显示 item.content，需要把明文写回去并清除保护标记
    const item = clip.items.value.find((i) => i.id === protectionDialogItem.value!.id)
    if (item && content) {
      item.content = content
      item.isProtected = false
      if (item.metadata) item.metadata.protected = false
    }
  }
  toast.show(t('protection_unlocked'), 'success')
}

// Get protection button title based on item state
function getProtectionTitle(item: ClipItem): string {
  if (!itemPw.isItemProtected(item)) return t('protection_set')

  // 高级加密：解锁状态存在 itemPw.unlockedIds 中
  if ((item as any).metadata?.protected === true) {
    return itemPw.isUnlocked(item.id) ? t('protection_unlocked') : t('protection_locked')
  }

  // PIN 保护：解锁状态在 privacy.peekItemId 中（30s 超时）
  if (item.metadata?.sensitive) {
    return privacy.peekItemId.value === item.id ? t('protection_unlocked') : t('protection_locked')
  }

  return t('protection_set')
}

// Drag & drop (local reorder only within favorites)
const dragItemId = ref<string | null>(null)
const localOrder = ref<string[]>([]) // local reorder state

// --- Load ---
async function loadTags() {
  allTags.value = await getAllFavoriteTags()
}
onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  collections.loadCollections()
  loadTags()
  clip.loadClipboardItems({ favorite: true })
})

// Auto-show new collection input when navigated from "no collections" dialog
watch(
  () => route.query.create,
  (val) => {
    if (val === 'true') {
      showNewCollectionInput.value = true
    }
  },
)

// --- Sidebar resize ---
const sidebarWidth = ref(220)
const isResizing = ref(false)
const MIN_SIDEBAR = 150
const MAX_SIDEBAR = 400

function onResizeStart(event: MouseEvent) {
  isResizing.value = true
  const startX = event.clientX
  const startWidth = sidebarWidth.value
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'

  function onMouseMove(e: MouseEvent) {
    const delta = e.clientX - startX
    const newWidth = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, startWidth + delta))
    sidebarWidth.value = newWidth
  }
  function onMouseUp() {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    isResizing.value = false
  }
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

// --- Data ---
const favoriteItems = computed(() => {
  let items = clip.items.value.filter((i) => (i as any).isFavorite)

  // Tag filter
  if (activeTagFilter.value) {
    items = items.filter((i) => getTags(i).includes(activeTagFilter.value!))
  }

  // Search
  if (searchInput.value.trim()) {
    const q = searchInput.value.toLowerCase()
    items = items.filter(
      (i) =>
        (i.content || '').toLowerCase().includes(q) ||
        (i.source || '').toLowerCase().includes(q) ||
        getTags(i).some((tag) => tag.toLowerCase().includes(q)),
    )
  }

  // Apply local reorder if set
  if (localOrder.value.length) {
    const idMap = new Map(items.map((i) => [i.id, i]))
    const reordered: ClipItem[] = []
    for (const id of localOrder.value) {
      if (idMap.has(id)) reordered.push(idMap.get(id)!)
    }
    // append any not in localOrder
    for (const item of items) {
      if (!localOrder.value.includes(item.id)) reordered.push(item)
    }
    return reordered
  }

  // Sort
  items = [...items].sort((a, b) => {
    if (sortBy.value === 'time') {
      const ta = (a as any).favoritedAt || a.timestamp
      const tb = (b as any).favoritedAt || b.timestamp
      return sortAsc.value ? ta - tb : tb - ta
    }
    const typeOrder: Record<string, number> = { text: 0, code: 1, link: 2, image: 3, file: 4 }
    return (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99)
  })

  // Collection filter: if a collection node is active, only show items in that collection
  if (collections.activeNodeId.value) {
    if (collections.collectionsLoaded.value.has(collections.activeNodeId.value)) {
      const colItemIds = collections.collectionItemsMap.value.get(collections.activeNodeId.value)
      if (colItemIds && colItemIds.size > 0) {
        items = items.filter((i) => colItemIds.has(i.id))
      } else {
        items = []
      }
    } else {
      items = []
    }
  }
  return items
})

// Group by type (used by both views)
const groupedItems = computed(() => {
  const groups: Record<string, ClipItem[]> = {}
  for (const item of favoriteItems.value) {
    if (!groups[item.type]) groups[item.type] = []
    groups[item.type].push(item)
  }
  return groups
})
const groupLabels: Record<string, string> = {
  text: t('fav_group_text'),
  code: t('fav_group_code'),
  link: t('fav_group_link'),
  image: t('fav_group_image'),
  file: t('fav_group_file'),
}
const groupOrder = ['text', 'code', 'link', 'image', 'file']
const sortedGroupKeys = computed(() => groupOrder.filter((k) => groupedItems.value[k]?.length))
const favoriteCount = computed(() => clip.items.value.filter((i) => (i as any).isFavorite).length)
const selectedCount = computed(() => selectedIds.value.size)

// --- Helpers ---
function parseMetadata(item: ClipItem): any {
  try {
    const raw = (clip.items.value.find((i) => i.id === item.id) as any)?.metadata
    if (typeof raw === 'string') return JSON.parse(raw)
    return raw || {}
  } catch {
    return {}
  }
}
function getTags(item: ClipItem): string[] {
  const meta = parseMetadata(item)
  return Array.isArray(meta.tags) ? meta.tags : []
}
function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return t('just_now')
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + t('m_ago')
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + t('h_ago')
  return Math.floor(diff / 86_400_000) + t('d_ago')
}
function getTypeLabel(type: string): string {
  const m: Record<string, string> = { text: 'TXT', image: 'IMG', link: 'URL', file: 'FILE', code: 'CODE' }
  return m[type] || type.toUpperCase()
}
// 与 useClipItemDisplay.isItemVisible 保持一致的可见性判断（含隐私模式自动识别的敏感数据）。
// 修复：自动识别为敏感的条目此前既未在列表 mask（泄露明文），复制时却要求 PIN 解锁，逻辑矛盾。
function isItemViewable(item: ClipItem): boolean {
  if (itemPw.isItemProtected(item)) {
    if (item.metadata?.protected === true) return itemPw.isUnlocked(item.id)
    return false
  }
  if (privacy.isItemSensitive(item)) return privacy.isPinUnlocked(item.id)
  return true
}

function formatContent(item: ClipItem): string {
  // 敏感数据（手动锁 + 隐私模式自动识别）未解锁时返回掩码，任何直接调用都安全
  if (privacy.isItemSensitive(item) && !privacy.isPinUnlocked(item.id)) {
    return t('item_password_mask')
  }
  if (item.type === 'image') return t('fav_screenshot')
  if (item.type === 'file') {
    try {
      const meta = JSON.parse(item.content)
      if (meta.name) return meta.name
      if (meta.paths && meta.paths[0]) return meta.paths[0].split(/[/\\]/).pop() || t('fav_file_default')
    } catch {
      /* */
    }
    return item.content?.split(/[/\\]/).pop() || item.content || t('fav_file_default')
  }
  if (item.type === 'link') {
    try {
      return new URL(item.content).hostname
    } catch {
      return item.content
    }
  }
  return item.content || ''
}
function detectContentType(content: string): string {
  if (!content) return 'text'
  const t = content.trim()
  if (/^https?:\/\//i.test(t)) return 'url'
  if (/[{}[\]];?\s*$/.test(t) || /\b(function|const|let|var|class|import|export)\s/.test(t)) return 'code'
  return 'text'
}
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
function hasLocalPath(item: ClipItem): boolean {
  if (item.type !== 'file') return false
  try {
    const m = JSON.parse(item.content)
    return !!(m.paths && m.paths.length)
  } catch {
    return false
  }
}
async function copyItem(item: ClipItem) {
  await clip.copyItem(item)
  toast.show(t('copied'), 'success')
}
async function handleUnfavorite(item: ClipItem) {
  // 如果当前在收藏夹视图中，先从收藏夹移除并实时更新计数
  const activeColId = collections.activeNodeId.value
  if (activeColId) {
    try {
      await removeCollectionItem(activeColId, item.id)
      // 乐观更新 collectionItemsMap
      const newMap = new Map(collections.collectionItemsMap.value)
      const activeSet = newMap.get(activeColId)
      if (activeSet?.has(item.id)) {
        const updated = new Set(activeSet)
        updated.delete(item.id)
        newMap.set(activeColId, updated)
      }
      collections.collectionItemsMap.value = newMap
      // 乐观更新 flatCollections 的 item_count
      collections.flatCollections.value = collections.flatCollections.value.map((c) =>
        c.id === activeColId ? { ...c, item_count: Math.max(0, (c.item_count || 0) - 1) } : c,
      )
    } catch (err: any) {
      console.warn('[Favorites] remove from collection failed:', err)
    }
  }
  clip.toggleFavorite(item)
  selectedIds.value.delete(item.id)
  toast.show(t('fav_unfavorited') || '已取消收藏', 'info')
}
function toggleSort() {
  if (sortBy.value === 'time') sortBy.value = 'type'
  else {
    sortBy.value = 'time'
    sortAsc.value = !sortAsc.value
  }
  localOrder.value = [] // reset local reorder on sort change
}
function sortLabel(): string {
  if (sortBy.value === 'time') return sortAsc.value ? t('fav_sort_time_asc') : t('fav_sort_time_desc')
  return t('fav_sort_type')
}
function openLink(item: ClipItem) {
  try {
    window.open(item.content, '_blank')
  } catch {
    /* */
  }
}
function revealFileFolder(item: ClipItem) {
  try {
    const m = JSON.parse(item.content)
    if (m.paths && m.paths[0])
      import('@tauri-apps/plugin-shell').then((mod) => mod.open(m.paths[0].replace(/[/\\][^/\\]+$/, '')))
  } catch {
    /* */
  }
}

// --- Batch ---
function toggleBatchMode() {
  batchMode.value = !batchMode.value
  if (!batchMode.value) selectedIds.value.clear()
}
function toggleSelect(id: string) {
  if (selectedIds.value.has(id)) selectedIds.value.delete(id)
  else selectedIds.value.add(id)
}
async function batchUnfavorite() {
  const items = clip.items.value.filter((i) => selectedIds.value.has(i.id))
  const activeColId = collections.activeNodeId.value
  if (activeColId) {
    for (const item of items) {
      try {
        await removeCollectionItem(activeColId, item.id)
      } catch (e) {
        /* ignore */
      }
    }
    // 批量乐观更新计数
    const newMap = new Map(collections.collectionItemsMap.value)
    const activeSet = newMap.get(activeColId)
    if (activeSet) {
      const updated = new Set(activeSet)
      for (const item of items) updated.delete(item.id)
      newMap.set(activeColId, updated)
    }
    collections.collectionItemsMap.value = newMap
    collections.flatCollections.value = collections.flatCollections.value.map((c) =>
      c.id === activeColId ? { ...c, item_count: Math.max(0, (c.item_count || 0) - items.length) } : c,
    )
  }
  for (const item of items) clip.toggleFavorite(item)
  toast.show(t('fav_unfav_count', { n: selectedIds.value.size }), 'info')
  selectedIds.value.clear()
  batchMode.value = false
}

// --- Collections ---
const pickAndCreate = ref(false)

async function handleCreateCollection() {
  if (!newCollectionName.value.trim()) return
  const parentId = newCollectionParentId.value
  const data = await collections.createCollection(newCollectionName.value.trim(), newCollectionIcon.value, parentId)
  if (data?.collection) {
    newCollectionName.value = ''
    newCollectionIcon.value = 'folder'
    showNewCollectionInput.value = false
    newCollectionParentId.value = undefined
    toast.show(t('fav_create_ok'), 'success')
    // If in pick mode, auto-move the item to the newly created collection
    if (pickAndCreate.value && pickItemId.value) {
      pickAndCreate.value = false
      await addCollectionItem(data.collection.id, pickItemId.value)
      toast.show(t('fav_moved'), 'success')
      clearPickMode()
    }
  } else {
    toast.show(t('fav_create_fail'), 'error')
  }
}
async function pickAndMove(colId: string) {
  if (!pickItemId.value) return
  const ok = await addCollectionItem(colId, pickItemId.value)
  if (ok) toast.show(t('fav_moved'), 'success')
  clearPickMode()
}
async function handleDeleteCollection(id: string) {
  // 找到要删的节点，构造二次确认消息
  const node = collections.findNodeById(id)
  const name = node?.name || t('this_collection')
  const childCount = (node?.children || []).length
  const itemCount = node?.item_count || 0
  let msg: string
  if (childCount > 0) {
    const translated = t('confirm_delete_collection_with_children', { name, children: childCount, items: itemCount })
    // i18n t() 在 key 找不到时返回字面 key 字符串，所以检查是否等于 key 本身
    msg = translated && translated !== 'confirm_delete_collection_with_children'
      ? translated
      : `确认删除收藏夹「${name}」及其下 ${childCount} 个子收藏夹（共 ${itemCount} 项）？`
  } else {
    const translated = t('confirm_delete_collection', { name, items: itemCount })
    msg = translated && translated !== 'confirm_delete_collection'
      ? translated
      : `确认删除收藏夹「${name}」（共 ${itemCount} 项）？`
  }
  pendingDeleteCollectionId.value = id
  pendingDeleteCollectionMessage.value = msg
  showCollectionDeleteConfirm.value = true
}

const confirmTitleFallback = computed(() => {
  const v = t('confirm_delete_collection_title')
  return v && v !== 'confirm_delete_collection_title' ? v : '删除收藏夹'
})

async function doDeleteCollection() {
  const id = pendingDeleteCollectionId.value
  if (!id) return
  try {
    await collections.deleteCollection(id)
    toast.show(t('fav_deleted'), 'info')
  } catch (e: any) {
    toast.show(e?.message || t('del_fail'), 'error')
  } finally {
    pendingDeleteCollectionId.value = ''
    showCollectionDeleteConfirm.value = false
  }
}
async function selectCollection(id: string | null) {
  collections.selectNode(id)
  activeTagFilter.value = null
}

// Add item to collection
function toggleAddToCol(itemId: string) {
  const wasOpen = addToColItemId.value === itemId
  addToColItemId.value = wasOpen ? null : itemId
}
async function addToCollection(colId: string, itemId: string) {
  addToColItemId.value = null
  try {
    const ok = await addCollectionItem(colId, itemId)
    if (!ok) {
      toast.show(t('fav_add_fail'), 'error')
      return
    }
    toast.show(t('fav_added'), 'success')
    // Refresh collection counts in the tree
    await collections.loadCollections()
    // Optimistically update the active collection's item map so the moved item
    // disappears from the current collection view (if applicable)
    const activeId = collections.activeNodeId.value
    const newMap = new Map(collections.collectionItemsMap.value)
    if (activeId) {
      const activeSet = newMap.get(activeId)
      if (activeSet?.has(itemId)) {
        const updated = new Set(activeSet)
        updated.delete(itemId)
        newMap.set(activeId, updated)
      }
    }
    const targetSet = newMap.get(colId) || new Set()
    newMap.set(colId, new Set(targetSet).add(itemId))
    collections.collectionItemsMap.value = newMap
  } catch (err: any) {
    toast.show(err.message || t('fav_add_fail'), 'error')
  }
}

// --- Tags ---
async function startEditTags(item: ClipItem) {
  editingTagsItemId.value = item.id
  tagInputValue.value = getTags(item).join(', ')
  await nextTick()
}
async function saveTags(item: ClipItem) {
  await saveItemTags(item)
  editingTagsItemId.value = null
  toast.show(t('tag_saved'), 'success')
}
async function saveItemTags(item: ClipItem) {
  const tags = tagInputValue.value
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
  const tagColors: Record<string, string> = { ..._tagColorMap.value }
  if (editingTagColor.value) {
    for (const tag of tags) {
      if (!tagColors[tag]) tagColors[tag] = editingTagColor.value
    }
  }
  const result = await setItemTags(item.id, tags, tagColors)
  if (result?.tagColors) {
    for (const [k, v] of Object.entries(result.tagColors)) {
      if (v) _tagColorMap.value[k] = v
    }
  }
  const target = clip.items.value.find((i) => i.id === item.id)
  if (target) {
    const meta = parseMetadata(target)
    meta.tags = tags
    ;(target as any).metadata = meta
  }
  editingTagColor.value = ''
  await loadTags() // 新增标签后实时同步到标签栏
  if (!result) toast.show(t('fav_tag_save_fail'), 'error')
}

// 标签颜色编辑器
function openTagColorPicker(tag: string, event?: MouseEvent) {
  if (editingTagsItemId.value === null) return
  colorPickerTag.value = tag
  colorPickerColor.value = getTagDisplayColor(tag, _tagColorMap.value)
  // 计算弹出位置（基于点击位置）
  if (event) {
    const x = event.clientX
    const y = event.clientY
    colorPickerPos.value = {
      top: `${y + 8}px`,
      left: `${Math.min(x - 110, window.innerWidth - 240)}px`,
    }
  } else {
    colorPickerPos.value = { top: '50%', left: '50%' }
  }
}
async function saveTagColor() {
  if (!colorPickerTag.value) return
  _tagColorMap.value[colorPickerTag.value] = colorPickerColor.value
  const item = clip.items.value.find((i) => getTags(i).includes(colorPickerTag.value))
  if (item) {
    const tags = getTags(item)
    const tagColors: Record<string, string> = { ..._tagColorMap.value }
    const result = await setItemTags(item.id, tags, tagColors)
    if (!result) toast.show(t('fav_tag_color_save_fail'), 'error')
  }
  colorPickerTag.value = ''
  toast.show(t('fav_tag_color_updated'), 'success')
}
function cancelTagColor() {
  colorPickerTag.value = ''
}
function removeTagColor(tag: string) {
  delete _tagColorMap.value[tag]
  const item = clip.items.value.find((i) => getTags(i).includes(tag))
  if (item) {
    const tags = getTags(item)
    const tagColors: Record<string, string> = { ..._tagColorMap.value }
    setItemTags(item.id, tags, tagColors).then(() => loadTags())
  }
}

// Click an existing tag suggestion → open color editor or toggle it
function onTagSuggestionClick(tag: string, event?: MouseEvent) {
  if (editingTagsItemId.value === null) return
  const currentTags = getTags(clip.items.value.find((i) => i.id === editingTagsItemId.value)!)
  if (currentTags.includes(tag)) {
    openTagColorPicker(tag, event)
  } else {
    toggleTagSuggestion(tag)
  }
}

// Click an existing tag suggestion → toggle it on/off, auto-save, and close edit mode
async function toggleTagSuggestion(tag: string) {
  if (editingTagsItemId.value === null) return
  const current = tagInputValue.value
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
  const idx = current.indexOf(tag)
  if (idx >= 0)
    current.splice(idx, 1) // remove
  else current.push(tag) // add
  tagInputValue.value = current.join(', ')
  const item = clip.items.value.find((i) => i.id === editingTagsItemId.value)
  if (item) {
    await saveItemTags(item) // save to server + update local metadata
    editingTagsItemId.value = null // close edit mode — tag appears on card directly
  }
}

async function removeTag(tagName: string) {
  pendingDeleteTag.value = tagName
  pendingDeleteTagMessage.value = t('tag_delete_confirm').replace('{tag}', tagName)
  showTagDeleteConfirm.value = true
}

async function doDeleteTag() {
  const tagName = pendingDeleteTag.value
  if (!tagName) return
  const ok = await deleteTag(tagName)
  if (ok) {
    if (activeTagFilter.value === tagName) activeTagFilter.value = null
    loadTags()
    toast.show(t('tag_deleted'), 'success')
  } else {
    toast.show(t('tag_delete_fail'), 'error')
  }
  pendingDeleteTag.value = ''
}

// --- Drag & Drop (local reorder only) ---
function onDragStart(e: DragEvent, item: ClipItem) {
  dragItemId.value = item.id
  e.dataTransfer!.effectAllowed = 'move'
  // Initialize localOrder from current display order if not set
  if (!localOrder.value.length) {
    localOrder.value = favoriteItems.value.map((i) => i.id)
  }
}
function onDragOver(e: DragEvent) {
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'move'
}
function onDrop(e: DragEvent, targetItem: ClipItem) {
  e.preventDefault()
  if (!dragItemId.value || dragItemId.value === targetItem.id) return
  if (!localOrder.value.length) localOrder.value = favoriteItems.value.map((i) => i.id)
  const fromIdx = localOrder.value.indexOf(dragItemId.value)
  const toIdx = localOrder.value.indexOf(targetItem.id)
  if (fromIdx === -1 || toIdx === -1) return
  const [moved] = localOrder.value.splice(fromIdx, 1)
  localOrder.value.splice(toIdx, 0, moved)
  dragItemId.value = null
}
function onDragEnd() {
  dragItemId.value = null
}

function goToClipboard() {
  router.push('/app/clipboard')
}

// Close dropdown on mousedown outside (use mousedown instead of click to avoid
// racing with the option's own click handler when the dropdown removes itself)
function handleClickOutside(e: Event) {
  if (addToColItemId.value) {
    const target = e.target as HTMLElement
    const inside = target.closest('.fav-add-col-wrap')
    if (!inside) addToColItemId.value = null
  }
}
onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside)
  // 监听 useCollections 的右键删除请求：弹确认框后真正删
  const onDeleteReq = (e: Event) => {
    const id = (e as CustomEvent).detail?.id
    if (id) handleDeleteCollection(id)
  }
  window.addEventListener('clipsync:collection-delete-requested', onDeleteReq)
  collections.loadCollections().catch((e: any) => {
    toast.show(e.message || t('fav_load_fail'), 'error')
  })
})

function cancelEditTags() {
  editingTagsItemId.value = null
  tagInputValue.value = ''
}
</script>

<style src="./favorites-view.css" scoped></style>

<template>
  <div class="fav-page">
    <!-- Left: Collection tree panel -->
    <div class="fav-col-panel" :style="{ width: sidebarWidth + 'px' }">
      <div class="fav-col-panel-header">
        <div class="fav-col-panel-title-wrap">
          <span class="fav-col-panel-title">{{ t('nav_favorites') }}</span>
          <Badge variant="outline" class="fav-count">{{ favoriteCount }}</Badge>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          class="fav-col-header-new-btn"
          :title="t('fav_new_col')"
          @click="showNewCollectionInputAtTop()"
        >
          <Plus :size="14" />
        </Button>
      </div>
      <!-- Breadcrumb -->
      <div v-if="collections.breadcrumb && collections.breadcrumb.value.length > 0" class="fav-tree-breadcrumb">
        <button class="fav-tree-breadcrumb-item" @click="collections.selectNode(null)">{{ t('fav_all') }}</button>
        <template v-for="(crumb, idx) in collections.breadcrumb.value" :key="crumb.id">
          <span class="fav-tree-breadcrumb-sep">/</span>
          <button
            class="fav-tree-breadcrumb-item"
            :class="{ active: idx === collections.breadcrumb.value.length - 1 }"
            @click="collections.selectNode(crumb.id)"
          >
            {{ crumb.name }}
          </button>
        </template>
      </div>
      <!-- Tree nodes (flat visible list from composable) -->
      <div class="fav-tree-list">
        <!-- Inline new collection row -->
        <div v-if="showNewCollectionInput" class="fav-tree-node fav-tree-node--new">
          <span class="fav-tree-icon">
            <component :is="COLLECTION_ICON_MAP[newCollectionIcon] || Folder" :size="14" />
          </span>
          <input
            ref="newCollectionInputRef"
            v-model="newCollectionName"
            class="fav-tree-new-input"
            :placeholder="t('fav_new_col_placeholder')"
            maxlength="100"
            @keydown.enter="confirmNewCollection"
            @keydown.esc="cancelNewCollection"
            @blur="onNewCollectionBlur"
          />
        </div>

        <!-- Root drop zone -->
        <div
          class="fav-tree-drop-zone"
          :class="{ active: collections.dropTargetId.value === null && collections.dropPosition.value === 'before' }"
          @dragover.prevent="collections.onDragOverRoot($event)"
          @dragleave="collections.onDragLeaveRoot()"
          @drop.prevent="collections.onDropRoot()"
        >
          <span class="fav-tree-drop-line" /> {{ t('fav_drop_root') }}
        </div>

        <!-- Tree nodes -->
        <div
          v-for="node in collections.visibleNodes.value"
          :key="node.id"
          class="fav-tree-node"
          :style="{ paddingLeft: Math.max(0, (node.depth - 2) * 16) + 8 + 'px' }"
          :class="{
            'fav-tree-node--drag-over-inside':
              collections.dropTargetId.value === node.id && collections.dropPosition.value === 'inside',
            'fav-tree-node--drag-over-before':
              collections.dropTargetId.value === node.id && collections.dropPosition.value === 'before',
            'fav-tree-node--drag-over-after':
              collections.dropTargetId.value === node.id && collections.dropPosition.value === 'after',
            'fav-tree-node--dragging': collections.dragNodeId.value === node.id,
          }"
          draggable="true"
          @dragstart="collections.onDragStart(node.id, $event)"
          @dragend="collections.onDragEnd()"
          @dragover.prevent="collections.onDragOver(node.id, $event)"
          @dragleave="collections.onDragLeave($event)"
          @drop.prevent="collections.onDrop(node.id)"
          @contextmenu.prevent="collections.openCtxMenu(node.id, $event)"
          @mouseenter="collections.openFlyout(node.id)"
          @mouseleave="collections.closeFlyout"
        >
          <span
            class="fav-tree-expand"
            :class="{ 'fav-tree-expand--empty': !(node.children || []).length }"
            @click.stop="(node.children || []).length && collections.toggleExpand(node.path)"
          >
            <ChevronRight
              v-if="(node.children || []).length > 0"
              :size="14"
              :class="{ 'fav-tree-expand--open': collections.expandedPaths.value.has(node.path) }"
            />
          </span>
          <span class="fav-tree-icon" :class="{ active: collections.activeNodeId.value === node.id }">
            <component :is="COLLECTION_ICON_MAP[node.icon] || Folder" :size="14" />
          </span>
          <input
            v-if="collections.renamingNodeId.value === node.id"
            ref="renameInputRef"
            v-model="collections.renameValue.value"
            class="fav-tree-rename-input"
            @keydown.enter.stop="collections.confirmRename()"
            @keydown.esc.stop="collections.cancelRename()"
            @blur="collections.confirmRename()"
          />
          <span
            v-else
            class="fav-tree-name"
            :class="{ active: collections.activeNodeId.value === node.id }"
            @click.stop="collections.selectNode(node.id)"
            @dblclick.stop="collections.startRename(node.id)"
          >
            {{ node.name }}
          </span>
          <span class="fav-tree-count">{{ (node.children || []).length + node.item_count }}</span>
          <button class="fav-tree-del" :title="t('delete')" @click.stop="handleDeleteCollection(node.id)">
            ×
          </button>
          <!-- Flyout: show direct children on hover -->
          <div
            v-if="collections.flyoutNodeId.value === node.id && (node.children || []).length > 0"
            class="fav-tree-flyout"
            @mouseenter="collections.closeFlyout"
            @mouseleave="collections.closeFlyout"
          >
            <div
              v-for="child in node.children || []"
              :key="child.id"
              class="fav-tree-flyout-item"
              @click="collections.selectNode(child.id)"
            >
              <component :is="COLLECTION_ICON_MAP[child.icon] || Folder" :size="12" /> {{ child.name }}
              <span class="fav-tree-flyout-count">{{ child.item_count }}</span>
            </div>
          </div>
        </div>

        <!-- Bottom drop zone -->
        <div
          class="fav-tree-drop-zone fav-tree-drop-zone--bottom"
          :class="{ active: collections.dropTargetId.value === null && collections.dropPosition.value === 'after' }"
          @dragover.prevent="collections.onDragOverBottom($event)"
          @dragleave="collections.onDragLeaveBottom()"
          @drop.prevent="collections.onDropBottom()"
        >
          <span class="fav-tree-drop-line" /> {{ t('fav_drop_root') }}
        </div>
      </div>
      <!-- Resize handle -->
      <div class="fav-col-resize-handle" @mousedown.prevent="onResizeStart"></div>
    </div>

    <!-- Right: Main content area -->
    <div class="fav-main">
      <!-- Header: search + actions (title/count moved to collection panel) -->
      <div class="fav-header">
        <div class="fav-header-right">
          <div class="fav-search">
            <Search :size="14" class="fav-search-icon" />
            <input v-model="searchInput" class="fav-search-input" :placeholder="t('search_ph')" />
          </div>
          <Button variant="ghost" size="sm" class="fav-action-btn" @click="toggleSort">
            <ArrowUpDown :size="14" /><span>{{ sortLabel() }}</span>
          </Button>
          <Button
            v-if="favoriteItems.length > 0"
            variant="ghost"
            size="sm"
            class="fav-action-btn"
            :class="{ 'fav-active': batchMode }"
            @click="toggleBatchMode"
          >
            <CheckSquare v-if="batchMode" :size="14" /><Square v-else :size="14" /><span>{{
              batchMode ? t('fav_batch_exit') : t('fav_batch_select')
            }}</span>
          </Button>
          <template v-if="batchMode && selectedCount > 0">
            <span class="fav-batch-count">{{ t('fav_batch_selected', { n: selectedCount }) }}</span>
            <Button variant="ghost" size="sm" class="fav-action-btn fav-unfav-btn" @click="batchUnfavorite">
              <Star :size="14" fill="currentColor" /><span>{{ t('unfavorite') }}</span>
            </Button>
          </template>
          <div class="fav-view-toggle">
            <button
              :class="['fav-view-btn', { active: viewMode === 'grid' }]"
              :title="t('fav_grid_view')"
              @click="viewMode = 'grid'"
            >
              <LayoutGrid :size="14" />
            </button>
            <button
              :class="['fav-view-btn', { active: viewMode === 'list' }]"
              :title="t('fav_list_view')"
              @click="viewMode = 'list'"
            >
              <List :size="14" />
            </button>
          </div>
        </div>
      </div>

      <!-- Row 2: Tag filters -->
      <div v-if="allTags.length > 0" class="fav-tag-bar">
        <span class="fav-tag-label">{{ t('fav_tags_label') }}</span>
        <button :class="['fav-tag-pill', { active: !activeTagFilter }]" @click="activeTagFilter = null">
          {{ t('fav_filter_all') }}
        </button>
        <button
          v-for="tag in allTags"
          :key="tag.name"
          :class="['fav-tag-pill', { active: activeTagFilter === tag.name }]"
          @click="activeTagFilter = activeTagFilter === tag.name ? null : tag.name"
        >
          {{ tag.name }}
          <button class="fav-tag-del" :title="t('fav_tag_delete_title')" @click.stop="removeTag(tag.name)">×</button>
        </button>
      </div>

      <!-- Content -->
      <div class="fav-content">
        <!-- Skeleton loading -->
        <div v-if="collections.loading.value || clip.loading.value" class="fav-skeleton">
          <div v-if="viewMode === 'grid'" class="fav-skeleton-grid">
            <div v-for="i in 8" :key="i" class="fav-skeleton-card" />
          </div>
          <div v-else class="fav-skeleton-list">
            <div v-for="i in 5" :key="i" class="fav-skeleton-row" />
          </div>
        </div>
        <!-- Empty -->
        <div v-else-if="favoriteItems.length === 0 && !searchInput" class="fav-empty">
          <div class="fav-empty-icon"><Star :size="48" :stroke-width="1.2" /></div>
          <h3 class="fav-empty-title">{{ t('fav_empty_title') }}</h3>
          <p class="fav-empty-desc">{{ t('fav_empty_desc') }}</p>
          <Button @click="goToClipboard"><ClipboardList :size="14" /> {{ t('fav_empty_action') }}</Button>
        </div>
        <div v-else-if="favoriteItems.length === 0 && searchInput" class="fav-empty">
          <div class="fav-empty-icon"><Search :size="48" :stroke-width="1.2" /></div>
          <h3 class="fav-empty-title">{{ t('fav_search_empty_title') }}</h3>
          <p class="fav-empty-desc">{{ t('fav_search_empty_desc') }}</p>
        </div>

        <!-- LIST VIEW (grouped) -->
        <div v-else-if="viewMode === 'list'" class="fav-groups">
          <div v-for="gk in sortedGroupKeys" :key="gk" class="fav-group">
            <div class="fav-group-header" style="cursor: pointer" @click="toggleGroup(gk)">
              <ChevronRight
                :size="14"
                class="fav-group-chevron"
                :class="{ 'fav-group-chevron--open': !collapsedGroups.has(gk) }"
              />
              <Badge variant="outline" class="fav-group-badge" :data-type="gk"
                ><span class="type-dot" />{{ groupLabels[gk] }}</Badge
              >
              <span class="fav-group-count">{{ t('fav_items_count', { n: groupedItems[gk].length }) }}</span>
              <div class="fav-group-line" />
            </div>
            <template v-if="!collapsedGroups.has(gk)">
              <div
                v-for="item in groupedItems[gk]"
                :key="item.id"
                class="fav-list-item"
                :class="{
                  'fav-item--editing-tags': editingTagsItemId === item.id,
                  'fav-list-item--dropdown-open': addToColItemId === item.id,
                }"
                :draggable="!batchMode"
                @dragstart="onDragStart($event, item)"
                @dragover="onDragOver"
                @drop="onDrop($event, item)"
                @dragend="onDragEnd"
              >
                <div v-if="batchMode" class="fav-list-check">
                  <Checkbox :model-value="selectedIds.has(item.id)" @update:model-value="() => toggleSelect(item.id)" />
                </div>
                <div class="fav-list-content">
                  <!-- Tags at top-left, consistent with card view -->
                  <div class="fav-list-tags-inner">
                    <template v-if="editingTagsItemId !== item.id">
                      <Badge
                        v-for="tag in getTags(item)"
                        :key="tag"
                        class="fav-tag-badge"
                        :style="tagColorStyle(tag, _tagColorMap)"
                        >{{ tag }}</Badge
                      >
                      <button class="fav-tag-add-btn" :title="t('tag_edit_hint')" @click="startEditTags(item)">
                        <Tag :size="12" />
                      </button>
                    </template>
                    <div v-else class="fav-tag-edit" @click.stop>
                      <input
                        v-model="tagInputValue"
                        class="fav-tag-input"
                        :placeholder="t('tag_placeholder')"
                        @keydown.enter="saveTags(item)"
                        @keydown.esc="cancelEditTags"
                      />
                      <button class="fav-tag-save" :title="t('save_btn')" @click="saveTags(item)">
                        <Check :size="14" />
                      </button>
                      <button class="fav-tag-cancel" :title="t('cancel_btn')" @click="cancelEditTags">
                        <X :size="14" />
                      </button>
                      <div v-if="allTags.length > 0" class="fav-tag-suggestions">
                        <button
                          v-for="suggestTag in allTags"
                          :key="suggestTag.name"
                          :class="[
                            'fav-tag-suggest',
                            { 'fav-tag-suggest--active': getTags(item).includes(suggestTag.name) },
                          ]"
                          :style="tagColorStyle(suggestTag.name, _tagColorMap)"
                          :title="t('tag_reuse_hint')"
                          @click="onTagSuggestionClick(suggestTag.name, $event)"
                        >
                          <Check
                            v-if="getTags(item).includes(suggestTag.name)"
                            :size="10"
                            class="fav-tag-suggest-check"
                          />
                          <span>{{ suggestTag.name }}</span>
                        </button>
                      </div>
                      <!-- 新建标签颜色选择（始终显示） -->
                      <div class="fav-color-picker-row" @click.stop>
                        <span class="fav-color-picker-row-label">{{ t('fav_tag_color_label') }}</span>
                        <button
                          v-for="c in TAG_PRESET_COLORS"
                          :key="c"
                          :class="['fav-color-swatch-sm', { active: editingTagColor === c }]"
                          :style="{ background: c }"
                          @click="editingTagColor = editingTagColor === c ? '' : c"
                        />
                        <div
                          class="fav-color-swatch-sm fav-color-swatch-sm--custom"
                          :title="t('fav_color_custom')"
                          @click.stop
                        >
                          <Palette :size="10" />
                          <input v-model="editingTagColor" type="color" class="fav-color-custom-input" />
                        </div>
                        <button v-if="editingTagColor" class="fav-color-clear" @click="editingTagColor = ''">
                          {{ t('fav_color_clear') }}
                        </button>
                      </div>
                      <!-- 标签颜色编辑器（点击已应用标签时弹出） -->
                      <Teleport to="body">
                        <div v-if="colorPickerTag && editingTagsItemId === item.id">
                          <div class="fav-color-backdrop" @click="cancelTagColor"></div>
                          <div
                            class="fav-color-picker"
                            :style="{ top: colorPickerPos.top, left: colorPickerPos.left }"
                            @click.stop
                          >
                            <div class="fav-color-picker-header">
                              <span class="fav-color-picker-label">{{ t('fav_tag_color_edit') }}</span>
                              <button class="fav-color-picker-close" @click="cancelTagColor"><X :size="12" /></button>
                            </div>
                            <div class="fav-color-picker-name">
                              <span class="fav-color-picker-tag-name">{{ colorPickerTag }}</span>
                            </div>
                            <div class="fav-color-picker-swatches">
                              <button
                                v-for="c in TAG_PRESET_COLORS"
                                :key="c"
                                :class="['fav-color-swatch', { active: colorPickerColor === c }]"
                                :style="{ background: c }"
                                @click="colorPickerColor = c"
                              />
                              <div class="fav-color-swatch fav-color-swatch--custom" :title="t('fav_color_custom')">
                                <Palette :size="12" />
                                <input v-model="colorPickerColor" type="color" class="fav-color-custom-input" />
                              </div>
                            </div>
                            <div class="fav-color-picker-actions">
                              <button class="fav-color-remove" @click="removeTagColor(colorPickerTag)">
                                {{ t('fav_tag_remove_color') }}
                              </button>
                              <button class="fav-color-save" @click="saveTagColor()">
                                {{ t('fav_tag_save_color') }}
                              </button>
                            </div>
                          </div>
                        </div>
                      </Teleport>
                    </div>
                  </div>
                  <div v-if="!isItemViewable(item)" class="cell-protected-mask">
                    <Lock :size="14" />
                    <span>{{ t('item_protected_mask') }}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      class="h-7 px-3 text-[11px] rounded-md"
                      @click.stop="openProtectionDialog(item)"
                      >{{ t('item_unlock') }}</Button
                    >
                  </div>
                  <div v-else class="fav-list-title">{{ formatContent(item) }}</div>
                  <div class="fav-list-meta">
                    <span>{{ item.source || 'Desktop' }}</span
                    ><span>·</span><span>{{ timeAgo((item as any).favoritedAt || item.timestamp) }}</span>
                  </div>
                </div>
                <div v-if="!batchMode" class="fav-list-actions">
                  <Button variant="ghost" size="icon-sm" :title="t('copy')" @click="onCopyItem(item)"
                    ><Copy :size="14"
                  /></Button>
                  <Button
                    v-if="item.type === 'image'"
                    variant="ghost"
                    size="icon-sm"
                    :title="t('preview')"
                    @click="emit('preview-image', item)"
                    ><ImageIcon :size="14"
                  /></Button>
                  <Button v-else-if="item.type === 'link'" variant="ghost" size="icon-sm" @click="openLink(item)"
                    ><ExternalLink :size="14"
                  /></Button>
                  <Button
                    v-else-if="item.type === 'text'"
                    variant="ghost"
                    size="icon-sm"
                    :title="t('preview')"
                    @click="emit('preview-text', item)"
                    ><FileText :size="14"
                  /></Button>
                  <Button
                    v-else-if="item.type === 'file'"
                    variant="ghost"
                    size="icon-sm"
                    :title="t('preview')"
                    @click="emit('preview-file', item)"
                    ><FileText :size="14"
                  /></Button>
                  <!-- Manual sensitive lock/unlock -->
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    :class="{ 'sensitive-locked': (item as any).metadata?.sensitive }"
                    :title="(item as any).metadata?.sensitive ? t('sens_unlock') : t('sens_lock')"
                    @click="onToggleSensitive(item)"
                  >
                    <Lock :size="14" />
                  </Button>
                  <!-- Add to collection dropdown -->
                  <div v-if="collections.flatCollections.value.length > 0" class="fav-add-col-wrap">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      :title="t('fav_add_to_col')"
                      @click.stop="toggleAddToCol(item.id)"
                      ><FolderPlus :size="14"
                    /></Button>
                    <div v-if="addToColItemId === item.id" class="fav-add-col-dropdown" @mousedown.stop @click.stop>
                      <button
                        v-for="node in collections.allNodes.value"
                        :key="node.id"
                        type="button"
                        class="fav-add-col-option"
                        :style="{ paddingLeft: Math.max(0, (node.depth - 2) * 16) + 8 + 'px' }"
                        @mousedown.stop="addToCollection(node.id, item.id)"
                        @click.stop="addToCollection(node.id, item.id)"
                      >
                        <component :is="COLLECTION_ICON_MAP[node.icon] || Folder" :size="14" />
                        <span>{{ node.name }}</span>
                      </button>
                    </div>
                  </div>
                  <Button variant="ghost" size="icon-sm" class="fav-unfav-btn" @click="handleUnfavorite(item)"
                    ><Star :size="14" fill="currentColor"
                  /></Button>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- GRID VIEW (grouped) -->
        <div v-else class="fav-groups">
          <div v-for="gk in sortedGroupKeys" :key="gk" class="fav-group">
            <div class="fav-group-header" style="cursor: pointer" @click="toggleGroup(gk)">
              <ChevronRight
                :size="14"
                class="fav-group-chevron"
                :class="{ 'fav-group-chevron--open': !collapsedGroups.has(gk) }"
              />
              <Badge variant="outline" class="fav-group-badge" :data-type="gk"
                ><span class="type-dot" />{{ groupLabels[gk] }}</Badge
              >
              <span class="fav-group-count">{{ t('fav_items_count', { n: groupedItems[gk].length }) }}</span>
              <div class="fav-group-line" />
            </div>
            <div v-if="!collapsedGroups.has(gk)" class="fav-grid">
              <div
                v-for="item in groupedItems[gk]"
                :key="item.id"
                class="fav-card"
                :class="{
                  'fav-card--selected': selectedIds.has(item.id),
                  'fav-item--editing-tags': editingTagsItemId === item.id,
                  'fav-card--dropdown-open': addToColItemId === item.id,
                }"
                :draggable="!batchMode"
                @click="batchMode ? toggleSelect(item.id) : undefined"
                @dragstart="onDragStart($event, item)"
                @dragover="onDragOver"
                @drop="onDrop($event, item)"
                @dragend="onDragEnd"
              >
                <div v-if="batchMode" class="fav-card-check">
                  <Checkbox :model-value="selectedIds.has(item.id)" @update:model-value="() => toggleSelect(item.id)" />
                </div>
                <div class="fav-card-preview">
                  <template v-if="item.type === 'image'">
                    <img
                      v-if="item.preview && item.preview !== 'loading'"
                      :src="item.preview"
                      alt=""
                      class="fav-card-img"
                    />
                    <div v-else class="fav-card-placeholder"><ImageIcon :size="24" /></div>
                  </template>
                  <template v-else-if="item.type === 'link' || detectContentType(item.content) === 'url'">
                    <div v-if="!isItemViewable(item)" class="cell-protected-mask">
                      <Lock :size="14" />
                      <span>{{ t('item_protected_mask') }}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        class="h-7 px-3 text-[11px] rounded-md"
                        @click.stop="openProtectionDialog(item)"
                        >{{ t('item_unlock') }}</Button
                      >
                    </div>
                    <div v-else class="fav-card-text fav-card-link">
                      <ExternalLink :size="14" class="fav-card-link-icon" /><span class="fav-card-link-url">{{
                        item.content
                      }}</span
                      ><span class="fav-card-link-domain">{{ extractDomain(item.content) }}</span>
                    </div>
                  </template>
                  <template v-else-if="item.type === 'file'">
                    <div v-if="!isItemViewable(item)" class="cell-protected-mask">
                      <Lock :size="14" />
                      <span>{{ t('item_protected_mask') }}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        class="h-7 px-3 text-[11px] rounded-md"
                        @click.stop="openProtectionDialog(item)"
                        >{{ t('item_unlock') }}</Button
                      >
                    </div>
                    <div v-else class="fav-card-text fav-card-file">
                      <FileText :size="20" /><span>{{ formatContent(item) }}</span>
                    </div>
                  </template>
                  <template v-else>
                    <div v-if="!isItemViewable(item)" class="cell-protected-mask">
                      <Lock :size="14" />
                      <span>{{ t('item_protected_mask') }}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        class="h-7 px-3 text-[11px] rounded-md"
                        @click.stop="openProtectionDialog(item)"
                        >{{ t('item_unlock') }}</Button
                      >
                    </div>
                    <div v-else class="fav-card-text">{{ formatContent(item) }}</div>
                  </template>
                  <!-- Lock button: bottom-left of card preview for card view -->
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="fav-card-lock-btn"
                    :class="{
                      'sensitive-locked': (item as any).metadata?.sensitive,
                      'pw-locked': itemPw.isItemProtected(item) && !itemPw.isUnlocked(item.id),
                    }"
                    :title="getProtectionTitle(item)"
                    @click.stop="openProtectionDialog(item)"
                  >
                    <Lock :size="14" />
                  </Button>
                </div>
                <!-- Tags on card -->
                <div class="fav-card-tags">
                  <template v-if="editingTagsItemId !== item.id">
                    <Badge v-for="tag in getTags(item)" :key="tag" class="fav-tag-badge" :style="tagColorStyle(tag, _tagColorMap)">{{
                      tag
                    }}</Badge>
                    <button class="fav-tag-add-btn" :title="t('tag_edit_hint')" @click.stop="startEditTags(item)">
                      <Tag :size="12" />
                    </button>
                  </template>
                  <div v-else class="fav-tag-edit" @click.stop>
                    <input
                      v-model="tagInputValue"
                      class="fav-tag-input"
                      :placeholder="t('tag_placeholder')"
                      @keydown.enter="saveTags(item)"
                      @keydown.esc="cancelEditTags"
                    />
                    <button class="fav-tag-save" :title="t('save_btn')" @click="saveTags(item)">
                      <Check :size="14" />
                    </button>
                    <button class="fav-tag-cancel" :title="t('cancel_btn')" @click="cancelEditTags">
                      <X :size="14" />
                    </button>
                    <div v-if="allTags.length > 0" class="fav-tag-suggestions">
                      <button
                        v-for="suggestTag in allTags"
                        :key="suggestTag.name"
                        :class="[
                          'fav-tag-suggest',
                          { 'fav-tag-suggest--active': getTags(item).includes(suggestTag.name) },
                        ]"
                        :style="tagColorStyle(suggestTag.name, _tagColorMap)"
                        :title="t('tag_reuse_hint')"
                        @click="onTagSuggestionClick(suggestTag.name, $event)"
                      >
                        <Check
                          v-if="getTags(item).includes(suggestTag.name)"
                          :size="10"
                          class="fav-tag-suggest-check"
                        />
                        <span>{{ suggestTag.name }}</span>
                      </button>
                    </div>
                    <!-- 新建标签颜色选择（始终显示） -->
                    <div class="fav-color-picker-row" @click.stop>
                      <span class="fav-color-picker-row-label">{{ t('fav_tag_color_label') }}</span>
                      <button
                        v-for="c in TAG_PRESET_COLORS"
                        :key="c"
                        :class="['fav-color-swatch-sm', { active: editingTagColor === c }]"
                        :style="{ background: c }"
                        @click="editingTagColor = editingTagColor === c ? '' : c"
                      />
                      <div
                        class="fav-color-swatch-sm fav-color-swatch-sm--custom"
                        :title="t('fav_color_custom')"
                        @click.stop
                      >
                        <Palette :size="10" />
                        <input v-model="editingTagColor" type="color" class="fav-color-custom-input" />
                      </div>
                      <button v-if="editingTagColor" class="fav-color-clear" @click="editingTagColor = ''">
                        {{ t('fav_color_clear') }}
                      </button>
                    </div>
                    <!-- 标签颜色编辑器（点击已应用标签时弹出） -->
                    <Teleport to="body">
                      <div v-if="colorPickerTag && editingTagsItemId === item.id">
                        <div class="fav-color-backdrop" @click="cancelTagColor"></div>
                        <div
                          class="fav-color-picker"
                          :style="{ top: colorPickerPos.top, left: colorPickerPos.left }"
                          @click.stop
                        >
                          <div class="fav-color-picker-header">
                            <span class="fav-color-picker-label">{{ t('fav_tag_color_edit') }}</span>
                            <button class="fav-color-picker-close" @click="cancelTagColor"><X :size="12" /></button>
                          </div>
                          <div class="fav-color-picker-name">
                            <span class="fav-color-picker-tag-name">{{ colorPickerTag }}</span>
                          </div>
                          <div class="fav-color-picker-swatches">
                            <button
                              v-for="c in TAG_PRESET_COLORS"
                              :key="c"
                              :class="['fav-color-swatch', { active: colorPickerColor === c }]"
                              :style="{ background: c }"
                              @click="colorPickerColor = c"
                            />
                            <div class="fav-color-swatch fav-color-swatch--custom" :title="t('fav_color_custom')">
                              <Palette :size="12" />
                              <input v-model="colorPickerColor" type="color" class="fav-color-custom-input" />
                            </div>
                          </div>
                          <div class="fav-color-picker-actions">
                            <button class="fav-color-remove" @click="removeTagColor(colorPickerTag)">
                              {{ t('fav_tag_remove_color') }}
                            </button>
                            <button class="fav-color-save" @click="saveTagColor()">
                              {{ t('fav_tag_save_color') }}
                            </button>
                          </div>
                        </div>
                      </div>
                    </Teleport>
                  </div>
                </div>
                <div class="fav-card-meta">
                  <span class="fav-card-source">{{ item.source || 'Desktop' }}</span>
                  <span class="fav-card-time">{{ timeAgo((item as any).favoritedAt || item.timestamp) }}</span>
                </div>
                <div v-if="!batchMode" class="fav-card-actions">
                  <Button variant="ghost" size="icon-sm" :title="t('copy')" @click.stop="onCopyItem(item)"
                    ><Copy :size="14"
                  /></Button>
                  <Button
                    v-if="item.type === 'image'"
                    variant="ghost"
                    size="icon-sm"
                    :title="t('preview')"
                    @click.stop="emit('preview-image', item)"
                    ><ImageIcon :size="14"
                  /></Button>
                  <Button v-else-if="item.type === 'link'" variant="ghost" size="icon-sm" @click.stop="openLink(item)"
                    ><ExternalLink :size="14"
                  /></Button>
                  <Button
                    v-else-if="item.type === 'text'"
                    variant="ghost"
                    size="icon-sm"
                    :title="t('preview')"
                    @click.stop="emit('preview-text', item)"
                    ><FileText :size="14"
                  /></Button>
                  <Button
                    v-else-if="item.type === 'file'"
                    variant="ghost"
                    size="icon-sm"
                    :title="t('preview')"
                    @click.stop="emit('preview-file', item)"
                    ><FileText :size="14"
                  /></Button>
                  <Button
                    v-if="item.type === 'file' && hasLocalPath(item)"
                    variant="ghost"
                    size="icon-sm"
                    :title="t('show_in_folder')"
                    @click.stop="revealFileFolder(item)"
                    ><Folder :size="14"
                  /></Button>
                  <!-- Add to collection -->
                  <div v-if="collections.flatCollections.value.length > 0" class="fav-add-col-wrap">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      :title="t('fav_add_to_col')"
                      @click.stop="toggleAddToCol(item.id)"
                      ><FolderPlus :size="14"
                    /></Button>
                    <div v-if="addToColItemId === item.id" class="fav-add-col-dropdown" @mousedown.stop @click.stop>
                      <button
                        v-for="node in collections.allNodes.value"
                        :key="node.id"
                        type="button"
                        class="fav-add-col-option"
                        :style="{ paddingLeft: Math.max(0, (node.depth - 2) * 16) + 8 + 'px' }"
                        @mousedown.stop="addToCollection(node.id, item.id)"
                        @click.stop="addToCollection(node.id, item.id)"
                      >
                        <component :is="COLLECTION_ICON_MAP[node.icon] || Folder" :size="14" />
                        <span>{{ node.name }}</span>
                      </button>
                    </div>
                  </div>
                  <Button variant="ghost" size="icon-sm" class="fav-unfav-btn" @click.stop="handleUnfavorite(item)"
                    ><Star :size="14" fill="currentColor"
                  /></Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Context menu for collection tree nodes -->
  <Teleport to="body">
    <div v-if="collections.ctxMenuVisible.value" class="fav-ctx-backdrop" @click="collections.closeCtxMenu()"></div>
    <div
      v-if="collections.ctxMenuVisible.value"
      class="fav-ctx-menu"
      :style="{ top: collections.ctxMenuPos.value.top + 'px', left: collections.ctxMenuPos.value.left + 'px' }"
    >
      <button class="fav-ctx-item" @click="collections.ctxRename()">
        <Edit :size="14" /> {{ t('fav_ctx_rename') }}
      </button>
      <button class="fav-ctx-item" @click="collections.ctxNewSubCollection()">
        <FolderPlus :size="14" /> {{ t('fav_ctx_new_sub') }}
      </button>
      <button
        v-if="collections.ctxMenuNode.value && collections.ctxMenuNode.value.depth > 2"
        class="fav-ctx-item"
        @click="collections.ctxMoveToRoot()"
      >
        <FolderInput :size="14" /> {{ t('fav_ctx_move_root') }}
      </button>
      <div class="fav-ctx-sep"></div>
      <button class="fav-ctx-item fav-ctx-item--danger" @click="collections.ctxDelete()">
        <Trash2 :size="14" /> {{ t('fav_ctx_delete') }}
      </button>
    </div>
  </Teleport>

  <!-- Tag delete confirmation dialog -->
  <ConfirmDialog
    v-model:open="showTagDeleteConfirm"
    :title="t('confirm_t')"
    :message="pendingDeleteTagMessage"
    :confirm-text="t('delete_btn')"
    :cancel-text="t('cancel_btn')"
    confirm-variant="destructive"
    @confirm="doDeleteTag"
  />

  <!-- 删除收藏夹（防止误删父级） -->
  <ConfirmDialog
    v-model:open="showCollectionDeleteConfirm"
    :title="confirmTitleFallback"
    :message="pendingDeleteCollectionMessage"
    :confirm-text="t('delete_btn')"
    :cancel-text="t('cancel_btn')"
    confirm-variant="destructive"
    @confirm="doDeleteCollection"
  />

  <!-- 统一保护级别对话框 -->
  <ProtectionDialog
    v-model:open="protectionDialogOpen"
    :item-id="protectionDialogItem?.id || ''"
    :content="protectionDialogItem?.content || ''"
    :current-level="
      protectionDialogItem?.metadata?.protected
        ? 'advanced'
        : protectionDialogItem?.metadata?.sensitive
          ? 'pin'
          : 'none'
    "
    :item-name="protectionDialogItem?.content || ''"
    @protected="onProtectionProtected"
    @unprotected="onProtectionUnprotected"
    @unlocked="onProtectionUnlocked"
  />
</template>
