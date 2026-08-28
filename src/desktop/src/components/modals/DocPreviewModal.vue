<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { usePrivacy } from '@/composables/usePrivacy'
import { useClipboard } from '@/composables/useClipboard'
import { api, apiBlob, getClipboardItemContent } from '@/api/client'
import * as tauri from '@/lib/tauri'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import Badge from '@/components/ui/badge/Badge.vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Lock, Clock } from 'lucide-vue-next'
import HtmlPreview from '@/components/clipboard/HtmlPreview.vue'
import TablePreview from '@/components/clipboard/TablePreview.vue'
import ExpiryPicker from '@/components/clipboard/ExpiryPicker.vue'
import MarkdownPreview from '@/components/doc-preview/MarkdownPreview.vue'
import CodePreview from '@/components/doc-preview/CodePreview.vue'
import DocxPreview from '@/components/doc-preview/DocxPreview.vue'
import PdfPreview from '@/components/doc-preview/PdfPreview.vue'
import ImagePreview from '@/components/doc-preview/ImagePreview.vue'
import TextPreview from '@/components/doc-preview/TextPreview.vue'
import { isHtmlContent } from '@/utils/html'
import { parseTable } from '@/utils/table'
import { detectFileType, extractToc, type TocItem } from '@/utils/docPreview'
import './modal-shared.css'

const props = defineProps<{ previewItem?: any; previewType?: string }>()
const emit = defineEmits<{
  close: []
  'show-pin-dialog': []
  'show-pin-setup': []
  'toggle-sensitive': [item: any]
}>()

const { t } = useI18n()
const toast = useSonner()
const privacy = usePrivacy()
const clip = useClipboard()

// ===== State =====
const fileContentLoading = ref(false)
const textContentLoading = ref(false)
const previewContent = ref('')
const previewFileName = ref('')
const previewToc = ref<TocItem[]>([])
const previewImageDataUrl = ref('') // for image file preview

// ===== Document Preview =====
const DOC_PREVIEW_MAX_LINES = 500 // Show first 500 lines for large files

