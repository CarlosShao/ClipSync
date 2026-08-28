<script setup lang="ts">
// Word (.docx) 预览：mammoth 把 .docx 转成 HTML（已含 <h1>-<h6> 标题与 id 锚点），
// 通过 v-html 注入；可选传入 toc 列表显示左侧目录（点击跳锚点）。
import { ref, nextTick, watch } from 'vue'
import type { TocItem } from '@/utils/docPreview'

const props = defineProps<{
  html: string
  toc?: TocItem[]
}>()

const contentRef = ref<HTMLElement | null>(null)
const activeId = ref('')

function scrollToToc(id: string) {
  if (!contentRef.value) return
  // .docx-preview 自身就是滚动容器：直接 scrollTo 目标标题，避免 scrollIntoView
  // 在外层 modal 嵌套滚动容器中滚动错层级
  const scroller = contentRef.value
  // id 由 ensureHeadingIds 注入（与 toc 同算法生成），querySelector 精确匹配
  const escaped = id.replace(/["\\]/g, '\\$&')
  const el = scroller.querySelector(`[id="${escaped}"]`) as HTMLElement | null
  if (el) {
    scroller.scrollTo({ top: Math.max(0, el.offsetTop - scroller.offsetTop - 8), behavior: 'smooth' })
    activeId.value = id
  }
}

// Mammoth 转换的 HTML 已包含 h1-h6 锚点，无需我们二次注入。
// DocPreviewModal 在拿到 docxHtml 时会同步调用 extractHtmlToc 抽 toc 列表。
watch(
  () => props.html,
  () => {
    activeId.value = ''
  },
)
nextTick(() => {
  // 初次挂载后默认无 activeId，由用户点击 toc 触发
})
</script>

<template>
  <div class="docx-preview-wrap">
    <div v-if="toc && toc.length > 0" class="docx-toc" :aria-label="'目录'">
      <div class="docx-toc-title">目录</div>
      <ul class="docx-toc-list">
        <li
          v-for="item in toc"
          :key="item.id"
          :class="['docx-toc-item', `depth-${item.depth}`, { active: activeId === item.id }]"
          @click="scrollToToc(item.id)"
        >
          <span class="docx-toc-text">{{ item.text }}</span>
        </li>
      </ul>
    </div>
    <div ref="contentRef" class="docx-preview markdown-body" v-html="html" />
  </div>
</template>

<style scoped>
.docx-preview-wrap {
  display: grid;
  grid-template-columns: minmax(180px, 220px) 1fr;
  gap: 14px;
  max-height: 500px;
}
@media (max-width: 720px) {
  .docx-preview-wrap {
    grid-template-columns: 1fr;
  }
}
.docx-toc {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  padding: 10px 12px;
  max-height: 500px;
  overflow: auto;
  font-size: 12px;
}
.docx-toc-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 8px;
}
.docx-toc-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.docx-toc-item {
  padding: 4px 0;
  cursor: pointer;
  color: var(--text-secondary);
  border-left: 2px solid transparent;
  padding-left: 6px;
  margin: 1px 0;
  transition: all 0.12s;
  line-height: 1.4;
}
.docx-toc-item:hover {
  color: var(--accent);
  border-left-color: var(--accent);
}
.docx-toc-item.active {
  color: var(--accent);
  border-left-color: var(--accent);
  font-weight: 600;
}
.docx-toc-item.depth-1 {
  font-weight: 600;
  font-size: 13px;
}
.docx-toc-item.depth-2 {
  padding-left: 14px;
}
.docx-toc-item.depth-3 {
  padding-left: 24px;
  font-size: 11px;
}
.docx-toc-item.depth-4 {
  padding-left: 34px;
  font-size: 11px;
  color: var(--text-tertiary);
}
.docx-toc-item.depth-5,
.docx-toc-item.depth-6 {
  padding-left: 44px;
  font-size: 11px;
  color: var(--text-tertiary);
}
.docx-toc-text {
  word-break: break-word;
}
.docx-preview {
  overflow-y: auto;
  max-height: 500px;
  padding: 4px 8px;
}
.docx-preview :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 8px 0;
}
.docx-preview :deep(th),
.docx-preview :deep(td) {
  border: 1px solid var(--border-default);
  padding: 4px 8px;
  text-align: left;
  font-size: 12px;
}
.docx-preview :deep(th) {
  background: var(--bg-hover);
  font-weight: 600;
}
.docx-preview :deep(p) {
  margin: 4px 0;
}
.docx-preview :deep(ul),
.docx-preview :deep(ol) {
  padding-left: 20px;
  margin: 4px 0;
}
.docx-preview :deep(h1),
.docx-preview :deep(h2),
.docx-preview :deep(h3),
.docx-preview :deep(h4) {
  scroll-margin-top: 8px;
}
</style>
