<script setup lang="ts">
import { Search } from 'lucide-vue-next'
import { useI18n } from '@/composables/useI18n'
import type { SearchHistoryItem } from '@/api/searchHistory'

defineProps<{
  keywords: SearchHistoryItem[]
  loaded: boolean
}>()

const emit = defineEmits<{
  pick: [keyword: string]
  clear: []
}>()

const { t } = useI18n()
</script>

<template>
  <div class="search-history-dropdown">
    <template v-if="keywords.length > 0">
      <div
        v-for="item in keywords"
        :key="item.id"
        class="search-history-item"
        @mousedown.prevent="emit('pick', item.keyword)"
      >
        <Search :size="12" class="search-history-item-icon" />
        <span class="search-history-item-text">{{ item.keyword }}</span>
      </div>
      <button class="search-history-clear" @mousedown.prevent="emit('clear')">
        {{ t('clear_search_history') }}
      </button>
    </template>
    <div v-else-if="loaded" class="search-history-empty">
      {{ t('no_search_history') }}
    </div>
  </div>
</template>

<style scoped>
.search-history-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 200;
  min-width: 100%;
  width: max-content;
  max-width: 360px;
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
.search-history-empty {
  padding: 10px 12px;
  color: var(--text-tertiary);
  font-size: 13px;
  text-align: center;
}
</style>