function detectDocType(content: string, filename?: string): string {
  // Always prioritize filename extension if available
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase() || ''
    if (['md', 'markdown', 'mdx', 'rst'].includes(ext)) return 'Markdown'
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
        'vue',
        'svelte',
        'dockerfile',
        'makefile',
        'ini',
        'env',
        'dart',
        'ex',
        'exs',
        'clj',
        'hs',
        'nim',
        'zig',
        'proto',
        'graphql',
        'tf',
        'hcl',
        'erl',
        'ml',
        'mli',
        'f90',
        'f95',
        'vim',
      ].includes(ext)
    )
      return 'Code'
    if (['txt', 'log', 'csv', 'tsv', 'cfg', 'conf', 'properties', 'tex', 'latex', 'org'].includes(ext)) return 'Text'
    // Known but unsupported extensions (docx, pdf, image handled separately by detectFileType)
    if (
      [
        'doc',
        'pages',
        'key',
        'numbers',
        'odt',
        'rtf',
        'xls',
        'xlsx',
        'ppt',
        'pptx',
        'zip',
        'rar',
        '7z',
        'apk',
        'exe',
        'msi',
        'dmg',
        'iso',
        'epub',
        'mobi',
        'azw3',
        'djvu',
      ].includes(ext)
    )
      return 'Unsupported'
  }
  // Fallback: content-based detection (only when no filename or unknown extension)
  if (!content) return 'Text'
  const trimmed = content.trim()
  if (
    /^#{1,6}\s/.test(trimmed) ||
    /\*\*.*\*\*/.test(trimmed) ||
    /^\s*[-*+]\s/.test(trimmed) ||
    /^\s*\d+\.\s/.test(trimmed) ||
    /```/.test(trimmed)
  )
    return 'Markdown'
  // 富文本 HTML 要在 Code 之前识别，否则 <section> 等标签会被 detectDocType 当成源码
  if (isHtmlContent(trimmed)) return 'HTML'
  if (
    /\b(function|const|let|var|class|import|export|return|if|for|while|async|await)\s/.test(trimmed) ||
    /[{}[\]];?\s*$/.test(trimmed) ||
    /^\s*(def |class |import |from |public |private )/.test(trimmed) ||
    /=>\s*[{(]/.test(trimmed) ||
    /^\s*<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>/i.test(trimmed)
  )
    return 'Code'
  return 'Text'
}

function isCodeContent(content: string, filename?: string): boolean {
  return detectDocType(content, filename) === 'Code'
}

const previewContentLines = computed(() => {
  if (!previewContent.value) return []
  const lines = previewContent.value.split('\n')
  return lines.slice(0, DOC_PREVIEW_MAX_LINES)
})

const isTruncated = computed(() => {
  return (previewContent.value?.split('\n').length || 0) > DOC_PREVIEW_MAX_LINES
})

// 富文本捕获（Windows "HTML Format"）：条目 metadata.html 携带的 HTML 片段。
// 优先渲染它；没有捕获片段时才回退到「内容恰好是 HTML 源码」的嗅探渲染（isHtmlContent）。
// metadata 可能是对象（pg jsonb）或 JSON 字符串（旧 API 兼容），两种都处理。
const previewItemHtml = computed(() => {
  const meta = props.previewItem?.metadata
  if (!meta) return ''
  let obj: any = meta
  if (typeof meta === 'string') {
    try {
      obj = JSON.parse(meta)
    } catch {
      return ''
    }
  }
  const html = obj?.html
  return typeof html === 'string' ? html : ''
})

function formatDocSize(chars: number): string {
  if (chars < 1024) return `${chars} chars`
  return `${(chars / 1024).toFixed(1)} KB`
}

// ===== Word (.docx) rendering =====
const docxHtml = ref('')
const docxLoading = ref(false)

async function renderDocx(arrayBuffer: ArrayBuffer) {
  docxLoading.value = true
  try {
    const { default: mammoth } = await import('mammoth')
    const result = await mammoth.convertToHtml({ arrayBuffer })
    docxHtml.value = result.value || '<p style="color:var(--text-tertiary)">Document is empty</p>'
    if (result.messages.length > 0) {
      console.warn('[Preview] mammoth messages:', result.messages)
    }
  } catch (e) {
    console.error('[Preview] mammoth error:', e)
    docxHtml.value = '<p style="color:var(--danger)">Failed to render Word document</p>'
  }
  docxLoading.value = false
}

// ===== PDF rendering =====
const pdfPages = ref<{ num: number; dataUrl: string }[]>([])
const pdfLoading = ref(false)
const pdfTotalPages = ref(0)

async function renderPdf(arrayBuffer: ArrayBuffer) {
  pdfLoading.value = true
  pdfPages.value = []
  try {
    const pdfjsLib = await import('pdfjs-dist')
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
    pdfTotalPages.value = pdf.numPages
    const maxPages = Math.min(pdf.numPages, 20) // Render first 20 pages max
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i)
      const scale = 1.5
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')!
      await page.render({ canvasContext: ctx, viewport, canvas }).promise
      pdfPages.value.push({ num: i, dataUrl: canvas.toDataURL('image/png') })
    }
  } catch (e) {
    console.error('[Preview] PDF render error:', e)
  }
  pdfLoading.value = false
}

/** Load file content from server for file-type preview */
async function loadFileContent(item: any) {
  if (!item?.id) return

  // ── Step 1: Extract filename from item.content ──
  // item.content can be: {name,paths} JSON | path array JSON | plain path | raw text
  // Strategy: regex scan for a filename with known extension, then JSON parsing
  const knownExts = [
    'md',
    'markdown',
    'mdx',
    'rst',
    'txt',
    'log',
    'csv',
    'tsv',
    'cfg',
    'conf',
    'properties',
    'tex',
    'latex',
    'org',
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
    'vue',
    'svelte',
    'dockerfile',
    'makefile',
    'ini',
    'env',
    'dart',
    'ex',
    'exs',
    'clj',
    'hs',
    'nim',
    'zig',
    'proto',
    'graphql',
    'tf',
    'hcl',
    'erl',
    'ml',
    'mli',
    'f90',
    'f95',
    'vim',
    'doc',
    'docx',
    'pages',
    'key',
    'numbers',
    'odt',
    'rtf',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'pdf',
    'epub',
    'mobi',
    'azw3',
    'djvu',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'bmp',
    'svg',
    'ico',
    'tiff',
    'avif',
    'heic',
  ]
  const extPattern = knownExts.join('|')
  const filenameRegex = new RegExp(`([^/\\\\<>"|?*]+)\\.(${extPattern})(?=[^/\\\\]|$)`, 'i')
  let fileName = ''
  const contentStr = String(item.content || '')

  // Strategy A: regex scan for filename with extension
  const regexMatch = contentStr.match(filenameRegex)
  if (regexMatch) {
    fileName = regexMatch[0]
  } else {
    // Strategy B: JSON parsing
    try {
      const meta = JSON.parse(item.content)
      if (meta && typeof meta === 'object') {
        if (meta.name) fileName = meta.name
        else if (meta.originalName) fileName = meta.originalName
        else if (meta.fileName) fileName = meta.fileName
        else if (Array.isArray(meta.paths) && meta.paths.length > 0 && typeof meta.paths[0] === 'string') {
          fileName = meta.paths[0].split(/[/\\]/).pop() || 'Untitled'
        } else if (Array.isArray(meta) && meta.length > 0 && typeof meta[0] === 'string') {
          fileName = meta[0].split(/[/\\]/).pop() || 'Untitled'
        }
      }
    } catch {
      /* not JSON */
    }

    // Strategy C: plain path or contentPreview fallback
    if (!fileName) {
      const raw = contentStr.split(/[/\\]/).pop()
      if (raw && raw.includes('.')) fileName = raw
      else if ((item as any).contentPreview) {
        const prev = String((item as any).contentPreview)
          .split(/[/\\]/)
          .pop()
        if (prev) fileName = prev
      }
    }
  }
  previewFileName.value = fileName || 'Untitled'

  const fileType = detectFileType(previewFileName.value)
  const docType = detectDocType('', previewFileName.value)

  // Reset state
  previewContent.value = ''
  previewToc.value = []
  docxHtml.value = ''
  pdfPages.value = []
  previewImageDataUrl.value = ''

  // For unsupported types (except image/docx/pdf handled below), show message immediately
  if (docType === 'Unsupported' && fileType !== 'docx' && fileType !== 'pdf' && fileType !== 'image') {
    return
  }

  fileContentLoading.value = true
  try {
    if (fileType === 'image') {
      // Image files: read via Tauri as base64, convert to data URL
      try {
        // Get file path from API contentEncrypted (path array or direct path)
        const res = await api('GET', `/api/clipboard/${item.id}`)
        let filePath = ''
        if (res.ok && res.data?.contentEncrypted) {
          try {
            const parsed = JSON.parse(res.data.contentEncrypted)
            if (Array.isArray(parsed) && parsed[0]) filePath = parsed[0]
          } catch {
            if (res.data.contentEncrypted.includes('\\') || res.data.contentEncrypted.includes('/')) {
              filePath = res.data.contentEncrypted
            }
          }
        }
        if (filePath) {
          const { invoke } = await import('@tauri-apps/api/core')
          const base64: string = await invoke('read_file_content_base64', { path: filePath })
          if (base64) {
            const ext = filePath.split('.').pop()?.toLowerCase() || 'png'
            const mimeMap: Record<string, string> = {
              png: 'image/png',
              jpg: 'image/jpeg',
              jpeg: 'image/jpeg',
              gif: 'image/gif',
              webp: 'image/webp',
              bmp: 'image/bmp',
              svg: 'image/svg+xml',
              ico: 'image/x-icon',
              tiff: 'image/tiff',
            }
            previewImageDataUrl.value = `data:${mimeMap[ext] || 'image/png'};base64,${base64}`
          }
        }
      } catch (e) {
        console.error('[Preview] Image file load error:', e)
      }
    } else if (fileType === 'docx' || fileType === 'pdf') {
      // Binary files: try download endpoint first, fallback to Tauri for path-based content
      let loaded = false
      // Check if content_encrypted is a file path (clipboard monitor uploads)
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
      // If it's a local file path, read via Tauri
      if (filePath) {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const base64: string = await invoke('read_file_content_base64', { path: filePath })
          if (base64) {
            const arrayBuffer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer
            if (fileType === 'docx') await renderDocx(arrayBuffer)
            else if (fileType === 'pdf') await renderPdf(arrayBuffer)
            loaded = true
          }
        } catch {
          /* fallback to download endpoint */
        }
      }
      // Fallback: download from server
      if (!loaded) {
        const blobRes = await apiBlob('GET', `/api/media/${item.id}/download`)
        if (blobRes && blobRes.ok) {
          const arrayBuffer = await blobRes.arrayBuffer()
          if (fileType === 'docx') await renderDocx(arrayBuffer)
          else if (fileType === 'pdf') await renderPdf(arrayBuffer)
        } else {
          previewContent.value = t('preview_unable')
        }
      }
    } else {
      // Text-based files: fetch content via lightweight endpoint
      const content = await getClipboardItemContent(item.id)
      if (content) {
        // If content is a file path array (old uploads), read actual file via Tauri
        let finalContent = content
        try {
          const parsed = JSON.parse(content)
          if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string' && parsed[0].includes('\\')) {
            // Path array — try reading actual file content
            try {
              const fileContent = await tauri.readFileContent(parsed[0])
              if (fileContent) finalContent = fileContent
            } catch {
              /* file not readable */
            }
          }
        } catch {
          /* not JSON, use as-is */
        }
        previewContent.value = finalContent
        if (docType === 'Markdown') {
          previewToc.value = extractToc(finalContent)
        }
      } else {
        previewContent.value = t('preview_unable')
      }
    }
  } catch {
    previewContent.value = t('preview_failed')
  }
  fileContentLoading.value = false
}

