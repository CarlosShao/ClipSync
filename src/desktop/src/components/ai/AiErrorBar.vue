<script setup lang="ts">
/**
 * AiErrorBar — 错误条原子组件（UI-C）
 *
 * 参考 AISidebar.vue 既有错误条实现自建（AISidebar 归并行代理 UI-B 改造，此处不动它）。
 * 样式全部走语义 token（--danger / --danger-bg），供 AiMessageList 顶部区域与
 * 后续新 Shell 复用。
 */
defineProps<{ message: string }>()
</script>

<template>
  <div class="ai-error-bar" role="alert">{{ message }}</div>
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
