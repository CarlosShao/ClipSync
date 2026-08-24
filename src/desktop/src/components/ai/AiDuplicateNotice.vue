<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'
import { CopyCheck, X } from 'lucide-vue-next'

/**
 * AiDuplicateNotice — 图片重复横幅原子组件（UI-C）
 *
 * 参考旧 AISidebar.vue 既有横幅实现自建（历史注：UI-C 时期 AISidebar 归并行代理 UI-B 改造）；
 * 原实现的 hsl() 硬编码色替换为语义 token（--accent / --accent-bg）。
 * notice 结构与 useAiChat.duplicateImageNotice 对齐（只读消费，不新增字段）。
 */
const props = defineProps<{ notice: { createdAt?: string } }>()
const emit = defineEmits<{ dismiss: [] }>()
const { t, currentLang } = useI18n()

const timeText = computed(() => {
  if (!props.notice.createdAt) return ''
  try {
    return new Date(props.notice.createdAt).toLocaleString(currentLang.value === 'en' ? 'en-US' : 'zh-CN')
  } catch {
    return ''
  }
})

const text = computed(() => t('ai_dup_image_notice', { earliestTime: timeText.value }))
</script>

<template>
  <div class="ai-dup-notice" role="status">
    <CopyCheck :size="15" class="ai-dup-notice-icon" />
    <span class="ai-dup-notice-text">{{ text }}</span>
    <Button variant="ghost" size="icon-sm" :title="t('close_btn')" @click="emit('dismiss')">
      <X :size="14" />
    </Button>
  </div>
</template>

<style scoped>
.ai-dup-notice {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 8px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--accent);
  background: var(--accent-bg);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-radius: var(--radius-sm);
}

.ai-dup-notice-icon {
  flex-shrink: 0;
}

.ai-dup-notice-text {
  flex: 1;
  min-width: 0;
}
</style>
