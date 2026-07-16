<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick, h, Teleport } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useConfigStore } from '@/stores/configStore'
import { usePrivacy } from '@/composables/usePrivacy'
import {
  Star, Search, Copy, Image as ImageIcon, LayoutGrid, List,
  ExternalLink, FileText, Folder, FolderOpen, FolderPlus, FolderX, FolderSearch, FolderInput, FolderOutput, FolderSync,
  ArrowUpDown, CheckSquare, Square,
  Plus, X, Check, Tag, ClipboardList, ChevronRight, Lock,
  Bookmark, Archive, Trash2, Heart, Zap, Shield, Globe, Code2, Music, Video, Settings, Palette, Pencil, Edit,
} from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import Badge from '@/components/ui/badge/Badge.vue'
import Checkbox from '@/components/ui/checkbox/Checkbox.vue'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  createFavoriteCollection, deleteFavoriteCollection,
  addCollectionItem, removeCollectionItem, setItemTags, getAllFavoriteTags, deleteTag,
  getCollectionItems, type FavoriteTag,
} from '@/api/client'
import { useCollections, type CollectionNode } from '@/composables/useCollections'

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
watch(() => route.query.pickCollection, (val) => {
  if (val === 'true' && route.query.itemId) {
    pickItemId.value = route.query.itemId as string
  }
})
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

watch(() => collections.renamingNodeId.value, (id) => {
  if (id) {
    nextTick(() => {
      renameInputRef.value?.focus()
      renameInputRef.value?.select()
    })
  }
})

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
watch(() => collections.newSubCollectionParentId.value, (parentId) => {
  if (parentId) {
    showNewCollectionInputAtTop(parentId)
    collections.newSubCollectionParentId.value = null
  }
})

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

// Collection icon map: string name → lucide component
const COLLECTION_ICON_MAP: Record<string, any> = {
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

function renderCollectionIcon(iconName: string, size = 14) {
  const comp = COLLECTION_ICON_MAP[iconName] || Folder
  return h(comp, { size })
}

// Tag color system
const TAG_PRESET_COLORS = [
  '#6366F1', '#EC4899', '#F59E0B', '#10B981', '#3B82F6',
  '#8B5CF6', '#EF4444', '#06B6D4', '#F97316', '#14B8A6',
]
const TAG_AUTO_COLORS = [
  '#6366F1', '#EC4899', '#F59E0B', '#10B981', '#3B82F6',
  '#8B5CF6', '#EF4444', '#06B6D4', '#F97316', '#14B8A6',
]
function getTagAutoColor(tag: string): string {
  let hash = 0
  for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash)
  return TAG_AUTO_COLORS[Math.abs(hash) % TAG_AUTO_COLORS.length]
}
// Tag color lookup: custom color (from tagColorMap) → auto-assigned fallback
function getTagDisplayColor(tag: string): string {
  return tagColorMap.value[tag] || getTagAutoColor(tag)
}
function tagColorStyle(tag: string): string {
  const c = getTagDisplayColor(tag)
  return `--tag-c: ${c}; --tag-c-bg: ${c}25; --tag-c-border: ${c}60;`
}

// Tags
const allTags = ref<FavoriteTag[]>([])
const _tagColorMap = ref<Record<string, string>>({})
const tagColorMap = computed(() => _tagColorMap.value)

