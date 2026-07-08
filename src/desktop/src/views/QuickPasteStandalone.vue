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

let stopPolling: (() => void) | null = null
onMounted(() => {
  stopPolling = clip.startPolling(2000)
  nextTick(() => {
    focusSearch()
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

;(window as any).__qpActivate = () => {
  clip.refresh()
  qpSearch.value = ''
  qpSelectedIndex.value = 0
  expanded.value = false
  nextTick(() => {
    focusSearch()
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

async function collapseAndClose(action: () => void) {
  expanded.value = false
  action()
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
  <div class="qp-standalone">
    <!-- Root container — no border, no card frame. Just positions content -->
    <div class="qp-body" :class="{ expanded }">
      <!-- Search bar: the only thing visible initially. Drag handle. -->
      <div class="qp-search-bar" data-tauri-drag-region>
        <div class="qp-search-inner" data-tauri-drag-region @mousedown.stop>
          <Search :size="15" class="qp-icon" />
          <input
            v-model="qpSearch"
            type="text"
            :placeholder="t('search_ph')"
            class="qp-search-input"
            @focus="expanded = true"
          />
          <span class="qp-esc">ESC</span>
        </div>
      </div>

      <!-- Results drawer: slides down from under the search bar -->
      <Transition name="drawer">
        <div v-show="expanded" class="qp-results">
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
          <div class="qp-results-footer">
            <span>{{ filteredItems.length }} {{ t('items_c') }}</span>
            <span><kbd>\u2191\u2193</kbd> {{ t('qp_navigate') }}</span>
            <span><kbd>↵</kbd> {{ t('qp_paste') }}</span>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
/* ═════════════════════════════════
   STAGE: transparent backdrop
   Centers content near top of screen
   ═════════════════════════════════ */
.qp-standalone {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 8vh;
  background: transparent;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  overflow: hidden;
  /* Click outside → close */
  cursor: default;
}

/* ═════════════════════════════════
   BODY: holds search + results
   NO border, NO card frame, NO shadow wrapper
   ═════════════════════════════════ */
.qp-body {
  width: 440px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  /* Entry animation */
  animation: qp-enter .15s cubic-bezier(.16, 1, .3, 1) both;
}
@keyframes qp-enter {
  from { opacity: 0; transform: translateY(-8px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* ═════════════════════════════════
   SEARCH BAR — the standalone floating input
   Rounded pill shape, subtle glass background
   This is the drag handle (data-tauri-drag-region)
   ═════════════════════════════════ */
.qp-search-bar {
  padding: 3px; /* thin gap for visual separation when results show below */
}
.qp-search-inner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--bg-surface, rgba(255, 255, 255, 0.85));
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow:
    0 2px 12px rgba(0, 0, 0, 0.08),
    0 1px 3px rgba(0, 0, 0, 0.04);
  cursor: default;
  -webkit-user-select: none;
  user-select: none;
  transition: box-shadow .2s ease, border-radius .2s ease;
}
/* When drawer is open: connect visually to results below */
.qp-body.expanded .qp-search-inner {
  border-radius: 10px 10px 0 0;
  box-shadow:
    0 2px 12px rgba(0, 0, 0, 0.08),
    0 1px 3px rgba(0, 0, 0, 0.04);
}

.qp-icon {
  color: var(--text-tertiary, #9ca3af);
  flex-shrink: 0;
  pointer-events: none;
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
  min-width: 0;
  cursor: text;
}
.qp-search-input::placeholder {
  color: var(--text-tertiary, #9ca3af);
}
.qp-esc {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-tertiary, #9ca3af);
  background: var(--bg-hover, rgba(0,0,0,0.05));
  border-radius: 4px;
  padding: 1px 6px;
  line-height: 1.6;
  font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
  letter-spacing: 0.02em;
  flex-shrink: 0;
  pointer-events: none;
}

/* ═════════════════════════════════
   RESULTS DRAWER — slides down on focus
   Matches search bar width exactly
   NO outer frame — flows from search bar
   ═════════════════════════════════ */
.qp-results {
  background: var(--bg-surface, rgba(255, 255, 255, 0.9));
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-radius: 0 0 10px 10px;
  overflow: hidden;
  box-shadow:
    0 4px 20px rgba(0, 0, 0, 0.1),
    0 1px 4px rgba(0, 0, 0, 0.04);
}

/* Vue Transition for drawer slide-down */
.drawer-enter-active {
  transition: all .22s cubic-bezier(.16, 1, .3, 1);
  overflow: hidden;
}
.drawer-leave-active {
  transition: all .18s ease-in;
  overflow: hidden;
}
.drawer-enter-from {
  opacity: 0;
  max-height: 0;
  transform: translateY(-4px);
}
.drawer-enter-to {
  opacity: 1;
  max-height: 340px;
  transform: translateY(0);
}
.drawer-leave-from {
  opacity: 1;
  max-height: 340px;
}
.drawer-leave-to {
  opacity: 0;
  max-height: 0;
  transform: translateY(-4px);
}

/* List */
.qp-list {
  max-height: 276px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
.qp-list::-webkit-scrollbar { width: 4px; }
.qp-list::-webkit-scrollbar-track { background: transparent; }
.qp-list::-webkit-scrollbar-thumb {
  background: var(--border-default, rgba(0,0,0,0.12));
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
  background: var(--bg-hover, rgba(0,0,0,0.03));
}
.qp-item.sel {
  background: var(--bg-selected, rgba(59, 130, 246, 0.08));
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

/* Results footer */
.qp-results-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 14px 7px;
  font-size: 10px;
  color: var(--text-tertiary, #9ca3af);
  border-top: 1px solid var(--border-subtle, rgba(0,0,0,0.06));
  flex-shrink: 0;
}
.qp-results-footer span:first-child {
  margin-right: auto;
  font-weight: 600;
  color: var(--text-secondary, #6b7280);
}
.qp-results-footer kbd {
  font-size: 9px;
  background: rgba(0,0,0,0.04);
  border-radius: 3px;
  padding: 0 3px;
  line-height: 1.5;
  font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
  color: var(--text-secondary, #6b7280);
}

/* ═════════════════════════════════
   DARK MODE
   ═════════════════════════════════ */
:global(html.dark) .qp-search-inner {
  background: var(--bg-surface, rgba(30, 30, 46, 0.88));
  box-shadow:
    0 2px 12px rgba(0, 0, 0, 0.3),
    0 1px 3px rgba(0, 0, 0, 0.15);
}
:global(html.dark) .qp-results {
  background: var(--bg-surface, rgba(30, 30, 46, 0.92));
  box-shadow:
    0 4px 20px rgba(0, 0, 0, 0.35),
    0 1px 4px rgba(0, 0, 0, 0.15);
}
:global(html.dark) .qp-item.sel {
  background: var(--bg-selected, rgba(137, 180, 250, 0.1));
}
:global(html.dark) .qp-results-footer {
  border-top-color: var(--border-subtle, rgba(255,255,255,0.06));
}
:global(html.dark) .qp-esc {
  background: rgba(255,255,255,0.06);
}
:global(html.dark) .qp-item:hover {
  background: var(--bg-hover, rgba(255,255,255,0.04));
}
:global(html.dark) .qp-results-footer kbd {
  background: rgba(255,255,255,0.06);
}
</style>
