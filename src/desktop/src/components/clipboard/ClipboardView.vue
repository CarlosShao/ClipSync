<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import { useToast } from '@/composables/useToast'
import * as tauri from '@/lib/tauri'
import { useConfigStore } from '@/stores/configStore'

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
      if (plan === 'Pro' || plan === 'pro' || plan === '专业版') return 20 * 1024 * 1024
      if (plan === 'Enterprise' || plan === 'enterprise' || plan === '企业版') return 100 * 1024 * 1024
      return 1 * 1024 * 1024 // Free default: 1MB
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
    await clip.batchDelete()
    toast.show(t('batch_deleted', { n: count }), 'success')
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
    const paths = JSON.parse(item.content)
    if (Array.isArray(paths) && paths.length > 0) {
      // 取第一个路径，在资源管理器中选中显示
      tauri.revealInFolder(paths[0]).catch(() => {
        // fallback：打开所在目录
        const dir = paths[0].replace(/[/\\][^/\\]+$/, '')
        tauri.openUrl(dir).catch(() => toast.show('无法打开文件夹', 'error'))
      })
      return
    }
  } catch { /* ignore */ }
  toast.show('文件路径不可用', 'warning')
}

function handleSingleDelete(item: ClipItem) {
  showConfirm(t('confirm_delete'), async () => {
    await clip.deleteSingle(item)
    toast.show(t('deleted'), 'success')
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
        <button class="btn btn-ghost btn-sm" @click="triggerFileUpload">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span style="margin-left:4px;">{{ t('upload_file') }}</span>
        </button>
        <input ref="fileInputRef" type="file" style="display:none" multiple @change="handleFileUpload" />
        <button class="btn btn-ghost btn-sm" @click="toggleQuickPaste">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="2" width="20" height="20" rx="4"/><path d="M8 12h8M12 8v8"/>
          </svg>
          <span style="margin-left:4px;">{{ t('new_clip') }}</span>
        </button>
      </div>
    </div>

    <!-- Tab bar -->
    <div class="tab-bar">
      <button :class="['tab-btn', { active: activeFilter === 'all' }]" @click="clip.setFilter('all')">{{ t('tab_all') }}</button>
      <button :class="['tab-btn', { active: activeFilter === 'text' }]" @click="clip.setFilter('text')">{{ t('tab_text') }}</button>
      <button :class="['tab-btn', { active: activeFilter === 'images' }]" @click="clip.setFilter('images')">{{ t('tab_images') }}</button>
      <button :class="['tab-btn', { active: activeFilter === 'links' }]" @click="clip.setFilter('links')">{{ t('tab_links') }}</button>
      <button :class="['tab-btn', { active: activeFilter === 'files' }]" @click="clip.setFilter('files')">{{ t('tab_files') }}</button>
      <div class="tab-spacer" />
      <div class="search-wrap" :class="{ open: searchOpen }">
        <button v-if="!searchOpen" class="btn-icon" @click="searchOpen = true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </button>
        <input v-else v-model="searchInput" type="text" :placeholder="t('search_ph')" class="search-input"
          @blur="handleSearchBlur" @input="clip.setSearch(searchInput)" />
      </div>
      <button :class="['btn-icon', { active: batchMode }]" @click="toggleBatchMode" :title="t('batch_select')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
        </svg>
      </button>
      <button v-if="batchMode && selectedCount > 0" class="btn-icon" style="color:var(--danger)" @click="handleBatchDelete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
        </svg>
        <span style="margin-left:2px;font-size:11px;">{{ selectedCount }}</span>
      </button>
    </div>

    <!-- Confirm Modal -->
    <div v-if="showConfirmModal" class="confirm-modal-overlay" @click.self="cancelConfirm">
      <div class="confirm-modal">
        <p class="confirm-msg">{{ confirmMessage }}</p>
        <div class="confirm-actions">
          <button class="btn btn-ghost btn-sm" @click="cancelConfirm">{{ t('cancel_btn') }}</button>
          <button class="btn btn-primary btn-sm" @click="confirmAction">{{ t('confirm_t') }}</button>
        </div>
      </div>
    </div>

    <!-- Clipboard Table -->
    <div class="clipboard-view">
      <table v-if="filteredItems.length > 0" class="clip-table">
        <colgroup>
          <col v-if="batchMode" class="col-cb" />
          <col class="col-content" />
          <col class="col-source" />
          <col class="col-type" />
          <col class="col-time" />
          <col class="col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th v-if="batchMode"><input type="checkbox" class="batch-cb" :checked="allSelected" @change="clip.toggleSelectAll()" /></th>
            <th>{{ t('head_content') }}</th>
            <th>{{ t('head_source') }}</th>
            <th>{{ t('head_type') }}</th>
            <th>{{ t('head_time') }}</th>
            <th>{{ t('head_actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredItems" :key="item.id"
            :class="{ 'batch-selected': item.selected, 'with-cb': batchMode }"
            @dblclick="clip.copyItem(item)">
            <td v-if="batchMode"><input type="checkbox" class="batch-cb" v-model="item.selected" /></td>
            <td class="cell-content" :title="item.content">
              <div class="cell-content-inner">
                <span v-if="item.type === 'image'" class="cell-img-preview">
                  <img :src="item.preview || item.content" alt="" class="cell-thumb" />
                </span>
                <span v-else class="cell-text">{{ formatContent(item) }}</span>
              </div>
            </td>
            <td class="cell-source">{{ item.source || 'Desktop' }}</td>
            <td class="cell-type"><span class="type-badge">{{ getTypeLabel(item.type) }}</span></td>
            <td class="cell-time">{{ timeAgo(item.timestamp) }}</td>
            <td class="cell-actions">
              <button class="btn-icon btn-icon-sm" @click="clip.copyItem(item)" :title="t('copy')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                </svg>
              </button>
              <!-- 图片预览 -->
              <button v-if="item.type === 'image'" class="btn-icon btn-icon-sm" @click="emit('preview-image', item)" :title="t('preview')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
                </svg>
              </button>
              <!-- 链接打开 -->
              <button v-else-if="item.type === 'link'" class="btn-icon btn-icon-sm" @click="openLink(item)" :title="t('link_opened')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </button>
              <!-- 文字详情 -->
              <button v-else-if="item.type === 'text'" class="btn-icon btn-icon-sm" @click="emit('preview-text', item)" :title="t('preview')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
              </button>
              <!-- 文件：在文件夹中显示 -->
              <button v-if="item.type === 'file'" class="btn-icon btn-icon-sm" @click="revealFileFolder(item)" :title="'在文件夹中显示'">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                </svg>
              </button>
              <button class="btn-icon btn-icon-sm" style="color:var(--danger)" @click="handleSingleDelete(item)" :title="t('delete')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                </svg>
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Empty State -->
      <div v-else class="empty-state">
        <div class="empty-icon-wrap">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--text-tertiary)">
            <rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/>
          </svg>
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
.tab-bar { display: flex; align-items: center; gap: 2px; padding: 4px 14px; border-bottom: 1px solid var(--border-subtle); background: var(--bg-base); flex-shrink: 0; }
.tab-btn { padding: 4px 12px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 500; border: none; background: transparent; color: var(--text-tertiary); cursor: pointer; }
.tab-btn:hover { color: var(--text-secondary); background: var(--bg-hover); }
.tab-btn.active { background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--shadow-card); }
.tab-spacer { flex: 1; }
.search-wrap { display: flex; align-items: center; gap: 4px; }
.search-input {
  width: 160px; height: 28px; padding: 0 8px;
  border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  font-size: 12px; background: var(--bg-surface); color: var(--text-primary);
  outline: none; transition: width 0.25s ease, padding 0.25s ease, border-color 0.25s ease;
} 
.search-input:focus { border-color: var(--border-focus); }

/* ===== CLIPBOARD TABLE ===== */
.clipboard-view { flex: 1; overflow-y: auto; }
.clip-table { width: 100%; table-layout: fixed; border-collapse: collapse; }
.clip-table col { padding: 0; }
.col-cb { width: 36px; }
.col-content { width: auto; }
.col-source { width: 160px; }
.col-type { width: 64px; }
.col-time { width: 90px; }
.col-actions { width: 100px; }
.clip-table th { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text-tertiary); padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border-subtle); background: var(--bg-surface); position: sticky; top: 0; z-index: 1; }
.clip-table thead tr th:last-child { text-align: center; }
.clip-table td { padding: 8px 12px; font-size: 13px; border-bottom: 1px solid var(--border-subtle); color: var(--text-primary); }
.clip-table tr:hover td { background: var(--bg-hover); }
.clip-table tr.batch-selected td { background: var(--accent-light); }
.batch-cb { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; }
.cell-content { overflow: hidden; }
.cell-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
.cell-img-preview { display: flex; align-items: center; gap: 8px; }
.cell-thumb { width: 48px; height: 32px; object-fit: cover; border-radius: 4px; }
.cell-source { color: var(--text-secondary); }
.type-badge { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--text-tertiary); background: var(--bg-hover); padding: 2px 6px; border-radius: 4px; transition: transform 0.15s; }
.type-badge:hover { transform: scale(1.06); }
.cell-time { color: var(--text-tertiary); font-size: 12px; }
.cell-actions { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.btn-icon-sm { width: 26px; height: 26px; border-radius: var(--radius-sm); display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; color: var(--text-tertiary); cursor: pointer; opacity: 0.4; transition: all 0.12s ease; }
.btn-icon-sm:hover { opacity: 1; background: var(--bg-hover); color: var(--text-primary); }

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

/* ===== BUTTONS ===== */
.btn { display: inline-flex; align-items: center; justify-content: center; height: 34px; padding: 0 14px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid transparent; transition: all 150ms; white-space: nowrap; }
.btn-primary { background: var(--accent); color: var(--text-inverse); }
.btn-primary:hover { background: var(--accent-hover); }
.btn-ghost { background: transparent; color: var(--text-secondary); border: none; }
.btn-ghost:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-sm { height: 28px; padding: 0 10px; font-size: 12px; }
.btn-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--radius-sm); background: transparent; border: none; color: var(--text-secondary); cursor: pointer; }
.btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-icon.active { color: var(--accent); background: var(--accent-light); }
</style>
