<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, h, Teleport } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useConfigStore } from '@/stores/configStore'
import { useDevice } from '@/composables/useDevice'
import { usePrivacy } from '@/composables/usePrivacy'
import { Star, Search, Copy, Image as ImageIcon, LayoutGrid, List, ExternalLink, FileText, Folder, FolderPlus, FolderInput, Plus, X, Check, CheckSquare, Square, ArrowUpDown, Tag, ClipboardList, ChevronRight, Lock, Bookmark, Archive, Trash2, Palette, Edit, AlertTriangle, RefreshCw, Code2, Sparkles, Eye, Pencil, History } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import Badge from '@/components/ui/badge/Badge.vue'
import Checkbox from '@/components/ui/checkbox/Checkbox.vue'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { createFavoriteCollection, updateFavoriteCollection, deleteFavoriteCollection, addCollectionItem, removeCollectionItem, setItemTags, getAllFavoriteTags, deleteTag, createTag, updateTag, getCollectionItems, type FavoriteTag } from '@/api/client'
import { useCollections, type CollectionNode } from '@/composables/useCollections'
import { useItemPassword } from '@/composables/useItemPassword'
import ProtectionDialog from '@/components/clipboard/ProtectionDialog.vue'
import { TAG_PRESET_COLORS, getTagDisplayColor, tagColorStyle } from '@/utils/favorites/tagColors'
import { COLLECTION_ICON_MAP, renderCollectionIcon } from '@/utils/favorites/collectionIcons'
import ClipDetailDrawer from '@/components/clipboard/ClipDetailDrawer.vue'
import { setKeyboardLayer } from '@/composables/useClipboardKeyboard'
// A2：页内内联 AI（总结卡 + 整理流程卡），结果直接在收藏页展示，不再跳侧栏
import InlineAiCard from '@/components/ai/InlineAiCard.vue'
import FavOrganizeFlow from '@/components/clipboard/FavOrganizeFlow.vue'
import { useInlineAi } from '@/composables/useInlineAi'

const props = defineProps<{ aiEnabled?: boolean }>()
const emit = defineEmits<{
  'preview-image': [item: ClipItem]
  'preview-text': [item: ClipItem]
  'preview-file': [item: ClipItem]
  'show-pin-dialog': []
  'show-pin-setup': []
  'toggle-sensitive': [item: ClipItem]
}>()

const { t, tf } = useI18n()
const toast = useSonner()
const clip = useClipboard()
const router = useRouter()
const route = useRoute()
const configStore = useConfigStore()
const device = useDevice()
const itemPw = useItemPassword()

// --- State ---
const searchInput = ref('')
const sortBy = ref<'time' | 'type'>('time')
const sortAsc = ref(false)
const batchMode = ref(false)
const selectedIds = ref<Set<string>>(new Set())
const viewMode = ref<'grid' | 'list'>('list')
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

// 原型：新建/重命名收藏夹弹窗（名称 + 自定义图标；不选图标 = 默认文件夹）
const ICON_CHOICES = ['folder', 'star', 'code', 'globe', 'zap', 'palette']
const colModal = ref<{ mode: 'create' | 'rename'; id?: string; parentId?: string; name: string; icon: string } | null>(null)
function openColModal(
  mode: 'create' | 'rename',
  opts?: { id?: string; parentId?: string; name?: string; icon?: string },
) {
  colModal.value = { mode, id: opts?.id, parentId: opts?.parentId, name: opts?.name || '', icon: opts?.icon || 'folder' }
}
async function saveColModal() {
  const m = colModal.value
  if (!m || isCreatingCollection.value) return
  const name = m.name.trim()
  if (!name) return
  isCreatingCollection.value = true
  try {
    if (m.mode === 'create') {
      const data = await collections.createCollection(name, m.icon, m.parentId)
      if (data?.collection) {
        toast.show(t('fav_create_ok'), 'success')
        if (pickAndCreate.value && pickItemId.value) {
          pickAndCreate.value = false
          await addCollectionItem(data.collection.id, pickItemId.value)
          toast.show(t('fav_moved'), 'success')
          clearPickMode()
        }
        colModal.value = null
      } else {
        toast.show(t('fav_create_fail', '创建失败'), 'error')
      }
    } else if (m.id) {
      const data = await updateFavoriteCollection(m.id, { name, icon: m.icon })
      if (data?.collection) {
        toast.show(t('fav_rename_ok', '已保存'), 'success')
        colModal.value = null
        await collections.loadCollections()
      } else {
        toast.show(t('fav_rename_fail', '保存失败'), 'error')
      }
    }
  } finally {
    isCreatingCollection.value = false
  }
}

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

  const ok = await clip.copyItem(item)
  // 传入条目：敏感条目无条件清空，普通条目受"复制后自动清空"开关控制
  if (ok) privacy.scheduleClipboardClear(item)
  // 必须按 copyItem 的真实结果提示：之前无条件弹"已复制"，跨设备文件复制失败时是在说谎
  toast.show(ok ? t('copied') : clip.lastCopyError.value || t('copy_failed'), ok ? 'success' : 'error')
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
  reloadFavorites()
})