// 当 allTags 从服务器加载后，同步到 _tagColorMap
watch(allTags, (tags) => {
  for (const t of tags) {
    if (t.color) _tagColorMap.value[t.name] = t.color
  }
}, { immediate: true })
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
  return privacy.isItemSensitive(item)
}
function showPeek(itemId: string) {
  if (privacy.startPeek(itemId)) {
  } else {
    if (!privacy.pinSet.value) {
      emit('show-pin-setup') // no PIN → prompt user to set one first
    } else {
      emit('show-pin-dialog') // PIN set but not verified → ask for PIN
    }
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
  if (privacy.isItemSensitive(item) && !privacy.canCopySensitive()) {
    emit('show-pin-dialog')
    return
  }
  await clip.copyItem(item)
  privacy.scheduleClipboardClear()
  toast.show(t('copied'), 'success')
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
watch(() => route.query.create, (val) => {
  if (val === 'true') {
    showNewCollectionInput.value = true
  }
})

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
  let items = clip.items.value.filter(i => (i as any).isFavorite)

  // Tag filter
  if (activeTagFilter.value) {
    items = items.filter(i => getTags(i).includes(activeTagFilter.value!))
  }

  // Search
  if (searchInput.value.trim()) {
    const q = searchInput.value.toLowerCase()
    items = items.filter(i =>
      (i.content || '').toLowerCase().includes(q) ||
      (i.source || '').toLowerCase().includes(q) ||
      getTags(i).some(tag => tag.toLowerCase().includes(q))
    )
  }

  // Apply local reorder if set
  if (localOrder.value.length) {
    const idMap = new Map(items.map(i => [i.id, i]))
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
        items = items.filter(i => colItemIds.has(i.id))
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
const groupLabels: Record<string, string> = { text: t('fav_group_text'), code: t('fav_group_code'), link: t('fav_group_link'), image: t('fav_group_image'), file: t('fav_group_file') }
const groupOrder = ['text', 'code', 'link', 'image', 'file']
const sortedGroupKeys = computed(() => groupOrder.filter(k => groupedItems.value[k]?.length))
const favoriteCount = computed(() => clip.items.value.filter(i => (i as any).isFavorite).length)
const selectedCount = computed(() => selectedIds.value.size)

// --- Helpers ---
function parseMetadata(item: ClipItem): any {
  try {
    const raw = (clip.items.value.find(i => i.id === item.id) as any)?.metadata
    if (typeof raw === 'string') return JSON.parse(raw)
    return raw || {}
  } catch { return {} }
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
function formatContent(item: ClipItem): string {
  if (item.type === 'image') return t('fav_screenshot')
  if (item.type === 'file') {
    try {
      const meta = JSON.parse(item.content)
      if (meta.name) return meta.name
      if (meta.paths && meta.paths[0]) return meta.paths[0].split(/[/\\]/).pop() || t('fav_file_default')
    } catch { /* */ }
    return item.content?.split(/[/\\]/).pop() || item.content || t('fav_file_default')
  }
  if (item.type === 'link') {
    try { return new URL(item.content).hostname } catch { return item.content }
  }
  return item.content || ''
}
function detectContentType(content: string): string {
  if (!content) return 'text'
  const t = content.trim()
  if (/^https?:\/\//i.test(t)) return 'url'
  if (/[{}\[\]];?\s*$/.test(t) || /\b(function|const|let|var|class|import|export)\s/.test(t)) return 'code'
  return 'text'
}
function extractDomain(url: string): string { try { return new URL(url).hostname } catch { return '' } }
function hasLocalPath(item: ClipItem): boolean {
  if (item.type !== 'file') return false
  try { const m = JSON.parse(item.content); return !!(m.paths && m.paths.length) } catch { return false }
}
async function copyItem(item: ClipItem) { await clip.copyItem(item); toast.show(t('copied'), 'success') }
function handleUnfavorite(item: ClipItem) { clip.toggleFavorite(item); selectedIds.value.delete(item.id); toast.show(t('unfavorite'), 'info') }
function toggleSort() {
  if (sortBy.value === 'time') sortBy.value = 'type'
  else { sortBy.value = 'time'; sortAsc.value = !sortAsc.value }
  localOrder.value = [] // reset local reorder on sort change
}
function sortLabel(): string {
  if (sortBy.value === 'time') return sortAsc.value ? t('fav_sort_time_asc') : t('fav_sort_time_desc')
  return t('fav_sort_type')
}
function openLink(item: ClipItem) { try { window.open(item.content, '_blank') } catch { /* */ } }
function revealFileFolder(item: ClipItem) {
  try {
    const m = JSON.parse(item.content)
    if (m.paths && m.paths[0]) import('@tauri-apps/plugin-shell').then(mod => mod.open(m.paths[0].replace(/[/\\][^/\\]+$/, '')))
  } catch { /* */ }
}

// --- Batch ---
function toggleBatchMode() { batchMode.value = !batchMode.value; if (!batchMode.value) selectedIds.value.clear() }
function toggleSelect(id: string) { selectedIds.value.has(id) ? selectedIds.value.delete(id) : selectedIds.value.add(id) }
function batchUnfavorite() {
  const items = clip.items.value.filter(i => selectedIds.value.has(i.id))
  for (const item of items) clip.toggleFavorite(item)
  toast.show(t('fav_unfav_count', {n: selectedIds.value.size}), 'info')
  selectedIds.value.clear(); batchMode.value = false
}

// --- Collections ---
const pickAndCreate = ref(false)

async function handleCreateCollection() {
  if (!newCollectionName.value.trim()) return
  const parentId = newCollectionParentId.value
  const data = await collections.createCollection(newCollectionName.value.trim(), newCollectionIcon.value, parentId)
  if (data?.collection) {
    newCollectionName.value = ''; newCollectionIcon.value = 'folder'; showNewCollectionInput.value = false; newCollectionParentId.value = undefined
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
  await collections.deleteCollection(id)
  toast.show(t('fav_deleted'), 'info')
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
  const tags = tagInputValue.value.split(/[,，]/).map(t => t.trim()).filter(Boolean)
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
  const target = clip.items.value.find(i => i.id === item.id)
  if (target) { const meta = parseMetadata(target); meta.tags = tags; (target as any).metadata = meta }
  editingTagColor.value = ''
  await loadTags() // 新增标签后实时同步到标签栏
  if (!result) toast.show(t('fav_tag_save_fail'), 'error')
}

// 标签颜色编辑器
function openTagColorPicker(tag: string, event?: MouseEvent) {
  if (editingTagsItemId.value === null) return
  colorPickerTag.value = tag
  colorPickerColor.value = getTagDisplayColor(tag)
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
  const item = clip.items.value.find(i => getTags(i).includes(colorPickerTag.value))
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
  const item = clip.items.value.find(i => getTags(i).includes(tag))
  if (item) {
    const tags = getTags(item)
    const tagColors: Record<string, string> = { ..._tagColorMap.value }
    setItemTags(item.id, tags, tagColors).then(() => loadTags())
  }
}

// Click an existing tag suggestion → open color editor or toggle it
function onTagSuggestionClick(tag: string, event?: MouseEvent) {
  if (editingTagsItemId.value === null) return
  const currentTags = getTags(clip.items.value.find(i => i.id === editingTagsItemId.value)!)
  if (currentTags.includes(tag)) {
    openTagColorPicker(tag, event)
  } else {
    toggleTagSuggestion(tag)
  }
}

// Click an existing tag suggestion → toggle it on/off, auto-save, and close edit mode
async function toggleTagSuggestion(tag: string) {
  if (editingTagsItemId.value === null) return
  const current = tagInputValue.value.split(/[,，]/).map(t => t.trim()).filter(Boolean)
  const idx = current.indexOf(tag)
  if (idx >= 0) current.splice(idx, 1) // remove
  else current.push(tag) // add
  tagInputValue.value = current.join(', ')
  const item = clip.items.value.find(i => i.id === editingTagsItemId.value)
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
    localOrder.value = favoriteItems.value.map(i => i.id)
  }
}
function onDragOver(e: DragEvent) { e.preventDefault(); e.dataTransfer!.dropEffect = 'move' }
function onDrop(e: DragEvent, targetItem: ClipItem) {
  e.preventDefault()
  if (!dragItemId.value || dragItemId.value === targetItem.id) return
  if (!localOrder.value.length) localOrder.value = favoriteItems.value.map(i => i.id)
  const fromIdx = localOrder.value.indexOf(dragItemId.value)
  const toIdx = localOrder.value.indexOf(targetItem.id)
  if (fromIdx === -1 || toIdx === -1) return
  const [moved] = localOrder.value.splice(fromIdx, 1)
  localOrder.value.splice(toIdx, 0, moved)
  dragItemId.value = null
}
function onDragEnd() { dragItemId.value = null }

function goToClipboard() { router.push('/app/clipboard') }

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
  collections.loadCollections().catch((e: any) => {
    toast.show(e.message || t('fav_load_fail'), 'error')
  })
})

function cancelEditTags() {
  editingTagsItemId.value = null
  tagInputValue.value = ''
}
</script>

<template>
  <div class="fav-page">
    <!-- Left: Collection tree panel -->
    <div class="fav-col-panel" :style="{ width: sidebarWidth + 'px' }">
      <div class="fav-col-panel-header">
        <div class="fav-col-panel-title-wrap">
          <span class="fav-col-panel-title">{{ t('nav_favorites') }}</span>
          <Badge variant="outline" class="fav-count">{{ favoriteCount }}</Badge>
        </div>
        <Button variant="ghost" size="icon-sm" class="fav-col-header-new-btn" @click="showNewCollectionInputAtTop" :title="t('fav_new_col')">
          <Plus :size="14" />
        </Button>
      </div>
      <!-- Breadcrumb -->
      <div class="fav-tree-breadcrumb" v-if="collections.breadcrumb && collections.breadcrumb.value.length > 0">
        <button class="fav-tree-breadcrumb-item" @click="collections.selectNode(null)">{{ t('fav_all') }}</button>
        <template v-for="(crumb, idx) in collections.breadcrumb.value" :key="crumb.id">
          <span class="fav-tree-breadcrumb-sep">/</span>
          <button class="fav-tree-breadcrumb-item" :class="{ active: idx === collections.breadcrumb.value.length - 1 }" @click="collections.selectNode(crumb.id)">
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
        <div v-for="node in collections.visibleNodes.value" :key="node.id" class="fav-tree-node"
          :style="{ paddingLeft: Math.max(0, (node.depth - 2) * 16) + 8 + 'px' }"
          :class="{
            'fav-tree-node--drag-over-inside': collections.dropTargetId.value === node.id && collections.dropPosition.value === 'inside',
            'fav-tree-node--drag-over-before': collections.dropTargetId.value === node.id && collections.dropPosition.value === 'before',
            'fav-tree-node--drag-over-after': collections.dropTargetId.value === node.id && collections.dropPosition.value === 'after',
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
          @mouseleave="collections.closeFlyout">
          <span class="fav-tree-expand" :class="{ 'fav-tree-expand--empty': !(node.children || []).length }" @click.stop="(node.children || []).length && collections.toggleExpand(node.path)">
            <ChevronRight v-if="(node.children || []).length > 0" :size="14" :class="{ 'fav-tree-expand--open': collections.expandedPaths.value.has(node.path) }" />
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
          <span v-else class="fav-tree-name" :class="{ active: collections.activeNodeId.value === node.id }" @click.stop="collections.selectNode(node.id)" @dblclick.stop="collections.startRename(node.id)">
            {{ node.name }}
          </span>
          <span class="fav-tree-count">{{ (node.children || []).length + node.item_count }}</span>
          <button class="fav-tree-del" @click.stop="collections.deleteCollection(node.id)" :title="t('delete')">×</button>
          <!-- Flyout: show direct children on hover -->
          <div v-if="collections.flyoutNodeId.value === node.id && (node.children || []).length > 0" class="fav-tree-flyout" @mouseenter="collections.closeFlyout" @mouseleave="collections.closeFlyout">
            <div v-for="child in (node.children || [])" :key="child.id" class="fav-tree-flyout-item" @click="collections.selectNode(child.id)">
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
          <Button v-if="favoriteItems.length > 0" variant="ghost" size="sm" class="fav-action-btn" :class="{ 'fav-active': batchMode }" @click="toggleBatchMode">
            <CheckSquare v-if="batchMode" :size="14" /><Square v-else :size="14" /><span>{{ batchMode ? t('fav_batch_exit') : t('fav_batch_select') }}</span>
          </Button>
          <template v-if="batchMode && selectedCount > 0">
            <span class="fav-batch-count">{{ t('fav_batch_selected', { n: selectedCount }) }}</span>
            <Button variant="ghost" size="sm" class="fav-action-btn fav-unfav-btn" @click="batchUnfavorite">
              <Star :size="14" fill="currentColor" /><span>{{ t('unfavorite') }}</span>
            </Button>
          </template>
          <div class="fav-view-toggle">
            <button :class="['fav-view-btn', { active: viewMode === 'grid' }]" @click="viewMode = 'grid'" :title="t('fav_grid_view')"><LayoutGrid :size="14" /></button>
            <button :class="['fav-view-btn', { active: viewMode === 'list' }]" @click="viewMode = 'list'" :title="t('fav_list_view')"><List :size="14" /></button>
          </div>
        </div>
      </div>

      <!-- Row 2: Tag filters -->
      <div class="fav-tag-bar" v-if="allTags.length > 0">
        <span class="fav-tag-label">{{ t('fav_tags_label') }}</span>
        <button :class="['fav-tag-pill', { active: !activeTagFilter }]" @click="activeTagFilter = null">{{ t('fav_filter_all') }}</button>
        <button v-for="tag in allTags" :key="tag.name" :class="['fav-tag-pill', { active: activeTagFilter === tag.name }]" @click="activeTagFilter = activeTagFilter === tag.name ? null : tag.name">
          {{ tag.name }}
          <button class="fav-tag-del" @click.stop="removeTag(tag.name)" :title="t('fav_tag_delete_title')">×</button>
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
          <div class="fav-group-header" @click="toggleGroup(gk)" style="cursor:pointer">
            <ChevronRight :size="14" class="fav-group-chevron" :class="{ 'fav-group-chevron--open': !collapsedGroups.has(gk) }" />
            <Badge variant="outline" class="fav-group-badge" :data-type="gk"><span class="type-dot" />{{ groupLabels[gk] }}</Badge>
            <span class="fav-group-count">{{ t('fav_items_count', { n: groupedItems[gk].length }) }}</span>
            <div class="fav-group-line" />
          </div>
          <template v-if="!collapsedGroups.has(gk)">
          <div v-for="item in groupedItems[gk]" :key="item.id" class="fav-list-item"
            :class="{ 'fav-item--editing-tags': editingTagsItemId === item.id, 'fav-list-item--dropdown-open': addToColItemId === item.id }"
            :draggable="!batchMode" @dragstart="onDragStart($event, item)" @dragover="onDragOver" @drop="onDrop($event, item)" @dragend="onDragEnd">
            <div v-if="batchMode" class="fav-list-check"><Checkbox :model-value="selectedIds.has(item.id)" @update:model-value="() => toggleSelect(item.id)" /></div>
            <div class="fav-list-content">
              <div v-if="isItemSensitive(item) && privacy.peekItemId.value !== item.id" class="fav-mask-wrap">
                <div class="fav-masked-text">{{ t('content_masked') }}</div>
                <button class="fav-peek-btn" @click.stop="showPeek(item.id)">{{ t('peek_content') }}</button>
              </div>
              <div v-else class="fav-list-title">{{ formatContent(item) }}</div>
              <div class="fav-list-meta"><span>{{ item.source || 'Desktop' }}</span><span>·</span><span>{{ timeAgo((item as any).favoritedAt || item.timestamp) }}</span></div>
              <!-- Tags inside content so they flow naturally -->
              <div class="fav-list-tags-inner">
                <template v-if="editingTagsItemId !== item.id">
                  <Badge v-for="tag in getTags(item)" :key="tag" class="fav-tag-badge" :style="tagColorStyle(tag)">{{ tag }}</Badge>
                  <button class="fav-tag-add-btn" @click="startEditTags(item)" :title="t('tag_edit_hint')"><Tag :size="12" /></button>
                </template>
                <div v-else class="fav-tag-edit" @click.stop>
                  <input v-model="tagInputValue" class="fav-tag-input" :placeholder="t('tag_placeholder')" @keydown.enter="saveTags(item)" @keydown.esc="cancelEditTags" />
                  <button class="fav-tag-save" @click="saveTags(item)" :title="t('save_btn')"><Check :size="14" /></button>
                  <button class="fav-tag-cancel" @click="cancelEditTags" :title="t('cancel_btn')"><X :size="14" /></button>
                  <div v-if="allTags.length > 0" class="fav-tag-suggestions">
                    <button v-for="suggestTag in allTags" :key="suggestTag.name"
                      :class="['fav-tag-suggest', { 'fav-tag-suggest--active': getTags(item).includes(suggestTag.name) }]"
                      :style="tagColorStyle(suggestTag.name)"
                      @click="onTagSuggestionClick(suggestTag.name, $event)" :title="t('tag_reuse_hint')">
                      <Check v-if="getTags(item).includes(suggestTag.name)" :size="10" class="fav-tag-suggest-check" />
                      <span>{{ suggestTag.name }}</span>
                    </button>
                  </div>
                  <!-- 新建标签颜色选择（始终显示） -->
                  <div class="fav-color-picker-row" @click.stop>
                    <span class="fav-color-picker-row-label">{{ t('fav_tag_color_label') }}</span>
                    <button v-for="c in TAG_PRESET_COLORS" :key="c"
                      :class="['fav-color-swatch-sm', { active: editingTagColor === c }]"
                      :style="{ background: c }"
                      @click="editingTagColor = editingTagColor === c ? '' : c" />
                    <div class="fav-color-swatch-sm fav-color-swatch-sm--custom" :title="t('fav_color_custom')" @click.stop>
                      <Palette :size="10" />
                      <input type="color" v-model="editingTagColor" class="fav-color-custom-input" />
                    </div>
                    <button v-if="editingTagColor" class="fav-color-clear" @click="editingTagColor = ''">{{ t('fav_color_clear') }}</button>
                  </div>
                  <!-- 标签颜色编辑器（点击已应用标签时弹出） -->
                  <Teleport to="body">
                    <div v-if="colorPickerTag && editingTagsItemId === item.id">
                      <div class="fav-color-backdrop" @click="cancelTagColor"></div>
                      <div class="fav-color-picker" :style="{ top: colorPickerPos.top, left: colorPickerPos.left }" @click.stop>
                    <div class="fav-color-picker-header">
                      <span class="fav-color-picker-label">{{ t('fav_tag_color_edit') }}</span>
                      <button class="fav-color-picker-close" @click="cancelTagColor"><X :size="12" /></button>
                    </div>
                    <div class="fav-color-picker-name">
                      <span class="fav-color-picker-tag-name">{{ colorPickerTag }}</span>
                    </div>
                    <div class="fav-color-picker-swatches">
                      <button v-for="c in TAG_PRESET_COLORS" :key="c"
                        :class="['fav-color-swatch', { active: colorPickerColor === c }]"
                        :style="{ background: c }"
                        @click="colorPickerColor = c" />
                      <div class="fav-color-swatch fav-color-swatch--custom" :title="t('fav_color_custom')">
                        <Palette :size="12" />
                        <input type="color" v-model="colorPickerColor" class="fav-color-custom-input" />
                      </div>
                    </div>
                    <div class="fav-color-picker-actions">
                      <button class="fav-color-remove" @click="removeTagColor(colorPickerTag)">{{ t('fav_tag_remove_color') }}</button>
                      <button class="fav-color-save" @click="saveTagColor()">{{ t('fav_tag_save_color') }}</button>
                    </div>
                  </div>
                    </div>
                  </Teleport>
                </div>
              </div>
            </div>
            <div v-if="!batchMode" class="fav-list-actions">
              <Button variant="ghost" size="icon-sm" @click="onCopyItem(item)" :title="t('copy')"><Copy :size="14" /></Button>
              <Button v-if="item.type === 'image'" variant="ghost" size="icon-sm" @click="emit('preview-image', item)" :title="t('preview')"><ImageIcon :size="14" /></Button>
              <Button v-else-if="item.type === 'link'" variant="ghost" size="icon-sm" @click="openLink(item)"><ExternalLink :size="14" /></Button>
              <Button v-else-if="item.type === 'text'" variant="ghost" size="icon-sm" @click="emit('preview-text', item)" :title="t('preview')"><FileText :size="14" /></Button>
              <Button v-else-if="item.type === 'file'" variant="ghost" size="icon-sm" @click="emit('preview-file', item)" :title="t('preview')"><FileText :size="14" /></Button>
              <!-- Manual sensitive lock/unlock -->
              <Button variant="ghost" size="icon-sm" :class="{ 'sensitive-locked': (item as any).metadata?.sensitive }" @click="onToggleSensitive(item)" :title="(item as any).metadata?.sensitive ? t('sens_unlock') : t('sens_lock')">
                <Lock :size="14" />
              </Button>
              <!-- Add to collection dropdown -->
              <div v-if="collections.flatCollections.value.length > 0" class="fav-add-col-wrap">
                <Button variant="ghost" size="icon-sm" @click.stop="toggleAddToCol(item.id)" :title="t('fav_add_to_col')"><FolderPlus :size="14" /></Button>
                <div v-if="addToColItemId === item.id" class="fav-add-col-dropdown" @mousedown.stop @click.stop>
                  <button v-for="node in collections.allNodes.value" :key="node.id" type="button" class="fav-add-col-option" :style="{ paddingLeft: Math.max(0, (node.depth - 2) * 16) + 8 + 'px' }" @mousedown.stop="addToCollection(node.id, item.id)" @click.stop="addToCollection(node.id, item.id)">
                    <component :is="COLLECTION_ICON_MAP[node.icon] || Folder" :size="14" />
                    <span>{{ node.name }}</span>
                  </button>
                </div>
              </div>
              <Button variant="ghost" size="icon-sm" class="fav-unfav-btn" @click="handleUnfavorite(item)"><Star :size="14" fill="currentColor" /></Button>
            </div>
          </div>
          </template>
        </div>
      </div>

      <!-- GRID VIEW (grouped) -->
      <div v-else class="fav-groups">
        <div v-for="gk in sortedGroupKeys" :key="gk" class="fav-group">
          <div class="fav-group-header" @click="toggleGroup(gk)" style="cursor:pointer">
            <ChevronRight :size="14" class="fav-group-chevron" :class="{ 'fav-group-chevron--open': !collapsedGroups.has(gk) }" />
            <Badge variant="outline" class="fav-group-badge" :data-type="gk"><span class="type-dot" />{{ groupLabels[gk] }}</Badge>
            <span class="fav-group-count">{{ t('fav_items_count', { n: groupedItems[gk].length }) }}</span>
            <div class="fav-group-line" />
          </div>
          <div v-if="!collapsedGroups.has(gk)" class="fav-grid">
            <div v-for="item in groupedItems[gk]" :key="item.id" class="fav-card"
              :class="{ 'fav-card--selected': selectedIds.has(item.id), 'fav-item--editing-tags': editingTagsItemId === item.id, 'fav-card--dropdown-open': addToColItemId === item.id }"
              :draggable="!batchMode"
              @click="batchMode ? toggleSelect(item.id) : undefined"
              @dragstart="onDragStart($event, item)" @dragover="onDragOver" @drop="onDrop($event, item)" @dragend="onDragEnd">
              <div v-if="batchMode" class="fav-card-check"><Checkbox :model-value="selectedIds.has(item.id)" @update:model-value="() => toggleSelect(item.id)" /></div>
              <div class="fav-card-preview">
                <template v-if="item.type === 'image'">
                  <img v-if="item.preview && item.preview !== 'loading'" :src="item.preview" alt="" class="fav-card-img" />
                  <div v-else class="fav-card-placeholder"><ImageIcon :size="24" /></div>
                </template>
                <template v-else-if="item.type === 'link' || detectContentType(item.content) === 'url'">
                  <div v-if="isItemSensitive(item) && privacy.peekItemId.value !== item.id" class="fav-mask-wrap fav-mask-wrap--card">
                    <div class="fav-masked-text">{{ t('content_masked') }}</div>
                    <button class="fav-peek-btn" @click.stop="showPeek(item.id)">{{ t('peek_content') }}</button>
                  </div>
                  <div v-else class="fav-card-text fav-card-link"><ExternalLink :size="14" class="fav-card-link-icon" /><span class="fav-card-link-url">{{ item.content }}</span><span class="fav-card-link-domain">{{ extractDomain(item.content) }}</span></div>
                </template>
                <template v-else-if="item.type === 'file'">
                  <div v-if="isItemSensitive(item) && privacy.peekItemId.value !== item.id" class="fav-mask-wrap fav-mask-wrap--card">
                    <div class="fav-masked-text">{{ t('content_masked') }}</div>
                    <button class="fav-peek-btn" @click.stop="showPeek(item.id)">{{ t('peek_content') }}</button>
                  </div>
                  <div v-else class="fav-card-text fav-card-file"><FileText :size="20" /><span>{{ formatContent(item) }}</span></div>
                </template>
                <template v-else>
                  <div v-if="isItemSensitive(item) && privacy.peekItemId.value !== item.id" class="fav-mask-wrap fav-mask-wrap--card">
                    <div class="fav-masked-text">{{ t('content_masked') }}</div>
                    <button class="fav-peek-btn" @click.stop="showPeek(item.id)">{{ t('peek_content') }}</button>
                  </div>
                  <div v-else class="fav-card-text">{{ formatContent(item) }}</div>
                </template>
                <!-- Lock button: bottom-left of card preview for card view -->
                <Button variant="ghost" size="icon-sm" class="fav-card-lock-btn" :class="{ 'sensitive-locked': (item as any).metadata?.sensitive }" @click.stop="onToggleSensitive(item)" :title="(item as any).metadata?.sensitive ? t('sens_unlock') : t('sens_lock')">
                  <Lock :size="14" />
                </Button>
              </div>
              <!-- Tags on card -->
              <div class="fav-card-tags">
                <template v-if="editingTagsItemId !== item.id">
                  <Badge v-for="tag in getTags(item)" :key="tag" class="fav-tag-badge" :style="tagColorStyle(tag)">{{ tag }}</Badge>
                  <button class="fav-tag-add-btn" @click.stop="startEditTags(item)" :title="t('tag_edit_hint')"><Tag :size="12" /></button>
                </template>
                <div v-else class="fav-tag-edit" @click.stop>
                  <input v-model="tagInputValue" class="fav-tag-input" :placeholder="t('tag_placeholder')" @keydown.enter="saveTags(item)" @keydown.esc="cancelEditTags" />
                  <button class="fav-tag-save" @click="saveTags(item)" :title="t('save_btn')"><Check :size="14" /></button>
                  <button class="fav-tag-cancel" @click="cancelEditTags" :title="t('cancel_btn')"><X :size="14" /></button>
                  <div v-if="allTags.length > 0" class="fav-tag-suggestions">
                    <button v-for="suggestTag in allTags" :key="suggestTag.name"
                      :class="['fav-tag-suggest', { 'fav-tag-suggest--active': getTags(item).includes(suggestTag.name) }]"
                      :style="tagColorStyle(suggestTag.name)"
                      @click="onTagSuggestionClick(suggestTag.name, $event)" :title="t('tag_reuse_hint')">
                      <Check v-if="getTags(item).includes(suggestTag.name)" :size="10" class="fav-tag-suggest-check" />
                      <span>{{ suggestTag.name }}</span>
                    </button>
                  </div>
                  <!-- 新建标签颜色选择（始终显示） -->
                  <div class="fav-color-picker-row" @click.stop>
                    <span class="fav-color-picker-row-label">{{ t('fav_tag_color_label') }}</span>
                    <button v-for="c in TAG_PRESET_COLORS" :key="c"
                      :class="['fav-color-swatch-sm', { active: editingTagColor === c }]"
                      :style="{ background: c }"
                      @click="editingTagColor = editingTagColor === c ? '' : c" />
                    <div class="fav-color-swatch-sm fav-color-swatch-sm--custom" :title="t('fav_color_custom')" @click.stop>
                      <Palette :size="10" />
                      <input type="color" v-model="editingTagColor" class="fav-color-custom-input" />
                    </div>
                    <button v-if="editingTagColor" class="fav-color-clear" @click="editingTagColor = ''">{{ t('fav_color_clear') }}</button>
                  </div>
                  <!-- 标签颜色编辑器（点击已应用标签时弹出） -->
                  <Teleport to="body">
                    <div v-if="colorPickerTag && editingTagsItemId === item.id">
                      <div class="fav-color-backdrop" @click="cancelTagColor"></div>
                      <div class="fav-color-picker" :style="{ top: colorPickerPos.top, left: colorPickerPos.left }" @click.stop>
                    <div class="fav-color-picker-header">
                      <span class="fav-color-picker-label">{{ t('fav_tag_color_edit') }}</span>
                      <button class="fav-color-picker-close" @click="cancelTagColor"><X :size="12" /></button>
                    </div>
                    <div class="fav-color-picker-name">
                      <span class="fav-color-picker-tag-name">{{ colorPickerTag }}</span>
                    </div>
                    <div class="fav-color-picker-swatches">
                      <button v-for="c in TAG_PRESET_COLORS" :key="c"
                        :class="['fav-color-swatch', { active: colorPickerColor === c }]"
                        :style="{ background: c }"
                        @click="colorPickerColor = c" />
                      <div class="fav-color-swatch fav-color-swatch--custom" :title="t('fav_color_custom')">
                        <Palette :size="12" />
                        <input type="color" v-model="colorPickerColor" class="fav-color-custom-input" />
                      </div>
                    </div>
                    <div class="fav-color-picker-actions">
                      <button class="fav-color-remove" @click="removeTagColor(colorPickerTag)">{{ t('fav_tag_remove_color') }}</button>
                      <button class="fav-color-save" @click="saveTagColor()">{{ t('fav_tag_save_color') }}</button>
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
                <Button variant="ghost" size="icon-sm" @click.stop="onCopyItem(item)" :title="t('copy')"><Copy :size="14" /></Button>
                <Button v-if="item.type === 'image'" variant="ghost" size="icon-sm" @click.stop="emit('preview-image', item)" :title="t('preview')"><ImageIcon :size="14" /></Button>
                <Button v-else-if="item.type === 'link'" variant="ghost" size="icon-sm" @click.stop="openLink(item)"><ExternalLink :size="14" /></Button>
                <Button v-else-if="item.type === 'text'" variant="ghost" size="icon-sm" @click.stop="emit('preview-text', item)" :title="t('preview')"><FileText :size="14" /></Button>
                <Button v-else-if="item.type === 'file'" variant="ghost" size="icon-sm" @click.stop="emit('preview-file', item)" :title="t('preview')"><FileText :size="14" /></Button>
                <Button v-if="item.type === 'file' && hasLocalPath(item)" variant="ghost" size="icon-sm" @click.stop="revealFileFolder(item)" :title="t('show_in_folder')"><Folder :size="14" /></Button>
                <!-- Add to collection -->
                <div v-if="collections.flatCollections.value.length > 0" class="fav-add-col-wrap">
                  <Button variant="ghost" size="icon-sm" @click.stop="toggleAddToCol(item.id)" :title="t('fav_add_to_col')"><FolderPlus :size="14" /></Button>
                  <div v-if="addToColItemId === item.id" class="fav-add-col-dropdown" @mousedown.stop @click.stop>
                    <button v-for="node in collections.allNodes.value" :key="node.id" type="button" class="fav-add-col-option" :style="{ paddingLeft: Math.max(0, (node.depth - 2) * 16) + 8 + 'px' }" @mousedown.stop="addToCollection(node.id, item.id)" @click.stop="addToCollection(node.id, item.id)">
                      <component :is="COLLECTION_ICON_MAP[node.icon] || Folder" :size="14" />
                      <span>{{ node.name }}</span>
                    </button>
                  </div>
                </div>
                <Button variant="ghost" size="icon-sm" class="fav-unfav-btn" @click.stop="handleUnfavorite(item)"><Star :size="14" fill="currentColor" /></Button>
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
    <div v-if="collections.ctxMenuVisible.value" class="fav-ctx-menu" :style="{ top: collections.ctxMenuPos.value.top + 'px', left: collections.ctxMenuPos.value.left + 'px' }">
      <button class="fav-ctx-item" @click="collections.ctxRename()"><Edit :size="14" /> {{ t('fav_ctx_rename') }}</button>
      <button class="fav-ctx-item" @click="collections.ctxNewSubCollection()"><FolderPlus :size="14" /> {{ t('fav_ctx_new_sub') }}</button>
      <button v-if="collections.ctxMenuNode.value && collections.ctxMenuNode.value.depth > 2" class="fav-ctx-item" @click="collections.ctxMoveToRoot()"><FolderInput :size="14" /> {{ t('fav_ctx_move_root') }}</button>
      <div class="fav-ctx-sep"></div>
      <button class="fav-ctx-item fav-ctx-item--danger" @click="collections.ctxDelete()"><Trash2 :size="14" /> {{ t('fav_ctx_delete') }}</button>
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
</template>

<style scoped>
/* ===== Layout: sidebar (collections) + main content ===== */
.fav-page { display: flex; height: 100%; }

/* Collection panel (left sidebar) */
.fav-col-panel {
  flex-shrink: 0; display: flex; flex-direction: column;
  border-right: 1px solid var(--border-default); background: var(--bg-surface);
  position: relative;
}
.fav-col-resize-handle {
  position: absolute; right: -3px; top: 0; bottom: 0; width: 7px;
  cursor: col-resize; z-index: 10;
}
.fav-col-resize-handle:hover { background: rgba(128,128,128,0.15); }
.fav-col-panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px 6px; flex-shrink: 0;
}
.fav-col-panel-title-wrap { display: flex; align-items: center; gap: 8px; }
.fav-col-panel-title { font-weight: 600; font-size: 13px; color: var(--text-primary); }

.fav-col-header-new-btn {
  width: 24px !important; height: 24px !important; padding: 0 !important;
  color: var(--text-tertiary); border-radius: var(--radius-sm);
}
.fav-col-header-new-btn:hover { background: var(--bg-hover); color: var(--accent); }

/* Tree list: scrollable, takes remaining height */
.fav-tree-list { flex: 1; overflow-y: auto; min-height: 0; padding: 0 4px; }
.fav-tree-new { flex-shrink: 0; padding: 4px 8px; margin-top: 4px; }

/* Main content area (right) */
.fav-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

/* Header */
.fav-header { display: flex; align-items: center; justify-content: flex-end; height: 52px; padding: 0 20px; background: var(--bg-surface); flex-shrink: 0; border-bottom: 1px solid var(--border-default); }
.fav-header-left { display: flex; align-items: center; gap: 10px; }
.fav-header-right { display: flex; align-items: center; gap: 6px; }
.fav-title { font-weight: 600; font-size: 15px; }
.fav-count { padding: 2px 10px !important; }

/* Search */
.fav-search { position: relative; display: inline-flex; align-items: center; }
.fav-search-icon { position: absolute; left: 10px; color: var(--text-tertiary); pointer-events: none; }
.fav-search-input { width: 180px; height: 32px; padding: 0 12px 0 32px; border: 1px solid var(--border-default); border-radius: var(--radius-md); font-size: 13px; background: var(--bg-surface); color: var(--text-primary); outline: none; transition: border-color 0.15s; }
.fav-search-input:focus { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-light); }

/* Action buttons */
.fav-action-btn { padding: 0 8px !important; height: 28px !important; }
.fav-active { color: var(--accent) !important; }
.fav-batch-count { font-size: 12px; color: var(--text-tertiary); padding: 0 6px; }
.fav-unfav-btn { color: var(--warning) !important; }
.fav-view-toggle { display: inline-flex; background: var(--bg-hover); border-radius: var(--radius-sm); padding: 2px; gap: 2px; margin-left: 4px; }
.fav-view-btn { display: flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--text-tertiary); cursor: pointer; transition: all 0.15s; }
.fav-view-btn:hover { color: var(--text-primary); }
.fav-view-btn.active { background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--shadow-card); }