/** Load full content for text-type items (server list only returns a preview) */
async function loadTextContent(item: any) {
  if (!item?.id) return

  previewFileName.value = ''
  previewToc.value = []
  textContentLoading.value = true

  let content = item?.content || ''
  // If the list only gave us a preview, fetch the complete content.
  const contentSize = (item as any)?.contentSize || 0
  const isLocalItem = /^local-|^text-|^file-|^img-|^browser-/.test(item.id)
  // New items: contentSize tells us whether the preview is complete.
  // Old items: contentSize may be 0/missing, so treat any non-empty server item as potentially truncated.
  const needsFetch = !isLocalItem && content.length > 0 && (contentSize === 0 || content.length < contentSize)
  if (needsFetch) {
    try {
      const full = await getClipboardItemContent(item.id)
      if (full) {
        content = full
      }
    } catch (e: any) {
      console.warn('[Preview] failed to load full text content:', e?.message || e)
    }
  }

  previewContent.value = content
  const docType = detectDocType(content)
  if (docType === 'Markdown') {
    previewToc.value = extractToc(content)
  }

  textContentLoading.value = false
}

/** Render code with highlight.js — 由 utils/docPreview 提供，此处仅保留模板引用占位 */
// ===== Privacy: sensitive content mask =====
function isPreviewSensitive(): boolean {
  const itemId = props.previewItem?.id || 'modal-preview'
  if (privacy.peekItemId.value === itemId) return false // already peeked for this item
  const item = props.previewItem
  // Manual lock always applies
  if (item?.metadata?.sensitive === true) return true
  // Auto-detect only for text-like previews; file/image previews are not secrets
  const itemType = props.previewType || item?.type || item?.contentType
  const textLikeTypes = ['text', 'link', 'code']
  if (!textLikeTypes.includes(itemType)) return false
  const text = previewContent.value || item?.content || ''
  if (privacy.isSensitiveContent(text)) return true
  return false
}
function onPreviewPeek() {
  const itemId = props.previewItem?.id || 'modal-preview'
  if (privacy.startPeek(itemId)) {
    // peeked
  } else {
    if (!privacy.pinSet.value) {
      emit('show-pin-setup')
    } else {
      emit('show-pin-dialog')
    }
  }
}

