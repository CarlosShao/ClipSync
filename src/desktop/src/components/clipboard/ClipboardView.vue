<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import { useToast } from '@/composables/useToast'
import * as tauri from '@/lib/tauri'
import { useConfigStore } from '@/stores/configStore'
import {
  Upload, Plus, Search, Trash2, Copy, Image as ImageIcon,
  ExternalLink, FileText, Folder, ClipboardList,
} from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Checkbox from '@/components/ui/checkbox/Checkbox.vue'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import Badge from '@/components/ui/badge/Badge.vue'

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

// allSelected 用本地 computed，同理避免 ref 解包问题
const allSelected = computed(() => clip.allSelected.value)

const searchInput = ref('')
const showQuickPaste = ref(false)

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
      // 新格式（uploadFileItem）: { name, size, type, path }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.name) {
        return String(parsed.name)
      }
      // 旧格式/剪贴板监控（readAndUpload）: 路径数组 ["D:\\path\\to\\file"]
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((p: any): string => {
          if (typeof p !== 'string') return String(p)
          // 从完整路径中提取文件名
          return p.split(/[/\\]/).pop() || p
        }).join(', ')
      }
    } catch {
      /* JSON 解析失败，走下面的兜底提取 */
    }
    // 兜底：用正则从原始内容中提取文件名
    // 匹配 "...\filename.ext" 或 [..."\path\to\filename.ext"...]
    const raw = item.content.trim()
    // 尝试匹配 JSON 数组中的路径元素
    const pathMatches = raw.match(/"([^"]*(?:[\\/][^"/\\]+))"/g)
    if (pathMatches && pathMatches.length > 0) {
      return pathMatches.map(m => {
        // 去掉首尾引号后取最后一部分
        const inner = m.slice(1, -1)
        return inner.split(/[/\\]/).pop() || inner
      }).join(', ')
    }
    // 最后兜底：如果内容看起来像路径，直接取文件名部分
    if (raw.includes('\\') || raw.includes('/')) {
      return raw.split(/[/\\]/).pop() || truncate(raw, 60)
    }
  }
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
        <Badge variant="secondary">{{ filteredItems.length }} {{ t('items_c') }}</Badge>
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
        <Input v-model="searchInput" type="text" :placeholder="t('search_ph')" class="search-input" @input="clip.setSearch(searchInput)" />
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
          <Button variant="destructive" size="default" @click="confirmAction" class="confirm-btn-delete">{{ t('confirm_t') }}</Button>
        </div>
      </div>
    </div>

    <!-- Clipboard Table (shadcn-vue Data Table style) -->
    <div class="clipboard-view">
      <div v-if="filteredItems.length > 0" class="table-wrapper">
        <Table>
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
            v-for="item in filteredItems"
            :key="item.id"
            :data-state="item.selected ? 'selected' : undefined"
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
                <Button variant="ghost" size="icon-sm" class="btn-action-hide danger" @click="handleSingleDelete(item)" :title="t('delete')">
                  <Trash2 :size="14" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
        </Table>
      </div>

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
.toolbar { display: flex; align-items: center; gap: 16px; height: 56px; padding: 0 24px; border-bottom: 1px solid var(--border-default); background: var(--bg-surface); flex-shrink: 0; }
.toolbar-left { display: flex; align-items: center; gap: 10px; }
.toolbar-title { font-weight: 600; font-size: 16px; letter-spacing: -0.01em; }
.toolbar-spacer { flex: 1; }
.toolbar-right { display: flex; align-items: center; gap: 10px; }
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
  padding: 5px 16px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
  line-height: 1.4;
}
.segment-btn:hover { color: var(--text-primary); background: var(--bg-active); }
.segment-btn.active {
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
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

.clipboard-view :deep(table) { border-collapse: separate; border-spacing: 0; width: 100%; }
.clipboard-view :deep(thead tr) { border-bottom: 1px solid var(--border-default); }
.clipboard-view :deep(thead th) {
  padding: 10px 16px; text-align: left; font-weight: 500; font-size: 12px;
  color: var(--text-tertiary); background: var(--bg-surface);
  position: sticky; top: 0; z-index: 1;
}
.clipboard-view :deep(tbody tr) { border-bottom: 1px solid var(--border-subtle); transition: background .12s ease; }
.clipboard-view :deep(tbody tr:hover) { background: var(--bg-hover); }
.clipboard-view :deep(tbody tr:last-child) { border-bottom-color: transparent; }
.clipboard-view :deep(tbody td) { padding: 8px 16px; vertical-align: middle; }

/* Cell styles */
.cell-content { overflow: hidden; max-width: 0; }
.cell-content-inner { display: flex; align-items: center; gap: 10px; }

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
</style>
