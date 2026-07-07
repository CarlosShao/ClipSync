<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import { useToast } from '@/composables/useToast'
import * as tauri from '@/lib/tauri'
import { useConfigStore } from '@/stores/configStore'
import {
  Upload, Plus, Search, SquareCheck, Trash2, Copy, Image as ImageIcon,
  ExternalLink, FileText, Folder, ClipboardList,
} from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Checkbox from '@/components/ui/checkbox/Checkbox.vue'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'

const emit = defineEmits<{
  'toggle-quick-paste': []
  'preview-image': [item: ClipItem]
  'preview-text': [item: ClipItem]
}>()

const { t } = useI18n()
const toast = useToast()
const clip = useClipboard()
const configStore = useConfigStore()
// 本地变量帮助 TS 正确推断类型（模板中 Vue 会自动解包 ref）
const filteredItems = clip.filteredItems
const allItems = clip.items
const activeFilter = clip.activeFilter
const selectedCount = clip.selectedCount

// batchMode 用本地 ref 控制，避免 composable 返回的 ref 在模板中解包问题
const batchMode = ref(false)
// allSelected 用本地 computed，同理避免 ref 解包问题
const allSelected = computed(() => clip.allSelected.value)

// 同步本地 batchMode 和 composable 的 batchMode
function toggleBatchMode() {
  batchMode.value = !batchMode.value
  clip.toggleBatch()
  if (!batchMode.value) clip.clearSelection()
}

const searchOpen = ref(false)
const searchInput = ref('')
const showQuickPaste = ref(false)
const showConfirmModal = ref(false)
const confirmMessage = ref('')
let confirmCallback: (() => void) | null = null

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
  // 确保 batchMode 初始为 false
  batchMode.value = false
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

