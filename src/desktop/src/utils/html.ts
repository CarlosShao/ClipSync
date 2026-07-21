// HTML 安全预览工具
// 设计：与表格预览一致，HTML 预览是「渲染层」能力，不改后端 content_type
// （content_type 列有 CHECK 约束，且 HTML 本质是富文本的一种呈现方式）。
// 检测与净化都在前端完成：isHtmlContent 嗅探是否为富文本 HTML，
// sanitizeHtml 用 DOMPurify 净化后交给 v-html 渲染，杜绝 XSS。

import DOMPurify from 'dompurify'

const HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9]*(\s+[^>]*)*\/?>/

/**
 * 嗅探内容是否为富文本 HTML（而非代码/纯文本）。
 * - 至少出现一个 HTML 标签
 * - 排除「看起来像代码且标签极少」的情况（避免把含单个 <div> 的代码片段当 HTML）
 */
export function isHtmlContent(content: string): boolean {
  if (!content) return false
  const trimmed = content.trim()
  if (trimmed.length < 8) return false
  if (!HTML_TAG_RE.test(trimmed)) return false
  const tagCount = (trimmed.match(HTML_TAG_RE) || []).length
  const looksLikeCode = /\b(function|const|let|var|class|interface|import|export|return|=>|def |public |private |protected )\b/.test(trimmed)
  if (looksLikeCode && tagCount <= 2) return false
  return true
}

/**
 * 用 DOMPurify 净化 HTML，返回可安全交给 v-html 的字符串。
 * 禁止脚本/外联/事件处理器/内联样式，仅保留排版语义标签与基础属性。
 */
export function sanitizeHtml(content: string): string {
  try {
    return DOMPurify.sanitize(content, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'style', 'base', 'form'],
      FORBID_ATTR: [
        'onerror', 'onload', 'onclick', 'ondblclick', 'onmouseover', 'onmouseout',
        'onfocus', 'onblur', 'onchange', 'onsubmit', 'onkeydown', 'onkeyup',
        'style', 'srcset', 'formaction',
      ],
    })
  } catch {
    return ''
  }
}