/* Row 2: Tag filter bar */
.fav-tag-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 20px; border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0; flex-wrap: wrap;
}
.fav-tag-label { font-size: 12px; color: var(--text-tertiary); flex-shrink: 0; margin-right: 4px; }

/* Tag pills */
.fav-tag-pill {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 3px 10px; border-radius: 9999px;
  border: 1px solid var(--border-default); background: var(--bg-surface);
  font-size: 11px; color: var(--text-secondary); cursor: pointer;
  transition: all 0.15s; white-space: nowrap; flex-shrink: 0;
}
.fav-tag-pill:hover { border-color: var(--border-focus); color: var(--text-primary); }
.fav-tag-pill.active { background: var(--tag-c-bg, var(--accent-bg)); border-color: var(--tag-c, var(--accent)); color: var(--tag-c, var(--accent)); }
.fav-tag-del {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border: none; background: none;
  color: var(--text-tertiary); cursor: pointer; padding: 0;
  font-size: 12px; line-height: 1; border-radius: 50%;
  transition: all 0.12s;
}
.fav-tag-pill:hover .fav-tag-del { color: var(--text-primary); }
.fav-tag-del:hover { background: var(--danger-bg); color: var(--danger) !important; }

/* Privacy: sensitive content mask */
.fav-mask-wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 8px; height: 100%; }
.fav-mask-wrap--card { position: absolute; inset: 0; background: var(--bg-hover); border-radius: var(--radius-sm); }
.fav-masked-text { font-size: 12px; color: var(--text-tertiary); text-align: center; line-height: 1.4; }
.fav-peek-btn { padding: 3px 10px; border-radius: 9999px; border: 1px solid var(--border-default); background: var(--bg-surface); font-size: 11px; color: var(--accent); cursor: pointer; transition: all 0.12s; white-space: nowrap; }
.fav-peek-btn:hover { background: var(--accent-bg); border-color: var(--accent); }

