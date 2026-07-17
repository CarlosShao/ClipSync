<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { X, FileText } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import Badge from '@/components/ui/badge/Badge.vue'
import { api, apiBlob } from '@/api/client'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
import * as tauri from '@/lib/tauri'
import { Marked } from 'marked'
import hljs from 'highlight.js'
import mammoth from 'mammoth'
import * as pdfjsLib from 'pdfjs-dist'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href

const props = defineProps<{
  open: boolean
  item: any // ClipItem
}>()
const emit = defineEmits<{
  'close': []
}>()

// ===== Markdown setup =====
const marked = new Marked()
marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    heading({ text, depth }: { text: string; depth: number }) {
      const raw = String(text).replace(/<[^>]+>/g, '')
      const id = raw.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
      return `<h${depth} id="${id}">${text}</h${depth}>`
    },
  },
})

function renderMarkdown(text: string): string {
  if (!text) return ''
  try {
    return marked.parse(text) as string
  } catch (e) {
    console.error('[Drawer] marked error:', e)
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  }
}

// ===== State =====
const loading = ref(false)
const content = ref('')
const fileName = ref('')
const docType = ref<'markdown' | 'code' | 'text' | 'docx' | 'pdf' | 'excel' | 'pptx' | 'image' | 'unsupported'>('text')
const toc = ref<{ id: string; text: string; depth: number }[]>([])
const docxHtml = ref('')
const pdfPages = ref<{ num: number; dataUrl: string }[]>([])
const pdfTotalPages = ref(0)
const imageDataUrl = ref('')
const excelSheets = ref<{ name: string; html: string }[]>([])
const activeSheetIdx = ref(0)
const docxToc = ref<{ id: string; text: string; depth: number }[]>([])
const pptxSlides = ref<string[]>([])

// ===== File type detection =====
function detectType(filename: string): typeof docType.value {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown'
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'cs',
       'html', 'css', 'scss', 'less', 'json', 'yaml', 'yml', 'xml', 'toml',
       'sql', 'sh', 'bash', 'rb', 'php', 'swift', 'kt', 'scala', 'r', 'lua',
       'vue', 'svelte', 'dockerfile', 'makefile', 'ini', 'env'].includes(ext)) return 'code'
  if (['txt', 'log', 'csv', 'tsv', 'cfg', 'conf', 'properties'].includes(ext)) return 'text'
  if (['docx', 'doc'].includes(ext)) return 'docx'
  if (['xls', 'xlsx', 'xlsm', 'xlsb', 'csv'].includes(ext)) return 'excel'
  if (['pptx'].includes(ext)) return 'pptx'
  if (['pdf'].includes(ext)) return 'pdf'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff'].includes(ext)) return 'image'
  return 'unsupported'
}

function getLangFromExt(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', cs: 'csharp',
    html: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', toml: 'ini',
    sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
    php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
    r: 'r', lua: 'lua', vue: 'html', svelte: 'html',
    dockerfile: 'dockerfile', makefile: 'makefile',
    ini: 'ini', env: 'bash',
  }
  return map[ext] || ext
}

