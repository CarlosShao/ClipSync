<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useClipboard } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import * as tauri from '@/lib/tauri'
import { Search, X } from 'lucide-vue-next'
import Input from '@/components/ui/input/Input.vue'

const { t } = useI18n()
const clip = useClipboard()

const qpSearch = ref('')
const qpSelectedIndex = ref(0)

// Start clipboard polling when mounted
let stopPolling: (() => void) | null = null
onMounted(() => {
  stopPolling = clip.startPolling(2000)
  // Auto-focus search input after a tick (wait for DOM)
  setTimeout(() => {
    const el = document.querySelector('.qp-search-input') as HTMLInputElement | null
    el?.focus()
    el?.select()
  }, 100)
})
onUnmounted(() => {
  if (stopPolling) stopPolling()
})

// Expose activation hook — called by Rust via eval when window is shown
;(window as any).__qpActivate = () => {
  clip.refresh()
  qpSearch.value = ''
  qpSelectedIndex.value = 0
  setTimeout(() => {
    const el = document.querySelector('.qp-search-input') as HTMLInputElement | null
    el?.focus()
    el?.select()
  }, 50)
}

const filteredItems = computed(() => {
  let result = clip.items.value
  if (qpSearch.value.trim()) {
    const q = qpSearch.value.toLowerCase()
    result = result.filter(i => i.content.toLowerCase().includes(q))
  }
  return result.slice(0, 10)
})

function selectItem(item: any) {
  clip.copyItem(item)
  // Auto-close popup after copying
  window.close() // closes the Tauri webview window
}

function closePopup() {
  window.close()
}

function handleKeydown(e: KeyboardEvent) {
  const list = filteredItems.value
  if (e.key === 'ArrowDown') { e.preventDefault(); qpSelectedIndex.value = Math.min(qpSelectedIndex.value + 1, list.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); qpSelectedIndex.value = Math.max(qpSelectedIndex.value - 1, 0) }
  else if (e.key === 'Enter' && list[qpSelectedIndex.value]) { selectItem(list[qpSelectedIndex.value]) }
  else if (e.key === 'Escape') { closePopup() }
}

// Global keydown listener (this is the only view in the window)
onMounted(() => { document.addEventListener('keydown', handleKeydown) })
onUnmounted(() => { document.removeEventListener('keydown', handleKeydown); delete (window as any).__qpActivate })

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return t('just_now')
  if (diff < 3600000) return Math.floor(diff / 60000) + t('m_ago')
  if (diff < 86400000) return Math.floor(diff / 3600000) + t('h_ago')
  return Math.floor(diff / 86400000) + t('d_ago')
}
function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str
}
</script>

<template>
  <div class="qp-standalone" tabindex="-1" @keydown="handleKeydown">
    <div class="qp-panel">
      <!-- Draggable title bar area -->
      <div class="qp-titlebar" data-tauri-drag-region>
        <span class="qp-titlebar-label">ClipSync</span>
        <button class="qp-titlebar-close" @click="closePopup" :title="t('close')">
          <X :size="14" />
        </button>
      </div>
      <div class="qp-search">
        <Search :size="16" style="color:var(--text-tertiary);flex-shrink:0" />
        <Input v-model="qpSearch" type="text" :placeholder="t('search_ph')" class="qp-search-input" />
      </div>
      <div class="qp-list">
        <div v-for="(item, idx) in filteredItems" :key="item.id"
          :class="['qp-item', { sel: idx === qpSelectedIndex }]"
          @click="selectItem(item)" @mouseenter="qpSelectedIndex = idx">
          <span class="qp-type-indicator">{{ item.type === 'image' ? '\u{1F5BC}' : item.type === 'file' ? '\u{1F4C4}' : '\u{1F4CB}' }}</span>
          <span class="qp-text">{{ truncate(item.content, 60) }}</span>
          <span class="qp-time">{{ timeAgo(item.timestamp) }}</span>
        </div>
        <div v-if="filteredItems.length === 0" class="qp-empty">
          <span style="font-size:13px;color:var(--text-tertiary)">{{ t('empty_title') }}</span>
        </div>
      </div>
      <div class="qp-footer">
        <span class="qp-count">{{ filteredItems.length }} {{ t('items_c') }}</span>
        <span class="kbd-pair"><kbd>↑↓</kbd> {{ t('qp_navigate') }}</span>
        <span class="kbd-pair"><kbd>↵</kbd> {{ t('qp_paste') }}</span>
        <span class="kbd-pair"><kbd>ESC</kbd> {{ t('qp_close') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.qp-standalone {
  width: 100vw; height: 100vh;
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 6vh;
  background: transparent;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.qp-panel {
  width: 580px; max-width: 92vw;
  background: var(--bg-surface, #fff);
  border: 1px solid var(--border-default, #e0e0e0);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.2), 0 2px 8px rgba(0,0,0,0.1);
  overflow: hidden;
  display: flex; flex-direction: column;
}
/* Title bar (draggable) */
.qp-titlebar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px;
  background: var(--bg-hover, #f5f5f5);
  border-bottom: 1px solid var(--border-subtle, #eee);
  cursor: default;
  -webkit-user-select: none; user-select: none;
}
.qp-titlebar-label {
  font-size: 12px; font-weight: 600; color: var(--text-secondary, #888);
  letter-spacing: 0.02em;
}
.qp-titlebar-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 6px;
  border: none; background: transparent;
  color: var(--text-tertiary, #aaa); cursor: pointer;
}
.qp-titlebar-close:hover { background: var(--bg-active, #e8e8e8); color: var(--text-primary, #333); }

/* Search */
.qp-search { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border-default, #e0e0e0); }
.qp-search-input { flex: 1; border: none; outline: none; background: transparent; font-size: 14px; font-family: inherit; color: var(--text-primary, #333); }
.qp-search-input::placeholder { color: var(--text-tertiary, #aaa); }

/* List */
.qp-list { max-height: 300px; overflow-y: auto; }
.qp-item { display: flex; align-items: center; gap: 10px; padding: 9px 16px; cursor: pointer; transition: background .1s; }
.qp-item:hover, .qp-item.sel { background: var(--bg-selected, rgba(99,102,241,.08)); }
.qp-type-indicator { flex-shrink: 0; font-size: 16px; }
.qp-text { flex: 1; font-size: 13px; color: var(--text-primary, #333); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qp-time { font-size: 11px; color: var(--text-tertiary, #999); flex-shrink: 0; }
.qp-empty { padding: 28px 24px; text-align: center; }

/* Footer */
.qp-footer { display: flex; align-items: center; gap: 14px; padding: 8px 16px; border-top: 1px solid var(--border-default, #e0e0e0); font-size: 11px; color: var(--text-tertiary, #999); }
.qp-count { margin-right: auto; font-weight: 500; color: var(--text-secondary, #666); }
.kbd-pair { display: flex; align-items: center; gap: 4px; }
.qp-footer kbd { font-size: 10px; background: var(--bg-hover, #f5f5f5); border: 1px solid var(--border-default, #ddd); border-radius: 3px; padding: 1px 5px; font-family: 'SF Mono', Monaco, Consolas, monospace; }
</style>
