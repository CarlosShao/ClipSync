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
  <div class="qp">
    <!-- Search row — draggable -->
    <div class="qp-search" data-tauri-drag-region @mousedown.stop>
      <Search :size="14" class="qp-icon" />
      <input
        v-model="qpSearch"
        type="text"
        :placeholder="t('search_ph')"
        class="qp-input"
        @focus="expanded = true"
      />
      <span class="qp-esc">ESC</span>
    </div>

    <!-- Results — no frame, just slides down -->
    <Transition name="drop">
      <div v-show="expanded" class="qp-results">
        <div class="qp-list">
          <div
            v-for="(item, idx) in filteredItems"
            :key="item.id"
            :class="['qp-row', { sel: idx === qpSelectedIndex }]"
            @click="selectItem(item)"
            @mouseenter="qpSelectedIndex = idx"
          >
            <span class="qp-ty">{{ item.type === 'image' ? '\u{1F5BC}' : item.type === 'file' ? '\u{1F4C4}' : '\u{1F4CB}' }}</span>
            <span class="qp-txt">{{ truncate(item.content, 60) }}</span>
            <span class="qp-tm">{{ timeAgo(item.timestamp) }}</span>
          </div>
          <div v-if="filteredItems.length === 0" class="qp-empty">{{ t('empty_title') }}</div>
        </div>
        <div class="qp-foot">
          <span>{{ filteredItems.length }} {{ t('items_c') }}</span>
          <span><kbd>\u2191\u2193</kbd> {{ t('qp_navigate') }}</span>
          <span><kbd>↵</kbd> {{ t('qp_paste') }}</span>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ── Stage: fully transparent ── */
.qp {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 8vh;
  background: transparent;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  animation: qp-in .12s ease-out;
}
@keyframes qp-in {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ── Search bar: flat, no shadow, no card feel ── */
.qp-search {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 420px;
  max-width: 90vw;
  padding: 10px 14px;
  background: var(--bg-surface);
  border-radius: 8px;
  /* NO box-shadow — that's what created the "frame" */
  cursor: default;
  -webkit-user-select: none;
  user-select: none;
}
/* When expanded: flatten top corners to merge with results below */
.qp-search.expanded-style {
  border-radius: 8px 8px 0 0;
}

.qp-icon { color: var(--text-tertiary); flex-shrink: 0; pointer-events: none; }

.qp-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13.5px;
  font-family: inherit;
  color: var(--text-primary);
  min-width: 0;
  cursor: text;
}
.qp-input::placeholder { color: var(--text-tertiary); }

.qp-esc {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-tertiary);
  background: var(--bg-hover);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
  flex-shrink: 0;
  pointer-events: none;
}

/* ── Results: flat panel, NO shadow, NO outer border ── */
.qp-results {
  width: 420px;
  max-width: 90vw;
  background: var(--bg-surface);
  border-radius: 0 0 8px 8px;
  overflow: hidden;
  /* NO box-shadow — zero container feeling */
}

/* Vue Transition */
.drop-enter-active { transition: all .18s cubic-bezier(.16,1,.3,1); overflow: hidden; }
.drop-leave-active { transition: all .14s ease-in; overflow: hidden; }
.drop-enter-from { opacity: 0; max-height: 0; transform: translateY(-6px); }
.drop-enter-to   { opacity: 1; max-height: 340px; transform: translateY(0); }
.drop-leave-from { opacity: 1; max-height: 340px; }
.drop-leave-to   { opacity: 0; max-height: 0; transform: translateY(-6px); }

/* List */
.qp-list { max-height: 276px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: transparent transparent; }
.qp-list::-webkit-scrollbar { width: 3px; }
.qp-list::-webkit-scrollbar-track { background: transparent; }
.qp-list::-webkit-scrollbar-thumb { background: var(--border-subtle); border-radius: 2px; }

/* Rows */
.qp-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 14px;
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background .06s;
}
.qp-row:hover { background: var(--bg-hover); }
.qp-row.sel { background: var(--bg-selected); border-left-color: var(--accent); }

.qp-ty { flex-shrink: 0; font-size: 13px; width: 18px; text-align: center; }
.qp-txt { flex: 1; font-size: 12.5px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.qp-tm { font-size: 10px; color: var(--text-tertiary); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.qp-empty { padding: 20px; text-align: center; font-size: 13px; color: var(--text-tertiary); }

/* Footer inside results */
.qp-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 5px 14px 6px;
  font-size: 10px;
  color: var(--text-tertiary);
  border-top: 1px solid var(--border-subtle);
}
.qp-foot span:first-child { margin-right: auto; font-weight: 600; color: var(--text-secondary); }
.qp-foot kbd {
  font-size: 9px;
  background: var(--bg-hover);
  border-radius: 3px;
  padding: 0 3px;
  line-height: 1.5;
  font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
  color: var(--text-secondary);
}
</style>
