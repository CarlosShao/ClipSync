<script setup lang="ts">
import { ref, computed } from 'vue'
import { useClipboard } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import { Search } from 'lucide-vue-next'

const props = withDefaults(defineProps<{ open: boolean }>(), { open: false })
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const clip = useClipboard()

const qpSearch = ref('')
const qpSelectedIndex = ref(0)

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
  emit('close')
}

function handleKeydown(e: KeyboardEvent) {
  const list = filteredItems.value
  if (e.key === 'ArrowDown') { e.preventDefault(); qpSelectedIndex.value = Math.min(qpSelectedIndex.value + 1, list.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); qpSelectedIndex.value = Math.max(qpSelectedIndex.value - 1, 0) }
  else if (e.key === 'Enter' && list[qpSelectedIndex.value]) { selectItem(list[qpSelectedIndex.value]) }
  else if (e.key === 'Escape') { emit('close') }
}

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
  <Teleport to="body">
    <div v-if="open" class="qp-overlay" @click.self="emit('close')" @keydown="handleKeydown">
      <div class="qp-panel">
        <div class="qp-search">
          <Search :size="16" style="color:var(--text-tertiary)" />
          <input v-model="qpSearch" type="text" ref="qpInput" :placeholder="t('search_ph')" autofocus class="qp-search-input" />
          <kbd class="qp-kbd">ESC</kbd>
        </div>
        <div class="qp-list">
          <div v-for="(item, idx) in filteredItems" :key="item.id"
            :class="['qp-item', { sel: idx === qpSelectedIndex }]"
            @click="selectItem(item)" @mouseenter="qpSelectedIndex = idx">
            <span class="qp-type-indicator">{{ item.type === 'image' ? '🖼' : item.type === 'file' ? '📄' : '📋' }}</span>
            <span class="qp-text">{{ truncate(item.content, 50) }}</span>
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
  </Teleport>
</template>

<style scoped>
.qp-overlay { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: flex-start; justify-content: center; padding-top: 18vh; background: var(--bg-modal-overlay); }
.qp-panel { width: 560px; max-width: 92vw; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg); box-shadow: var(--shadow-modal); overflow: hidden; animation: slideDown 0.15s ease; }
@keyframes slideDown { from { transform: translateY(-12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.qp-search { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border-default); }
.qp-search-input { flex: 1; border: none; outline: none; background: transparent; font-size: 14px; font-family: inherit; color: var(--text-primary); }
.qp-search-input::placeholder { color: var(--text-tertiary); }
.qp-kbd { font-size: 10px; color: var(--text-tertiary); background: var(--bg-hover); border: 1px solid var(--border-default); border-radius: 3px; padding: 1px 5px; font-family: monospace; }
.qp-list { max-height: 300px; overflow-y: auto; }
.qp-item { display: flex; align-items: center; gap: 10px; padding: 8px 16px; cursor: pointer; }
.qp-item:hover, .qp-item.sel { background: var(--bg-selected); }
.qp-type-indicator { flex-shrink: 0; font-size: 16px; }
.qp-text { flex: 1; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qp-time { font-size: 11px; color: var(--text-tertiary); flex-shrink: 0; }
.qp-empty { padding: 24px; text-align: center; }
.qp-footer { display: flex; align-items: center; gap: 14px; padding: 8px 16px; border-top: 1px solid var(--border-default); font-size: 11px; color: var(--text-tertiary); }
.qp-count { margin-right: auto; font-weight: 500; color: var(--text-secondary); }
.kbd-pair { display: flex; align-items: center; gap: 4px; }
.qp-footer kbd { font-size: 10px; background: var(--bg-hover); border: 1px solid var(--border-default); border-radius: 3px; padding: 1px 4px; font-family: monospace; }
</style>
