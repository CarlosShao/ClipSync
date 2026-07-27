<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()

defineProps<{
  pages: { num: number; dataUrl: string }[]
  totalPages: number
}>()
</script>

<template>
  <div class="pdf-preview">
    <div v-if="totalPages > 20" class="pdf-info">{{ t('preview_pages', { n: totalPages }) }}</div>
    <div v-for="page in pages" :key="page.num" class="pdf-page">
      <img :src="page.dataUrl" :alt="'Page ' + page.num" class="pdf-img" />
      <span class="pdf-num">{{ page.num }}</span>
    </div>
  </div>
</template>

<style scoped>
.pdf-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  max-height: 500px;
  overflow-y: auto;
  padding: 8px 0;
}
.pdf-info {
  font-size: 11px;
  color: var(--text-tertiary);
  text-align: center;
  padding: 4px 0;
}
.pdf-page {
  position: relative;
  display: inline-block;
}
.pdf-img {
  max-width: 100%;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}
.pdf-num {
  position: absolute;
  bottom: 4px;
  right: 8px;
  font-size: 10px;
  color: var(--text-tertiary);
  background: var(--bg-surface);
  padding: 1px 6px;
  border-radius: 8px;
}
</style>