// === 收藏分页（B10 / 决策 D7）===
// 之前 favorites=true 一次性拉 limit=200，超过 200 条收藏后面的永远取不到。
// 改为按 pageSize 分页 + 滚动到底自动加载（不做虚拟滚动）。
const FAV_PAGE_SIZE = 50
const favPage = ref(1)
const favLoadingMore = ref(false)
const favHasMore = ref(true)
// 服务端收藏总数（分页加载后本地只持有已加载页，徽标不能退化为"已加载条数"）
const favTotal = ref(0)

async function reloadFavorites() {
  favPage.value = 1
  favHasMore.value = true
  const ok = await clip.loadClipboardItems({ favorite: true, page: 1, limit: FAV_PAGE_SIZE })
  if (!ok) return
  favTotal.value = clip.totalItems.value
  // 第一页就装满了全部收藏 → 没有更多（否则会多打一次必然为空的第 2 页请求）
  if (favTotal.value <= clip.items.value.length) favHasMore.value = false
}

async function loadMoreFavorites() {
  if (favLoadingMore.value || !favHasMore.value) return
  const next = favPage.value + 1
  const before = clip.items.value.length
  favLoadingMore.value = true
  const ok = await clip.loadClipboardItems({
    favorite: true,
    page: next,
    append: true,
    limit: FAV_PAGE_SIZE,
  })
  favLoadingMore.value = false
  if (!ok) return // 失败不推进页码，重试拿到的还是同一页
  const added = clip.items.value.length - before
  // 本页不满 或 已加载条数达到服务端总数 → 后面没有了
  if (added < FAV_PAGE_SIZE || (favTotal.value > 0 && clip.items.value.length >= favTotal.value)) {
    favHasMore.value = false
  }
  favPage.value = next
}

// 滚动到底自动加载：滚到底部前一屏（160px）就预取，用户几乎感知不到等待
const favContentRef = ref<HTMLElement | null>(null)
const favSentinelRef = ref<HTMLElement | null>(null)
let favObserver: IntersectionObserver | null = null

