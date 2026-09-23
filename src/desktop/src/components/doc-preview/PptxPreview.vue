<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'

const { tf } = useI18n()
// PPTX 预览：从 .pptx 文件解压出所有 slide XML，正则提取 <a:t> 文本节点
// 按 slide 顺序展示。DocPreviewModal 负责读 ArrayBuffer + 调 JSZip 解析，
// 本组件只负责渲染传入的 slide 文本数组。
//
// P0-C C3 · v-html 命中点 11/12 —— 判 A（真风险），处置：改成纯文本渲染，v-html 从本文件消失。
// 原本是 `slides: string[]` + `<div class="slide-body" v-html="slide" />`：组件把收到的
// 字符串无条件 innerHTML，自身没有任何转义/消毒，安全性 100% 依赖唯一调用方
// （DocPreviewModal 的 `<a:t>` 正则「碰巧」不会带出裸 `<`）。prop 类型是公开的 string[]，
// 任何新调用方都能把远端可控内容直接灌进这个汇聚点 —— 这正是 vue/no-v-html 该拦的形态。
// 现在契约改成「每张 slide = 一组纯文本行」，模板用 {{ }} 插值，恶意内容只能作为文本出现。
defineProps<{
  slides: string[][]
}>()
</script>

<template>
  <div class="pptx-preview">
    <div v-if="slides.length === 0" class="pptx-empty">{{ tf('doc_slides_empty', '幻灯片为空') }}</div>
    <div v-else class="slide-list">
      <div v-for="(slide, idx) in slides" :key="idx" class="slide-card">
        <div class="slide-header">
          <span class="slide-num">{{ tf('doc_slide_page', '第 {n} 页', { n: idx + 1 }) }}</span>
        </div>
        <div class="slide-body">
          <!-- 文案与颜色与原 DocPreviewModal 里的常量 <p style="color:var(--text-tertiary)"> 一致；
               改为模板内文本节点后不再需要（也不再允许）内联 style。 -->
          <p v-if="slide.length === 0" class="slide-empty">(本页无可提取文本)</p>
          <p v-for="(line, li) in slide" :key="li">{{ line }}</p>
        </div>
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
/* slide-body 内部现在是本组件自己的 <p> 文本节点（不再是 v-html 注入），无需 :deep()；
   原先的 :deep(strong) / :deep(li) 规则随 v-html 一起移除——纯文本渲染下不可能再出现这些标签 */
.slide-body p {
  margin: 4px 0;
}
.slide-empty {
  color: var(--text-tertiary);
}
</style>
