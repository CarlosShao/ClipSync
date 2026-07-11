<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import { useToast } from '@/composables/useToast'
import {
  Star, Search, Copy, Image as ImageIcon, LayoutGrid, List,
  ExternalLink, FileText, Folder, ArrowUpDown, CheckSquare, Square,
  Plus, X, Tag, ClipboardList, FolderPlus, ChevronRight,
} from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import Badge from '@/components/ui/badge/Badge.vue'
import Checkbox from '@/components/ui/checkbox/Checkbox.vue'
import {
  getFavoriteCollections, createFavoriteCollection, deleteFavoriteCollection,
  addCollectionItem, removeCollectionItem, setItemTags, getAllFavoriteTags,
} from '@/api/client'

const emit = defineEmits<{
  'preview-image': [item: ClipItem]
  'preview-text': [item: ClipItem]
  'preview-file': [item: ClipItem]
}>()

const { t } = useI18n()
const toast = useToast()
const clip = useClipboard()
const router = useRouter()

// --- State ---
const searchInput = ref('')
const sortBy = ref<'time' | 'type'>('time')
const sortAsc = ref(false)
const batchMode = ref(false)
const selectedIds = ref<Set<string>>(new Set())
const viewMode = ref<'grid' | 'list'>('grid')
const collapsedGroups = ref<Set<string>>(new Set())

function toggleGroup(key: string) {
  if (collapsedGroups.value.has(key)) collapsedGroups.value.delete(key)
  else collapsedGroups.value.add(key)
  // Force reactivity
  collapsedGroups.value = new Set(collapsedGroups.value)
}

// Collections
const collections = ref<any[]>([])
const activeCollectionId = ref<string | null>(null)
const showNewCollectionInput = ref(false)
const newCollectionName = ref('')
const newCollectionIcon = ref('📁')

// Tags
const allTags = ref<string[]>([])
const activeTagFilter = ref<string | null>(null)
const editingTagsItemId = ref<string | null>(null)
const tagInputValue = ref('')

// Add to collection dropdown
const addToColItemId = ref<string | null>(null)

// Drag & drop (local reorder only within favorites)
const dragItemId = ref<string | null>(null)
const localOrder = ref<string[]>([]) // local reorder state

