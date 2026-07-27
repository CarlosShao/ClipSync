<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { Image as ImageIcon, FileText, Link, ClipboardList, Code } from 'lucide-vue-next'
import type { FrequentItem } from '@/api/clipboard'

const props = defineProps<{ suggestions: FrequentItem[] }>()
const emit = defineEmits<{ select: [item: FrequentItem] }>()
const { t } = useI18n()

function iconFor(type: string) {
  switch (type) {
    case 'image':
      return ImageIcon
    case 'file':
      return FileText
    case 'link':
      return Link
    case 'code':
      return Code
    default:
      return ClipboardList
  }
}
function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + '…' : s
}
</script>

<template>
  <div class="qp-sug" v-if="suggestions.length > 0">
    <span class="qp-sug-label">{{ t('smart_suggest') }}</span>
    <button
      v-for="s in suggestions"
      :key="s.id"
      class="qp-sug-item"
      :title="s.contentPreview"
      @click="emit('select', s)"
    >
      <component :is="iconFor(s.contentType)" :size="13" class="qp-sug-ico" />
      <span class="qp-sug-tx">{{ truncate(s.contentPreview, 24) }}</span>
    </button>
  </div>
</template>

<style scoped>
.qp-sug {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.12));
  overflow-x: auto;
  scrollbar-width: none;
}
.qp-sug::-webkit-scrollbar {
  display: none;
}
.qp-sug-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
}
.qp-sug-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 180px;
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.qp-sug-item:hover {
  border-color: var(--accent);
  background: var(--accent-light, rgba(99, 102, 241, 0.1));
}
.qp-sug-ico {
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.qp-sug-tx {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
