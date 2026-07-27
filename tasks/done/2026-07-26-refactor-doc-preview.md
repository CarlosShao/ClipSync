---
id: 2026-07-26-refactor-doc-preview
title: 提取 DocPreviewModal 预览子组件 + 重构 DocumentDrawer 复用
priority: done
status: done
source: manual
assignee: ''
module: desktop-frontend
tags:
  - refactor
  - vue
  - component-extraction
progress: 100
created: '2026-07-26'
updated: '2026-07-26'
lifecycle_id: ''
batchId: batch-20260726-refactor
---

## 目标
从 DocPreviewModal.vue（1205行）提取 8 个预览子组件，然后重构 DocumentDrawer.vue（1117行）复用这些子组件，消除两个文件的功能重叠。

## 拆分方案
从 DocPreviewModal.vue 提取以下子组件到 `src/components/doc-preview/` 目录：

| 子组件 | 职责 |
|---|---|
| MarkdownPreview.vue | Markdown 渲染 |
| CodePreview.vue | 代码高亮 |
| DocxPreview.vue | Word 文档渲染 |
| PdfPreview.vue | PDF 预览 |
| ExcelPreview.vue | Excel 表格 |
| PptxPreview.vue | PPT 幻灯片 |
| ImagePreview.vue | 图片预览 |

然后重构 DocumentDrawer.vue，复用这些子组件替代其内部的重复实现。

## 验收标准
- [ ] DocPreviewModal.vue 行数减少到 300 行以下
- [ ] DocumentDrawer.vue 行数减少到 400 行以下
- [ ] 8 个预览子组件在 `src/components/doc-preview/` 目录下
- [ ] DocPreviewModal 和 DocumentDrawer 功能完整，无回归
- [ ] 所有文档格式预览正常（md/docx/pdf/xlsx/pptx/image）
- [ ] 构建通过，无 TypeScript 错误
