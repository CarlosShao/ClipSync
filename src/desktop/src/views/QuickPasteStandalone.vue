<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useClipboard } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import * as tauriLib from '@/lib/tauri'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { Search } from 'lucide-vue-next'

const { t } = useI18n()
const clip = useClipboard()

const qpSearch = ref('')
const qpSelectedIndex = ref(0)
const expanded = ref(false)

// ── Window dimensions ──
const COLLAPSED_W = 640
const COLLAPSED_H = 56
const EXPANDED_W = 640
const EXPANDED_H = 460

let stopPolling: (() => void) | null = null

onMounted(async () => {
  stopPolling = clip.startPolling(2000)
  await nextTick()
  setTimeout(() => focusSearch(), 80)
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

// ── Expand: resize window + show drawer ──
async function expandDrawer() {
  if (expanded.value) return
  expanded.value = true

  // Method 1: Tauri JS API
  try {
    const win = getCurrentWindow()
    await win.setSize(new LogicalSize(EXPANDED_W, EXPANDED_H))
    console.log('[QP] expanded via JS API')
    return
  } catch (e) {
    console.warn('[QP] JS API resize failed:', e)
  }

  // Method 2: Fallback via Rust invoke (bypasses any JS API limitation)
  try {
    await tauriLib.invoke('resize_qp_window', { width: EXPANDED_W, height: EXPANDED_H })
    console.log('[QP] expanded via invoke fallback')
  } catch (e2) {
    console.error('[QP] ALL resize methods failed:', e2)
  }
}

async function collapseAndClose(action: () => void = () => {}) {
  expanded.value = false
  action()
  await new Promise(r => setTimeout(r, 200))
  window.close()
}

// ── Input focus triggers expansion ──
function onFocus() { expandDrawer() }

// ── Drag: explicit startDragging() on bar mousedown ──
async function onBarMousedown(e: MouseEvent) {
  // Only initiate drag if clicking the bar itself (not the input)
  const target = e.target as HTMLElement
  if (target.closest('.qp-in')) return // let input handle normally

  try {
    await getCurrentWindow().startDragging()
  } catch (err) {
    console.warn('[QP] startDragging failed:', err)
  }
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
  <!-- ROOT = card surface -->
  <div class="qp">
    <!-- Search bar — drag handle (explicit mousedown handler) -->
    <div class="qp-bar" @mousedown="onBarMousedown">
      <Search :size="14" class="qp-ico" />
      <input
        v-model="qpSearch"
        type="text"
        :placeholder="t('search_ph')"
        class="qp-in"
        @focus="onFocus"
      />
      <span class="qp-esc">ESC</span>
    </div>

    <!-- Results drawer — slides down on focus -->
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
/* ── Root: fills entire Tauri window ── */
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

/* ── Search bar / drag handle ── */
.qp-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  cursor: grab;
  border-radius: 12px 12px 0 0;
  flex-shrink: 0;
  height: COLLAPSED_H;
  box-sizing: border-box;
  -webkit-user-select: none;
  user-select: none;
}
.qp-bar:active { cursor: grabbing; }

.qp-ico { color: var(--text-tertiary); flex-shrink: 0; pointer-events: none; }

.qp-in {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 14px;
  color: var(--text-primary);
  min-width: 0;
  cursor: text;
  pointer-events: auto;
}
.qp-in::placeholder { color: var(--text-tertiary); }

.qp-esc {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted, var(--text-tertiary));
  background: var(--bg-hover);
  border-radius: 4px;
  padding: 2px 6px;
  font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
  flex-shrink: 0;
  pointer-events: none;
}

/* ── Drawer (results) ── */
.qp-drp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border-radius: 0 0 12px 12px;
}

/* Vue Transition: slide-down drawer animation */
.dr-enter-active {
  transition: all .28s cubic-bezier(.16, 1, .3, 1);
  overflow: hidden;
}
.dr-leave-active {
  transition: all .2s ease-in;
  overflow: hidden;
}
.dr-enter-from {
  opacity: 0;
  max-height: 0;
  transform: translateY(-10px);
}
.dr-enter-to {
  opacity: 1;
  max-height: 420px;
  transform: translateY(0);
}
.dr-leave-from {
  opacity: 1;
  max-height: 420px;
  transform: translateY(0);
}
.dr-leave-to {
  opacity: 0;
  max-height: 0;
  transform: translateY(-10px);
}

/* Scrollable list */
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
  padding: 8px 18px;
  cursor: pointer;
  transition: background .08s;
  border-left: 3px solid transparent;
}
.qp-it:hover { background: var(--bg-hover); }
.qp-it.on   { background: var(--bg-selected, var(--bg-hover)); border-left-color: var(--accent); }

.qp-em { flex-shrink: 0; font-size: 13px; width: 20px; text-align: center; }
.qp-tx { flex: 1; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.qp-ag { font-size: 11px; color: var(--text-tertiary); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.qp-no { padding: 24px; text-align: center; font-size: 13px; color: var(--text-tertiary); }

/* Footer */
.qp-ft {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 7px 18px 8px;
  font-size: 11px;
  color: var(--text-tertiary);
  border-top: 1px solid var(--border-subtle, rgba(128,128,128,.12));
  flex-shrink: 0;
}
.qp-ft span:first-child { margin-right: auto; font-weight: 600; color: var(--text-secondary); }
.qp-ft kbd {
  font-size: 10px;
  background: var(--bg-hover);
  border-radius: 4px;
  padding: 0 4px;
  line-height: 1.6;
  font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
  color: var(--text-secondary);
}

/* QP mode: body/html bg matches card */
:global(html.qp-mode),
:global(html.qp-mode body) {
  background: var(--bg-surface) !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
}
</style>
