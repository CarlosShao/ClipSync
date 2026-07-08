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
  nextTick(() => focusSearch())
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
  if (diff < 86400000) return Math.floor(diff / 3600000) + t('h_ago')
  return Math.floor(diff / 86400000) + t('d_ago')
}
function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str
}
</script>

<template>
  <div class="qp">
    <!-- Search bar — draggable, no border, no shadow -->
    <div class="qp-bar" data-tauri-drag-region>
      <div :class="['qp-bar-inner', { open: expanded }]">
        <Search :size="13" class="qp-ico" />
        <input
          v-model="qpSearch"
          type="text"
          :placeholder="t('search_ph')"
          class="qp-in"
          @focus="expanded = true"
        />
        <span class="qp-esc">ESC</span>
      </div>
    </div>

    <!-- Results slide DOWN from under the search bar -->
    <Transition name="dr">
      <div v-show="expanded" class="qp-drop">
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
/* ── Container: COLUMN layout, centered, fully transparent ── */
.qp {
  display: flex;
  flex-direction: column;       /* ← FIX: was default row, pushed results to the RIGHT */
  align-items: center;
  width: min(440px, 90vw);
  /* No background, no border, no shadow — the .qp itself is invisible */
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  animation: qp-fade .1s ease-out;
}
@keyframes qp-fade {
  from { opacity: 0; transform: translateY(-4px) scale(.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* ── Search bar ── */
.qp-bar {
  width: 100%;
}
.qp-bar-inner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  /* Semi-transparent — blends into desktop, no hard "card" edges */
  background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
  border-radius: 10px;
  cursor: grab;
  -webkit-user-select: none;
  user-select: none;
}
/* When drawer is open: flatten bottom corners so results merge cleanly */
.qp-bar-inner.open {
  border-radius: 10px 10px 0 0;
}

.qp-ico { color: var(--text-tertiary); flex-shrink: 0; pointer-events: none; }

.qp-in {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: var(--text-primary);
  min-width: 0;
  cursor: text;
}
.qp-in::placeholder { color: var(--text-tertiary); }

.qp-esc {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted, var(--text-tertiary));
  background: color-mix(in srgb, var(--bg-hover) 70%, transparent);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
  flex-shrink: 0;
  pointer-events: none;
}

/* ── Drawer (results) — stacks UNDER search bar ── */
.qp-drop {
  width: 100%;
  background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
  border-radius: 0 0 10px 10px;
  overflow: hidden;
}

/* Vue Transition: slide down + fade in */
.dr-enter-active { transition: all .2s cubic-bezier(.16, 1, .3, 1); overflow: hidden; }
.dr-leave-active { transition: all .15s ease-in; overflow: hidden; }
.dr-enter-from { opacity: 0; max-height: 0; }
.dr-enter-to   { opacity: 1; max-height: 340px; }
.dr-leave-from { opacity: 1; max-height: 340px; }
.dr-leave-to   { opacity: 0; max-height: 0; }

/* Scrollable list */
.qp-lst { max-height: 270px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: transparent transparent; }
.qp-lst::-webkit-scrollbar { width: 3px; }
.qp-lst::-webkit-scrollbar-track { background: transparent; }
.qp-lst::-webkit-scrollbar-thumb { background: var(--border-subtle, rgba(128,128,128,.2)); border-radius: 2px; }

/* Row */
.qp-it {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  cursor: pointer;
  transition: background .08s;
}
.qp-it:hover { background: color-mix(in srgb, var(--bg-hover) 70%, transparent); }
.qp-it.on   { background: color-mix(in srgb, var(--bg-selected, var(--bg-hover)) 80%, transparent); }

.qp-em { flex-shrink: 0; font-size: 12px; width: 18px; text-align: center; }
.qp-tx { flex: 1; font-size: 12px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.qp-ag { font-size: 10px; color: var(--text-tertiary); flex-shrink: 0; }
.qp-no { padding: 20px; text-align: center; font-size: 13px; color: var(--text-tertiary); }

/* Footer inside drawer */
.qp-ft {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 5px 14px 6px;
  font-size: 10px;
  color: var(--text-tertiary);
  border-top: 1px solid color-mix(in srgb, var(--border-subtle, rgba(128,128,128,.3)) 50%, transparent);
}
.qp-ft span:first-child { margin-right: auto; font-weight: 600; color: var(--text-secondary); }
.qp-ft kbd {
  font-size: 9px;
  background: color-mix(in srgb, var(--bg-hover) 70%, transparent);
  border-radius: 3px;
  padding: 0 3px;
  font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
  color: var(--text-secondary);
}

/* ── CRITICAL: body must be transparent in QP mode ── */
:global(html.qp-mode),
:global(html.qp-mode body) {
  background: transparent !important;
}
</style>
