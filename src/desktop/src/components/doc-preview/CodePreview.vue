<script setup lang="ts">
import { computed } from 'vue'
import { renderCode } from '@/utils/docPreview'

const props = defineProps<{
  content: string
  fileName?: string
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
  <div class="code-preview">
    <div class="code-lines">
      <span v-for="(_, i) in lines" :key="i" class="line-num">{{ i + 1 }}</span>
    </div>
    <pre class="code-content"><code v-html="renderCode(content, fileName)"></code></pre>
    <div v-if="isTruncated" class="code-truncated">内容已截断</div>
  </div>
</template>

<style scoped>
.code-preview {
  display: flex;
  gap: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
  max-height: 500px;
}
.code-lines {
  display: flex;
  flex-direction: column;
  padding: 14px 0 14px 12px;
  border-right: 1px solid var(--border-subtle);
  user-select: none;
  flex-shrink: 0;
  background: var(--bg-hover);
}
.line-num {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.65;
  text-align: right;
  min-width: 32px;
  padding-right: 8px;
  font-family: var(--font-mono, monospace);
}
.code-content {
  margin: 0;
  padding: 14px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-primary);
  white-space: pre;
  overflow-x: auto;
  flex: 1;
  background: var(--bg-surface);
}
.code-truncated {
  font-size: 11px;
  color: var(--text-tertiary);
  text-align: center;
  padding: 8px 0;
  border-top: 1px solid var(--border-subtle);
}
</style>
