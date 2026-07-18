<script setup lang="ts">
import type { ClipboardTemplate } from '@/types'
import TemplateRow from './TemplateRow.vue'

defineProps<{ templates: ClipboardTemplate[] }>()
const emit = defineEmits<{
  edit: [tpl: ClipboardTemplate]
  insert: [tpl: ClipboardTemplate]
  delete: [tpl: ClipboardTemplate]
}>()
</script>

<template>
  <div class="tpl-list">
    <TemplateRow
      v-for="tpl in templates"
      :key="tpl.id"
      :template="tpl"
      @edit="emit('edit', $event)"
      @insert="emit('insert', $event)"
      @delete="emit('delete', $event)"
    />
  </div>
</template>

<style scoped>
.tpl-list {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--bg-surface);
}
</style>