function detectLangFromContent(c: string): string {
  const t = c.trim()
  if (/^\s*[{[]/.test(t) && /"\w+"/.test(t)) return 'json'
  if (/^\s*<\?xml/.test(t)) return 'xml'
  if (/^\s*<!DOCTYPE|<html/i.test(t)) return 'html'
  if (/^\s*import\s/.test(t) || /^\s*from\s+\w+\s+import/.test(t)) return 'python'
  if (/^\s*(const|let|var|function|class|export|import)\s/.test(t)) return 'javascript'
  if (/^\s*(def|class|import|from)\s/.test(t)) return 'python'
  if (/^\s*(public|private|protected)\s/.test(t)) return 'java'
  if (/^\s*#include/.test(t)) return 'c'
  if (/^\s*(fn|let|mut|use|pub)\s/.test(t)) return 'rust'
  if (/^\s*(func|package|import)\s/.test(t)) return 'go'
  return 'plaintext'
}

function renderCode(c: string, filename?: string): string {
  const lang = filename ? getLangFromExt(filename) : detectLangFromContent(c)
  try {
    if (lang && lang !== 'plaintext' && hljs.getLanguage(lang)) {
      return hljs.highlight(c, { language: lang }).value
    }
    return hljs.highlightAuto(c).value
  } catch {
    return c.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}

// ===== TOC extraction =====
function extractToc(md: string): { id: string; text: string; depth: number }[] {
  const items: { id: string; text: string; depth: number }[] = []
  const lines = md.split(/\r?\n/)
  let inCode = false
  for (const line of lines) {
    if (/^```/.test(line) || /^~~~/.test(line)) { inCode = !inCode; continue }
    if (inCode) continue
    if (/^\s{4,}/.test(line)) continue
    const m = line.match(/^(#{1,6})\s+(.+)$/)
    if (m) {
      const depth = m[1].length
      const text = m[2].replace(/[*_`]/g, '')
      const id = text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
      items.push({ id, text, depth })
    }
  }
  return items
}

function scrollToHeading(id: string) {
  nextTick(() => {
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

// ===== Content loading =====
async function loadContent(item: any) {
  console.log('[Drawer] loadContent called, item:', item?.id, 'content:', item?.content?.slice(0, 80))
  if (!item?.id) return

  // Parse filename
  try {
    const meta = JSON.parse(item.content)
    fileName.value = meta.name || item.content?.slice(0, 50) || 'Untitled'
  } catch {
    fileName.value = item.content || 'Untitled'
  }

  docType.value = detectType(fileName.value)
  console.log('[Drawer] fileName:', fileName.value, 'docType:', docType.value)
  content.value = ''
  toc.value = []
  docxHtml.value = ''
  pdfPages.value = []
  imageDataUrl.value = ''
  excelSheets.value = []
  activeSheetIdx.value = 0
  docxToc.value = []
  pptxSlides.value = []

  if (docType.value === 'unsupported') return

  loading.value = true
  try {
    if (docType.value === 'image') {
      await loadImage(item)
    } else if (['docx', 'doc', 'pdf', 'excel', 'pptx'].includes(docType.value)) {
      await loadBinary(item)
    } else {
      await loadText(item)
    }
  } catch (e) {
    console.error('[Drawer] Load error:', e)
    content.value = '[Failed to load file]'
  }
  loading.value = false
}

async function loadText(item: any) {
  const res = await api('GET', `/api/clipboard/${item.id}`)
  if (res.ok && res.data?.contentEncrypted) {
    let c = res.data.contentEncrypted

    // Case 1: content is a path array (clipboard monitor uploads)
    try {
      const parsed = JSON.parse(c)
      if (Array.isArray(parsed) && parsed[0] && (parsed[0].includes('\\') || parsed[0].includes('/'))) {
        try { c = await tauri.readFileContent(parsed[0]) } catch { /* keep as-is */ }
      }
    } catch { /* not JSON */ }

    // Case 2: content is a UUID filename (file picker uploads via /api/media/file)
    // UUID format: 8-4-4-4-12 hex chars
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(c.trim())) {
      console.log('[Drawer] Detected UUID, fetching from download endpoint...')
      try {
        const blobRes = await apiBlob('GET', `/api/media/${item.id}/download`)
        if (blobRes && blobRes.ok) {
          c = await blobRes.text()
          console.log('[Drawer] Downloaded content:', c.length, 'chars, first 200:', c.slice(0, 200))
        } else {
          console.log('[Drawer] Download failed:', blobRes?.status)
        }
      } catch (e) { console.log('[Drawer] Download error:', e) }
    } else {
      console.log('[Drawer] Not UUID, using content directly:', c.length, 'chars')
    }

    content.value = c
    console.log('[Drawer] Content set:', c.length, 'chars')
    if (docType.value === 'markdown') {
      toc.value = extractToc(c)
      console.log('[Drawer] TOC:', toc.value.length, 'items, docType:', docType.value)
    }
  }
}

async function loadImage(item: any) {
  const res = await api('GET', `/api/clipboard/${item.id}`)
  if (res.ok && res.data?.contentEncrypted) {
    let filePath = ''
    try {
      const parsed = JSON.parse(res.data.contentEncrypted)
      if (Array.isArray(parsed) && parsed[0]) filePath = parsed[0]
    } catch {
      if (res.data.contentEncrypted.includes('\\') || res.data.contentEncrypted.includes('/')) {
        filePath = res.data.contentEncrypted
      }
    }
    if (filePath) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const base64: string = await invoke('read_file_content_base64', { path: filePath })
        if (base64) {
          const ext = filePath.split('.').pop()?.toLowerCase() || 'png'
          const mimeMap: Record<string, string> = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', bmp:'image/bmp' }
          imageDataUrl.value = `data:${mimeMap[ext] || 'image/png'};base64,${base64}`
        }
      } catch (e) { console.error('[Drawer] Image load error:', e) }
    }
  }
}

async function loadBinary(item: any) {
  // Check if content is a local file path
  const apiRes = await api('GET', `/api/clipboard/${item.id}`)
  let filePath = ''
  if (apiRes.ok && apiRes.data?.contentEncrypted) {
    try {
      const parsed = JSON.parse(apiRes.data.contentEncrypted)
      if (Array.isArray(parsed) && parsed[0]) filePath = parsed[0]
    } catch {
      if (apiRes.data.contentEncrypted.includes('\\') || apiRes.data.contentEncrypted.includes('/')) {
        filePath = apiRes.data.contentEncrypted
      }
    }
  }

  let arrayBuffer: ArrayBuffer | null = null
  if (filePath) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const base64: string = await invoke('read_file_content_base64', { path: filePath })
      if (base64) arrayBuffer = Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer
    } catch { /* fallback */ }
  }
  if (!arrayBuffer) {
    const blobRes = await apiBlob('GET', `/api/media/${item.id}/download`)
    if (blobRes && blobRes.ok) arrayBuffer = await blobRes.arrayBuffer()
  }

  if (!arrayBuffer) { content.value = t('drawer_file_fail'); return }

  // === Word (.docx / .doc) ===
  if (docType.value === 'docx') {
    const isOldDoc = fileName.value.toLowerCase().endsWith('.doc') && !fileName.value.toLowerCase().endsWith('.docx')
    if (isOldDoc) {
      docxHtml.value = `<div style="text-align:center;padding:40px 20px;color:var(--text-tertiary)">
        <p style="font-size:15px;margin-bottom:8px">${t('drawer_doc_old')}</p>
      </div>`
    } else {
      try {
        const result = await mammoth.convertToHtml({ arrayBuffer })
        let html = result.value || `<p style="color:var(--text-tertiary)">${t('drawer_doc_empty')}</p>`
        // Add IDs to headings for TOC anchor links
        html = html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi, (match: string, level: string, attrs: string, text: string) => {
          const plainText = text.replace(/<[^>]+>/g, '').trim()
          const id = plainText.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
          return `<h${level} id="${id}"${attrs}>${text}</h${level}>`
        })
        docxHtml.value = html
        docxToc.value = extractDocxToc(html)
      } catch { docxHtml.value = `<p style="color:var(--danger)">${t('drawer_doc_fail')}</p>` }
    }
  }
  // === PDF ===
  else if (docType.value === 'pdf') {
    try {
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
      pdfTotalPages.value = pdf.numPages
      const max = Math.min(pdf.numPages, 30)
      for (let i = 1; i <= max; i++) {
        const page = await pdf.getPage(i)
        const viewport = page.getViewport({ scale: 1.5 })
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext('2d')!
        await page.render({ canvasContext: ctx, viewport, canvas }).promise
        pdfPages.value.push({ num: i, dataUrl: canvas.toDataURL('image/png') })
      }
    } catch (e) { console.error('[Drawer] PDF error:', e) }
  }
  // === Excel (.xlsx / .xls) ===
  else if (docType.value === 'excel') {
    try {
      const workbook = XLSX.read(arrayBuffer, { type: 'array' })
      excelSheets.value = workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name]
        return { name, html: XLSX.utils.sheet_to_html(sheet, { editable: false }) }
      })
      activeSheetIdx.value = 0
    } catch (e) { console.error('[Drawer] Excel error:', e) }
  }
  // === PowerPoint (.pptx) ===
  else if (docType.value === 'pptx') {
    try {
      pptxSlides.value = await extractPptxText(arrayBuffer)
    } catch (e) { console.error('[Drawer] PPTX error:', e); pptxSlides.value = [`<p style="color:var(--danger)">${t('drawer_pptx_fail')}</p>`] }
  }
}