function onToggleSensitive(item: any) {
  const isLocked = item?.metadata?.sensitive === true
  if (isLocked && !privacy.canCopySensitive()) {
    if (!privacy.pinSet.value) {
      emit('show-pin-setup')
    } else {
      emit('show-pin-dialog')
    }
    return
  }
  emit('toggle-sensitive', item)
}

// ===== Expiry control =====
function formatExpiry(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString()
}
async function onExpirySelect(iso: string | null) {
  const item = props.previewItem
  if (!item?.id) return
  const ok = await clip.setExpiry(item, iso)
  if (ok) toast.show(iso ? t('exp_set_toast') : t('exp_clear_toast'), 'success')
  else toast.show(t('del_fail'), 'error')
}

// Load content when preview item changes (immediate: 异步 v-if 门控下挂载即触发)
function handlePreviewItemChange(item: any) {
  if (!item) return
  // Reset peek state for new preview item (usePrivacy handles its own state)
  if (props.previewType === 'file') {
    loadFileContent(item)
  } else if (props.previewType === 'text') {
    loadTextContent(item)
  }
}
watch(() => props.previewItem, handlePreviewItemChange, { immediate: true })
</script>

<template>
  <!-- Text / Document / File Detail -->
  <ModalDialog
    :open="previewType === 'text' || previewType === 'file'"
    :title="previewType === 'file' ? t('file_preview_title') : t('text_detail_title')"
    max-width="900px"
    @close="emit('close')"
  >
    <div v-if="previewItem" class="doc-preview-wrap">
      <!-- Sensitive content mask overlay -->
      <div v-if="isPreviewSensitive() && !privacy.peekItemId.value" class="doc-mask-overlay">
        <div class="doc-mask-content">
          <Lock :size="24" class="doc-mask-icon" />
          <div class="doc-mask-text">{{ t('content_masked') }}</div>
          <button class="doc-peek-btn" @click="onPreviewPeek()">{{ t('peek_content') }}</button>
        </div>
      </div>

      <!-- Content type indicator -->
      <div class="doc-type-bar">
        <div class="doc-type-left">
          <Badge variant="outline" class="doc-type-badge">{{ detectDocType(previewContent, previewFileName) }}</Badge>
          <span class="doc-size">{{ formatDocSize(previewContent.length) }}</span>
        </div>
        <div class="doc-type-right">
          <Popover>
            <PopoverTrigger as-child>
              <Button variant="ghost" size="icon-sm" :title="t('exp_set')">
                <Clock :size="14" />
              </Button>
            </PopoverTrigger>
            <PopoverContent class="w-auto p-3">
              <div class="doc-expiry-head">
                <span class="doc-expiry-label">{{ t('exp_current') }}</span>
                <span v-if="previewItem?.expiresAt" class="doc-expiry-current">{{
                  formatExpiry(previewItem.expiresAt)
                }}</span>
                <span v-else class="doc-expiry-none">{{ t('exp_never') }}</span>
              </div>
              <ExpiryPicker :model-value="previewItem?.expiresAt ?? null" @select="onExpirySelect" />
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="icon-sm"
            :class="{ 'sensitive-locked': previewItem?.metadata?.sensitive }"
            :title="previewItem?.metadata?.sensitive ? t('sens_unlock') : t('sens_lock')"
            @click="onToggleSensitive(previewItem)"
          >
            <Lock :size="14" />
          </Button>
        </div>
      </div>

      <!-- Loading state for file / text content -->
      <div v-if="fileContentLoading || textContentLoading" class="doc-loading">
        <div class="doc-loading-spinner" />
        <span>{{ t('preview_loading') }}</span>
      </div>

      <!-- Image file preview -->
      <ImagePreview
        v-else-if="detectFileType(previewFileName) === 'image' && previewImageDataUrl"
        :src="previewImageDataUrl"
        :alt="previewFileName"
      />

      <!-- Word (.docx) rendering -->
      <DocxPreview
        v-else-if="detectFileType(previewFileName) === 'docx' && docxHtml"
        :html="docxHtml"
      />

      <!-- PDF rendering -->
      <PdfPreview
        v-else-if="detectFileType(previewFileName) === 'pdf' && pdfPages.length > 0"
        :pages="pdfPages"
        :total-pages="pdfTotalPages"
      />

      <!-- PPTX / other unsupported: show raw text content -->
      <TextPreview
        v-else-if="
          detectFileType(previewFileName) === 'pptx' ||
          (detectDocType(previewContent, previewFileName) === 'Unsupported' &&
            detectFileType(previewFileName) !== 'docx' &&
            detectFileType(previewFileName) !== 'pdf' &&
            detectFileType(previewFileName) !== 'image')
        "
        :content="previewContentLines.join('\n')"
      />

      <!-- Markdown rendering with TOC -->
      <MarkdownPreview
        v-else-if="detectDocType(previewContent, previewFileName) === 'Markdown'"
        :content="previewContent"
        :toc="previewToc"
      />

      <!-- HTML safe preview (DOMPurify sanitized)：优先渲染捕获的富文本片段 metadata.html，
           没有捕获片段时回退为「内容恰好是 HTML 源码」的嗅探渲染 -->
      <!-- 必须在 Code 分支之前：detectDocType 会把 HTML 标签识别为 Code，导致 HTML 被当成源码高亮 -->
      <div v-else-if="isHtmlContent(previewContent) || previewItemHtml" class="doc-preview html-preview-doc">
        <HtmlPreview :content="previewContent" :html="previewItemHtml" />
      </div>

      <!-- Table preview (TSV/CSV/semicolon) -->
      <div v-else-if="parseTable(previewContent)" class="doc-preview table-preview-doc">
        <TablePreview :content="previewContent" />
      </div>

      <!-- Code with line numbers + syntax highlighting -->
      <CodePreview
        v-else-if="isCodeContent(previewContent, previewFileName)"
        :content="previewContent"
        :file-name="previewFileName"
      />

      <!-- Plain text -->
      <TextPreview v-else :content="previewContentLines.join('\n')" />

      <div v-if="isTruncated" class="doc-truncated">{{ t('doc_truncated') }}</div>
    </div>
  </ModalDialog>