function revealFileFolder(item: ClipItem) {
  try {
    const data = JSON.parse(item.content)
    // 新格式：{ name, size, type, path } — 使用 path 字段
    if (data.path && typeof data.path === 'string' && data.path.length > 0) {
      tauri.revealInFolder(data.path).catch(() => {
        // fallback：打开所在目录
        const dir = data.path.replace(/[/\\][^/\\]+$/, '')
        tauri.openUrl(dir).catch(() => toast.show('无法打开文件夹', 'error'))
      })
      return
    }
    // 旧格式/兼容：路径数组
    if (Array.isArray(data) && data.length > 0) {
      tauri.revealInFolder(data[0]).catch(() => {
        const dir = data[0].replace(/[/\\][^/\\]+$/, '')
        tauri.openUrl(dir).catch(() => toast.show('无法打开文件夹', 'error'))
      })
      return
    }
    // 从其他设备同步的文件，本地无路径
    if (data.name) {
      toast.show(`"${data.name}" ${t('file_remote_no_path')}`, 'info')
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

function handleSearchBlur() {
  if (!searchInput.value) searchOpen.value = false
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
  if (item.type === 'file') {
    try {
      const parsed = JSON.parse(item.content)
      if (Array.isArray(parsed) && parsed.length > 0) {
        // 旧格式：路径数组 → 提取文件名
        return parsed.map((p: string) => p.split(/[/\\]/).pop() || p).join(', ')
      }
      if (parsed && typeof parsed === 'object' && parsed.name) {
        // 新上传格式：{name, size, type} → 显示文件名
        return String(parsed.name)
      }
    } catch { /* 解析失败，显示原始内容 */ }
  }
  return truncate(item.content, 80)
}
function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str
}
</script>

<template>
  <!-- Clipboard View -->
  <div class="clipboard-page">
    <!-- Toolbar -->
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="toolbar-title">{{ t('nav_clipboard') }}</span>
        <span class="toolbar-count">{{ filteredItems.length }} {{ t('items_c') }}</span>
      </div>
      <div class="toolbar-spacer" />
      <div class="toolbar-right">
        <Button variant="ghost" size="sm" @click="triggerFileUpload">
          <Upload :size="14" />
          <span style="margin-left:4px;">{{ t('upload_file') }}</span>
        </Button>
        <input ref="fileInputRef" type="file" style="display:none" multiple @change="handleFileUpload" />
        <Button variant="ghost" size="sm" @click="toggleQuickPaste">
          <Plus :size="14" />
          <span style="margin-left:4px;">{{ t('new_clip') }}</span>
        </Button>
      </div>
    </div>

    <!-- Tab bar -->
    <div class="tab-bar">
      <Button :variant="activeFilter === 'all' ? 'default' : 'ghost'" size="sm" @click="clip.setFilter('all')">{{ t('tab_all') }}</Button>
      <Button :variant="activeFilter === 'text' ? 'default' : 'ghost'" size="sm" @click="clip.setFilter('text')">{{ t('tab_text') }}</Button>
      <Button :variant="activeFilter === 'images' ? 'default' : 'ghost'" size="sm" @click="clip.setFilter('images')">{{ t('tab_images') }}</Button>
      <Button :variant="activeFilter === 'links' ? 'default' : 'ghost'" size="sm" @click="clip.setFilter('links')">{{ t('tab_links') }}</Button>
      <Button :variant="activeFilter === 'files' ? 'default' : 'ghost'" size="sm" @click="clip.setFilter('files')">{{ t('tab_files') }}</Button>
      <div class="tab-spacer" />
      <div class="search-wrap" :class="{ open: searchOpen }">
        <Button v-if="!searchOpen" variant="ghost" size="icon" class="btn-icon" @click="searchOpen = true">
          <Search :size="14" />
        </Button>
        <Input v-else v-model="searchInput" type="text" :placeholder="t('search_ph')" class="search-input"
          @blur="handleSearchBlur" @input="clip.setSearch(searchInput)" />
      </div>
      <Button :class="['btn-icon', { active: batchMode }]" variant="ghost" size="icon" @click="toggleBatchMode" :title="t('batch_select')">
        <SquareCheck :size="14" />
      </Button>
      <Button v-if="batchMode && selectedCount > 0" variant="ghost" size="icon" class="btn-icon text-destructive" style="color:var(--danger)" @click="handleBatchDelete">
        <Trash2 :size="14" />
        <span style="margin-left:2px;font-size:11px;">{{ selectedCount }}</span>
      </Button>
    </div>

    <!-- Confirm Modal -->
    <div v-if="showConfirmModal" class="confirm-modal-overlay" @click.self="cancelConfirm">
      <div class="confirm-modal">
        <p class="confirm-msg">{{ confirmMessage }}</p>
        <div class="confirm-actions">
          <Button variant="ghost" size="sm" @click="cancelConfirm">{{ t('cancel_btn') }}</Button>
          <Button size="sm" @click="confirmAction">{{ t('confirm_t') }}</Button>
        </div>
      </div>
    </div>

    <!-- Clipboard Table (shadcn-vue Table) -->
    <div class="clipboard-view">
      <Table v-if="filteredItems.length > 0" class="clip-table">
        <TableHeader>
          <TableRow>
            <TableHead v-if="batchMode" class="w-12">
              <Checkbox :model-value="allSelected" @update:model-value="() => clip.toggleSelectAll()" />
            </TableHead>
            <TableHead>{{ t('head_content') }}</TableHead>
            <TableHead class="w-[160px]">{{ t('head_source') }}</TableHead>
            <TableHead class="w-[64px]">{{ t('head_type') }}</TableHead>
            <TableHead class="w-[90px]">{{ t('head_time') }}</TableHead>
            <TableHead class="w-[120px] text-right">{{ t('head_actions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow
            v-for="item in filteredItems"
            :key="item.id"
            :class="{ 'batch-selected': item.selected }"
            @dblclick="clip.copyItem(item)"
          >
            <TableCell v-if="batchMode">
              <Checkbox :model-value="item.selected" @update:model-value="(v: boolean | string) => (item.selected = v === true)" />
            </TableCell>
            <TableCell class="cell-content" :title="item.content">
              <div class="cell-content-inner">
                <span v-if="item.type === 'image'" class="cell-img-preview">
                  <img :src="item.preview || item.content" alt="" class="cell-thumb" />
                </span>
                <span v-else class="cell-text">{{ formatContent(item) }}</span>
              </div>
            </TableCell>
            <TableCell class="cell-source">{{ item.source || 'Desktop' }}</TableCell>
            <TableCell><span class="type-badge">{{ getTypeLabel(item.type) }}</span></TableCell>
            <TableCell class="cell-time">{{ timeAgo(item.timestamp) }}</TableCell>
            <TableCell>
              <div class="cell-actions">
                <Button variant="ghost" size="icon-sm" class="btn-action-hide" @click="clip.copyItem(item)" :title="t('copy')">
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
                <Button v-if="item.type === 'file'" variant="ghost" size="icon-sm" class="btn-action-hide" @click="revealFileFolder(item)" :title="'在文件夹中显示'">
                  <Folder :size="14" />
                </Button>
                <Button variant="ghost" size="icon-sm" class="btn-action-hide" style="color:var(--danger)" @click="handleSingleDelete(item)" :title="t('delete')">
                  <Trash2 :size="14" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <!-- Empty State -->
      <div v-else class="empty-state">
        <div class="empty-icon-wrap">
          <ClipboardList :size="48" style="color:var(--text-tertiary)" />
        </div>
        <h3 class="empty-title">{{ t('empty_title') }}</h3>
        <p class="empty-desc">{{ t('empty_desc') }}</p>
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
.toolbar { display: flex; align-items: center; gap: 8px; height: 48px; padding: 0 16px; border-bottom: 1px solid var(--border-default); background: var(--bg-surface); flex-shrink: 0; }
.toolbar-left { display: flex; align-items: center; gap: 8px; }
.toolbar-title { font-weight: 600; font-size: 14px; }
.toolbar-count { font-size: 12px; color: var(--text-secondary); }
.toolbar-spacer { flex: 1; }
.toolbar-right { display: flex; align-items: center; gap: 4px; }

/* ===== TAB BAR ===== */
.tab-bar { display: flex; align-items: center; gap: 2px; padding: 6px 14px 0; flex-shrink: 0; }
.tab-spacer { flex: 1; }
.search-wrap { display: flex; align-items: center; gap: 4px; }
.search-input {
  width: 160px; height: 28px; padding: 0 8px;
  border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  font-size: 12px; background: var(--bg-surface); color: var(--text-primary);
  outline: none; transition: width 0.25s ease, padding 0.25s ease, border-color 0.25s ease;
} 
.search-input:focus { border-color: var(--border-focus); }

/* ===== CLIPBOARD TABLE (shadcn-vue Table) ===== */
.clipboard-view { flex: 1; overflow-y: auto; }
/* Override default shadcn table styles for our layout needs */
.clip-table :where(th, td) { padding: 10px 14px; }
.clip-table .batch-selected { background: var(--accent-light) !important; }
.cell-content { overflow: hidden; }
.cell-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
.cell-img-preview { display: flex; align-items: center; gap: 8px; }
.cell-thumb { width: 48px; height: 32px; object-fit: cover; border-radius: 4px; }
.cell-source { color: var(--text-secondary); }
.type-badge { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--text-tertiary); background: var(--bg-hover); padding: 2px 6px; border-radius: 4px; transition: transform 0.15s; }
.type-badge:hover { transform: scale(1.06); }
.cell-time { color: var(--text-tertiary); font-size: 12px; }
.cell-actions { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.cell-actions .btn-action-hide { opacity: 0; transition: opacity 0.15s; }
.clip-table tbody tr:hover .cell-actions .btn-action-hide { opacity: 1; }

/* ===== EMPTY STATE ===== */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 80px 20px; text-align: center; }
.empty-icon-wrap { width: 64px; height: 64px; border-radius: 16px; background: var(--bg-hover); display: flex; align-items: center; justify-content: center; margin-bottom: 16px; }
.empty-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.empty-desc { font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.empty-action { font-size: 13px; color: var(--accent); margin-top: 12px; font-weight: 500; }

/* ===== CONFIRM MODAL ===== */
.confirm-modal-overlay {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-modal-overlay);
}
.confirm-modal {
  background: var(--bg-surface); border: 1px solid var(--border-default);
  border-radius: var(--radius-lg); padding: 24px; max-width: 400px;
  box-shadow: var(--shadow-modal);
}
.confirm-msg { font-size: 14px; margin-bottom: 20px; color: var(--text-primary); }
.confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* Icon-only toolbar buttons (shadcn Button size=icon) */
.btn-icon { color: var(--text-secondary); }
.btn-icon.active { color: var(--accent); background: var(--accent-light); }
</style>
