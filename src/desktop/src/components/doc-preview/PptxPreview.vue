<script setup lang="ts">
// PPTX 预览：从 .pptx 文件解压出所有 slide XML，正则提取 <a:t> 文本节点
// 按 slide 顺序展示。DocPreviewModal 负责读 ArrayBuffer + 调 JSZip 解析，
// 本组件只负责渲染传入的 slide 文本数组。
defineProps<{
  slides: string[]
}>()
</script>

<template>
  <div class="pptx-preview">
    <div v-if="slides.length === 0" class="pptx-empty">幻灯片为空</div>
    <div v-else class="slide-list">
      <div v-for="(slide, idx) in slides" :key="idx" class="slide-card">
        <div class="slide-header">
          <span class="slide-num">第 {{ idx + 1 }} 页</span>
        </div>
        <div class="slide-body" v-html="slide" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.pptx-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 70vh;
  overflow: auto;
}
.pptx-empty {
  padding: 40px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}
.slide-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.slide-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  overflow: hidden;
}
.slide-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg-hover);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.slide-num {
  color: var(--accent);
}
.slide-body {
  padding: 16px 20px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-primary);
  word-break: break-word;
}
/* slide-body 内部是 <p>...</p>，用 deep 控制段落间距 */
.slide-body :deep(p) {
  margin: 4px 0;
}
.slide-body :deep(strong) {
  font-weight: 600;
  color: var(--text-primary);
}
.slide-body :deep(li) {
  list-style: disc;
  margin-left: 20px;
}
</style>