</template>

<style scoped>
/* Document Preview — base */
.doc-preview-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.doc-type-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.doc-type-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 10px;
}
.doc-size {
  font-size: 11px;
  color: var(--text-tertiary);
}
.doc-preview {
  background: var(--bg-hover);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 16px;
  max-height: 500px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.7;
}

/* Loading state */
.doc-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px;
  color: var(--text-tertiary);
  font-size: 13px;
}
.doc-loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: modal-spin 0.6s linear infinite;
}

/* HTML safe preview wrapper in detail modal */
.html-preview-doc {
  max-height: 70vh;
  overflow: auto;
}

/* Table preview wrapper in detail modal */
.table-preview-doc {
  max-height: 70vh;
  overflow: auto;
}

/* Privacy: sensitive content mask in modal preview */
.doc-mask-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-hover);
  border-radius: var(--radius-md);
}
.doc-mask-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.doc-mask-icon {
  color: var(--text-tertiary);
  opacity: 0.6;
}
.doc-mask-text {
  font-size: 13px;
  color: var(--text-secondary);
}
.doc-peek-btn {
  padding: 6px 16px;
  border-radius: 9999px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  font-size: 12px;
  color: var(--accent);
  cursor: pointer;
  transition: all 0.12s;
}
.doc-peek-btn:hover {
  background: var(--accent-bg);
  border-color: var(--accent);
}

/* Ensure doc-preview-wrap is position:relative for the overlay */
.doc-preview-wrap {
  position: relative;
}
</style>