// 与"确实没有收藏"区分开：失败时渲染错误态 + 重试，而不是空态
const loadError = computed(() => clip.loadError.value)

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
// 分页加载后本地只持有已加载页，徽标必须用服务端总数，否则会显示成"50"
const favoriteCount = computed(() =>
  favTotal.value > 0 ? favTotal.value : clip.items.value.filter((i) => (i as any).isFavorite).length,
)
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
/* 原型 favorites.html：列表行复用剪贴板 .clip-item 语言（type-tile + clip-body + clip-acts） */
const FAV_TILE: Record<string, string> = { text: 't-text', code: 't-code', link: 't-link', image: 't-image', file: 't-file' }
const FAV_BADGE: Record<string, string> = { text: 'b-text', code: 'b-code', link: 'b-link', image: 'b-image', file: 'b-file' }
function favTileClass(item: ClipItem): string {
  if (item.type === 'text') {
    const ct = detectContentType(item.content)
    if (ct === 'url') return 't-link'
    if (ct === 'code') return 't-code'
  }
  return FAV_TILE[item.type] || 't-text'
}
function favBadgeClass(item: ClipItem): string {
  if (item.type === 'text') {
    const ct = detectContentType(item.content)
    if (ct === 'url') return 'b-link'
    if (ct === 'code') return 'b-code'
  }
  return FAV_BADGE[item.type] || 'b-text'
}
function favBadgeLabel(item: ClipItem): string {
  if (item.type === 'text') {
    const ct = detectContentType(item.content)
    if (ct === 'url') return 'URL'
    if (ct === 'code') return 'CODE'
  }
  return getTypeLabel(item.type)
}
/* 网格卡片卡头的类型图标（tile 配色复用上方 favTileClass） */
function favTileIcon(item: ClipItem): unknown {
  switch (favBadgeClass(item)) {
    case 'b-image':
      return ImageIcon
    case 'b-file':
      return FileText
    case 'b-link':
      return ExternalLink
    case 'b-code':
      return Code2
    default:
      return ClipboardList
  }
}
/* 原型 favWhere：当前位置提示行（合集 · 标签 · 搜索） */
const manageTagsOpen = ref(false)
// 原型管理标签：新建 + 行内重命名
const newTagName = ref('')
const newTagColor = ref('')
const renamingTag = ref<string | null>(null)
const renameTagValue = ref('')
const isSavingTag = ref(false)
function startTagRename(name: string) {
  renamingTag.value = name
  renameTagValue.value = name
}
async function saveTagRename(oldName: string) {
  const newName = renameTagValue.value.trim()
  renamingTag.value = null
  if (!newName || newName === oldName) return
  isSavingTag.value = true
  try {
    const res = await updateTag(oldName, { name: newName })
    if (res?.tag) {
      toast.show(tf('tag_rename_ok', '标签已重命名'), 'success')
      await loadTags()
    } else {
      toast.show(tf('tag_rename_fail', '重命名失败'), 'error')
    }
  } finally {
    isSavingTag.value = false
  }
}
async function createTagPreset() {
  const name = newTagName.value.trim()
  if (!name) return
  isSavingTag.value = true
  try {
    const res = await createTag(name, newTagColor.value || undefined)
    if (res?.tag) {
      toast.show(tf('tag_create_ok', '标签已创建'), 'success')
      newTagName.value = ''
      newTagColor.value = ''
      await loadTags()
    } else {
      toast.show(tf('tag_create_fail', '创建失败'), 'error')
    }
  } finally {
    isSavingTag.value = false
  }
}
// 原型 v1 收藏页统计卡（真实数据：总数/合集数/本月新增/标签数/在线设备）
const monthNewCount = computed(() => {
  const start = new Date()
  start.setDate(1)
  start.setHours(0, 0, 0, 0)
  return favoriteItems.value.filter((i) => ((i as any).favoritedAt || i.timestamp) >= start.getTime()).length
})
const onlineDeviceCount = computed(() => device.devices.value.filter((d) => d.online).length)
function tagDotColor(name: string): string {
  return getTagDisplayColor(name, _tagColorMap.value)
}
function tagUsage(name: string): number {
  return favoriteItems.value.filter((i) => getTags(i).includes(name)).length
}
// 改色：服务端按用户维度存全局标签色，任一持有该标签的条目提交即可生效
async function recolorTag(name: string, color: string) {
  const owner = favoriteItems.value.find((i) => getTags(i).includes(name))
  if (!owner) {
    toast.show(tf('fav_tag_color_no_item', '该标签暂无使用条目，暂不能改色'), 'error')
    return
  }
  const result = await setItemTags(owner.id, getTags(owner), { ..._tagColorMap.value, [name]: color })
  if (result?.tagColors) {
    for (const [k, v] of Object.entries(result.tagColors)) if (v) _tagColorMap.value[k] = v
    toast.show(tf('fav_tag_color_ok', '颜色已更新'), 'success')
  } else {
    toast.show(tf('fav_tag_color_fail', '颜色更新失败'), 'error')
  }
}
const favWhere = computed(() => {
  const parts: string[] = []
  const active = collections.activeNodeId.value
  const node = active ? collections.allNodes.value.find((n) => n.id === active) : null
  parts.push(node ? node.name : t('fav_all'))
  if (activeTagFilter.value) parts.push(t('fav_where_tag', { tag: activeTagFilter.value }))
  if (searchInput.value.trim()) parts.push(t('fav_where_search', { q: searchInput.value.trim() }))
  return parts.join(' · ')
})


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
  const ok = await clip.copyItem(item)
  toast.show(ok ? t('copied') : clip.lastCopyError.value || t('copy_failed'), ok ? 'success' : 'error')
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
const addToColPos = ref<{ top: number; left: number }>({ top: 0, left: 0 })
function toggleAddToCol(itemId: string, e?: MouseEvent) {
  const wasOpen = addToColItemId.value === itemId
  addToColItemId.value = wasOpen ? null : itemId
  if (!wasOpen && e) {
    // Teleport 到 body 后用按钮 rect 固定定位：向下弹出并防止出屏
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const W = 200
    addToColPos.value = {
      top: Math.min(r.bottom + 6, window.innerHeight - 64),
      left: Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8)),
    }
  }
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
/** 卡片操作条 Tag+ 按钮：再次点击收起浮层 */
function toggleEditTags(item: ClipItem) {
  if (editingTagsItemId.value === item.id) cancelEditTags()
  else void startEditTags(item)
}
/** 标签浮层 chip：点击即套用/移除已有全局标签（无需手动保存；新建/改色走「管理标签」） */
async function toggleItemTag(item: ClipItem, tagName: string) {
  const cur = getTags(item)
  tagInputValue.value = (cur.includes(tagName) ? cur.filter((t) => t !== tagName) : [...cur, tagName]).join(', ')
  await saveItemTags(item)
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

// 行点击：批量模式=切换选中；常态=打开右侧详情抽屉（与剪贴板一致，点击其他行直接切换）
const drawerItem = ref<ClipItem | null>(null)
function onFavRowClick(item: ClipItem) {
  if (batchMode.value) {
    toggleSelect(item.id)
    return
  }
  // 文件类型沿用原文件预览弹窗（md 左目录右内容）；其余走详情抽屉
  if (item.type === 'file') {
    emit('preview-file', item)
    return
  }
  drawerItem.value = item
}
// 抽屉原位 AI：打开 AI 面板并携带条目内容
function onDrawerAi(action: string, item: ClipItem) {
  askAi(`${action}：\n${(item.content || '').slice(0, 2000)}`)
}
// 通用：呼出 AI 面板并附带提示词
function askAi(prompt: string) {
  window.dispatchEvent(new CustomEvent('clipsync:toggle-ai'))
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('clipsync:ai-send-message', { detail: { content: prompt } }))
  }, 120)
}
// === A2：「AI 整理收藏」/「总结这个合集」改为页内内联出结果（不再跳侧栏）===
// 总结卡：InlineAiCard 只读输出；整理卡：FavOrganizeFlow 两段式（分析 → 预览/采纳）
const summarizeAi = useInlineAi()
const showSummarize = ref(false)
const showOrganizeFlow = ref(false)
const summarizeCtx = ref<{ prompt: string; context: string } | null>(null)

