<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'

const { tf } = useI18n()
import { computed } from 'vue'

const props = defineProps<{
  content: string
  maxLines?: number
}>()

const lines = computed(() => {
  const max = props.maxLines || 500
  return (props.content || '').split('\n').slice(0, max)
})

const isTruncated = computed(() => {
  const max = props.maxLines || 500
  return (props.content || '').split('\n').length > max
})
</script>

<template>
  <div class="text-preview">
    <div class="text-preview-content">{{ lines.join('\n') }}</div>
    <div v-if="isTruncated" class="text-truncated">{{ tf('doc_truncated', '内容已截断') }}</div>
  </div>
</template>

<style scoped>
.text-preview {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
  max-height: 500px;
}
.text-preview-content {
  font-size: 13px;
  line-height: 1.7;
  background: var(--bg-hover);
  padding: 16px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow-y: auto;
  color: var(--text-primary);
}
.text-truncated {
  font-size: 11px;
  color: var(--text-tertiary);
  text-align: center;
  padding: 8px 0;
  border-top: 1px solid var(--border-subtle);
}
</style>