/* Grid view card adjustments for mask */
.fav-card-preview { position: relative; }

/* Tag suggestion chips (shown during inline tag editing) */
.fav-tag-suggestions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.fav-tag-suggest {
  display: inline-flex; align-items: center; gap: 2px;
  padding: 2px 8px; border-radius: 9999px;
  border: 1px solid var(--tag-c-border, var(--border-default));
  background: var(--tag-c-bg, var(--bg-hover));
  font-size: 10px; color: var(--tag-c, var(--text-secondary));
  cursor: pointer; transition: all 0.12s; white-space: nowrap;
  font-weight: 500;
}
.fav-tag-suggest:hover { filter: brightness(1.2); }
.fav-tag-suggest--active {
  font-weight: 600;
  animation: tagBlink 1.6s ease-in-out infinite;
}
.fav-tag-suggest-check { color: var(--tag-c, var(--accent)); display: inline-flex; align-items: center; }

/* Tag color picker */
/* Tag color picker (teleported to body) — backdrop */
.fav-color-backdrop { position: fixed; inset: 0; z-index: 9998; background: transparent; }
/* Tag color picker (teleported to body) — popup */
.fav-color-picker { position: fixed; z-index: 9999; width: 220px; display: flex; flex-direction: column; gap: 6px; padding: 8px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); box-shadow: 0 8px 32px rgba(0,0,0,0.35); }
.fav-color-picker-header { display: flex; align-items: center; justify-content: space-between; }
.fav-color-picker-label { font-size: 11px; font-weight: 600; color: var(--text-primary); }
.fav-color-picker-close { border: none; background: none; color: var(--text-tertiary); cursor: pointer; padding: 2px; display: inline-flex; border-radius: var(--radius-sm); }
.fav-color-picker-close:hover { background: var(--bg-active); color: var(--text-primary); }
.fav-color-picker-name { display: flex; }
.fav-color-picker-swatches { display: flex; gap: 6px; flex-wrap: wrap; }
.fav-color-swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; transition: all 0.12s; padding: 0; flex-shrink: 0; }
.fav-color-swatch:hover { transform: scale(1.15); }
.fav-color-swatch.active { border-color: var(--text-primary); box-shadow: 0 0 0 2px var(--bg-surface); }
.fav-color-swatch--custom { position: relative; overflow: hidden; background: var(--bg-hover) !important; display: inline-flex; align-items: center; justify-content: center; color: var(--text-tertiary); }
.fav-color-swatch--custom:hover { color: var(--text-primary); }
.fav-color-custom-input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
.fav-color-picker-actions { display: flex; gap: 6px; justify-content: flex-end; }
.fav-color-remove { border: none; background: none; color: var(--danger); font-size: 11px; cursor: pointer; padding: 3px 8px; border-radius: var(--radius-sm); }
.fav-color-remove:hover { background: var(--danger-bg); }
.fav-color-save { border: none; background: var(--accent); color: white; font-size: 11px; cursor: pointer; padding: 3px 12px; border-radius: var(--radius-sm); }
.fav-color-save:hover { opacity: 0.9; }

