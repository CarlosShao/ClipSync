<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useClipboard } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import * as tauri from '@/lib/tauri'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { Search } from 'lucide-vue-next'

const { t } = useI18n()
const clip = useClipboard()

const qpSearch = ref('')
const qpSelectedIndex = ref(0)
const expanded = ref(false)

// ── Window dimensions ──
const COLLAPSED_W = 560
const COLLAPSED_H = 48   // just the search bar
const EXPANDED_W = 560
const EXPANDED_H = 430   // full card with ~10 items

let stopPolling: (() => void) | null = null

onMounted(async () => {
  stopPolling = clip.startPolling(2000)
  // Start collapsed — window created at search-bar size by Rust
  // Auto-focus input after a tick (window must be ready)
  await nextTick()
  setTimeout(() => focusSearch(), 50)
})
onUnmounted(() => { if (stopPolling) stopPolling() })

function focusSearch() {
  const el = document.querySelector('.qp-in') as HTMLInputElement | null
  el?.focus()
  el?.select()
}

;(window as any).__qpActivate = () => {
  clip.refresh()
  qpSearch.value = ''
  qpSelectedIndex.value = 0
  expanded.value = false
  nextTick(() => focusSearch())
}

// ── Window resize + drawer animation on focus/blur ──
async function expandDrawer() {
  if (expanded.value) return
  expanded.value = true
  // Resize Tauri window to full size (instant OS-level, content animates via Transition)
  try {
    await getCurrentWindow().setSize(new LogicalSize(EXPANDED_W, EXPANDED_H))
  } catch (e) { console.warn('[QP] resize failed:', e) }
}

async function collapseAndClose(action: () => void = () => {}) {
  expanded.value = false
  action()
  // Wait for slide-up animation to finish (matches .dr-leave-active duration)
  await new Promise(r => setTimeout(r, 180))
  window.close()
}

// ── Input focus triggers expansion ──
function onFocus() { expandDrawer() }

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
function closePopup() {
  collapseAndClose()
}

function handleKeydown(e: KeyboardEvent) {
  const list = filteredItems.value
  if (e.key === 'ArrowDown') { e.preventDefault(); qpSelectedIndex.value = Math.min(qpSelectedIndex.value + 1, list.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); qpSelectedIndex.value = Math.max(qpSelectedIndex.value - 1, 0) }
  else if (e.key === 'Enter' && list[qpSelectedIndex.value]) { e.preventDefault(); selectItem(list[qpSelectedIndex.value]) }
  else if (e.key === 'Escape') { e.preventDefault(); closePopup() }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => { document.removeEventListener('keydown', handleKeydown); delete (window as any).__qpActivate })

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return t('just_now')
  if (diff < 3600000) return Math.floor(diff / 60000) + t('m_ago')
  if (diff < 86400000) return Math.floor(diff / 3600000) + t('d_ago')
  return Math.floor(diff / 86400000) + t('d_ago')
}
function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str
}
</script>

<template>
  <!-- ROOT = card surface, fills entire Tauri window -->
  <div class="qp">
    <!-- Search bar — ALSO the drag handle for the entire window -->
    <div class="qp-bar" data-tauri-drag-region>
      <Search :size="13" class="qp-ico" />
      <input
        v-model="qpSearch"
        type="text"
        :placeholder="t('search_ph')"
        class="qp-in"
        @focus="onFocus"
      />
      <span class="qp-esc">ESC</span>
    </div>

    <!-- Results drawer — slides down when input gains focus -->
    <Transition name="dr">
      <div v-show="expanded" class="qp-drp">
        <div class="qp-lst">
          <div
            v-for="(item, idx) in filteredItems"
            :key="item.id"
            :class="['qp-it', { on: idx === qpSelectedIndex }]"
            @click="selectItem(item)"
            @mouseenter="qpSelectedIndex = idx"
          >
            <span class="qp-em">{{ item.type === 'image' ? '\u{1F5BC}' : item.type === 'file' ? '\u{1F4C4}' : '\u{1F4CB}' }}</span>
            <span class="qp-tx">{{ truncate(item.content, 60) }}</span>
            <span class="qp-ag">{{ timeAgo(item.timestamp) }}</span>
          </div>
          <div v-if="filteredItems.length === 0" class="qp-no">{{ t('empty_title') }}</div>
        </div>
        <div class="qp-ft">
          <span>{{ filteredItems.length }} {{ t('items_c') }}</span>
          <span><kbd>&#x2191;&#x2193;</kbd> {{ t('qp_navigate') }}</span>
          <span><kbd>&#23ce;</kbd> {{ t('qp_paste') }}</span>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ── Root: fills Tauri window completely ── */
