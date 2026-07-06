<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import { useToast } from '@/composables/useToast'

const emit = defineEmits<{
  'toggle-quick-paste': []
  'toggle-theme': []
  'preview-image': [item: ClipItem]
  'preview-text': [item: ClipItem]
}>()

const { t } = useI18n()
const toast = useToast()
const clip = useClipboard()
// 本地变量帮助 TS 正确推断类型（模板中 Vue 会自动解包 ref）
const filteredItems = clip.filteredItems
const allItems = clip.items
const activeFilter = clip.activeFilter
const selectedCount = clip.selectedCount

const searchOpen = ref(false)
const searchInput = ref('')
const showQuickPaste = ref(false)
const showConfirmModal = ref(false)
const confirmMessage = ref('')
let confirmCallback: (() => void) | null = null

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
  showConfirm(t('confirm_batch_delete', { n: clip.selectedCount.value }), async () => {
    await clip.batchDelete()
    toast.show(t('batch_deleted', { n: clip.selectedCount.value }), 'success')
  })
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
        <button class="btn btn-ghost btn-sm" @click="emit('toggle-theme')" :title="t('mode_dark')">
          🌙
        </button>
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
      <button :class="['btn-icon', { active: clip.batchMode }]" @click="clip.toggleBatch" :title="t('batch_select')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
        </svg>
      </button>
      <button v-if="clip.batchMode && selectedCount > 0" class="btn-icon" style="color:var(--danger)" @click="handleBatchDelete">
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
          <button class="btn btn-ghost btn-sm" @click="cancelConfirm">{{ t('cancel') }}</button>
          <button class="btn btn-primary btn-sm" @click="confirmAction">{{ t('confirm') }}</button>
        </div>
      </div>
    </div>

    <!-- Clipboard Table -->
    <div class="clipboard-view">
      <table v-if="filteredItems.length > 0" class="clip-table">
        <colgroup>
          <col v-if="clip.batchMode" class="col-cb" />
          <col class="col-content" />
          <col class="col-source" />
          <col class="col-type" />
          <col class="col-time" />
          <col class="col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th v-if="clip.batchMode"><input type="checkbox" class="batch-cb" @change="clip.toggleSelectAll()" /></th>
            <th>{{ t('head_content') }}</th>
            <th>{{ t('head_source') }}</th>
            <th>{{ t('head_type') }}</th>
            <th>{{ t('head_time') }}</th>
            <th>{{ t('head_actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredItems" :key="item.id"
            :class="{ 'batch-selected': item.selected, 'with-cb': clip.batchMode }"
            @dblclick="clip.copyItem(item)">
            <td v-if="clip.batchMode"><input type="checkbox" class="batch-cb" v-model="item.selected" /></td>
            <td class="cell-content" :title="item.content">
              <div class="cell-content-inner">
                <span v-if="item.type === 'image'" class="cell-img-preview">
                  <img :src="item.preview || item.content" alt="" class="cell-thumb" />
                </span>
                <span v-else class="cell-text">{{ truncate(item.content, 80) }}</span>
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
              <button v-if="item.type === 'image'" class="btn-icon btn-icon-sm" @click="emit('preview-image', item)" :title="t('preview')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
                </svg>
              </button>
              <button v-else class="btn-icon btn-icon-sm" @click="emit('preview-text', item)" :title="t('preview')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
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
.cell-actions { display: flex; align-items: center; gap: 2px; }
.btn-icon-sm { width: 26px; height: 26px; }
.btn-icon-sm:hover { background: var(--bg-hover); border-radius: var(--radius-sm); }

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