/* Color picker row (inline, for new tags) */
.fav-color-picker-row { display: flex; align-items: center; gap: 4px; margin-top: 4px; padding: 4px 0; }
.fav-color-picker-row-label { font-size: 11px; color: var(--text-tertiary); flex-shrink: 0; }
.fav-color-swatch-sm { width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; transition: all 0.12s; padding: 0; flex-shrink: 0; }
.fav-color-swatch-sm:hover { transform: scale(1.2); }
.fav-color-swatch-sm.active { border-color: var(--text-primary); box-shadow: 0 0 0 2px var(--bg-surface); }
.fav-color-swatch-sm--custom { position: relative; overflow: hidden; background: var(--bg-hover) !important; display: inline-flex; align-items: center; justify-content: center; color: var(--text-tertiary); }
.fav-color-swatch-sm--custom:hover { color: var(--text-primary); }
.fav-color-clear { border: none; background: none; color: var(--text-tertiary); font-size: 10px; cursor: pointer; padding: 2px 4px; }
.fav-color-clear:hover { color: var(--danger); }
.fav-color-picker-tag-name { font-size: 12px; font-weight: 600; color: var(--text-primary); }
@keyframes tagBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

/* Confirm / Cancel icon buttons */
.fav-col-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: var(--radius-sm);
  border: none; cursor: pointer; transition: all 0.15s; flex-shrink: 0;
}
.fav-col-confirm { background: var(--success); color: white; }
.fav-col-confirm:hover { opacity: 0.85; }
.fav-col-cancel { background: var(--bg-hover); color: var(--text-tertiary); }
.fav-col-cancel:hover { background: var(--danger-bg); color: var(--danger); }

