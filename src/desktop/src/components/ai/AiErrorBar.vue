<script setup lang="ts">
/**
 * AiErrorBar — 错误条原子组件（UI-C）
 *
 * 参考旧 AISidebar.vue 既有错误条实现自建（历史注：UI-C 时期 AISidebar 归并行代理 UI-B 改造）。
 * 样式全部走语义 token（--danger / --danger-bg），供 AiMessageList 顶部区域与
 * 后续新 Shell 复用。
 */
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'

const props = defineProps<{ message: string }>()
const { tMsg } = useI18n()

// 后端/协议层可能直接回传 i18n key（如 ai_approve_failed）；统一翻译，
// 避免界面直接渲染裸 key；非 key 的普通句子原样展示。
const text = computed(() => tMsg(props.message))
</script>

<template>
  <div class="ai-error-bar" role="alert">{{ text }}</div>
</template>

<style scoped>
.ai-error-bar {
  flex-shrink: 0;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--danger);
  background: var(--danger-bg);
  border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent);
  border-radius: var(--radius-sm);
}
</style>