/** 收藏条目摘要清单（id + 类型 + 内容前 80 字，最多 60 条），作为内联 AI 的参考上下文 */
function buildFavoriteDigest(): string {
  return favoriteItems.value
    .slice(0, 60)
    .map((item, i) => {
      const body =
        item.type === 'image' ? '（图片）' : String(item.content || '').replace(/\s+/g, ' ').trim()
      return `#${i} [${item.type}] id=${item.id} ${body.slice(0, 80)}`
    })
    .join('\n')
}
function aiSummarizeCollection() {
  // 两个卡互斥：开一个关另一个
  showOrganizeFlow.value = false
  const context = buildFavoriteDigest()
  const prompt =
    `${tf('fav_ai_summarize_col', '总结这个合集')}：以下是当前收藏条目清单（每行 #序号 [类型] id=条目ID 内容前80字）。\n` +
    `请总结这批收藏的主题分布与要点：\n` +
    `- 先用 2~3 句话概括整体构成；\n` +
    `- 再按主题/类型分布列出要点（每条一行，简短）；\n` +
    `- 如有明显的整理建议（某类内容偏多、可归档等）可附一句。\n` +
    `不要逐条复述清单。`
  summarizeCtx.value = { prompt, context }
  showSummarize.value = true
  void summarizeAi.run(prompt, context)
}
function retrySummarize() {
  if (!summarizeCtx.value) return
  void summarizeAi.run(summarizeCtx.value.prompt, summarizeCtx.value.context)
}
function closeSummarize() {
  summarizeAi.reset()
  showSummarize.value = false
}
function aiOrganize() {
  // 两个卡互斥：开一个关另一个
  showSummarize.value = false
  summarizeAi.reset()
  showOrganizeFlow.value = true
}
/** 整理采纳执行成功：关闭卡片 + 刷新收藏/合集树/标签 */
async function onOrganizeApplied() {
  await Promise.all([reloadFavorites(), collections.loadCollections(), loadTags()])
}
watch(drawerItem, (v) => setKeyboardLayer('modal', !!v))
onUnmounted(() => setKeyboardLayer('modal', false))

// 剪贴板全局刷新（WS/轮询）会用非收藏列表整体替换 clip.items，
// 停留在收藏页时列表会被瞬间清空 —— 检测到这种清空就自动重拉收藏，无需手动切页
let favReloading = false
watch(
  () => clip.items.value,
  async (items) => {
    if (favReloading) return
    if (favTotal.value > 0 && items.length > 0 && !items.some((i) => (i as any).isFavorite)) {
      favReloading = true
      try {
        favPage.value = 1
        favHasMore.value = true
        await clip.loadClipboardItems({ favorite: true, page: 1, limit: FAV_PAGE_SIZE })
        favTotal.value = clip.totalItems.value
      } finally {
        setTimeout(() => (favReloading = false), 800)
      }
    }
  },
)
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
  // 收藏分页：滚到底自动加载下一页（B10）
  nextTick(() => {
    const root = favContentRef.value
    const target = favSentinelRef.value
    if (!root || !target || typeof IntersectionObserver === 'undefined') return
    favObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) loadMoreFavorites()
      },
      { root, rootMargin: '160px' },
    )
    favObserver.observe(target)
  })
})

onUnmounted(() => {
  favObserver?.disconnect()
  favObserver = null
  document.removeEventListener('mousedown', handleClickOutside)
})

function cancelEditTags() {
  editingTagsItemId.value = null
  tagInputValue.value = ''
}
</script>

<style src="./favorites-view.css" scoped></style>

<style scoped>
/* 收藏分页加载区（B10）：样式独立成块，不侵入共有的 favorites-view.css */
.fav-load-more {
  display: flex;
  justify-content: center;
  padding: 16px 0 24px;
}
/* A2：页内内联 AI 结果区（总结卡 / 整理流程卡）纵向排布 */
.fav-ai-zone {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 10px 0 2px;
}
</style>

