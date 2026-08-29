// === 文档预览纯函数辅助（Markdown/代码高亮/文件类型检测/TOC 提取）===
import { marked } from 'marked'
import hljs from 'highlight.js'

// Configure marked once for the preview pipeline
marked.setOptions({
  gfm: true,
  breaks: false,
})

/** Render markdown to HTML with heading anchors for TOC */
export function renderMarkdown(text: string): string {
  if (!text) return ''
  try {
    // Custom renderer: add id to headings for TOC anchor links
    const renderer = new marked.Renderer()
    renderer.heading = function ({ text, depth }: { text: string; depth: number }) {
      const raw = String(text).replace(/<[^>]+>/g, '')
      const id = raw
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff]+/g, '-')
        .replace(/^-|-$/g, '')
      return `<h${depth} id="${id}">${text}</h${depth}>`
    }
    return marked.parse(text, { renderer }) as string
  } catch (e) {
    console.error('[Preview] marked.parse error:', e)
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  }
}

/** Detect file type from filename extension */
export function detectFileType(
  filename: string,
): 'markdown' | 'code' | 'text' | 'docx' | 'excel' | 'pptx' | 'pdf' | 'image' | 'unsupported' {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  if (['md', 'markdown', 'mdx', 'rst'].includes(ext)) return 'markdown'
  if (
    [
      'js',
      'ts',
      'jsx',
      'tsx',
      'py',
      'java',
      'go',
      'rs',
      'c',
      'cpp',
      'h',
      'cs',
      'html',
      'css',
      'scss',
      'less',
      'json',
      'yaml',
      'yml',
      'xml',
      'toml',
      'sql',
      'sh',
      'bash',
      'zsh',
      'ps1',
      'bat',
      'cmd',
      'rb',
      'php',
      'swift',
      'kt',
      'scala',
      'r',
      'lua',
      'vim',
      'dockerfile',
      'makefile',
      'ini',
      'env',
      'vue',
      'svelte',
      'dart',
      'ex',
      'exs',
      'clj',
      'hs',
      'nim',
      'zig',
      'wasm',
      'proto',
      'graphql',
      'tf',
      'hcl',
      'erl',
      'ml',
      'mli',
      'f90',
      'f95',
    ].includes(ext)
  )
    return 'code'
  if (['txt', 'log', 'csv', 'tsv', 'cfg', 'conf', 'properties', 'tex', 'latex', 'org'].includes(ext)) return 'text'
  if (['doc', 'docx', 'pages', 'key', 'numbers', 'odt', 'rtf'].includes(ext)) return 'docx'
  if (['xls', 'xlsx', 'xlsm', 'xlsb'].includes(ext)) return 'excel'
  if (['ppt', 'pptx'].includes(ext)) return 'pptx'
  if (['pdf', 'epub', 'mobi', 'azw3', 'djvu'].includes(ext)) return 'pdf'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'avif', 'heic'].includes(ext)) return 'image'
  return 'unsupported'
}

/** Get language name for highlight.js from file extension */
export function getLangFromExt(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    jsx: 'javascript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    cs: 'csharp',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    toml: 'ini',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    r: 'r',
    lua: 'lua',
    vue: 'html',
    svelte: 'html',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    ini: 'ini',
    env: 'bash',
    bat: 'batch',
    cmd: 'batch',
    ps1: 'powershell',
    dart: 'dart',
    ex: 'elixir',
    exs: 'elixir',
    clj: 'clojure',
    hs: 'haskell',
    nim: 'nim',
    zig: 'zig',
    wasm: 'wasm',
    proto: 'protobuf',
    graphql: 'graphql',
    tf: 'hcl',
    hcl: 'hcl',
    erl: 'erlang',
    ml: 'ocaml',
    mli: 'ocaml',
    f90: 'fortran',
    f95: 'fortran',
    tex: 'latex',
    latex: 'latex',
    vim: 'vim',
  }
  return map[ext] || ext
}