/* Content */
.fav-content { flex: 1; overflow-y: auto; padding: 16px 20px; }

/* Empty */
.fav-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 12px; }
.fav-empty-icon { color: var(--text-tertiary); opacity: 0.3; }
.fav-empty-title { font-weight: 600; font-size: 16px; color: var(--text-secondary); }
.fav-empty-desc { font-size: 13px; color: var(--text-tertiary); text-align: center; max-width: 300px; }
.fav-empty :deep(button) { padding: 0 20px !important; height: 36px !important; }

/* Skeleton loading */
.fav-skeleton { display: flex; flex-direction: column; gap: 12px; padding: 0 20px; }
.fav-skeleton-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.fav-skeleton-card { height: 160px; border-radius: var(--radius-md); background: linear-gradient(90deg, rgba(0,0,0,0.04) 25%, rgba(0,0,0,0.08) 50%, rgba(0,0,0,0.04) 75%); background-size: 200% 100%; animation: skeletonShimmer 1.5s ease-in-out infinite; }
.fav-skeleton-list { display: flex; flex-direction: column; gap: 8px; }
.fav-skeleton-row { height: 48px; border-radius: var(--radius-md); background: linear-gradient(90deg, rgba(0,0,0,0.04) 25%, rgba(0,0,0,0.08) 50%, rgba(0,0,0,0.04) 75%); background-size: 200% 100%; animation: skeletonShimmer 1.5s ease-in-out infinite; }
@keyframes skeletonShimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Groups */
.fav-groups { display: flex; flex-direction: column; gap: 20px; }
.fav-group-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; user-select: none; }
.fav-group-chevron { color: var(--text-tertiary); transition: transform 0.2s ease; flex-shrink: 0; }
.fav-group-chevron--open { transform: rotate(90deg); }
.fav-group-badge { font-size: 12px !important; padding: 2px 8px !important; }
.fav-group-badge .type-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-right: 4px; }
.fav-group-badge[data-type="text"] .type-dot { background: var(--info); }
.fav-group-badge[data-type="code"] .type-dot { background: var(--purple, #8b5cf6); }
.fav-group-badge[data-type="link"] .type-dot { background: var(--warning); }
.fav-group-badge[data-type="image"] .type-dot { background: var(--success); }
.fav-group-badge[data-type="file"] .type-dot { background: var(--accent); }
.fav-group-count { font-size: 12px; color: var(--text-tertiary); }
.fav-group-line { flex: 1; height: 1px; background: var(--border-subtle); }

/* List view */
.fav-list-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: var(--radius-md); transition: all 0.2s; position: relative; }
.fav-list-item:hover { background: var(--bg-hover); }
.fav-list-item.fav-item--editing-tags { z-index: 999 !important; }
.fav-list-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: var(--radius-md); transition: background 0.12s; }
.fav-list-item:hover { background: var(--bg-hover); }
/* Tag editing: blur content to focus on tag editor */
.fav-list-item.fav-item--editing-tags .fav-list-title,
.fav-list-item.fav-item--editing-tags .fav-list-meta { filter: blur(2px); opacity: 0.4; }
.fav-list-item.fav-item--editing-tags .fav-list-content { background: var(--accent-bg); border-radius: var(--radius-sm); }
.fav-list-item[draggable="true"] { cursor: grab; }
.fav-list-item[draggable="true"]:active { cursor: grabbing; }
.fav-list-check { flex-shrink: 0; }
.fav-list-content { flex: 1; min-width: 0; }
.fav-list-title { font-size: 13px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fav-list-meta { font-size: 11px; color: var(--text-tertiary); display: flex; gap: 6px; margin-top: 2px; }
.fav-list-tags-inner { display: flex; align-items: center; gap: 4px; margin-top: 5px; flex-wrap: wrap; }
.fav-list-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; opacity: 0; transition: opacity 0.12s; }
.fav-list-item:hover .fav-list-actions,
.fav-list-item--dropdown-open .fav-list-actions { opacity: 1; }
.fav-list-actions :deep(button) { color: var(--text-tertiary); border-radius: var(--radius-sm); transition: background .15s ease, color .15s ease; }
.fav-list-actions :deep(button):hover { background: var(--bg-active); color: var(--text-primary); }
.fav-list-actions :deep(button.sensitive-locked) { color: var(--danger); }
.fav-list-actions :deep(button.sensitive-locked):hover { background: var(--danger-bg); }