.qp {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  overflow: hidden;
  border-radius: 12px;
}

/* ── Search bar = drag handle ── */
/* data-tauri-drag-region is set directly on this element.
   The input inside gets pointer-events:auto so typing works,
   but clicking anywhere else on the bar (padding, icon, ESC area)
   initiates window drag. */
.qp-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  cursor: grab;
  -webkit-user-select: none;
  user-select: none;
  /* Rounded top corners always; bottom flattens when drawer opens */
  border-radius: 12px 12px 0 0;
  flex-shrink: 0;
  height: COLLAPSED_H; /* matches Rust initial window height */
  box-sizing: border-box;
}

.qp-ico { color: var(--text-tertiary); flex-shrink: 0; pointer-events: none; }

/* Input must reclaim mouse events for typing */
.qp-in {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: var(--text-primary);
  min-width: 0;
  cursor: text;
  /* Re-enable pointer events so click-to-focus works inside drag region */
  pointer-events: auto;
}
.qp-in::placeholder { color: var(--text-tertiary); }

.qp-esc {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted, var(--text-tertiary));
  background: var(--bg-hover);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
  flex-shrink: 0;
  pointer-events: none;
}

/* ── Results drawer ── */
.qp-drp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border-radius: 0 0 12px 12px;
}

/* Vue Transition: drawer slides down + fades in */
.dr-enter-active {
  transition: all .25s cubic-bezier(.16, 1, .3, 1);
  overflow: hidden;
}
.dr-leave-active {
  transition: all .18s ease-in;
  overflow: hidden;
}
.dr-enter-from {
  opacity: 0;
  max-height: 0;
  transform: translateY(-8px);
}
.dr-enter-to {
  opacity: 1;
  max-height: 400px;
  transform: translateY(0);
}
.dr-leave-from {
  opacity: 1;
  max-height: 400px;
  transform: translateY(0);
}
.dr-leave-to {
  opacity: 0;
  max-height: 0;
  transform: translateY(-8px);
}

/* Scrollable list area */
.qp-lst {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
.qp-lst::-webkit-scrollbar { width: 3px; }
.qp-lst::-webkit-scrollbar-track { background: transparent; }
.qp-lst::-webkit-scrollbar-thumb { background: var(--border-subtle, rgba(128,128,128,.25)); border-radius: 2px; }

/* Item row */
.qp-it {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 16px;
  cursor: pointer;
  transition: background .08s;
  border-left: 3px solid transparent;
}
.qp-it:hover { background: var(--bg-hover); }
.qp-it.on   { background: var(--bg-selected, var(--bg-hover)); border-left-color: var(--accent); }

.qp-em { flex-shrink: 0; font-size: 12px; width: 18px; text-align: center; }
.qp-tx { flex: 1; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.qp-ag { font-size: 10px; color: var(--text-tertiary); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.qp-no { padding: 20px; text-align: center; font-size: 13px; color: var(--text-tertiary); }

/* Footer */
.qp-ft {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 16px 7px;
  font-size: 10px;
  color: var(--text-tertiary);
  border-top: 1px solid var(--border-subtle, rgba(128,128,128,.12));
  flex-shrink: 0;
}
.qp-ft span:first-child { margin-right: auto; font-weight: 600; color: var(--text-secondary); }
.qp-ft kbd {
  font-size: 9px;
  background: var(--bg-hover);
  border-radius: 3px;
  padding: 0 3px;
  line-height: 1.5;
  font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
  color: var(--text-secondary);
}

/* QP mode: body/html bg matches card — no visible frame gap */
:global(html.qp-mode),
:global(html.qp-mode body) {
  background: var(--bg-surface) !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
}
</style>
