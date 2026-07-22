<script setup lang="ts">
import { computed } from 'vue'
import { sanitizeHtml } from '@/utils/html'

const props = defineProps<{ content: string }>()
const html = computed(() => sanitizeHtml(props.content))
</script>

<template>
  <div class="html-preview" v-html="html" />
</template>

<style scoped>
.html-preview {
  width: 100%;
  overflow: auto;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
  word-break: break-word;
}
.html-preview :deep(a) { color: var(--info); text-decoration: underline; }
.html-preview :deep(img) { max-width: 100%; height: auto; border-radius: var(--radius-sm); }
.html-preview :deep(table) { border-collapse: collapse; margin: 4px 0; }
.html-preview :deep(td),
.html-preview :deep(th) { border: 1px solid var(--border-subtle); padding: 2px 8px; }
.html-preview :deep(h1),
.html-preview :deep(h2),
.html-preview :deep(h3),
.html-preview :deep(h4) { margin: 6px 0 4px; line-height: 1.3; }
.html-preview :deep(p) { margin: 4px 0; }
.html-preview :deep(ul),
.html-preview :deep(ol) { padding-left: 20px; margin: 4px 0; }
.html-preview :deep(code) {
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
  font-size: 12px;
  background: var(--bg-hover);
  padding: 1px 4px;
  border-radius: var(--radius-sm);
}
</style>