/* Grid view */
.fav-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.fav-card { position: relative; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); display: flow-root; cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s; }
.fav-card:hover { border-color: var(--border-focus); box-shadow: var(--shadow-card); }
.fav-card--selected { border-color: var(--accent); }
.fav-card.fav-item--editing-tags { z-index: 100; }
/* Tag editing: blur card content to focus on tag editor */
.fav-card.fav-item--editing-tags .fav-card-preview { filter: blur(2px); opacity: 0.4; }
.fav-card.fav-item--editing-tags .fav-card-meta { filter: blur(2px); opacity: 0.4; }
.fav-card.fav-item--editing-tags .fav-card-preview::after {
  content: ''; position: absolute; inset: 0; background: var(--accent-bg); border-radius: var(--radius-sm); z-index: 1; pointer-events: none;
}
.fav-card[draggable="true"]:active { cursor: grabbing; opacity: 0.8; }
.fav-card-check { position: absolute; top: 8px; left: 8px; z-index: 2; background: var(--bg-surface); border-radius: var(--radius-sm); box-shadow: var(--shadow-card); }
.fav-card-preview { position: relative; height: 100px; display: flex; align-items: center; justify-content: center; background: var(--bg-hover); padding: 10px; overflow: hidden; }
.fav-card-lock-btn { position: absolute; bottom: 4px; left: 4px; color: var(--text-tertiary); border-radius: var(--radius-sm); z-index: 2; }
.fav-card-lock-btn:hover { background: var(--bg-active); color: var(--text-primary); }
.fav-card-lock-btn.sensitive-locked { color: var(--danger); }
.fav-card-lock-btn.sensitive-locked:hover { background: var(--danger-bg); }
.fav-card-img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: var(--radius-sm); }
.fav-card-placeholder { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: var(--text-tertiary); opacity: 0.4; }
.fav-card-text { font-size: 12px; line-height: 1.5; color: var(--text-primary); text-align: left; width: 100%; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; word-break: break-all; }
.fav-card-link { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
.fav-card-link-icon { color: var(--accent); flex-shrink: 0; }
.fav-card-link-url { font-size: 11px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.fav-card-link-domain { font-size: 10px; color: var(--text-tertiary); }
.fav-card-file { display: flex; flex-direction: column; align-items: center; gap: 4px; color: var(--text-secondary); }
.fav-card-file span { font-size: 11px; text-align: center; word-break: break-all; }
.fav-card-tags { position: absolute; top: 6px; left: 6px; z-index: 2; display: flex; align-items: center; gap: 3px; flex-wrap: wrap; max-width: calc(100% - 12px); }
.fav-card-meta { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-top: 1px solid var(--border-subtle); }
.fav-card-source { font-size: 11px; color: var(--text-tertiary); max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fav-card-time { font-size: 11px; color: var(--text-tertiary); }
.fav-card-actions { display: flex; align-items: center; justify-content: flex-end; gap: 2px; padding: 4px 6px 6px; opacity: 0; transition: opacity 0.15s; }
.fav-card:hover .fav-card-actions,
.fav-card--dropdown-open .fav-card-actions { opacity: 1; }
.fav-add-col-dropdown { pointer-events: auto; }

/* Tags */
.fav-tag-badge {
  font-size: 11px !important; padding: 3px 10px !important;
  border-color: var(--tag-c-border, var(--border-default)) !important;
  color: var(--tag-c, var(--text-secondary)) !important;
  background: var(--tag-c-bg, var(--bg-hover)) !important;
  font-weight: 500 !important;
}
.fav-tag-add-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1px dashed var(--border-default); border-radius: var(--radius-sm); background: transparent; color: var(--text-tertiary); cursor: pointer; transition: all 0.12s; flex-shrink: 0; }
.fav-tag-add-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }
.fav-tag-edit { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; position: relative; }
.fav-tag-input { width: 120px; height: 28px; padding: 0 8px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); font-size: 12px; background: var(--bg-surface); color: var(--text-primary); outline: none; transition: border-color 0.12s; }
.fav-tag-input:focus { border-color: var(--accent); }
.fav-tag-save { border: none; background: none; color: var(--accent); border-radius: var(--radius-sm); width: 24px; height: 24px; cursor: pointer; padding: 0; display: inline-flex; align-items: center; justify-content: center; transition: all 0.12s; }
.fav-tag-save:hover { background: var(--accent); color: white; }
.fav-tag-cancel { border: none; background: none; color: var(--text-tertiary); cursor: pointer; padding: 2px; display: inline-flex; align-items: center; justify-content: center; transition: all 0.12s; border-radius: var(--radius-sm); }
.fav-tag-cancel:hover { background: var(--bg-active); color: var(--text-primary); }
.fav-tag-cancel { border: none; background: none; color: var(--text-tertiary); cursor: pointer; padding: 2px; display: inline-flex; align-items: center; justify-content: center; }

