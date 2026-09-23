// 内联 HTML 小工具（P0-C C3）
// 场景：组件用 v-html 渲染「一小段带高亮标记的纯文本」（模板 {{变量}} chip、AI 搜索命中 <mark>）。
// 这类 v-html 的安全性完全建立在「先转义、再只注入本项目自己写死的标签」这条不变式上，
// 而原先 esc()/highlightSnippet() 各有一份副本散在 4 个组件的 <script setup> 里 —— 放在
// SFC 内部就无法被单测覆盖，等于豁免理由只是一句注释。抽到这里后由
// utils/__tests__/vhtml-invariants.test.ts 直接证明「恶意输入不会变成活标签」。
//
// 分工：本文件只处理「本项目生成标签」的场景；需要容纳任意远端/剪贴板 HTML 的地方
// （markdown 预览、docx、xlsx、富文本片段）一律走 utils/html.ts 的 sanitizeHtml（DOMPurify）。

/**
 * 转义 HTML 敏感字符。仅可用于「内容将被当作文本节点展示」的场景；
 * 转义范围取 5 个字符（& < > " '），是各调用点原先 3 字符版本的超集，
 * 文本节点里 &quot;/&#39; 会正常还原成 " 和 '，显示结果不变。
 */
export function escapeHtmlText(raw: string): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 模板正文的 `{{变量}}` 高亮（.var-hl chip）。
 * 顺序不可颠倒：先整段转义、再在转义结果上做占位符替换，
 * 这样被 `<span>` 包住的变量名也一定是已转义过的文本。
 * @param collapseWhitespace 列表/详情预览压成一行（true）；生成对话框保留换行（false）
 */
export function highlightTemplateVars(raw: string, collapseWhitespace = true): string {
  const src = collapseWhitespace ? String(raw ?? '').replace(/\s+/g, ' ').trim() : String(raw ?? '')
  return escapeHtmlText(src).replace(
    /\{\{\s*([^:{}]+?)\s*\}\}/g,
    (_m, k) => `<span class="var-hl">{{${String(k).trim()}}}</span>`,
  )
}

/**
 * AI 会话搜索命中片段高亮：snippet 与关键词走同一套转义（保证「匹配用文本」与
 * 「展示用文本」同源，否则含 & < 的内容会错位），随后只注入固定的 `<mark>` 标签。
 * 早先实现用 \u0001 / \u0002 哨兵再于模板里 replace 成 <mark>：那会让「内容本身含
 * 这两个控制字符」的 snippet 凭空多出一对 <mark>，故改为一次替换到位。
 */
export function highlightSearchSnippet(snippet: string, keyword: string): string {
  const esc = escapeHtmlText(snippet)
  const k = String(keyword ?? '').trim()
  if (!k) return esc
  const re = escapeHtmlText(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return esc.replace(new RegExp(`(${re})`, 'gi'), '<mark>$1</mark>')
}