/** Auto-detect language from content (fallback when no filename) */
export function detectLangFromContent(content: string): string {
  const trimmed = content.trim()
  if (/^\s*[{[]/.test(trimmed) && /"\w+"/.test(trimmed)) return 'json'
  if (/^\s*<\?xml/.test(trimmed)) return 'xml'
  if (/^\s*<!DOCTYPE|<html/i.test(trimmed)) return 'html'
  if (/^\s*import\s/.test(trimmed) || /^\s*from\s+\w+\s+import/.test(trimmed)) return 'python'
  if (/^\s*(const|let|var|function|class|export|import)\s/.test(trimmed)) return 'javascript'
  if (/^\s*(def|class|import|from)\s/.test(trimmed)) return 'python'
  if (/^\s*(public|private|protected)\s/.test(trimmed)) return 'java'
  if (/^\s*#include/.test(trimmed)) return 'c'
  if (/^\s*(fn|let|mut|use|pub)\s/.test(trimmed)) return 'rust'
  if (/^\s*(func|package|import)\s/.test(trimmed)) return 'go'
  return 'plaintext'
}

/** Extract headings from markdown for TOC — skips code blocks */
export interface TocItem {
  id: string
  text: string
  depth: number
}
export function extractToc(markdown: string): TocItem[] {
  const items: TocItem[] = []
  const lines = markdown.split('\n')
  let inCodeBlock = false
  for (const line of lines) {
    // Track fenced code blocks (``` or ~~~)
    if (/^```/.test(line) || /^~~~/.test(line)) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) continue
    // Skip indented lines (likely code)
    if (/^\s{4,}/.test(line)) continue
    const match = line.match(/^(#{1,6})\s+(.+)$/)
    if (match) {
      const depth = match[1].length
      const text = match[2].replace(/[*_`]/g, '')
      const id = text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff]+/g, '-')
        .replace(/^-|-$/g, '')
      items.push({ id, text, depth })
    }
  }
  return items
}

/**
 * Extract TOC from HTML (e.g. mammoth output for .docx) — picks <h1>–<h6> with
 * existing id or auto-generated id from text content. Used to give docx/word
 * previews the same left-side TOC that markdown previews already have.
 */
export function extractHtmlToc(html: string): TocItem[] {
  if (!html) return []
  const items: TocItem[] = []
  // Match each heading with optional existing id="..." attribute
  const headingRegex = /<h([1-6])(?:\s+id="([^"]*)")?[^>]*>([\s\S]*?)<\/h\1>/gi
  const seenIds = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = headingRegex.exec(html)) !== null) {
    const depth = parseInt(m[1], 10)
    const explicitId = m[2] || ''
    // Strip nested tags from heading text
    const rawText = String(m[3])
      .replace(/<[^>]+>/g, '')
      .trim()
    if (!rawText) continue
    let id = explicitId
    if (!id) {
      id = rawText
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff]+/g, '-')
        .replace(/^-|-$/g, '')
    }
    // Ensure unique ids — duplicate (rare) suffixed -1, -2
    let uniqueId = id
    let n = 1
    while (seenIds.has(uniqueId)) uniqueId = `${id}-${n++}`
    seenIds.add(uniqueId)
    items.push({ id: uniqueId, text: rawText, depth })
  }
  return items
}

/**
 * Inject id="..." attributes into heading tags so the extracted TOC can
 * anchor-jump to them. Uses the SAME id generator as extractHtmlToc, so the
 * TOC item id always matches an element id in the rendered HTML.
 * Existing ids are preserved and deduplicated.
 */
export function ensureHeadingIds(html: string): string {
  if (!html) return html
  const seenIds = new Set<string>()
  return html.replace(/<h([1-6])(\b[^>]*)>([\s\S]*?)<\/h\1>/gi, (_full, depth, attrs, inner) => {
    // Already has an id — keep it (and register for dedup)
    const existing = attrs.match(/\bid="([^"]*)"/i)
    if (existing && existing[1]) {
      seenIds.add(existing[1])
      return _full
    }
    // Generate id from the heading text (strip any nested tags)
    const text = String(inner)
      .replace(/<[^>]+>/g, '')
      .trim()
    let id = text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]+/g, '-')
      .replace(/^-|-$/g, '')
    if (!id) id = `heading-${Math.random().toString(36).slice(2, 6)}`
    // Dedup: append -1, -2...
    let uniqueId = id
    let n = 1
    while (seenIds.has(uniqueId)) uniqueId = `${id}-${n++}`
    seenIds.add(uniqueId)
    return `<h${depth} id="${uniqueId}"${attrs}>${inner}</h${depth}>`
  })
}

/** Render code with highlight.js */
export function renderCode(content: string, filename?: string): string {
  const lang = filename ? getLangFromExt(filename) : detectLangFromContent(content)
  try {
    if (lang && lang !== 'plaintext' && hljs.getLanguage(lang)) {
      return hljs.highlight(content, { language: lang }).value
    }
    return hljs.highlightAuto(content).value
  } catch {
    return content.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}
