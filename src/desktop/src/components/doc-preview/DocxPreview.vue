<script setup lang="ts">
defineProps<{
  html: string
}>()
</script>

<template>
  <div class="docx-preview markdown-body" v-html="html"></div>
</template>

<style scoped>
.docx-preview {
  max-height: 500px;
  overflow-y: auto;
}
.docx-preview :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 8px 0;
}
.docx-preview :deep(th),
.docx-preview :deep(td) {
  border: 1px solid var(--border-default);
  padding: 4px 8px;
  text-align: left;
  font-size: 12px;
}
.docx-preview :deep(th) {
  background: var(--bg-hover);
  font-weight: 600;
}
.docx-preview :deep(p) {
  margin: 4px 0;
}
.docx-preview :deep(ul),
.docx-preview :deep(ol) {
  padding-left: 20px;
  margin: 4px 0;
}
</style>
