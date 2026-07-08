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
  // Clear content immediately to prevent Windows ghost outline, then close
  document.body.style.background = 'transparent'
  document.body.innerHTML = ''
  setTimeout(() => { window.close() }, 10)
}

function closePopup() {
  // Clear content immediately to prevent Windows ghost outline
  document.body.style.background = 'transparent'
  document.body.innerHTML = ''
  setTimeout(() => { window.close() }, 10)
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
  padding-top: 8vh;
  background: transparent;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}
.qp-panel {
  width: 560px; max-width: 92vw;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-dropdown);
  overflow: hidden;
  display: flex; flex-direction: column;
  /* Smooth appear animation */
  animation: qp-slide-in .18s ease-out;
}
@keyframes qp-slide-in {
  from { opacity: 0; transform: translateY(-8px) scale(.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* Title bar (draggable) */
.qp-titlebar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 14px;
  height: 36px;
  background: var(--bg-hover);
  border-bottom: 1px solid var(--border-subtle);
  cursor: default;
  -webkit-user-select: none; user-select: none;
  flex-shrink: 0;
}
.qp-titlebar-label {
  font-size: 11px; font-weight: 700; color: var(--text-tertiary);
  letter-spacing: .06em; text-transform: uppercase;
}
.qp-titlebar-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: var(--radius-xs);
  border: none; background: transparent;
  color: var(--text-tertiary); cursor: pointer;
  transition: background .15s, color .15s;
}
.qp-titlebar-close:hover { background: var(--bg-active); color: var(--text-primary); }

/* Search */
.qp-search { 
  display: flex; align-items: center; gap: 10px; 
  padding: 10px 14px; 
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.qp-search-input { 
  flex: 1; border: none; outline: none; 
  background: transparent; 
  font-size: 13px; font-family: inherit; 
  color: var(--text-primary); 
}
.qp-search-input::placeholder { color: var(--text-tertiary); }

/* List */
.qp-list { 
  max-height: 280px; overflow-y: auto; 
  /* Custom scrollbar */
  scrollbar-width: thin;
  scrollbar-color: var(--border-default) transparent;
}
.qp-list::-webkit-scrollbar { width: 5px; }
.qp-list::-webkit-scrollbar-track { background: transparent; }
.qp-list::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 3px; }

.qp-item { 
  display: flex; align-items: center; gap: 10px; 
  padding: 7px 14px; cursor: pointer; 
  transition: background .1s; 
  border-left: 2px solid transparent;
}
.qp-item:hover { background: var(--bg-hover); }
.qp-item.sel { 
  background: var(--bg-selected); 
  border-left-color: var(--accent);
}
.qp-type-indicator { flex-shrink: 0; font-size: 14px; line-height: 1; width: 20px; text-align: center; }
.qp-text { 
  flex: 1; font-size: 12.5px; 
  color: var(--text-primary); 
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.4;
}
.qp-time { 
  font-size: 10.5px; color: var(--text-tertiary); 
  flex-shrink: 0; font-variant-numeric: tabular-nums;
}
.qp-empty { padding: 24px 20px; text-align: center; }

/* Footer */
.qp-footer { 
  display: flex; align-items: center; gap: 12px; 
  padding: 7px 14px; 
  border-top: 1px solid var(--border-subtle); 
  font-size: 10.5px; color: var(--text-tertiary); 
  flex-shrink: 0;
  background: var(--bg-base);
}
.qp-count { margin-right: auto; font-weight: 600; color: var(--text-secondary); }
.kbd-pair { display: flex; align-items: center; gap: 3px; }
.qp-footer kbd { 
  font-size: 9px; 
  background: var(--bg-surface); 
  border: 1px solid var(--border-default); 
  border-radius: var(--radius-xs); 
  padding: 0 4px; line-height: 1.6;
  font-family: 'SF Mono', SFMono-Regular, 'Cascadia Code', Consolas, monospace; 
  color: var(--text-secondary);
  box-shadow: 0 1px 0 var(--border-subtle);
}

/* Dark mode: slightly adjust for contrast */
:global(html.dark) .qp-panel {
  box-shadow: var(--shadow-dropdown), 0 0 0 1px var(--border-subtle);
}
</style>
