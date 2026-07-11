<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import { useToast } from '@/composables/useToast'
import * as tauri from '@/lib/tauri'
import { useConfigStore } from '@/stores/configStore'
import {
  Upload, Plus, Search, Trash2, Copy, Image as ImageIcon,
  ExternalLink, FileText, Folder, ClipboardList, Star, FolderPlus,
} from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Checkbox from '@/components/ui/checkbox/Checkbox.vue'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import Badge from '@/components/ui/badge/Badge.vue'
import { getFavoriteCollections, addCollectionItem } from '@/api/client'

const emit = defineEmits<{
  'toggle-quick-paste': []
  'preview-image': [item: ClipItem]
  'preview-text': [item: ClipItem]
  'preview-file': [item: ClipItem]
  'version-history': [item: ClipItem]
}>()

const { t } = useI18n()
const toast = useToast()
const clip = useClipboard()
const configStore = useConfigStore()
const router = useRouter()
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
function onClipboardScroll(e: Event) {
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
    clip.loadMore()
  }
}

// allSelected 用本地 computed，同理避免 ref 解包问题
const allSelected = computed(() => clip.allSelected.value)

const searchInput = ref('')
const showQuickPaste = ref(false)
// Keyboard-focused row index for in-app shortcuts (copyClip / deleteClip / arrow nav)
const focusedIndex = ref(0)

// Collections (for "add to collection" dropdown)
const collections = ref<any[]>([])
const addToColItemId = ref<string | null>(null)

async function loadCollections() {
  const data = await getFavoriteCollections()
  if (data) collections.value = data.collections
}
onMounted(() => { loadCollections() })

function toggleAddToCol(itemId: string) {
  addToColItemId.value = addToColItemId.value === itemId ? null : itemId
}
async function addToCollection(colId: string, itemId: string) {
  const ok = await addCollectionItem(colId, itemId)
  if (ok) toast.show('已添加到收藏夹', 'success')
  addToColItemId.value = null
}

// Star button: favorite + show collection picker (optional)
function handleFavorite(item: ClipItem) {
  if (item.isFavorite) {
    clip.toggleFavorite(item)
    addToColItemId.value = null
  } else {
    clip.toggleFavorite(item)
    if (collections.value.length > 0) {
      addToColItemId.value = item.id
    } else {
      // No collections → local confirm dialog
      confirmMessage.value = '还没有收藏夹，是否现在创建一个？'
      confirmCallback = () => { router.push('/app/favorites') }
      confirmBtnVariant.value = 'default'
      showConfirmModal.value = true
    }
  }
}

