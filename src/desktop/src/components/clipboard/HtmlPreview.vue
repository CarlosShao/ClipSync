<script setup lang="ts">
import { computed } from 'vue'
import { sanitizeHtml } from '@/utils/html'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
const props = defineProps<{ content: string }>()
const html = computed(() => sanitizeHtml(props.content))

// 如果 HTML 净下来只剩空壳（只有属性、没有可见文本/图片/输入框等），
// 回退到源码展示，否则用户会看到一个空白区域。
const isEffectivelyEmpty = computed(() => {
  const sanitized = html.value
  if (!sanitized || !sanitized.trim()) return true
  const text = sanitized.replace(/<[^>]+>/g, '').trim()
  if (text.length > 0) return false
  const hasVisibleElement = /<(img|input|button|select|textarea|svg|canvas|video|audio|iframe|embed|object|table|ul|ol|dl|hr|br)\b/i.test(sanitized)
  return !hasVisibleElement
})
</script>

<template>
  <div v-if="!isEffectivelyEmpty" class="html-preview" v-html="html" />
  <div v-else class="html-empty-fallback">
    <div class="html-empty-hint">{{ t('html_empty_hint') }}</div>
    <pre class="html-source"><code>{{ content }}</code></pre>
  </div>
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
.html-empty-fallback {
  width: 100%;
  overflow: auto;
}
.html-empty-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 8px;
  padding: 4px 8px;
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
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