/** Extract text from .pptx using JSZip → parse slide XML for text content */
async function extractPptxText(buf: ArrayBuffer): Promise<string[]> {
  try {
    const zip = await JSZip.loadAsync(buf)
    const slideFiles = Object.keys(zip.files).filter(f => f.match(/ppt\/slides\/slide\d+\.xml$/)).sort()
    const slides: string[] = []
    for (const slideFile of slideFiles) {
      const xml = await zip.file(slideFile)!.async('text')
      // Extract text from <a:t> tags (PowerPoint text runs)
      const textParts: string[] = []
      const regex = /<a:t>([^<]*)<\/a:t>/g
      let match
      while ((match = regex.exec(xml)) !== null) {
        if (match[1].trim()) textParts.push(escapeHtml(match[1]))
      }
      slides.push(`<div class="pptx-slide"><div class="pptx-slide-num">${slideFile.match(/slide(\d+)/)?.[1] || ''}</div><div class="pptx-slide-text">${textParts.join('<br>')}</div></div>`)
    }
    return slides.length > 0 ? slides : [`<p style="color:var(--text-tertiary)">${t('drawer_pptx_no_slides')}</p>`]
  } catch (e) {
    console.error('[Drawer] PPTX parse error:', e)
    return ['<p style="color:var(--danger)">Failed to parse presentation</p>']
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Extract headings from mammoth HTML for DOCX TOC */
function extractDocxToc(html: string): { id: string; text: string; depth: number }[] {
  const items: { id: string; text: string; depth: number }[] = []
  const regex = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi
  let match
  while ((match = regex.exec(html)) !== null) {
    const depth = parseInt(match[1])
    const text = match[2].replace(/<[^>]+>/g, '').trim()
    if (text) {
      const id = text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
      items.push({ id, text, depth })
    }
  }
  return items
}

// ===== Watch for open =====
// 组件改为 v-if 门控后，挂载时 open 已为 true，必须 immediate 否则漏触发首次加载
watch(() => props.open, (v) => {
  if (v && props.item) loadContent(props.item)
}, { immediate: true })
watch(() => props.item, (item) => {
  if (props.open && item) loadContent(item)
})

// ===== Computed =====
const typeLabel = computed(() => {
  const map: Record<string, string> = {
    markdown: 'Markdown', code: 'Code', text: 'Text',
    docx: 'Word', pdf: 'PDF', excel: 'Excel', pptx: 'PPT',
    image: 'Image', unsupported: 'Unsupported',
  }
  return map[docType.value] || docType.value
})

const contentLines = computed(() => {
  if (!content.value) return []
  return content.value.split('\n').slice(0, 1000)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="open" class="drawer-overlay" @click.self="emit('close')">
        <div class="drawer-panel">
          <!-- Header -->
          <div class="drawer-header">
            <div class="drawer-header-left">
              <FileText :size="18" class="drawer-header-icon" />
              <span class="drawer-header-title">{{ fileName }}</span>
              <Badge variant="outline" class="drawer-type-badge">{{ typeLabel }}</Badge>
            </div>
            <Button variant="ghost" size="icon-sm" @click="emit('close')" class="drawer-close-btn">
              <X :size="18" />
            </Button>
          </div>

          <!-- Loading -->
          <div v-if="loading" class="drawer-loading">
            <div class="drawer-spinner" />
            <span>{{ t('drawer_loading') }}</span>
          </div>

          <!-- Content -->
          <div v-else class="drawer-body">
            <!-- Unsupported -->
            <div v-if="docType === 'unsupported'" class="drawer-unsupported">
              <FileText :size="40" style="color:var(--text-tertiary);margin-bottom:12px" />
              <p>{{ t('drawer_unsupported') }}</p>
            </div>

            <!-- Markdown with TOC -->
            <div v-else-if="docType === 'markdown'" class="drawer-markdown-layout">
              <nav v-if="toc.length > 0" class="drawer-toc">
                <div class="drawer-toc-title">{{ t('drawer_toc') }}</div>
                <a v-for="t in toc" :key="t.id" class="drawer-toc-item"
                   :class="'drawer-toc-depth-' + t.depth"
                   @click.prevent="scrollToHeading(t.id)">
                  {{ t.text }}
                </a>
              </nav>
              <div class="drawer-markdown-content markdown-body" v-html="renderMarkdown(content)"></div>
            </div>

            <!-- Code -->
            <div v-else-if="docType === 'code'" class="drawer-code">
              <div class="drawer-code-lines">
                <span v-for="(_, i) in contentLines" :key="i" class="drawer-line-num">{{ i + 1 }}</span>
              </div>
              <pre class="drawer-code-content"><code v-html="renderCode(content, fileName)"></code></pre>
            </div>

            <!-- Text -->
            <div v-else-if="docType === 'text'" class="drawer-text">{{ content }}</div>

            <!-- Word (.docx / .doc) with optional TOC -->
            <div v-else-if="docType === 'docx'" class="drawer-docx-layout">
              <nav v-if="docxToc.length > 0" class="drawer-toc">
                <div class="drawer-toc-title">{{ t('drawer_toc') }}</div>
                <a v-for="item in docxToc" :key="item.id" class="drawer-toc-item"
                   :class="'drawer-toc-depth-' + item.depth"
                   @click.prevent="scrollToHeading(item.id)">
                  {{ item.text }}
                </a>
              </nav>
              <div class="drawer-docx markdown-body" v-html="docxHtml"></div>
            </div>

            <!-- Excel (.xlsx / .xls) -->
            <div v-else-if="docType === 'excel'" class="drawer-excel-wrap">
              <div v-if="excelSheets.length > 1" class="drawer-excel-tabs">
                <button v-for="(sheet, i) in excelSheets" :key="i"
                  class="drawer-excel-tab" :class="{ active: activeSheetIdx === i }"
                  @click="activeSheetIdx = i">{{ sheet.name }}</button>
              </div>
              <div class="drawer-excel-content" v-if="excelSheets.length > 0" v-html="excelSheets[activeSheetIdx]?.html"></div>
              <div v-else class="drawer-unsupported"><p>{{ t('drawer_xlsx_empty') }}</p></div>
            </div>

            <!-- PowerPoint (.pptx) -->
            <div v-else-if="docType === 'pptx'" class="drawer-pptx">
              <div v-for="(slide, i) in pptxSlides" :key="i" class="drawer-pptx-slide" v-html="slide"></div>
            </div>

            <!-- PDF -->
            <div v-else-if="docType === 'pdf'" class="drawer-pdf">
              <div v-if="pdfTotalPages > 30" class="drawer-pdf-info">{{ t('drawer_pdf_pages', { n: 30, total: pdfTotalPages }) }}</div>
              <div v-for="page in pdfPages" :key="page.num" class="drawer-pdf-page">
                <img :src="page.dataUrl" :alt="'Page ' + page.num" class="drawer-pdf-img" />
                <span class="drawer-pdf-num">{{ page.num }}</span>
              </div>
            </div>

            <!-- Image -->
            <div v-else-if="docType === 'image' && imageDataUrl" class="drawer-image">
              <img :src="imageDataUrl" :alt="fileName" class="drawer-image-img" />
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Overlay */
.drawer-overlay {
  position: fixed; inset: 0; z-index: 9990;
  background: rgba(0,0,0,0.3); display: flex; justify-content: flex-end;
  animation: fadeIn .2s ease;
}
/* Panel */
.drawer-panel {
  width: 60vw; min-width: 480px; max-width: 960px; height: 100vh; background: var(--bg-surface);
  border-left: 1px solid var(--border-subtle); display: flex; flex-direction: column;
  box-shadow: -4px 0 24px rgba(0,0,0,0.12);
  animation: slideInRight .25s ease;
}
/* Header */
.drawer-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 20px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0;
}
.drawer-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
.drawer-header-icon { color: var(--text-tertiary); flex-shrink: 0; }
.drawer-header-title {
  font-size: 15px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.drawer-type-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; flex-shrink: 0; }
.drawer-close-btn { color: var(--text-tertiary); }

/* Loading */
.drawer-loading {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; flex: 1; color: var(--text-tertiary); font-size: 13px;
}
.drawer-spinner {
  width: 24px; height: 24px; border: 2px solid var(--border-default);
  border-top-color: var(--accent); border-radius: 50%; animation: spin .6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Body */
.drawer-body { flex: 1; overflow-y: auto; }

/* Unsupported */
.drawer-unsupported {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 60px 20px; color: var(--text-tertiary); font-size: 13px;
}

/* Markdown + TOC */
.drawer-markdown-layout { display: flex; height: 100%; }
.drawer-toc {
  width: 220px; min-width: 180px; flex-shrink: 0; border-right: 1px solid var(--border-subtle);
  padding: 16px 0; overflow-y: auto; background: var(--bg-surface);
}
.drawer-toc-title {
  font-size: 11px; font-weight: 600; color: var(--text-tertiary);
  text-transform: uppercase; letter-spacing: .05em; padding: 0 16px 10px;
}
.drawer-toc-item {
  display: block; font-size: 12px; color: var(--text-secondary); text-decoration: none;
  padding: 3px 16px; cursor: pointer; transition: color .15s, background .15s;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.5;
}
.drawer-toc-item:hover { color: var(--accent); background: var(--bg-hover); }
.drawer-toc-depth-1 { font-weight: 600; padding-left: 16px; }
.drawer-toc-depth-2 { padding-left: 28px; }
.drawer-toc-depth-3 { padding-left: 40px; font-size: 11px; }
.drawer-toc-depth-4, .drawer-toc-depth-5, .drawer-toc-depth-6 { padding-left: 52px; font-size: 11px; color: var(--text-tertiary); }
.drawer-markdown-content {
  flex: 1; overflow-y: auto; padding: 24px 32px; min-width: 0;
}

/* Code */
.drawer-code { display: flex; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace; font-size: 13px; }
.drawer-code-lines {
  display: flex; flex-direction: column; padding: 16px 0 16px 16px;
  border-right: 1px solid var(--border-subtle); user-select: none; flex-shrink: 0;
}
.drawer-line-num {
  font-size: 12px; color: var(--text-tertiary); line-height: 1.65;
  text-align: right; min-width: 36px; padding-right: 12px;
}
.drawer-code-content {
  margin: 0; padding: 16px; font-size: 13px; line-height: 1.65;
  color: var(--text-primary); white-space: pre; overflow-x: auto; flex: 1;
  background: transparent; border: none;
}

/* Text */
.drawer-text {
  padding: 24px 32px; white-space: pre-wrap; word-break: break-word;
  font-size: 14px; line-height: 1.7; color: var(--text-primary);
}

/* Word */
.drawer-docx-layout { display: flex; height: 100%; }
.drawer-docx { padding: 24px 32px; flex: 1; overflow-y: auto; }
.drawer-docx table { border-collapse: collapse; width: 100%; margin: 8px 0; }
.drawer-docx th, .drawer-docx td { border: 1px solid var(--border-default); padding: 6px 12px; text-align: left; font-size: 13px; }
.drawer-docx th { background: var(--bg-hover); font-weight: 600; }

/* PDF */
.drawer-pdf { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 16px; }
.drawer-pdf-info { font-size: 12px; color: var(--text-tertiary); }
.drawer-pdf-page { position: relative; display: inline-block; }
.drawer-pdf-img { max-width: 100%; border: 1px solid var(--border-subtle); border-radius: 6px; }
.drawer-pdf-num {
  position: absolute; bottom: 6px; right: 10px; font-size: 11px;
  color: var(--text-tertiary); background: var(--bg-surface); padding: 1px 8px; border-radius: 10px;
}

/* Image */
.drawer-image { display: flex; align-items: center; justify-content: center; padding: 24px; }
.drawer-image-img { max-width: 100%; max-height: calc(100vh - 80px); object-fit: contain; border-radius: 6px; }

/* Excel */
.drawer-excel-wrap { display: flex; flex-direction: column; height: 100%; }
.drawer-excel-tabs {
  display: flex; gap: 0; border-bottom: 1px solid var(--border-default);
  background: var(--bg-hover); padding: 0 8px; flex-shrink: 0; overflow-x: auto;
}
.drawer-excel-tab {
  font-size: 12px; font-weight: 500; padding: 8px 16px; border: none; background: none;
  color: var(--text-secondary); cursor: pointer; border-bottom: 2px solid transparent;
  transition: all .15s; white-space: nowrap;
}
.drawer-excel-tab:hover { color: var(--text-primary); background: var(--bg-active); }
.drawer-excel-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; background: var(--bg-surface); }
.drawer-excel-content { flex: 1; overflow: auto; padding: 12px; }
.drawer-excel-content :deep(table) { border-collapse: collapse; width: 100%; font-size: 13px; }
.drawer-excel-content :deep(th), .drawer-excel-content :deep(td) { border: 1px solid var(--border-default); padding: 5px 10px; text-align: left; white-space: nowrap; }
.drawer-excel-content :deep(th) { background: #f6f8fa; font-weight: 600; position: sticky; top: 0; z-index: 1; }
.drawer-excel-content :deep(tr:nth-child(2n)) { background: rgba(0,0,0,0.02); }
.drawer-excel-content :deep(td.selected) { background: #e8f0fe; }

/* PowerPoint */
.drawer-pptx { padding: 24px; display: flex; flex-direction: column; gap: 24px; align-items: center; }
.drawer-pptx-slide {
  background: #ffffff; border: 1px solid var(--border-subtle); border-radius: 4px;
  padding: 0; width: 100%; max-width: 640px; aspect-ratio: 16/9;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  font-size: 14px; line-height: 1.6; position: relative;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06);
  overflow: hidden;
}
.pptx-slide-num {
  position: absolute; bottom: 8px; right: 12px; font-size: 10px; color: var(--text-tertiary);
  background: rgba(0,0,0,0.04); padding: 1px 8px; border-radius: 8px;
}
.pptx-slide-text {
  white-space: pre-wrap; text-align: center; padding: 32px 40px;
  font-size: 15px; line-height: 1.8; color: #1a1a1a;
}
.pptx-slide-text:empty::after {
  content: '(Empty slide)'; color: var(--text-tertiary); font-style: italic;
}

/* Animations */
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
.drawer-enter-active { animation: fadeIn .2s ease; }
.drawer-enter-active .drawer-panel { animation: slideInRight .25s ease; }
.drawer-leave-active { animation: fadeIn .15s ease reverse; }
.drawer-leave-active .drawer-panel { animation: slideInRight .15s ease reverse; }
</style>