// Click outside to close dropdown (item stays favorited in default area)
function handleDocClick(e: MouseEvent) {
  if (addToColItemId.value) {
    const target = e.target as HTMLElement
    if (!target.closest('.add-col-wrap')) {
      addToColItemId.value = null
      toast.show('已收藏，可在「收藏」页面查看', 'info')
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
const showConfirmModal = ref(false)
const confirmMessage = ref('')
let confirmCallback: (() => void) | null = null
const confirmBtnVariant = ref<'default' | 'destructive'>('destructive')

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
function showConfirm(message: string, cb: () => void) {
  confirmMessage.value = message
  confirmCallback = cb
  showConfirmModal.value = true
}

function confirmAction() {
  if (confirmCallback) confirmCallback()
  showConfirmModal.value = false
  confirmCallback = null
}

function cancelConfirm() {
  showConfirmModal.value = false
  confirmCallback = null
}

// ===== Clipboard Operations =====
function handleBatchDelete() {
  if (clip.selectedCount.value === 0) { toast.show(t('batch_none'), 'warning'); return }
  const count = clip.selectedCount.value
  showConfirm(t('confirm_batch_delete', { n: count }), async () => {
    try {
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

/** Check if a file item is a local file (has a local path to reveal/copy).
 *  Shows copy/reveal buttons only for files that exist on the local disk. */
function hasLocalPath(item: ClipItem): boolean {
  try {
    const parsed = JSON.parse(item.content)
    // 路径数组：["D:\\path\\to\\file"] → 本地文件
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') return true
    // 元数据带 paths 字段：{"name":"file.md","paths":["D:\\..."]} → 本地文件（clipboard monitor 上传）
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.paths) && parsed.paths.length > 0) return true
    return false
  } catch { return false }
}

async function revealFileFolder(item: ClipItem) {
  try {
    const data = JSON.parse(item.content)
    // paths 字段：{"name":"file.md","paths":["D:\\..."]} → clipboard monitor 上传
    if (data.paths && Array.isArray(data.paths) && data.paths[0]) {
      tauri.revealInFolder(data.paths[0]).catch(() => {
        const dir = data.paths[0].replace(/[/\\][^/\\]+$/, '')
        tauri.openUrl(dir).catch(() => toast.show('无法打开文件夹', 'error'))
      })
      return
    }
    // path 字段：{"name":"...","path":"D:\\..."}
    if (data.path && typeof data.path === 'string' && data.path.length > 0) {
      tauri.revealInFolder(data.path).catch(() => {
        const dir = data.path.replace(/[/\\][^/\\]+$/, '')
        tauri.openUrl(dir).catch(() => toast.show('无法打开文件夹', 'error'))
      })
      return
    }
    // 路径数组：["D:\\path\\to\\file"]
    if (Array.isArray(data) && data.length > 0) {
      tauri.revealInFolder(data[0]).catch(() => {
        const dir = data[0].replace(/[/\\][^/\\]+$/, '')
        tauri.openUrl(dir).catch(() => toast.show('无法打开文件夹', 'error'))
      })
      return
    }
  } catch { /* ignore */ }
  toast.show('文件路径不可用', 'warning')
}

function handleSingleDelete(item: ClipItem) {
  showConfirm(t('confirm_delete'), async () => {
    try {
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
    if (showConfirmModal.value) { showConfirmModal.value = false; return }
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
  if (typing || showQuickPaste.value || showConfirmModal.value) return

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
    if (item) clip.copyItem(item)
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
  // 文件类型：始终尝试显示文件名
  if (item.type === 'file') {
    try {
      const parsed = JSON.parse(item.content)
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
    const raw = item.content.trim()
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

    // 内容太长（可能是文件内容而非文件名），截断显示
    if (raw.length > 100) return truncate(raw, 80)

    return raw || 'Unknown file'
  }

  // 非文件类型
  return truncate(item.content, 120)
}
function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str
}

// 内容类型检测
function detectContentType(content: string): 'code' | 'url' | 'text' {
  if (!content) return 'text'
  const trimmed = content.trim()
  // URL 检测
  if (/^https?:\/\/\S+$/.test(trimmed)) return 'url'
  // 代码检测：常见代码模式
  if (/[{}\[\]];?\s*$/.test(trimmed) ||
      /\b(function|const|let|var|class|import|export|return|if|for|while|async|await)\s/.test(trimmed) ||
      /^\s*(def |class |import |from |public |private |protected )/.test(trimmed) ||
      /=>\s*[{(]/.test(trimmed) ||
      /^\s*<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>/i.test(trimmed) ||
      /:\s*(string|number|boolean|void|any|null|undefined)\s/.test(trimmed)) {
    return 'code'
  }
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
        <Badge variant="secondary" class="count-badge">{{ filteredItems.length }} / {{ totalItems }} {{ t('items_c') }}</Badge>
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
      <Button v-if="selectedCount > 0" variant="ghost" size="icon-sm" class="batch-del-btn" @click="handleBatchDelete" :title="t('batch_select')">
        <Trash2 :size="15" />
        <span style="margin-left:2px;font-size:11px;">{{ selectedCount }}</span>
      </Button>
    </div>

    <!-- Confirm Modal -->
    <div v-if="showConfirmModal" class="confirm-modal-overlay" @click.self="cancelConfirm">
      <div class="confirm-modal">
        <p class="confirm-msg">{{ confirmMessage }}</p>
        <div class="confirm-actions">
          <Button variant="outline" size="default" @click="cancelConfirm" class="confirm-btn-cancel">{{ t('cancel_btn') }}</Button>
          <Button :variant="confirmBtnVariant" size="default" @click="confirmAction" class="confirm-btn-delete">{{ t('confirm_t') }}</Button>
        </div>
      </div>
    </div>

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
            @dblclick="clip.copyItem(item)"
          >
            <TableCell class="w-12">
              <Checkbox :model-value="item.selected" @update:model-value="(v: boolean | string) => (item.selected = v === true)" />
            </TableCell>
            <TableCell class="cell-content">
              <div class="cell-content-inner">
                <!-- 图片预览 -->
                <span v-if="item.type === 'image'" class="cell-img-preview">
                  <img v-if="item.preview && item.preview !== 'loading'" :src="item.preview" alt="" class="cell-thumb" />
                  <div v-else class="cell-thumb cell-thumb-placeholder">
                    <ImageIcon :size="14" style="opacity:0.4" />
                  </div>
                </span>
                <!-- URL 链接样式 -->
                <span v-else-if="item.type === 'link' || detectContentType(item.content) === 'url'" class="cell-link-preview">
                  <ExternalLink :size="12" class="cell-link-icon" />
                  <span class="cell-link-content">
                    <span class="cell-link-text">{{ item.content }}</span>
                    <span class="cell-link-domain">{{ extractDomain(item.content) }}</span>
                  </span>
                </span>
                <!-- 文件类型（必须在 code/url 检测之前，否则 JSON 路径数组会被误判为 code） -->
                <span v-else-if="item.type === 'file'" class="cell-text">
                  <span v-if="item.id.startsWith('local-') || item.id.startsWith('file-')" class="syncing-label">
                    <span class="syncing-dot" /> {{ formatContent(item) }}
                  </span>
                  <span v-else>{{ formatContent(item) }}</span>
                </span>
                <!-- 代码样式 -->
                <span v-else-if="detectContentType(item.content) === 'code'" class="cell-code-preview">
                  <code>{{ item.content }}</code>
                </span>
                <!-- 普通文本 -->
                <span v-else class="cell-text">{{ formatContent(item) }}</span>
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
                <Button v-if="item.type !== 'file' || hasLocalPath(item)" variant="ghost" size="icon-sm" class="btn-action-hide" @click="clip.copyItem(item)" :title="t('copy')">
                  <Copy :size="14" />
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
                <Button v-if="item.type === 'file' && hasLocalPath(item)" variant="ghost" size="icon-sm" class="btn-action-hide" @click="revealFileFolder(item)" :title="'在文件夹中显示'">
                  <Folder :size="14" />
                </Button>
                <!-- Star: click to favorite + pick collection -->
                <div class="add-col-wrap">
                  <Button variant="ghost" size="icon-sm" class="btn-action-hide" :class="{ 'favorited': item.isFavorite }" @click.stop="handleFavorite(item)" :title="item.isFavorite ? t('unfavorite') : t('favorite')">
                    <Star :size="14" :fill="item.isFavorite ? 'currentColor' : 'none'" />
                  </Button>
                  <div v-if="addToColItemId === item.id" class="add-col-dropdown">
                    <div class="add-col-dropdown-title">收藏到</div>
                    <button v-for="col in collections" :key="col.id" class="add-col-option" @click="addToCollection(col.id, item.id)">
                      {{ col.icon }} {{ col.name }}
                    </button>
                  </div>
                </div>
                <Button variant="ghost" size="icon-sm" class="btn-action-hide danger" @click="handleSingleDelete(item)" :title="t('delete')">
                  <Trash2 :size="14" />
                </Button>
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
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; text-overflow: ellipsis; word-break: break-word;
}

/* 图片预览 */
.cell-img-preview { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.cell-thumb { width: 48px; height: 34px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); }
.cell-thumb-placeholder { width: 48px; height: 34px; display: flex; align-items: center; justify-content: center; background: var(--bg-hover); border-radius: var(--radius-sm); }

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
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
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

/* ===== CONFIRM MODAL ===== */
.confirm-modal-overlay {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-modal-overlay);
  animation: fadeIn 0.15s ease;
}
.confirm-modal {
  background: var(--bg-surface); border: 1px solid var(--border-default);
  border-radius: var(--radius-xl); padding: 28px; max-width: 400px; width: 100%;
  box-shadow: var(--shadow-modal);
  animation: slideUp 0.2s ease;
}
.confirm-msg { font-size: 14px; margin-bottom: 28px; color: var(--text-primary); line-height: 1.6; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }
.confirm-btn-cancel { min-width: 80px; }
.confirm-btn-delete { min-width: 80px; }

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

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
  display: block; width: 100%; padding: 6px 10px; border: none; background: none;
  text-align: left; font-size: 12px; color: var(--text-primary); cursor: pointer;
  border-radius: var(--radius-sm); white-space: nowrap;
}
.add-col-option:hover { background: var(--bg-hover); }
.add-col-dropdown-title {
  padding: 4px 10px 2px; font-size: 11px; color: var(--text-tertiary);
  border-bottom: 1px solid var(--border-subtle); margin-bottom: 2px;
}
</style>