// --- Load ---
async function loadCollections() {
  const data = await getFavoriteCollections()
  if (data) collections.value = data.collections
}
async function loadTags() {
  allTags.value = await getAllFavoriteTags()
}
onMounted(() => { loadCollections(); loadTags() })
watch(() => clip.items.value.filter(i => (i as any).isFavorite).length, () => {
  loadCollections(); loadTags()
})

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
const groupLabels: Record<string, string> = { text: '文本', code: '代码', link: '链接', image: '图片', file: '文件' }
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
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`
  return `${Math.floor(diff / 86_400_000)}天前`
}
function getTypeLabel(type: string): string {
  const m: Record<string, string> = { text: 'TXT', image: 'IMG', link: 'URL', file: 'FILE', code: 'CODE' }
  return m[type] || type.toUpperCase()
}
function formatContent(item: ClipItem): string {
  if (item.type === 'image') return '截图'
  if (item.type === 'file') {
    try {
      const meta = JSON.parse(item.content)
      if (meta.name) return meta.name
      if (meta.paths && meta.paths[0]) return meta.paths[0].split(/[/\\]/).pop() || '文件'
    } catch { /* */ }
    return item.content?.split(/[/\\]/).pop() || item.content || '文件'
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
async function copyItem(item: ClipItem) { await clip.copyItem(item); toast.success(t('copied')) }
function handleUnfavorite(item: ClipItem) { clip.toggleFavorite(item); selectedIds.value.delete(item.id); toast.info(t('unfavorite')) }
function toggleSort() {
  if (sortBy.value === 'time') sortBy.value = 'type'
  else { sortBy.value = 'time'; sortAsc.value = !sortAsc.value }
  localOrder.value = [] // reset local reorder on sort change
}
function sortLabel(): string {
  if (sortBy.value === 'time') return sortAsc.value ? '时间 ↑' : '时间 ↓'
  return '类型'
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
  toast.info(`已取消 ${selectedIds.value.size} 项收藏`)
  selectedIds.value.clear(); batchMode.value = false
}

// --- Collections ---
async function handleCreateCollection() {
  if (!newCollectionName.value.trim()) return
  const data = await createFavoriteCollection(newCollectionName.value.trim(), newCollectionIcon.value)
  if (data?.collection) {
    collections.value.push(data.collection)
    newCollectionName.value = ''; newCollectionIcon.value = '📁'; showNewCollectionInput.value = false
    toast.success('收藏夹已创建')
  } else {
    toast.error('创建失败')
  }
}
async function handleDeleteCollection(id: string) {
  await deleteFavoriteCollection(id)
  collections.value = collections.value.filter(c => c.id !== id)
  if (activeCollectionId.value === id) activeCollectionId.value = null
  toast.info('收藏夹已删除')
}
function selectCollection(id: string | null) { activeCollectionId.value = id }

// Add item to collection
function toggleAddToCol(itemId: string) {
  addToColItemId.value = addToColItemId.value === itemId ? null : itemId
}
async function addToCollection(colId: string, itemId: string) {
  const ok = await addCollectionItem(colId, itemId)
  if (ok) toast.success('已加入收藏夹')
  addToColItemId.value = null
}

// --- Tags ---
async function startEditTags(item: ClipItem) {
  editingTagsItemId.value = item.id
  tagInputValue.value = getTags(item).join(', ')
  await nextTick()
}
async function saveTags(item: ClipItem) {
  const tags = tagInputValue.value.split(/[,，]/).map(t => t.trim()).filter(Boolean)
  await setItemTags(item.id, tags)
  const target = clip.items.value.find(i => i.id === item.id)
  if (target) { const meta = parseMetadata(target); meta.tags = tags; (target as any).metadata = meta }
  editingTagsItemId.value = null; loadTags(); toast.success('标签已保存')
}
function cancelEditTags() { editingTagsItemId.value = null; tagInputValue.value = '' }

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

// Close dropdown on click outside
function handleClickOutside(e: Event) {
  if (addToColItemId.value) {
    const target = e.target as HTMLElement
    if (!target.closest('.fav-add-col-wrap')) addToColItemId.value = null
  }
}
onMounted(() => document.addEventListener('click', handleClickOutside))
</script>

<template>
  <div class="fav-page">
    <!-- Header: title + search -->
    <div class="fav-header">
      <div class="fav-header-left">
        <Star :size="20" :stroke-width="2" class="fav-header-icon" />
        <h2 class="fav-title">收藏</h2>
        <Badge variant="outline" class="fav-count">{{ favoriteCount }}</Badge>
      </div>
      <div class="fav-header-right">
        <div class="fav-search">
          <Search :size="14" class="fav-search-icon" />
          <input v-model="searchInput" class="fav-search-input" placeholder="搜索收藏..." />
        </div>
      </div>
    </div>

    <!-- Tags + Actions row -->
    <div class="fav-toolbar">
      <div class="fav-toolbar-left">
        <button v-if="allTags.length > 0" :class="['fav-tag-pill', { active: !activeTagFilter }]" @click="activeTagFilter = null">全部</button>
        <button v-for="tag in allTags" :key="tag" :class="['fav-tag-pill', { active: activeTagFilter === tag }]" @click="activeTagFilter = activeTagFilter === tag ? null : tag">
          <Tag :size="10" />{{ tag }}
        </button>
      </div>
      <div class="fav-toolbar-right">
        <Button variant="ghost" size="sm" class="fav-action-btn" @click="toggleSort">
          <ArrowUpDown :size="14" /><span>{{ sortLabel() }}</span>
        </Button>
        <Button v-if="favoriteItems.length > 0" variant="ghost" size="sm" class="fav-action-btn" :class="{ 'fav-active': batchMode }" @click="toggleBatchMode">
          <CheckSquare v-if="batchMode" :size="14" /><Square v-else :size="14" /><span>{{ batchMode ? '退出' : '批量' }}</span>
        </Button>
        <template v-if="batchMode && selectedCount > 0">
          <span class="fav-batch-count">已选 {{ selectedCount }}</span>
          <Button variant="ghost" size="sm" class="fav-action-btn fav-unfav-btn" @click="batchUnfavorite">
            <Star :size="14" fill="currentColor" /><span>取消收藏</span>
          </Button>
        </template>
        <!-- View toggle: after batch -->
        <div class="fav-view-toggle">
          <button :class="['fav-view-btn', { active: viewMode === 'grid' }]" @click="viewMode = 'grid'" title="网格"><LayoutGrid :size="14" /></button>
          <button :class="['fav-view-btn', { active: viewMode === 'list' }]" @click="viewMode = 'list'" title="列表"><List :size="14" /></button>
        </div>
      </div>
    </div>

    <!-- Collection tabs -->
    <div class="fav-collection-bar">
      <button :class="['fav-col-tab', { active: !activeCollectionId }]" @click="selectCollection(null)">全部收藏</button>
      <button v-for="col in collections" :key="col.id" :class="['fav-col-tab', { active: activeCollectionId === col.id }]" @click="selectCollection(col.id)">
        {{ col.icon }} {{ col.name }}
        <span class="fav-col-count">{{ col.item_count }}</span>
        <button class="fav-col-del" @click.stop="handleDeleteCollection(col.id)" title="删除">×</button>
      </button>
      <!-- New collection -->
      <template v-if="!showNewCollectionInput">
        <button class="fav-col-new-btn" @click="showNewCollectionInput = true">
          <Plus :size="12" /> 新建收藏夹
        </button>
      </template>
      <template v-else>
        <div class="fav-col-new">
          <input v-model="newCollectionName" class="fav-col-name-input" placeholder="收藏夹名称" maxlength="100"
            @keydown.enter="handleCreateCollection" @keydown.esc="showNewCollectionInput = false" />
          <button class="fav-col-confirm-btn" @click="handleCreateCollection">✅ 确认</button>
          <button class="fav-col-cancel-btn" @click="showNewCollectionInput = false">❌ 取消</button>
        </div>
      </template>
    </div>

    <!-- Content -->
    <div class="fav-content">
      <!-- Empty -->
      <div v-if="favoriteItems.length === 0 && !searchInput" class="fav-empty">
        <div class="fav-empty-icon"><Star :size="48" :stroke-width="1.2" /></div>
        <h3 class="fav-empty-title">还没有收藏</h3>
        <p class="fav-empty-desc">在剪贴板中点击星标按钮，将重要内容添加到收藏</p>
        <Button @click="goToClipboard"><ClipboardList :size="14" /> 去剪贴板看看</Button>
      </div>
      <div v-else-if="favoriteItems.length === 0 && searchInput" class="fav-empty">
        <div class="fav-empty-icon"><Search :size="48" :stroke-width="1.2" /></div>
        <h3 class="fav-empty-title">未找到匹配项</h3>
        <p class="fav-empty-desc">换个关键词试试</p>
      </div>

      <!-- LIST VIEW (grouped) -->
      <div v-else-if="viewMode === 'list'" class="fav-groups">
        <div v-for="gk in sortedGroupKeys" :key="gk" class="fav-group">
          <div class="fav-group-header" @click="toggleGroup(gk)" style="cursor:pointer">
            <ChevronRight :size="14" class="fav-group-chevron" :class="{ 'fav-group-chevron--open': !collapsedGroups.has(gk) }" />
            <Badge variant="outline" class="fav-group-badge" :data-type="gk"><span class="type-dot" />{{ groupLabels[gk] }}</Badge>
            <span class="fav-group-count">{{ groupedItems[gk].length }} 项</span>
            <div class="fav-group-line" />
          </div>
          <template v-if="!collapsedGroups.has(gk)">
          <div v-for="item in groupedItems[gk]" :key="item.id" class="fav-list-item"
            :draggable="!batchMode" @dragstart="onDragStart($event, item)" @dragover="onDragOver" @drop="onDrop($event, item)" @dragend="onDragEnd">
            <div v-if="batchMode" class="fav-list-check"><Checkbox :model-value="selectedIds.has(item.id)" @update:model-value="() => toggleSelect(item.id)" /></div>
            <div class="fav-list-content">
              <div class="fav-list-title">{{ formatContent(item) }}</div>
              <div class="fav-list-meta"><span>{{ item.source || 'Desktop' }}</span><span>·</span><span>{{ timeAgo((item as any).favoritedAt || item.timestamp) }}</span></div>
            </div>
            <!-- Tags -->
            <div class="fav-list-tags">
              <template v-if="editingTagsItemId !== item.id">
                <Badge v-for="tag in getTags(item)" :key="tag" variant="outline" class="fav-tag-badge">{{ tag }}</Badge>
                <button class="fav-tag-add-btn" @click="startEditTags(item)" title="编辑标签"><Tag :size="10" /></button>
              </template>
              <div v-else class="fav-tag-edit" @click.stop>
                <input v-model="tagInputValue" class="fav-tag-input" placeholder="标签1, 标签2" @keydown.enter="saveTags(item)" @keydown.esc="cancelEditTags" />
                <button class="fav-tag-save" @click="saveTags(item)">✓</button>
                <button class="fav-tag-cancel" @click="cancelEditTags"><X :size="12" /></button>
              </div>
            </div>
            <div v-if="!batchMode" class="fav-list-actions">
              <Button variant="ghost" size="icon-sm" @click="copyItem(item)" :title="t('copy')"><Copy :size="14" /></Button>
              <Button v-if="item.type === 'image'" variant="ghost" size="icon-sm" @click="emit('preview-image', item)"><ImageIcon :size="14" /></Button>
              <Button v-else-if="item.type === 'link'" variant="ghost" size="icon-sm" @click="openLink(item)"><ExternalLink :size="14" /></Button>
              <Button v-else-if="item.type === 'text'" variant="ghost" size="icon-sm" @click="emit('preview-text', item)"><FileText :size="14" /></Button>
              <Button v-else-if="item.type === 'file'" variant="ghost" size="icon-sm" @click="emit('preview-file', item)"><FileText :size="14" /></Button>
              <!-- Add to collection dropdown -->
              <div v-if="collections.length > 0" class="fav-add-col-wrap">
                <Button variant="ghost" size="icon-sm" @click.stop="toggleAddToCol(item.id)" title="加入收藏夹"><FolderPlus :size="14" /></Button>
                <div v-if="addToColItemId === item.id" class="fav-add-col-dropdown">
                  <button v-for="col in collections" :key="col.id" class="fav-add-col-option" @click="addToCollection(col.id, item.id)">
                    {{ col.icon }} {{ col.name }}
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
            <span class="fav-group-count">{{ groupedItems[gk].length }} 项</span>
            <div class="fav-group-line" />
          </div>
          <div v-if="!collapsedGroups.has(gk)" class="fav-grid">
            <div v-for="item in groupedItems[gk]" :key="item.id" class="fav-card"
              :class="{ 'fav-card--selected': selectedIds.has(item.id) }"
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
                  <div class="fav-card-text fav-card-link"><ExternalLink :size="14" class="fav-card-link-icon" /><span class="fav-card-link-url">{{ item.content }}</span><span class="fav-card-link-domain">{{ extractDomain(item.content) }}</span></div>
                </template>
                <template v-else-if="item.type === 'file'">
                  <div class="fav-card-text fav-card-file"><FileText :size="20" /><span>{{ formatContent(item) }}</span></div>
                </template>
                <template v-else><div class="fav-card-text">{{ formatContent(item) }}</div></template>
              </div>
              <!-- Tags on card -->
              <div class="fav-card-tags">
                <template v-if="editingTagsItemId !== item.id">
                  <Badge v-for="tag in getTags(item)" :key="tag" variant="outline" class="fav-tag-badge">{{ tag }}</Badge>
                  <button class="fav-tag-add-btn" @click.stop="startEditTags(item)"><Tag :size="10" /></button>
                </template>
                <div v-else class="fav-tag-edit" @click.stop>
                  <input v-model="tagInputValue" class="fav-tag-input" placeholder="标签1, 标签2" @keydown.enter="saveTags(item)" @keydown.esc="cancelEditTags" />
                  <button class="fav-tag-save" @click="saveTags(item)">✓</button>
                  <button class="fav-tag-cancel" @click="cancelEditTags"><X :size="12" /></button>
                </div>
              </div>
              <div class="fav-card-meta">
                <span class="fav-card-source">{{ item.source || 'Desktop' }}</span>
                <span class="fav-card-time">{{ timeAgo((item as any).favoritedAt || item.timestamp) }}</span>
              </div>
              <div v-if="!batchMode" class="fav-card-actions">
                <Button variant="ghost" size="icon-sm" @click.stop="copyItem(item)" :title="t('copy')"><Copy :size="14" /></Button>
                <Button v-if="item.type === 'image'" variant="ghost" size="icon-sm" @click.stop="emit('preview-image', item)"><ImageIcon :size="14" /></Button>
                <Button v-else-if="item.type === 'link'" variant="ghost" size="icon-sm" @click.stop="openLink(item)"><ExternalLink :size="14" /></Button>
                <Button v-else-if="item.type === 'text'" variant="ghost" size="icon-sm" @click.stop="emit('preview-text', item)"><FileText :size="14" /></Button>
                <Button v-else-if="item.type === 'file'" variant="ghost" size="icon-sm" @click.stop="emit('preview-file', item)"><FileText :size="14" /></Button>
                <Button v-if="item.type === 'file' && hasLocalPath(item)" variant="ghost" size="icon-sm" @click.stop="revealFileFolder(item)" title="在文件夹中显示"><Folder :size="14" /></Button>
                <!-- Add to collection -->
                <div v-if="collections.length > 0" class="fav-add-col-wrap">
                  <Button variant="ghost" size="icon-sm" @click.stop="toggleAddToCol(item.id)" title="加入收藏夹"><FolderPlus :size="14" /></Button>
                  <div v-if="addToColItemId === item.id" class="fav-add-col-dropdown">
                    <button v-for="col in collections" :key="col.id" class="fav-add-col-option" @click="addToCollection(col.id, item.id)">
                      {{ col.icon }} {{ col.name }}
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
</template>

<style scoped>
.fav-page { display: flex; flex-direction: column; height: 100%; }

/* Header */
.fav-header { display: flex; align-items: center; justify-content: space-between; height: 56px; padding: 0 24px; background: var(--bg-surface); flex-shrink: 0; border-bottom: 1px solid var(--border-default); }
.fav-header-left { display: flex; align-items: center; gap: 10px; }
.fav-header-right { display: flex; align-items: center; gap: 6px; }
.fav-header-icon { color: var(--warning); }
.fav-title { font-weight: 600; font-size: 16px; }
.fav-count { padding: 2px 10px !important; }

/* Search (in header right) */
.fav-search { position: relative; display: inline-flex; align-items: center; }
.fav-search-icon { position: absolute; left: 10px; color: var(--text-tertiary); pointer-events: none; }
.fav-search-input { width: 200px; height: 34px; padding: 0 12px 0 32px; border: 1px solid var(--border-default); border-radius: var(--radius-md); font-size: 13px; background: var(--bg-surface); color: var(--text-primary); outline: none; transition: border-color 0.15s; }
.fav-search-input:focus { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-light); }

/* Toolbar: tags left, actions right */
.fav-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 24px; border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0; gap: 12px;
}
.fav-toolbar-left { display: flex; align-items: center; gap: 6px; overflow-x: auto; flex: 1; min-width: 0; }
.fav-toolbar-right { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

/* All action buttons: consistent padding */
.fav-action-btn { padding: 0 14px !important; height: 32px !important; }
.fav-active { color: var(--accent) !important; }
.fav-batch-count { font-size: 12px; color: var(--text-tertiary); padding: 0 6px; }
.fav-unfav-btn { color: var(--warning) !important; }

/* View toggle */
.fav-view-toggle { display: inline-flex; background: var(--bg-hover); border-radius: var(--radius-md); padding: 2px; gap: 2px; margin-left: 4px; }
.fav-view-btn { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--text-tertiary); cursor: pointer; transition: all 0.15s; }
.fav-view-btn:hover { color: var(--text-primary); }
.fav-view-btn.active { background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--shadow-card); }

/* Tag pills */
.fav-tag-pill { display: inline-flex; align-items: center; gap: 4px; padding: 4px 12px; border-radius: 9999px; border: 1px solid var(--border-default); background: var(--bg-surface); font-size: 12px; color: var(--text-secondary); cursor: pointer; transition: all 0.15s; white-space: nowrap; flex-shrink: 0; }
.fav-tag-pill:hover { border-color: var(--border-focus); color: var(--text-primary); }
.fav-tag-pill.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); }

/* Collection bar */
.fav-collection-bar { display: flex; align-items: center; gap: 8px; padding: 10px 24px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0; overflow-x: auto; }
.fav-col-tab { display: inline-flex; align-items: center; gap: 4px; padding: 6px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-default); background: var(--bg-surface); font-size: 12px; color: var(--text-secondary); cursor: pointer; transition: all 0.15s; white-space: nowrap; flex-shrink: 0; }
.fav-col-tab:hover { border-color: var(--border-focus); }
.fav-col-tab.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); font-weight: 500; }
.fav-col-count { font-size: 10px; color: var(--text-tertiary); margin-left: 2px; }
.fav-col-del { display: none; border: none; background: none; color: var(--text-tertiary); cursor: pointer; padding: 0 2px; font-size: 14px; }
.fav-col-tab:hover .fav-col-del { display: inline; }
.fav-col-new { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.fav-col-name-input { height: 32px; padding: 0 10px; border: 1px solid var(--border-default); border-radius: var(--radius-md); font-size: 12px; background: var(--bg-surface); color: var(--text-primary); outline: none; width: 140px; }

/* New collection button */
.fav-col-new-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 14px; border-radius: var(--radius-md);
  border: 1px dashed var(--border-default); background: var(--bg-surface);
  font-size: 12px; color: var(--text-secondary); cursor: pointer;
  transition: all 0.15s; white-space: nowrap; flex-shrink: 0;
}
.fav-col-new-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }

/* Confirm / Cancel buttons */
.fav-col-confirm-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 6px 14px; border-radius: var(--radius-md);
  border: none; background: var(--success); color: white;
  font-size: 12px; font-weight: 500; cursor: pointer;
  transition: all 0.15s; white-space: nowrap; flex-shrink: 0;
}
.fav-col-confirm-btn:hover { opacity: 0.9; }
.fav-col-cancel-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 6px 14px; border-radius: var(--radius-md);
  border: 1px solid var(--border-default); background: var(--bg-surface);
  font-size: 12px; color: var(--text-secondary); cursor: pointer;
  transition: all 0.15s; white-space: nowrap; flex-shrink: 0;
}
.fav-col-cancel-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

/* Content */
.fav-content { flex: 1; overflow-y: auto; padding: 16px 24px; }

/* Empty */
.fav-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 12px; }
.fav-empty-icon { color: var(--text-tertiary); opacity: 0.3; }
.fav-empty-title { font-weight: 600; font-size: 16px; color: var(--text-secondary); }
.fav-empty-desc { font-size: 13px; color: var(--text-tertiary); text-align: center; max-width: 300px; }
.fav-empty :deep(button) { padding: 0 20px !important; height: 36px !important; }

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
.fav-list-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: var(--radius-md); transition: background 0.12s; }
.fav-list-item:hover { background: var(--bg-hover); }
.fav-list-item[draggable="true"] { cursor: grab; }
.fav-list-item[draggable="true"]:active { cursor: grabbing; }
.fav-list-check { flex-shrink: 0; }
.fav-list-content { flex: 1; min-width: 0; }
.fav-list-title { font-size: 13px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fav-list-meta { font-size: 11px; color: var(--text-tertiary); display: flex; gap: 6px; margin-top: 2px; }
.fav-list-tags { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.fav-list-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; opacity: 0; transition: opacity 0.12s; }
.fav-list-item:hover .fav-list-actions { opacity: 1; }

/* Grid view */
.fav-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.fav-card { position: relative; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); overflow: hidden; cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s; }
.fav-card:hover { border-color: var(--border-focus); box-shadow: var(--shadow-card); }
.fav-card--selected { border-color: var(--accent); }
.fav-card[draggable="true"]:active { cursor: grabbing; opacity: 0.8; }
.fav-card-check { position: absolute; top: 8px; left: 8px; z-index: 2; background: var(--bg-surface); border-radius: var(--radius-sm); box-shadow: var(--shadow-card); }
.fav-card-preview { position: relative; height: 100px; display: flex; align-items: center; justify-content: center; background: var(--bg-hover); padding: 10px; overflow: hidden; }
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
.fav-card:hover .fav-card-actions { opacity: 1; }

/* Tags */
.fav-tag-badge { font-size: 10px !important; padding: 2px 8px !important; }
.fav-tag-add-btn { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border: 1px dashed var(--border-default); border-radius: var(--radius-sm); background: transparent; color: var(--text-tertiary); cursor: pointer; transition: all 0.12s; flex-shrink: 0; }
.fav-tag-add-btn:hover { border-color: var(--accent); color: var(--accent); }
.fav-tag-edit { display: flex; align-items: center; gap: 4px; }
.fav-tag-input { width: 120px; height: 26px; padding: 0 6px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); font-size: 11px; background: var(--bg-surface); color: var(--text-primary); outline: none; }
.fav-tag-save { border: none; background: var(--success); color: white; border-radius: var(--radius-sm); width: 22px; height: 22px; cursor: pointer; font-size: 11px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
.fav-tag-cancel { border: none; background: none; color: var(--text-tertiary); cursor: pointer; padding: 2px; display: inline-flex; align-items: center; justify-content: center; }

/* Add to collection dropdown */
.fav-add-col-wrap { position: relative; display: inline-flex; }
.fav-add-col-dropdown { position: absolute; top: 100%; right: 0; margin-top: 4px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); box-shadow: var(--shadow-modal); padding: 4px; z-index: 50; min-width: 160px; }
.fav-add-col-option { display: block; width: 100%; padding: 6px 10px; border: none; background: none; text-align: left; font-size: 12px; color: var(--text-primary); cursor: pointer; border-radius: var(--radius-sm); white-space: nowrap; }
.fav-add-col-option:hover { background: var(--bg-hover); }
</style>
