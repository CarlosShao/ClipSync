<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { CheckCircle2, AlertTriangle } from 'lucide-vue-next'

/**
 * AiCompressProgress — 上下文压缩的"分割线"过渡提示。
 *
 * 样式：`────── 上下文压缩中 ──────`，压缩中文字带从左到右的扫光动画
 * （与 AiThinking 的 shimmer 一致）；完成后切换为"压缩已完成"。
 * 自动压缩（任务流式进行中）与手动压缩共用同一组件，保持视觉统一。
 */
const props = defineProps<{
  progress: {
    status: 'compressing' | 'done' | 'too_short' | 'failed'
    source: 'manual' | 'auto'
    removed?: number
    savedTokens?: number
    error?: string
  }
}>()
const { t } = useI18n()

const isCompressing = computed(() => props.progress.status === 'compressing')

const label = computed(() => {
  switch (props.progress.status) {
    case 'compressing':
      return t('ai_compress_compressing', '上下文压缩中')
    case 'done':
      return t('ai_compress_done', '压缩已完成')
    case 'too_short':
      return t('ai_compact_too_short', '当前对话历史太短，无需压缩')
    case 'failed':
      return t('ai_compress_failed', '压缩失败')
  }
})

const detail = computed(() => {
  if (props.progress.status !== 'done' || !props.progress.removed) return ''
  return t('ai_compress_done_detail', {
    removed: props.progress.removed,
    savedTokens: props.progress.savedTokens ?? 0,
  })
})
</script>

<template>
  <div class="ai-compress-progress" :class="`ai-compress-progress--${progress.status}`">
    <span class="ai-compress-line" />
    <span class="ai-compress-center">
      <!-- 压缩中：文字带从左到右扫光动画 -->
      <template v-if="isCompressing">
        <span class="ai-compress-dot ai-compress-dot--pulse" />
        <span class="ai-compress-text ai-compress-text--shimmer">{{ label }}</span>
      </template>
      <!-- 完成：对勾 + "压缩已完成"（+ 细节） -->
      <template v-else-if="progress.status === 'done'">
        <CheckCircle2 :size="14" class="ai-compress-icon ai-compress-icon--ok" />
        <span class="ai-compress-text">{{ label }}</span>
        <span v-if="detail" class="ai-compress-detail">{{ detail }}</span>
      </template>
      <!-- 失败 / 历史太短 -->
      <template v-else>
        <AlertTriangle :size="13" class="ai-compress-icon" :class="progress.status === 'failed' ? 'ai-compress-icon--err' : 'ai-compress-icon--warn'" />
        <span class="ai-compress-text">{{ label }}</span>
      </template>
    </span>
    <span class="ai-compress-line" />
  </div>
</template>

<style scoped>
.ai-compress-progress {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  font-size: 12px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.ai-compress-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--border-default) 50%, transparent);
}
.ai-compress-center {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  max-width: 100%;
}
.ai-compress-dot {
  flex-shrink: 0;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}
.ai-compress-dot--pulse {
  animation: ai-compress-pulse 1.3s ease-in-out infinite;
}
@keyframes ai-compress-pulse {
  0%, 100% { opacity: 0.4; box-shadow: 0 0 0 0 rgba(var(--accent-rgb, 99 102 241), 0.35); }
  50% { opacity: 1; box-shadow: 0 0 6px 2px rgba(var(--accent-rgb, 99 102 241), 0.18); }
}
.ai-compress-icon { flex-shrink: 0; }
.ai-compress-icon--ok { color: var(--success, #16a34a); }
.ai-compress-icon--warn { color: var(--text-tertiary); }
.ai-compress-icon--err { color: var(--danger, #ef4444); }

/* 压缩中文字：从左到右扫光（与 AiThinking shimmer 一致） */
.ai-compress-text--shimmer {
  position: relative;
  display: inline-block;
  font-weight: 600;
  background: linear-gradient(
    90deg,
    var(--text-tertiary, #94a3b8) 0%,
    var(--text-tertiary, #94a3b8) 20%,
    var(--text-primary, #0f172a) 45%,
    var(--accent, #6366f1) 50%,
    var(--text-primary, #0f172a) 55%,
    var(--text-tertiary, #94a3b8) 80%,
    var(--text-tertiary, #94a3b8) 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: ai-compress-shimmer 1.6s linear infinite;
}
@keyframes ai-compress-shimmer {
  0% { background-position: 180% 0; }
  100% { background-position: -180% 0; }
}

.ai-compress-text {
  font-weight: 600;
  color: var(--text-secondary);
}
.ai-compress-detail {
  font-weight: 400;
  color: var(--text-tertiary);
}
</style>
