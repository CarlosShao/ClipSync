// === 收藏气泡 + 集合选择（模块级单例）===
// 表格行的星标按钮与右键菜单的收藏项共享此状态：
// 行内 FavoriteStarCell 渲染气泡，右键菜单动作也走同一 handleFavorite。
import { ref, computed, nextTick } from 'vue'
import {
  Star, Bookmark, Archive, Trash2, Heart, Zap, Shield, Globe, Code2, Music, Video, Settings, Palette,
  Folder, FolderOpen, FolderPlus, FolderX, FolderSearch, FolderInput, FolderOutput, FolderSync,
  Image as ImageIcon, FileText,
} from 'lucide-vue-next'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { getFavoriteCollections, addCollectionItem, createFavoriteCollection } from '@/api/client'

const { t } = useI18n()
const toast = useSonner()

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

export interface CollectionTreeNode {
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
  const clip = useClipboard()
  if (item.isFavorite) {
    clip.toggleFavorite(item)
    addToColItemId.value = null
    dismissFavPopover()
    // 取消收藏后立即刷新收藏夹计数，保证左侧数字实时同步
    loadCollections()
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

// Click outside to close "add to collection" dropdown (item stays favorited in default area)
function handleDocClickForCollections(e: MouseEvent) {
  if (addToColItemId.value) {
    const target = e.target as HTMLElement
    if (!target.closest('.add-col-wrap')) {
      addToColItemId.value = null
      toast.show(t('clip_favorited'), 'info')
    }
  }
}

export function useFavoritePopover() {
  return {
    collections,
    addToColItemId,
    collectionIconMap,
    collectionTreeNodes,
    favPopoverItemId,
    favPopoverFlipped,
    favNewName,
    showFavNewInput,
    loadCollections,
    showFavPopover,
    dismissFavPopover,
    onFavPopoverEnter,
    onFavPopoverLeave,
    pickCollection,
    createAndMove,
    toggleAddToCol,
    addToCollection,
    handleFavorite,
    handleDocClickForCollections,
  }
}