<template>
  <div class="fav-page">
    <!-- Left: Collection tree panel -->
      <div class="fav-page-wrap">
    <!-- v2 原型页头：标题 + 副题 + AI 整理收藏（管理控制台关闭 AI 时隐藏） -->
    <div class="page-head">
      <div>
        <div class="page-eyebrow">Favorite Collections</div>
        <div class="page-title page-title--big">{{ t('nav_favorites') }}</div>
        <div class="page-sub">{{ tf('page_sub_fav', '树形合集归档 + 全局标签体系 · 把常用片段沉淀为可复用资产') }}</div>
      </div>
      <div class="page-acts">
        <button v-if="props.aiEnabled" type="button" class="pl-btn" @click="aiOrganize">
          <Sparkles :size="14" /><span>{{ tf('fav_ai_organize', 'AI 整理收藏') }}</span>
        </button>
      </div>
    </div>

    <!-- 原型 v1 统计卡（真实数据） -->
    <div class="fav-stats">
      <div class="clip-stat">
        <span class="clip-stat-k"><Star :size="12" />{{ tf('fav_stat_total', '收藏总数') }}</span>
        <span class="clip-stat-v">{{ favoriteCount }}<em>{{ tf('stats_unit_tiao', '条') }}</em></span>
        <span class="clip-stat-d">{{ tf('fav_stat_total_sub', '跨 {n} 个合集', { n: collections.flatCollections.value.length }) }}</span>
      </div>
      <div class="clip-stat">
        <span class="clip-stat-k"><History :size="12" />{{ tf('fav_stat_month', '本月新增') }}</span>
        <span class="clip-stat-v">{{ monthNewCount }}<em>{{ tf('stats_unit_tiao', '条') }}</em></span>
        <span class="clip-stat-d">{{ tf('fav_stat_month_sub', '按收藏时间统计') }}</span>
      </div>
      <div class="clip-stat">
        <span class="clip-stat-k"><Tag :size="12" />{{ tf('fav_stat_tags', '标签') }}</span>
        <span class="clip-stat-v">{{ allTags.length }}<em>{{ tf('stats_unit_ge', '个') }}</em></span>
        <span class="clip-stat-d">{{ tf('fav_stat_tags_sub', '全局标签体系') }}</span>
      </div>
      <div class="clip-stat">
        <span class="clip-stat-k"><Wifi :size="12" />{{ tf('stats_devices', '在线设备') }}</span>
        <span class="clip-stat-v">{{ onlineDeviceCount }}<em>{{ tf('stats_unit_tai', '台') }}</em></span>
        <span class="clip-stat-d">{{ tf('stats_dev_sub', '端到端加密 · 实时同步') }}</span>
      </div>
    </div>
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
          @click="openColModal('create')"
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
          <!-- 原型：悬停显示 新建子级 / 重命名 / 删除 -->
          <span class="fav-tree-acts">
            <button class="fav-tree-act" :title="t('fav_new_col')" @click.stop="openColModal('create', { parentId: node.id })">
              <Plus :size="12" />
            </button>
            <button
              class="fav-tree-act"
              :title="t('rename_btn', '重命名')"
              @click.stop="openColModal('rename', { id: node.id, name: node.name, icon: node.icon })"
            >
              <Pencil :size="12" />
            </button>
            <button class="fav-tree-act" :title="t('delete')" @click.stop="handleDeleteCollection(node.id)">
              <Trash2 :size="12" />
            </button>
          </span>
          <!-- 原型子级灰色竖向引导线 -->
          <span
            v-if="node.depth > 2"
            class="fav-tree-guide"
            :style="{ left: Math.max(0, (node.depth - 3) * 16) + 21 + 'px' }"
          />
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
          <div class="fav-search">
            <Search :size="14" class="fav-search-icon" />
            <input v-model="searchInput" class="fav-search-input" :placeholder="tf('fav_search_ph', '搜索收藏内容…')" />
          </div>
          <button v-if="props.aiEnabled" type="button" class="pl-btn" @click="aiSummarizeCollection">
            <Sparkles :size="14" /><span>{{ tf('fav_ai_summarize_col', '总结这个合集') }}</span>
          </button>
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

      <!-- Row 2: Tag filters -->
      <div class="fav-tag-bar">
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
          <span class="fav-tag-dot" :style="{ background: tagDotColor(tag.name) }" />{{ tag.name }}
        </button>
        <span class="fav-tag-grow" />
        <button class="fav-manage-tags-btn" @click="manageTagsOpen = true">
          <Tag :size="12" /><span>{{ t('fav_manage_tags', '管理标签') }}</span>
        </button>
      </div>

      <!-- 原型「管理标签」弹窗：色块(点按改色) + 名称 + 使用次数 + 删除 + 完成 -->
      <Teleport to="body">
        <div v-if="manageTagsOpen" class="fav-modal-mask" @click.self="manageTagsOpen = false">
          <div class="fav-modal fav-modal--tags">
            <div class="fav-modal-head">
              <span>{{ t('fav_manage_tags', '管理标签') }}</span>
              <button class="fav-modal-close" @click="manageTagsOpen = false"><X :size="14" /></button>
            </div>
            <div class="fav-modal-body">
              <div class="fav-modal-sub">{{ tf('fav_manage_tags_sub', '标签是全局的实体，可挂在任意收藏条目上；颜色修改即时生效') }}</div>
              <div v-if="allTags.length === 0" class="fav-manage-empty">{{ t('fav_tags_empty', '暂无标签') }}</div>
              <div v-for="tag in allTags" :key="tag.name" class="fav-manage-row">
                <label
                  class="fav-manage-swatch"
                  :style="{ background: tagDotColor(tag.name) }"
                  :title="tf('fav_tag_color_edit', '修改颜色')"
                >
                  <input
                    type="color"
                    :value="tagDotColor(tag.name)"
                    @change="recolorTag(tag.name, ($event.target as HTMLInputElement).value)"
                  />
                </label>
                <input
                  v-if="renamingTag === tag.name"
                  v-model="renameTagValue"
                  class="fav-modal-input fav-manage-rename"
                  maxlength="50"
                  @keydown.enter="saveTagRename(tag.name)"
                  @keydown.esc="renamingTag = null"
                  @blur="saveTagRename(tag.name)"
                />
                <template v-else>
                  <span class="fav-manage-name">{{ tag.name }}</span>
                  <span class="fav-manage-count">{{ tf('fav_tag_usage_n', '{n} 处使用', { n: tagUsage(tag.name) }) }}</span>
                </template>
                <button
                  v-if="renamingTag !== tag.name"
                  class="fav-manage-del"
                  :title="tf('rename_btn', '重命名')"
                  @click="startTagRename(tag.name)"
                >
                  <Pencil :size="13" />
                </button>
                <button class="fav-manage-del" :title="t('delete')" @click="removeTag(tag.name)">
                  <Trash2 :size="13" />
                </button>
              </div>
              <div class="fav-manage-create">
                <span class="fav-manage-swatch fav-manage-swatch--new" :title="tf('fav_tag_color_new', '新标签颜色')">
                  <input v-model="newTagColor" type="color" />
                </span>
                <input
                  v-model="newTagName"
                  class="fav-modal-input fav-manage-rename"
                  :placeholder="tf('tag_new_ph', '输入标签名，例如：灵感')"
                  maxlength="50"
                  @keydown.enter="createTagPreset"
                />
                <button
                  type="button"
                  class="pl-btn pl-btn--sm pl-btn--acc"
                  :disabled="isSavingTag || !newTagName.trim()"
                  @click="createTagPreset"
                >
                  {{ tf('tag_create_btn', '新建') }}
                </button>
              </div>
            </div>
            <div class="fav-modal-foot">
              <button class="fav-modal-btn" @click="manageTagsOpen = false">{{ tf('fav_done_btn', '完成') }}</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 原型「新建/重命名收藏夹」弹窗：名称 + 自定义图标（不选 = 默认文件夹） -->
      <Teleport to="body">
        <div v-if="colModal" class="fav-modal-mask" @click.self="colModal = null">
          <div class="fav-modal fav-modal--col">
            <div class="fav-modal-head">
              <span>{{ colModal.mode === 'create' ? t('fav_new_col') : tf('fav_rename_col', '重命名收藏夹') }}</span>
              <button class="fav-modal-close" @click="colModal = null"><X :size="14" /></button>
            </div>
            <div class="fav-modal-body">
              <div class="fav-modal-sub">
                {{
                  colModal.mode === 'create'
                    ? tf('fav_col_create_sub', '收藏夹会出现在左侧树中，可拖拽整理层级')
                    : tf('fav_col_rename_sub', '修改名称或图标；不选图标则使用默认文件夹')
                }}
              </div>
              <div class="fav-modal-label">{{ tf('col_name_label', '名称') }}</div>
              <input
                v-model="colModal.name"
                class="fav-modal-input"
                :placeholder="t('fav_new_col_placeholder')"
                maxlength="100"
                @keydown.enter="saveColModal"
                @keydown.esc="colModal = null"
              />
              <div class="fav-modal-label">{{ tf('col_icon_label', '图标') }}</div>
              <div class="fav-modal-icons">
                <button
                  v-for="ic in ICON_CHOICES"
                  :key="ic"
                  :class="['fav-modal-icon', { active: colModal.icon === ic }]"
                  :title="ic === 'folder' ? tf('fav_col_default_icon', '默认文件夹') : ''"
                  @click="colModal.icon = ic"
                >
                  <component :is="COLLECTION_ICON_MAP[ic] || Folder" :size="15" />
                </button>
              </div>
            </div>
            <div class="fav-modal-foot">
              <button class="fav-modal-btn" @click="colModal = null">{{ t('cancel_btn') }}</button>
              <button
                class="fav-modal-btn fav-modal-btn--acc"
                :disabled="isCreatingCollection || !colModal.name.trim()"
                @click="saveColModal"
              >
                {{ isCreatingCollection ? tf('saving_btn', '保存中…') : t('save_btn') }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 原型 favWhere：当前位置提示行 -->
      <div class="fav-where">{{ favWhere }}</div>

      <!-- A2：页内内联 AI 结果区（列表上方）：总结卡 / 整理流程卡 -->
      <div v-if="showSummarize || showOrganizeFlow" class="fav-ai-zone">
        <InlineAiCard
          v-if="showSummarize"
          :title="tf('fav_ai_summarize_col', '总结这个合集')"
          :status="summarizeAi.status.value"
          :text="summarizeAi.text.value"
          :error="summarizeAi.error.value"
          closable
          @close="closeSummarize"
          @retry="retrySummarize"
        />
        <FavOrganizeFlow
          v-if="showOrganizeFlow"
          :items="favoriteItems"
          @close="showOrganizeFlow = false"
          @applied="onOrganizeApplied"
        />
      </div>

      <!-- Content -->
      <div ref="favContentRef" class="fav-content">
        <!-- Skeleton loading -->
        <div v-if="collections.loading.value || clip.loading.value" class="fav-skeleton">
          <div v-if="viewMode === 'grid'" class="fav-skeleton-grid">
            <div v-for="i in 8" :key="i" class="fav-skeleton-card" />
          </div>
          <div v-else class="fav-skeleton-list">
            <div v-for="i in 5" :key="i" class="fav-skeleton-row" />
          </div>
        </div>
        <!-- Load failed: 与真空态区分，提供重试入口 -->
        <div v-else-if="loadError && favoriteItems.length === 0" class="fav-empty">
          <div class="fav-empty-icon fav-empty-icon-error"><AlertTriangle :size="48" :stroke-width="1.2" /></div>
          <h3 class="fav-empty-title">{{ t('load_failed_title') }}</h3>
          <p class="fav-empty-desc">{{ t('load_failed_desc') }}</p>
          <Button variant="outline" size="sm" class="fav-retry-btn" @click="reloadFavorites">
            <RefreshCw :size="14" /> {{ t('retry_btn') }}
          </Button>
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
        <!-- 原型 favorites.html：单列 .clip-item 行（扁平、无分组头），保留标签编辑/拖拽/批量能力 -->
        <div v-else-if="viewMode === 'list'" class="fav-clip-list">
          <div
            v-for="item in favoriteItems"
            :key="item.id"
            class="clip-item fav-clip-item"
            :class="{
              'fav-item--editing-tags': editingTagsItemId === item.id,
              'fav-list-item--dropdown-open': addToColItemId === item.id,
              selected: batchMode && selectedIds.has(item.id),
            }"
            :draggable="!batchMode"
            @click="onFavRowClick(item)"
            @dragstart="onDragStart($event, item)"
            @dragover="onDragOver"
            @drop="onDrop($event, item)"
            @dragend="onDragEnd"
          >
            <div v-if="batchMode" class="fav-list-check">
              <Checkbox :model-value="selectedIds.has(item.id)" @update:model-value="() => toggleSelect(item.id)" />
            </div>

            <div class="type-tile" :class="favTileClass(item)">
              <ImageIcon v-if="item.type === 'image'" :size="16" />
              <FileText v-else-if="item.type === 'file'" :size="16" />
              <ExternalLink v-else-if="favBadgeClass(item) === 'b-link'" :size="16" />
              <Code2 v-else-if="favBadgeClass(item) === 'b-code'" :size="16" />
              <ClipboardList v-else :size="16" />
            </div>

            <div class="clip-body">
              <!-- 原型：未解锁敏感内容用黑点掩码，动作列眼睛图标解锁 -->
              <div class="clip-text" :class="{ code: isItemViewable(item) && favBadgeClass(item) === 'b-code' }">
                {{ isItemViewable(item) ? formatContent(item) : '••••••••••••' }}
              </div>
              <div class="clip-meta">
                <span class="badge" :class="favBadgeClass(item)">{{ favBadgeLabel(item) }}</span>
                <span>{{ item.source || 'Desktop' }}</span>
                <span class="mono">{{ timeAgo((item as any).favoritedAt || item.timestamp) }}</span>
                <span v-if="(item as any).metadata?.sensitive" class="badge b-gray fav-sensitive-badge">
                  <Lock :size="10" />{{ t('fav_sensitive') }}
                </span>
                <template v-if="editingTagsItemId !== item.id">
                  <span
                    v-for="tag in getTags(item)"
                    :key="tag"
                    class="tag-pill"
                    :style="tagColorStyle(tag, _tagColorMap)"
                    >{{ tag }}</span
                  >
                  <button class="fav-tag-add-btn" :title="t('tag_edit_hint')" @click.stop="startEditTags(item)">
                    <Tag :size="12" />
                  </button>
                </template>
              </div>
              <!-- 打标签浮层：只勾选已有全局标签（新建/改色一律走「管理标签」） -->
              <div v-if="editingTagsItemId === item.id" class="fav-tag-pop" @click.stop>
                <div v-if="allTags.length === 0" class="fav-tag-pop-empty">{{ tf('fav_tag_pop_empty', '暂无全局标签，请先在「管理标签」中新建') }}</div>
                <div v-else class="fav-tag-pop-chips">
                  <button
                    v-for="suggestTag in allTags"
                    :key="suggestTag.name"
                    :class="['fav-tag-suggest', 'fav-tag-suggest--lg', { 'fav-tag-suggest--active': getTags(item).includes(suggestTag.name) }]"
                    :style="tagColorStyle(suggestTag.name, _tagColorMap)"
                    @click.stop="toggleItemTag(item, suggestTag.name)"
                  >
                    <Check
                      v-if="getTags(item).includes(suggestTag.name)"
                      :size="11"
                      class="fav-tag-suggest-check"
                    />
                    <span>{{ suggestTag.name }}</span>
                  </button>
                </div>
              </div>
            </div>

            <div v-if="!batchMode" class="clip-acts">
              <button
                v-if="!isItemViewable(item)"
                type="button"
                class="pl-icon-btn"
                :title="t('fav_unlock_peek', '解锁查看')"
                @click.stop="openProtectionDialog(item)"
              >
                <Eye :size="14" />
              </button>
              <button type="button" class="pl-icon-btn" :title="t('copy')" @click.stop="onCopyItem(item)">
                <Copy :size="14" />
              </button>
              <button
                type="button"
                class="pl-icon-btn"
                :title="t('fav_ai_prefix', '处理这条收藏')"
                @click.stop="onDrawerAi(t('fav_ai_prefix', '处理这条收藏'), item)"
              >
                <Sparkles :size="14" />
              </button>
              <div v-if="collections.flatCollections.value.length > 0" class="fav-add-col-wrap">
                <button
                  type="button"
                  class="pl-icon-btn"
                  :title="t('fav_add_to_col')"
                  @click.stop="toggleAddToCol(item.id, $event)"
                >
                  <FolderPlus :size="14" />
                </button>
                <!-- Teleport 到 body：滚动容器顶部/底部都无法再裁剪层级树 -->
                <Teleport to="body">
                  <div
                    v-if="addToColItemId === item.id"
                    class="fav-pop-backdrop"
                    @mousedown.stop
                    @click.stop="addToColItemId = null"
                  />
                  <div
                    v-if="addToColItemId === item.id"
                    class="fav-add-col-dropdown fav-add-col-dropdown--fixed"
                    :style="{ top: addToColPos.top + 'px', left: addToColPos.left + 'px' }"
                    @mousedown.stop
                    @click.stop
                  >
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
                </Teleport>
              </div>
              <button type="button" class="pl-icon-btn fav-unfav-btn" :title="t('unfavorite')" @click.stop="handleUnfavorite(item)">
                <Star :size="14" fill="currentColor" />
              </button>
            </div>
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
                <!-- 卡头：类型 tile + 来源 + 时间（悬浮操作条盖在右上） -->
                <div class="fav-card-head">
                  <div class="fav-card-tile" :class="favTileClass(item)">
                    <component :is="favTileIcon(item)" :size="13" />
                  </div>
                  <span class="fav-card-source">{{ item.source || 'Desktop' }}</span>
                  <span class="fav-card-head-right">
                    <button
                      v-if="(item as any).metadata?.sensitive || (itemPw.isItemProtected(item) && !itemPw.isUnlocked(item.id))"
                      type="button"
                      class="fav-card-lock-chip"
                      :class="{ 'pw-locked': itemPw.isItemProtected(item) && !itemPw.isUnlocked(item.id) }"
                      :title="getProtectionTitle(item)"
                      @click.stop="openProtectionDialog(item)"
                    >
                      <Lock :size="11" />
                    </button>
                    <span class="fav-card-time">{{ timeAgo((item as any).favoritedAt || item.timestamp) }}</span>
                  </span>
                </div>
                <!-- 内容区：图片=媒体块；受保护=解锁条；其余=排版预览 -->
                <div class="fav-card-body" :class="{ 'fav-card-body--media': item.type === 'image' }">
                  <template v-if="item.type === 'image'">
                    <img
                      v-if="item.preview && item.preview !== 'loading'"
                      :src="item.preview"
                      alt=""
                      class="fav-card-media-img"
                    />
                    <div v-else class="fav-card-placeholder"><ImageIcon :size="22" /></div>
                  </template>
                  <div v-else-if="!isItemViewable(item)" class="cell-protected-mask">
                    <Lock :size="13" />
                    <span>{{ t('item_protected_mask') }}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      class="h-7 px-3 text-[11px] rounded-md"
                      @click.stop="openProtectionDialog(item)"
                      >{{ t('item_unlock') }}</Button
                    >
                  </div>
                  <div
                    v-else-if="item.type === 'link' || detectContentType(item.content) === 'url'"
                    class="fav-card-text fav-card-link"
                  >
                    <span class="fav-card-link-url">{{ item.content }}</span>
                    <span class="fav-card-link-domain">{{ extractDomain(item.content) }}</span>
                  </div>
                  <div v-else-if="item.type === 'file'" class="fav-card-text fav-card-file">
                    <FileText :size="16" /><span>{{ formatContent(item) }}</span>
                  </div>
                  <div v-else class="fav-card-text">{{ formatContent(item) }}</div>
                </div>
                <!-- 打标签：只勾选已有全局标签（新建/改色一律走「管理标签」） -->
                <div v-if="editingTagsItemId === item.id" class="fav-tag-pop" @click.stop>
                  <div v-if="allTags.length === 0" class="fav-tag-pop-empty">{{ tf('fav_tag_pop_empty', '暂无全局标签，请先在「管理标签」中新建') }}</div>
                  <div v-else class="fav-tag-pop-chips">
                    <button
                      v-for="suggestTag in allTags"
                      :key="suggestTag.name"
                      :class="['fav-tag-suggest', 'fav-tag-suggest--lg', { 'fav-tag-suggest--active': getTags(item).includes(suggestTag.name) }]"
                      :style="tagColorStyle(suggestTag.name, _tagColorMap)"
                      @click.stop="toggleItemTag(item, suggestTag.name)"
                    >
                      <Check
                        v-if="getTags(item).includes(suggestTag.name)"
                        :size="11"
                        class="fav-tag-suggest-check"
                      />
                      <span>{{ suggestTag.name }}</span>
                    </button>
                  </div>
                </div>
                <div v-if="!batchMode" class="fav-card-actions">
                  <Button variant="ghost" size="icon-sm" :title="t('copy')" @click.stop="onCopyItem(item)"
                    ><Copy :size="14"
                  /></Button>
                  <!-- 打标签入口：悬浮面板见下方 fav-tag-pop -->
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    :title="t('tag_edit_hint')"
                    @click.stop="toggleEditTags(item)"
                    ><Tag :size="14"
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
                      @click.stop="toggleAddToCol(item.id, $event)"
                      ><FolderPlus :size="14"
                    /></Button>
                    <Teleport to="body">
                      <div
                        v-if="addToColItemId === item.id"
                        class="fav-pop-backdrop"
                        @mousedown.stop
                        @click.stop="addToColItemId = null"
                      />
                      <div
                        v-if="addToColItemId === item.id"
                        class="fav-add-col-dropdown fav-add-col-dropdown--fixed"
                        :style="{ top: addToColPos.top + 'px', left: addToColPos.left + 'px' }"
                        @mousedown.stop
                        @click.stop
                      >
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
                    </Teleport>
                  </div>
                  <Button variant="ghost" size="icon-sm" class="fav-unfav-btn" @click.stop="handleUnfavorite(item)"
                    ><Star :size="14" fill="currentColor"
                  /></Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 收藏分页哨兵（B10）：滚动进入视口自动加载下一页；
             同时本身是个可点按钮，IntersectionObserver 不可用时仍能手动加载 -->
        <div v-if="favHasMore && favoriteItems.length > 0" ref="favSentinelRef" class="fav-load-more">
          <Button variant="outline" size="sm" :disabled="favLoadingMore" @click="loadMoreFavorites">
            <span v-if="favLoadingMore">{{ t('loading_more') }}</span>
            <span v-else>{{ t('load_more') }}</span>
          </Button>
        </div>
      </div>
    </div>
    </div><!-- /fav-page-wrap -->
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
