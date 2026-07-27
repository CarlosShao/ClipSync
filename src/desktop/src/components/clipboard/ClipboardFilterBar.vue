<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useClipboard } from '@/composables/useClipboard'
import { getSearchHistory, recordSearch, clearSearchHistory } from '@/api/searchHistory'
import type { SearchHistoryItem } from '@/api/searchHistory'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import { Search, Filter, Trash2, ArchiveRestore } from 'lucide-vue-next'

const props = defineProps<{ isArchive: boolean; showFilterPanel: boolean }>()
const emit = defineEmits<{
  'toggle-filter-panel': []
  'batch-delete': []
  'batch-unarchive': []
}>()

const { t } = useI18n()
const clip = useClipboard()

// Filter options for segmented control
const filterOptions = [
  { value: 'all', label: t('tab_all') },
  { value: 'text', label: t('tab_text') },
  { value: 'images', label: t('tab_images') },
  { value: 'links', label: t('tab_links') },
  { value: 'files', label: t('tab_files') },
] as const

const activeFilter = computed(() => clip.activeFilter.value)
const selectedCount = computed(() => clip.selectedCount.value)
const searchInput = ref('')

// 搜索历史（后端持久化，随账号跨设备同步）
const searchHistory = ref<SearchHistoryItem[]>([])
const showHistory = ref(false)

async function loadHistory() {
  try {
    const res = await getSearchHistory(10)
    if (res.ok) searchHistory.value = res.data?.items ?? []
  } catch (e) {
    console.warn('[search-history] load failed', e)
  }
}

function onSearchFocus() {
  showHistory.value = true
  loadHistory()
}

function onSearchBlur() {
  // 延迟关闭，确保下拉项 mousedown 能先触发
  setTimeout(() => { showHistory.value = false }, 150)
}

function pickHistory(kw: string) {
  searchInput.value = kw
  clip.setSearch(kw)
  showHistory.value = false
}

async function commitSearch() {
  const kw = searchInput.value.trim()
  if (!kw) return
  const res = await recordSearch(kw)
  if (!res.ok) console.warn('[search-history] record failed', res.error)
}

async function clearHistory() {
  const res = await clearSearchHistory()
  if (res.ok) searchHistory.value = []
  else console.warn('[search-history] clear failed', res.error)
}
</script>

<template>
  <div class="filter-row">
    <div class="segment-control">
      <button
        v-for="opt in filterOptions"
        :key="opt.value"
        class="segment-btn"
        :class="{ active: activeFilter === opt.value }"
        @click="clip.setFilter(opt.value)"
      >
        {{ opt.label }}
      </button>
    </div>
    <div class="tab-spacer" />
    <div class="search-field">
      <Search :size="14" class="search-field-icon" />
      <Input
        v-model="searchInput"
        type="text"
        :placeholder="t('search_ph')"
        class="search-input"
        :aria-label="t('search_ph')"
        @input="clip.setSearch(searchInput)"
        @focus="onSearchFocus"
        @blur="onSearchBlur"
        @keyup.enter="commitSearch"
      />
      <div v-if="showHistory && searchHistory.length" class="search-history-dropdown">
        <div
          v-for="item in searchHistory"
          :key="item.id"
          class="search-history-item"
          @mousedown.prevent="pickHistory(item.keyword)"
        >
          <Search :size="12" class="search-history-item-icon" />
          <span class="search-history-item-text">{{ item.keyword }}</span>
        </div>
        <button class="search-history-clear" @mousedown.prevent="clearHistory">
          {{ t('clear_search_history') }}
        </button>
      </div>
    </div>
    <Button
      variant="ghost"
      size="icon-sm"
      :class="{ 'text-primary': showFilterPanel }"
      :title="t('adv_filter')"
      @click="emit('toggle-filter-panel')"
    >
      <Filter :size="16" />
    </Button>
    <Button
      v-if="selectedCount > 0 && !isArchive"
      variant="ghost"
      size="icon-sm"
      class="batch-del-btn"
      :title="t('batch_delete_selected_btn')"
      @click="emit('batch-delete')"
    >
      <Trash2 :size="15" />
      <span style="margin-left: 2px; font-size: 11px">{{ selectedCount }}</span>
    </Button>
    <Button
      v-if="selectedCount > 0 && isArchive"
      variant="ghost"
      size="icon-sm"
      class="batch-restore-btn"
      :title="t('unarchive_selected_btn')"
      @click="emit('batch-unarchive')"
    >
      <ArchiveRestore :size="15" />
      <span style="margin-left: 2px; font-size: 11px">{{ selectedCount }}</span>
    </Button>
    <Button
      v-if="selectedCount > 0 && isArchive"
      variant="ghost"
      size="icon-sm"
      class="batch-del-btn"
      :title="t('batch_delete_selected_btn')"
      @click="emit('batch-delete')"
    >
      <Trash2 :size="15" />
    </Button>
  </div>
</template>

<style scoped>
.filter-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  flex-shrink: 0;
}

/* Pill / segmented control container */
.segment-control {
  display: inline-flex;
  background: var(--bg-hover);
  padding: 3px;
  border-radius: var(--radius-md);
  gap: 2px;
}
.segment-btn {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  padding: 4px 16px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
  line-height: 1.4;
}
.segment-btn:hover {
  color: var(--text-primary);
  background: var(--bg-active);
}
.segment-btn:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
.segment-btn.active {
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: var(--shadow-card);
  font-weight: 600;
}

.tab-spacer {
  flex: 1;
}

/* Search field (always visible) */
.search-field {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.search-field-icon {
  position: absolute;
  left: 10px;
  color: var(--text-tertiary);
  pointer-events: none;
}
.search-input {
  width: 200px;
  height: 34px;
  padding: 0 12px 0 32px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  font-size: 13px;
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.15s;
}
.search-input:focus {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px var(--accent-light);
}

/* 搜索历史下拉 */
.search-history-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 50;
  min-width: 100%;
  max-width: 320px;
  max-height: 280px;
  overflow-y: auto;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  padding: 4px;
}
.search-history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-primary);
  font-size: 13px;
}
.search-history-item:hover {
  background: var(--bg-hover);
}
.search-history-item-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.search-history-item-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.search-history-clear {
  width: 100%;
  margin-top: 2px;
  padding: 7px 10px;
  border: none;
  border-top: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
}
.search-history-clear:hover {
  color: var(--danger);
  background: var(--danger-bg);
}

/* Batch delete button */
.batch-del-btn {
  color: var(--danger);
}
.batch-del-btn:hover {
  background: var(--danger-bg);
}
</style>
