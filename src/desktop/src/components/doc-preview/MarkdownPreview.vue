<script setup lang="ts">
import { nextTick } from 'vue'
import { renderMarkdown, type TocItem } from '@/utils/docPreview'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()

const props = defineProps<{
  content: string
  toc: TocItem[]
}>()

function scrollToHeading(id: string) {
  nextTick(() => {
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}
</script>

<template>
  <div class="markdown-preview-layout">
    <nav v-if="toc.length > 0" class="markdown-toc">
      <div class="markdown-toc-title">{{ t('toc_title') }}</div>
      <a
        v-for="item in toc"
        :key="item.id"
        :href="'#' + item.id"
        class="markdown-toc-item"
        :class="'markdown-toc-depth-' + item.depth"
        @click.prevent="scrollToHeading(item.id)"
      >
        {{ item.text }}
      </a>
    </nav>
    <div class="markdown-preview-content markdown-body" v-html="renderMarkdown(content)"></div>
  </div>
</template>

<style scoped>
.markdown-preview-layout {
  display: flex;
  gap: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
  max-height: 500px;
}
.markdown-toc {
  width: 200px;
  min-width: 160px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  padding: 12px 0;
  overflow-y: auto;
}
.markdown-toc-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0 14px 8px;
}
.markdown-toc-item {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  text-decoration: none;
  padding: 3px 14px;
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.5;
}
.markdown-toc-item:hover {
  color: var(--accent);
  background: var(--bg-hover);
}
.markdown-toc-depth-1 {
  font-weight: 600;
  padding-left: 14px;
}
.markdown-toc-depth-2 {
  padding-left: 24px;
}
.markdown-toc-depth-3 {
  padding-left: 34px;
  font-size: 11px;
}
.markdown-toc-depth-4,
.markdown-toc-depth-5,
.markdown-toc-depth-6 {
  padding-left: 44px;
  font-size: 11px;
  color: var(--text-tertiary);
}
.markdown-preview-content {
  flex: 1;
  overflow-y: auto;
  border: none;
  border-radius: 0;
  max-height: 500px;
}
</style>
