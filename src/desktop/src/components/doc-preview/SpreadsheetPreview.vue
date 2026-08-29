<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'

const { tf } = useI18n()
// Excel 表格预览：xlsx 库 sheet_to_html 输出的多 sheet 表格，按 sheet 标签切换。
// 表格 HTML 由 DocPreviewModal 加载 ArrayBuffer 后动态生成并传入；
// 本组件只负责渲染 + 切换 sheet，不依赖网络。
//
// ⚠️ sheet_to_html 输出的是裸 <tr><td>（没有 <thead>/<th>），
// 而 Chromium 里 position:sticky 需要明确的表头结构才能吸顶 ——
// ensureThead 把每张表的第一行包进 <thead>，否则"表头吸顶"无从生效。

const props = defineProps<{
  sheets: { name: string; html: string }[]
  activeIdx: number
}>()

const emit = defineEmits<{
  'update:active-idx': [idx: number]
}>()

function ensureThead(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
    doc.querySelectorAll('table').forEach((tb) => {
      if (tb.querySelector('thead')) return
      const firstRow = tb.querySelector('tr')
      if (!firstRow) return
      const thead = doc.createElement('thead')
      tb.insertBefore(thead, firstRow)
      thead.appendChild(firstRow)
    })
    return doc.getElementById('root')?.innerHTML ?? html
  } catch {
    return html
  }
}

const processedSheets = computed(() => props.sheets.map((s) => ({ ...s, html: ensureThead(s.html) })))

function selectSheet(idx: number) {
  emit('update:active-idx', idx)
}
</script>

<template>
  <div class="spreadsheet-preview">
    <div v-if="sheets.length > 1" class="sheet-tabs">
      <button
        v-for="(sheet, idx) in sheets"
        :key="sheet.name"
        type="button"
        class="sheet-tab"
        :class="{ active: idx === activeIdx }"
        :title="sheet.name"
        @click="selectSheet(idx)"
      >
        {{ sheet.name }}
      </button>
    </div>
    <div v-else-if="sheets.length === 1" class="sheet-tabs sheet-single">
      <span class="sheet-tab sheet-tab-static">{{ sheets[0].name }}</span>
    </div>

    <div class="sheet-body">
      <!-- sheet_to_html 输出的是完整 <table>（经 ensureThead 注入表头），以 v-html 注入 -->
      <div v-if="processedSheets[activeIdx]" class="sheet-html" v-html="processedSheets[activeIdx].html" />
      <div v-else class="sheet-empty">{{ tf('doc_no_content', '无内容') }}</div>
    </div>
  </div>
</template>

<style scoped>
.spreadsheet-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 70vh;
}
.sheet-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-subtle);
}
.sheet-single {
  padding-bottom: 0;
  border-bottom: none;
}
.sheet-tab {
  padding: 4px 12px;
  font-size: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.12s;
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sheet-tab:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.sheet-tab.active {
  background: var(--accent-bg);
  color: var(--accent);
  border-color: var(--accent);
  font-weight: 600;
}
.sheet-tab-static {
  cursor: default;
  background: var(--bg-hover);
  font-weight: 600;
  color: var(--text-primary);
}
.sheet-body {
  flex: 1;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  min-height: 0;
}
.sheet-html {
  padding: 8px;
}
.sheet-empty {
  padding: 40px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}
/* sheet_to_html 生成的 table 没有样式，这里补齐。
   ⚠️ 必须用 border-collapse: separate —— Chromium 里 collapse 会让
   thead/th 的 position: sticky 静默失效（表头不吸顶的根因）。
   配合 border-spacing: 0 + 单边单元格边框保持与 collapse 相近的观感 */
.sheet-html :deep(table) {
  border-collapse: separate;
  border-spacing: 0;
  width: max-content;
  max-width: 100%;
  font-size: 12px;
}
.sheet-html :deep(thead) {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  /* 不透明底层：吸顶滚动时行内容不能从半透明表头里透出来 */
  background: var(--bg-surface);
}
.sheet-html :deep(thead td),
.sheet-html :deep(thead th) {
  background: var(--bg-hover);
  font-weight: 600;
  color: var(--text-primary);
}
.sheet-html :deep(th),
.sheet-html :deep(td) {
  border-right: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
  padding: 4px 10px;
  text-align: left;
  white-space: nowrap;
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sheet-html :deep(tr) :deep(th:first-child),
.sheet-html :deep(tr) :deep(td:first-child) {
  border-left: 1px solid var(--border-subtle);
}
.sheet-html :deep(thead th) {
  border-top: 1px solid var(--border-subtle);
}
.sheet-html :deep(th) {
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-hover);
}
.sheet-html :deep(tr:nth-child(even)) {
  background: var(--bg-hover);
}
.sheet-html :deep(td) {
  color: var(--text-secondary);
}
</style>
