<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useClipboard } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import * as tauri from '@/lib/tauri'
import { Search } from 'lucide-vue-next'

const { t } = useI18n()
const clip = useClipboard()

const qpSearch = ref('')
const qpSelectedIndex = ref(0)
const expanded = ref(false)

// Start clipboard polling when mounted
let stopPolling: (() => void) | null = null
onMounted(() => {
  stopPolling = clip.startPolling(2000)
  // Auto-focus search + trigger drawer expand
  nextTick(() => {
    focusSearch()
    // Small delay so user sees the "pop" then drawer opens
    setTimeout(() => { expanded.value = true }, 80)
  })
})
onUnmounted(() => {
  if (stopPolling) stopPolling()
})

function focusSearch() {
  const el = document.querySelector('.qp-search-input') as HTMLInputElement | null
  el?.focus()
  el?.select()
}

// Expose activation hook — called by Rust via eval when window is shown
;(window as any).__qpActivate = () => {
  clip.refresh()
  qpSearch.value = ''
  qpSelectedIndex.value = 0
  expanded.value = false
  nextTick(() => {
    focusSearch()
    setTimeout(() => { expanded.value = true }, 50)
  })
}

const filteredItems = computed(() => {
  let result = clip.items.value
  if (qpSearch.value.trim()) {
    const q = qpSearch.value.toLowerCase()
    result = result.filter(i => i.content.toLowerCase().includes(q))
  }
  return result.slice(0, 10)
})

async function selectItem(item: any) {
  await collapseAndClose(() => clip.copyItem(item))
}

async function closePopup() {
  await collapseAndClose(() => {})
}

// Collapse animation then close window
async function collapseAndClose(action: () => void) {
  expanded.value = false
  action()
  // Wait for collapse transition (~180ms) before closing window
  await new Promise(r => setTimeout(r, 200))
  window.close()
}