/* Add to collection dropdown */
.fav-add-col-wrap { position: relative; display: inline-flex; }
.fav-add-col-dropdown { position: absolute; top: 100%; right: 0; margin-top: 4px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); box-shadow: var(--shadow-modal); padding: 4px; z-index: 1000; min-width: 160px; pointer-events: auto; }
.fav-add-col-option { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 10px; border: none; background: none; text-align: left; font-size: 12px; color: var(--text-primary); cursor: pointer; border-radius: var(--radius-sm); white-space: nowrap; pointer-events: auto; }
.fav-add-col-option:hover { background: var(--bg-hover); }

/* Pick collection bar (方案 A: shown when navigating from ClipboardView popover) */
.fav-pick-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 24px; border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0; background: var(--accent-bg); overflow-x: auto;
}
.fav-pick-label { font-size: 12px; color: var(--accent); font-weight: 500; flex-shrink: 0; }
.fav-pick-cancel {
  padding: 2px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-default);
  background: var(--bg-surface); color: var(--text-secondary); font-size: 11px;
  cursor: pointer; flex-shrink: 0; transition: all 0.12s;
}
.fav-pick-cancel:hover { border-color: var(--danger); color: var(--danger); }
.fav-pick-collections { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
.fav-pick-col-btn {
  padding: 4px 12px; border-radius: 9999px; border: 1px solid var(--border-default);
  background: var(--bg-surface); font-size: 12px; color: var(--text-secondary);
  cursor: pointer; white-space: nowrap; flex-shrink: 0; transition: all 0.12s;
}
.fav-pick-col-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }
.fav-pick-new-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px; border-radius: 9999px;
  border: 1px dashed var(--accent); background: var(--bg-surface);
  font-size: 11px; color: var(--accent); cursor: pointer;
  flex-shrink: 0; transition: all 0.12s;
}
.fav-pick-new-btn:hover { background: var(--accent-bg); }

/* ===== Collection tree sidebar (replaces horizontal tab bar) ===== */
.fav-tree-sidebar { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; padding: 6px 0; }
.fav-tree-breadcrumb { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 0 8px; margin-bottom: 2px; }
.fav-tree-breadcrumb-item { border: none; background: none; color: var(--text-tertiary); font-size: 11px; cursor: pointer; padding: 2px 4px; border-radius: var(--radius-sm); transition: all 0.12s; }
.fav-tree-breadcrumb-item:hover { color: var(--text-primary); background: var(--bg-hover); }
.fav-tree-breadcrumb-item.active { color: var(--accent); font-weight: 500; }
.fav-tree-breadcrumb-sep { color: var(--text-tertiary); font-size: 10px; opacity: 0.5; }
.fav-tree-list { display: flex; flex-direction: column; gap: 0; }
.fav-tree-node { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: var(--radius-sm); cursor: grab; transition: all 0.12s; user-select: none; position: relative; border: 1px solid transparent; }
.fav-tree-node:hover { background: var(--bg-hover); }
.fav-tree-node:active { cursor: grabbing; }
.fav-tree-expand { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; flex-shrink: 0; color: var(--text-tertiary); transition: transform 0.2s ease; border-radius: var(--radius-sm); }
.fav-tree-expand:hover { background: var(--bg-active); }
.fav-tree-expand--open { transform: rotate(90deg); }
.fav-tree-expand--empty { visibility: hidden; pointer-events: none; }
.fav-tree-icon { display: inline-flex; align-items: center; color: var(--text-secondary); flex-shrink: 0; }
.fav-tree-icon.active { color: var(--accent); }
.fav-tree-name { font-size: 13px; color: var(--text-secondary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: color 0.12s; }
.fav-tree-name.active { color: var(--accent); font-weight: 500; }
.fav-tree-count { font-size: 10px; color: var(--text-tertiary); flex-shrink: 0; background: var(--bg-hover); padding: 1px 6px; border-radius: 9999px; min-width: 20px; text-align: center; }
.fav-tree-del { display: none; border: none; background: none; color: var(--text-tertiary); cursor: pointer; padding: 2px; font-size: 14px; line-height: 1; flex-shrink: 0; border-radius: var(--radius-sm); transition: all 0.12s; }
.fav-tree-node:hover .fav-tree-del { display: inline-flex; }
.fav-tree-del:hover { background: var(--danger-bg); color: var(--danger); }
.fav-tree-new { margin-top: 8px; padding: 0 8px; }

/* Context menu (teleported to body) */
.fav-ctx-backdrop { position: fixed; inset: 0; z-index: 9998; }
.fav-ctx-menu { position: fixed; z-index: 9999; min-width: 160px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); box-shadow: var(--shadow-modal); padding: 4px; }
.fav-ctx-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 12px; border: none; background: none; text-align: left; font-size: 12px; color: var(--text-primary); cursor: pointer; border-radius: var(--radius-sm); transition: all 0.12s; }
.fav-ctx-item:hover { background: var(--bg-hover); }
.fav-ctx-item--danger { color: var(--danger); }
.fav-ctx-item--danger:hover { background: var(--danger-bg); }
.fav-ctx-sep { height: 1px; background: var(--border-subtle); margin: 4px 0; }

/* Tree flyout (hover preview of children) */
.fav-tree-flyout { position: absolute; left: 100%; top: 0; margin-left: 4px; min-width: 160px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); box-shadow: var(--shadow-modal); padding: 4px; z-index: 100; }
.fav-tree-flyout-item { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border: none; background: none; text-align: left; font-size: 12px; color: var(--text-primary); cursor: pointer; border-radius: var(--radius-sm); transition: all 0.12s; width: 100%; }
.fav-tree-flyout-item:hover { background: var(--bg-hover); }
.fav-tree-flyout-count { font-size: 10px; color: var(--text-tertiary); margin-left: auto; }

/* Drag-over highlight states */
.fav-tree-node--dragging { opacity: 0.5; }
.fav-tree-node--drag-over-inside { background: var(--accent-bg) !important; border: 1px dashed var(--accent) !important; }
.fav-tree-node--drag-over-before { border-top: 2px solid var(--accent) !important; }
.fav-tree-node--drag-over-after { border-bottom: 2px solid var(--accent) !important; }

/* Inline new collection row: seamless like Windows Explorer new folder */
.fav-tree-node--new {
  background: transparent;
  cursor: default;
}
.fav-tree-node--new .fav-tree-icon {
  color: var(--accent);
}
.fav-tree-new-input {
  flex: 1;
  min-width: 0;
  height: auto;
  padding: 0;
  margin: 0;
  border: none;
  border-bottom: 1px solid var(--accent);
  border-radius: 0;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1;
  outline: none;
  transition: border-color 0.12s;
}
.fav-tree-new-input::placeholder {
  color: var(--text-tertiary);
  opacity: 0.8;
}
.fav-tree-new-input:focus {
  border-bottom-color: var(--accent);
}

/* Drop zones (root / bottom) */
.fav-tree-drop-zone {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; font-size: 11px; color: var(--text-tertiary);
  opacity: 0; transition: opacity 0.12s, background 0.12s;
  user-select: none; min-height: 20px; pointer-events: auto;
}
.fav-tree-drop-zone.active {
  opacity: 1;
  background: var(--accent-bg); color: var(--accent);
  border-radius: var(--radius-sm);
}
.fav-tree-drop-zone--bottom { margin-top: 2px; }
.fav-tree-drop-line {
  flex: 1; height: 2px; border-radius: 1px;
  background: transparent; transition: background 0.12s;
}
.fav-tree-drop-zone.active .fav-tree-drop-line { background: var(--accent); }

/* Inline rename input */
.fav-tree-rename-input { height: 24px; padding: 0 6px; border: 1px solid var(--accent); border-radius: var(--radius-sm); font-size: 12px; background: var(--bg-surface); color: var(--text-primary); outline: none; flex: 1; min-width: 60px; }
</style>
