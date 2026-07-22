<script setup lang="ts">
import { computed } from 'vue'
import { sanitizeHtml } from '@/utils/html'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
const props = defineProps<{ content: string }>()
const html = computed(() => sanitizeHtml(props.content))
</script>

<template>
  <div class="html-preview-stack">
    <div class="html-preview-section">
      <div class="html-section-label">{{ t('preview') }}</div>
      <div class="html-preview" v-html="html" />
    </div>
    <div class="html-source-section">
      <div class="html-section-label">{{ t('head_source') }}</div>
      <pre class="html-source"><code>{{ content }}</code></pre>
    </div>
  </div>
</template>

<style scoped>
.html-preview-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  overflow: auto;
}
.html-section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
  margin-bottom: 6px;
}
.html-preview {
  width: 100%;
  overflow: auto;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
  word-break: break-word;
  min-height: 24px;
}
.html-source {
  margin: 0;
  padding: 12px;
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
  font-size: 12px;
  line-height: 1.5;
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
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