function handleKeydown(e: KeyboardEvent) {
  const list = filteredItems.value
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    qpSelectedIndex.value = Math.min(qpSelectedIndex.value + 1, list.length - 1)
  }
  else if (e.key === 'ArrowUp') {
    e.preventDefault()
    qpSelectedIndex.value = Math.max(qpSelectedIndex.value - 1, 0)
  }
  else if (e.key === 'Enter' && list[qpSelectedIndex.value]) {
    e.preventDefault()
    selectItem(list[qpSelectedIndex.value])
  }
  else if (e.key === 'Escape') {
    e.preventDefault()
    closePopup()
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  delete (window as any).__qpActivate
})

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
  <div class="qp-standalone" tabindex="-1">
    <!-- Floating card: search bar + drawer list, no chrome -->
    <div class="qp-card" :class="{ expanded }" data-tauri-drag-region>
      <!-- Search row (also serves as drag handle) -->
      <div class="qp-search-row" data-tauri-drag-region @mousedown.stop>
        <Search :size="15" class="qp-search-icon" />
        <input
          ref="searchInput"
          v-model="qpSearch"
          type="text"
          :placeholder="t('search_ph')"
          class="qp-search-input"
          @focus="expanded = true"
        />
        <span class="qp-esc-hint">ESC</span>
      </div>

      <!-- Drawer: results list that slides down -->
      <div class="qp-drawer">
        <div class="qp-list">
          <div
            v-for="(item, idx) in filteredItems"
            :key="item.id"
            :class="['qp-item', { sel: idx === qpSelectedIndex }]"
            @click="selectItem(item)"
            @mouseenter="qpSelectedIndex = idx"
          >
            <span class="qp-type-icon">
              {{ item.type === 'image' ? '\u{1F5BC}' : item.type === 'file' ? '\u{1F4C4}' : '\u{1F4CB}' }}
            </span>
            <span class="qp-text">{{ truncate(item.content, 60) }}</span>
            <span class="qp-time">{{ timeAgo(item.timestamp) }}</span>
          </div>
          <div v-if="filteredItems.length === 0" class="qp-empty">
            {{ t('empty_title') }}
          </div>
        </div>
        <!-- Mini footer inside drawer -->
        <div class="qp-drawer-footer">
          <span>{{ filteredItems.length }} {{ t('items_c') }}</span>
          <span><kbd>\u2191\u2193</kbd> {{ t('qp_navigate') }}</span>
          <span><kbd>↵</kbd> {{ t('qp_paste') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.qp-standalone {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 10vh;
  background: transparent;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  overflow: hidden;
}

/* ── Card container ── */
.qp-card {
  width: 440px;
  max-width: 92vw;
  background: var(--bg-surface, #fff);
  border: 1px solid var(--border-default, #e5e7eb);
  border-radius: 12px;
  box-shadow:
    0 8px 30px rgba(0, 0, 0, 0.12),
    0 2px 8px rgba(0, 0, 0, 0.06);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  /* Entry animation */
  animation: qp-pop-in .15s cubic-bezier(.16, 1, .3, 1) both;
}
@keyframes qp-pop-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* ── Search row (always visible, drag handle) ── */
.qp-search-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  cursor: default;
  -webkit-user-select: none;
  user-select: none;
  flex-shrink: 0;
}
.qp-search-icon {
  color: var(--text-tertiary, #9ca3af);
  flex-shrink: 0;
}
.qp-search-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13.5px;
  font-family: inherit;
  color: var(--text-primary, #111827);
  line-height: 1.4;
  min-width: 0; /* prevent flex overflow */
  cursor: text;
}
.qp-search-input::placeholder {
  color: var(--text-tertiary, #9ca3af);
}
.qp-esc-hint {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-tertiary, #9ca3af);
  background: var(--bg-hover, #f3f4f6);
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 4px;
  padding: 1px 6px;
  line-height: 1.6;
  font-family: 'SF Mono', SFMono-Regular, 'Cascadia Code', Consolas, monospace;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}

/* ── Drawer (results area) ── */
.qp-drawer {
  /* Collapsed state */
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition: max-height .22s cubic-bezier(.16, 1, .3, 1),
              opacity .18s ease-out;
}
/* Expanded: show results */
.qp-card.expanded .qp-drawer {
  max-height: 340px;
  opacity: 1;
}

/* List */
.qp-list {
  max-height: 280px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border-default, transparent) transparent;
}
.qp-list::-webkit-scrollbar { width: 4px; }
.qp-list::-webkit-scrollbar-track { background: transparent; }
.qp-list::-webkit-scrollbar-thumb {
  background: var(--border-default, #d1d5db);
  border-radius: 2px;
}

/* Items */
.qp-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  cursor: pointer;
  transition: background .08s ease;
  border-left: 2px solid transparent;
}
.qp-item:hover {
  background: var(--bg-hover, #f9fafb);
}
.qp-item.sel {
  background: var(--bg-selected, #eff6ff);
  border-left-color: var(--accent, #3b82f6);
}

.qp-type-icon {
  flex-shrink: 0;
  font-size: 14px;
  width: 20px;
  text-align: center;
  line-height: 1;
}
.qp-text {
  flex: 1;
  font-size: 12.5px;
  color: var(--text-primary, #111827);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
  min-width: 0;
}
.qp-time {
  font-size: 10.5px;
  color: var(--text-tertiary, #9ca3af);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.qp-empty {
  padding: 20px 20px;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary, #9ca3af);
}

/* Drawer footer (mini) */
.qp-drawer-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 14px 8px;
  font-size: 10px;
  color: var(--text-tertiary, #9ca3af);
  border-top: 1px solid var(--border-subtle, #f3f4f6);
  flex-shrink: 0;
}
.qp-drawer-footer span:first-child {
  margin-right: auto;
  font-weight: 600;
  color: var(--text-secondary, #6b7280);
}
.qp-drawer-footer kbd {
  font-size: 9px;
  background: var(--bg-surface, #fff);
  border: 1px solid var(--border-default, #e5e7eb);
  border-radius: 3px;
  padding: 0 3px;
  line-height: 1.5;
  font-family: 'SF Mono', SFMono-Regular, 'Cascadia Code', Consolas, monospace;
  color: var(--text-secondary, #6b7280);
  box-shadow: 0 1px 0 rgba(0,0,0,.04);
}

/* Dark mode tweaks */
:global(html.dark) .qp-card {
  background: var(--bg-surface, #1e1e2e);
  border-color: var(--border-default, #313244);
  box-shadow:
    0 8px 30px rgba(0, 0, 0, 0.35),
    0 2px 8px rgba(0, 0, 0, 0.2);
}
:global(html.dark) .qp-item.sel {
  background: var(--bg-selected, rgba(137, 180, 250, 0.12));
}
:global(html.dark) .qp-drawer-footer {
  border-top-color: var(--border-subtle, #313244);
}
:global(html.dark) .qp-esc-hint,
:global(html.dark) .qp-drawer-footer kbd {
  background: var(--bg-base, #181825);
  border-color: var(--border-default, #313244);
}
</style>
