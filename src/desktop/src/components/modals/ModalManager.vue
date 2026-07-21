<script setup lang="ts">
import { ref, computed, watch, reactive, nextTick, onUnmounted, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useTheme } from '@/composables/useTheme'
import { QrCode, MessageCircle, Landmark } from 'lucide-vue-next'
import Badge from '@/components/ui/badge/Badge.vue'
import { api, apiBlob, getClipboardItemContent } from '@/api/client'
import { useConfigStore } from '@/stores/configStore'
import { useDevice } from '@/composables/useDevice'
import { usePrivacy } from '@/composables/usePrivacy'
import { initPairing, redeemPairing } from '@/api/device'
import { useNotifications } from '@/composables/useNotifications'
import * as tauri from '@/lib/tauri'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Switch from '@/components/ui/switch/Switch.vue'
import { Pencil, Monitor, Smartphone, FileText, CircleCheck, Download, ZoomIn, ZoomOut, RotateCcw, RotateCw, Lock } from 'lucide-vue-next'
import { marked } from 'marked'
import hljs from 'highlight.js'
import mammoth from 'mammoth'
import * as pdfjsLib from 'pdfjs-dist'
import HtmlPreview from '@/components/clipboard/HtmlPreview.vue'
import { isHtmlContent } from '@/utils/html'

// Set PDF.js worker source
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href

// Configure marked
marked.setOptions({
  gfm: true,
  breaks: false,
})

/** Render markdown to HTML with heading anchors for TOC */
function renderMarkdown(text: string): string {
  if (!text) return ''
  try {
    // Custom renderer: add id to headings for TOC anchor links
    const renderer = new marked.Renderer()
    renderer.heading = function({ text, depth }: { text: string; depth: number }) {
      const raw = String(text).replace(/<[^>]+>/g, '')
      const id = raw.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
      return `<h${depth} id="${id}">${text}</h${depth}>`
    }
    return marked.parse(text, { renderer }) as string
  } catch (e) {
    console.error('[Preview] marked.parse error:', e)
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  }
}

/** Detect file type from filename extension */
function detectFileType(filename: string): 'markdown' | 'code' | 'text' | 'docx' | 'pptx' | 'pdf' | 'image' | 'unsupported' {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  if (['md', 'markdown', 'mdx', 'rst'].includes(ext)) return 'markdown'
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'cs',
       'html', 'css', 'scss', 'less', 'json', 'yaml', 'yml', 'xml', 'toml',
       'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'rb', 'php', 'swift',
       'kt', 'scala', 'r', 'lua', 'vim', 'dockerfile', 'makefile', 'ini', 'env',
       'vue', 'svelte', 'dart', 'ex', 'exs', 'clj', 'hs', 'nim', 'zig', 'wasm',
       'proto', 'graphql', 'tf', 'hcl', 'erl', 'ml', 'mli', 'f90', 'f95'].includes(ext)) return 'code'
  if (['txt', 'log', 'csv', 'tsv', 'cfg', 'conf', 'properties', 'tex', 'latex', 'org'].includes(ext)) return 'text'
  if (['doc', 'docx', 'pages', 'key', 'numbers', 'odt', 'rtf'].includes(ext)) return 'docx'
  if (['ppt', 'pptx'].includes(ext)) return 'pptx'
  if (['pdf', 'epub', 'mobi', 'azw3', 'djvu'].includes(ext)) return 'pdf'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'avif', 'heic'].includes(ext)) return 'image'
  return 'unsupported'
}

/** Get language name for highlight.js from file extension */
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
    ini: 'ini', env: 'bash', bat: 'batch', cmd: 'batch', ps1: 'powershell',
    dart: 'dart', ex: 'elixir', exs: 'elixir', clj: 'clojure',
    hs: 'haskell', nim: 'nim', zig: 'zig', wasm: 'wasm',
    proto: 'protobuf', graphql: 'graphql', tf: 'hcl', hcl: 'hcl',
    erl: 'erlang', ml: 'ocaml', mli: 'ocaml',
    f90: 'fortran', f95: 'fortran',
    tex: 'latex', latex: 'latex',
    vim: 'vim',
  }
  return map[ext] || ext
}

/** Auto-detect language from content (fallback when no filename) */
function detectLangFromContent(content: string): string {
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
interface TocItem { id: string; text: string; depth: number }
function extractToc(markdown: string): TocItem[] {
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
      const id = text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
      items.push({ id, text, depth })
    }
  }
  return items
}

const props = defineProps<{
  showModalType: string
  showForgotPwd?: boolean
  previewItem?: any
  previewType?: string
  confirmMessage?: string
  versionItemId?: string
}>()
const emit = defineEmits<{
  'close-modal': []
  'close-forgot-pwd': []
  'close-preview': []
  'confirm-action': []
  'switch-modal': [type: string]
  'show-pin-dialog': []
  'show-pin-setup': []
  'toggle-sensitive': [item: any]
}>()

// 打开「生成配对码」弹窗时自动创建二维码；离开配对类弹窗时清理计时器与摄像头
function handleShowModalTypeChange(type: string) {
  if (type === 'pair-generate') {
    generatePairing()
  } else if (type !== 'pair-scan') {
    if (expireTimer) { clearInterval(expireTimer); expireTimer = undefined }
    stopScan()
  }
  if (type === 'sessions') loadSessions()
  if (type === 'billing') loadInvoices()
  if (type === 'notifications') loadPreferencesInto(secNotif)
}

watch(() => props.showModalType, handleShowModalTypeChange)

onMounted(() => {
  // 组件改为异步 + v-if 门控后，挂载时 showModalType 已是目标值，
  // 必须手动触发一次初始化，否则二维码/列表/账单等首次不会加载
  handleShowModalTypeChange(props.showModalType)
})

function handlePreviewItemChange(item: any) {
  if (!item) return
  // Reset peek state for new preview item (usePrivacy handles its own state)
  if (props.previewType === 'file') {
    loadFileContent(item)
  } else if (props.previewType === 'text') {
    loadTextContent(item)
  }
}

// Load file content when preview item changes
watch(() => props.previewItem, handlePreviewItemChange)

onMounted(() => {
  // 组件改为异步 + v-if 门控后，挂载时 previewItem 已是目标值，
  // 必须手动触发一次初始化，否则文本/文件预览首次不会加载
  handlePreviewItemChange(props.previewItem)
})

const { t } = useI18n()
const toast = useSonner()
const { allThemes, setStyle, currentStyle } = useTheme()
const { savePreference, loadPreferencesInto, PREF_TYPE_BY_KEY } = useNotifications()
const configStore = useConfigStore()
const privacy = usePrivacy()

// Privacy: helper for template — delegates to usePrivacy composable
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

// Plan selection state (for pricing → payment flow)
const selectedPlan = ref<{ id: string; name: string; price: number } | null>(null)
const paymentSending = ref(false)
const paymentResult = ref<{ success: boolean; message: string } | null>(null)

// Invoice list
const invoices = ref<any[]>([])
const loadingInvoices = ref(false)

// Forgot password state
const fpStep = ref(1)
const fpEmail = ref('')
const fpCode = ref('')
const fpNewPwd = ref('')
const fpConfirmPwd = ref('')
const fpSending = ref(false)

// ===== Security & Notification Preferences (persisted to localStorage) =====
const SEC_NOTIF_KEY = 'clipsync-sec-notif'
interface SecNotifPrefs {
  twoFA: boolean
  loginNotification: boolean
  nfNewDevice: boolean
  nfSyncDone: boolean
  nfSecurity: boolean
  nfUpdates: boolean
}
const defaultSecNotif: SecNotifPrefs = {
  twoFA: false,
  loginNotification: true,
  nfNewDevice: true,
  nfSyncDone: true,
  nfSecurity: true,
  nfUpdates: true,
}
function loadSecNotif(): SecNotifPrefs {
  try {
    const raw = localStorage.getItem(SEC_NOTIF_KEY)
    if (raw) return { ...defaultSecNotif, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...defaultSecNotif }
}
function saveSecNotif(partial: Partial<SecNotifPrefs>) {
  Object.assign(secNotif, partial)
  localStorage.setItem(SEC_NOTIF_KEY, JSON.stringify({ ...secNotif }))
  // 通知类开关同步到后端（其余安全开关如 2FA 仅本地）
  Object.keys(partial).forEach((key) => {
    if (key in PREF_TYPE_BY_KEY) savePreference(key, (partial as any)[key])
  })
}
// Initialize from localStorage immediately (before any render)
const secNotif = reactive(loadSecNotif())

async function downloadImage() {
  const src = props.previewItem?.preview || props.previewItem?.content
  if (!src) return
  // 尝试使用 File System Access API（支持选择保存位置）
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: `clipsync-image-${Date.now()}.png`,
        types: [{ description: 'Image', accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg'] } }],
      })
      const blob = await (await fetch(src)).blob()
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      toast.show(t('img_saved'), 'success')
      return
    } catch (e: any) {
      if (e.name === 'AbortError') return // 用户取消
    }
  }
  // Fallback: 直接下载
  const a = document.createElement('a')
  a.href = src
  a.download = `clipsync-image-${Date.now()}.png`
  a.click()
  toast.show(t('img_saved'), 'success')
}

// ===== Image Preview Zoom + Pan + Rotate =====
const imgZoom = ref(1)
const imgPanX = ref(0)
const imgPanY = ref(0)
const imgRotate = ref(0)
const IMG_ZOOM_MIN = 0.5
const IMG_ZOOM_MAX = 4
const IMG_ZOOM_STEP = 0.3

// Drag state for panning when zoomed in
let isImgDragging = false
let imgDragStartX = 0
let imgDragStartY = 0
let imgPanStartX = 0
let imgPanStartY = 0

function resetImgZoom() { imgZoom.value = 1; imgPanX.value = 0; imgPanY.value = 0; imgRotate.value = 0 }
function rotateLeft() { imgRotate.value = (imgRotate.value - 90) % 360 }
function rotateRight() { imgRotate.value = (imgRotate.value + 90) % 360 }
function zoomIn() {
  const next = Math.min(IMG_ZOOM_MAX, imgZoom.value + IMG_ZOOM_STEP)
  if (Math.abs(next - imgZoom.value) > 0.01) imgZoom.value = next
}
function zoomOut() {
  const next = Math.max(IMG_ZOOM_MIN, imgZoom.value - IMG_ZOOM_STEP)
  if (Math.abs(next - imgZoom.value) > 0.01) imgZoom.value = next
  // Zoom out to 1x also resets pan
  if (imgZoom.value <= 1) { imgPanX.value = 0; imgPanY.value = 0 }
}
function onImgWheel(e: WheelEvent) {
  e.preventDefault()
  e.stopPropagation()
  const delta = e.deltaY < 0 ? IMG_ZOOM_STEP : -IMG_ZOOM_STEP
  const next = Math.max(IMG_ZOOM_MIN, Math.min(IMG_ZOOM_MAX, imgZoom.value + delta))
  if (Math.abs(next - imgZoom.value) > 0.01) imgZoom.value = next
}
function onImgPointerDown(e: PointerEvent) {
  // Only enable drag when zoomed in beyond 100%
  if (imgZoom.value <= 1) return
  isImgDragging = true
  imgDragStartX = e.clientX
  imgDragStartY = e.clientY
  imgPanStartX = imgPanX.value
  imgPanStartY = imgPanY.value
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function onImgPointerMove(e: PointerEvent) {
  if (!isImgDragging) return
  const dx = e.clientX - imgDragStartX
  const dy = e.clientY - imgDragStartY
  imgPanX.value = imgPanStartX + dx
  imgPanY.value = imgPanStartY + dy
}
function onImgPointerUp() {
  isImgDragging = false
}

/** Scroll to a heading in the markdown preview */
function scrollToHeading(id: string) {
  nextTick(() => {
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

// ===== Document Preview =====
const DOC_PREVIEW_MAX_LINES = 500 // Show first 500 lines for large files

function detectDocType(content: string, filename?: string): string {
  // Always prioritize filename extension if available
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase() || ''
    if (['md', 'markdown', 'mdx', 'rst'].includes(ext)) return 'Markdown'
    if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'cs',
         'html', 'css', 'scss', 'less', 'json', 'yaml', 'yml', 'xml', 'toml',
         'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'rb', 'php', 'swift',
         'kt', 'scala', 'r', 'lua', 'vue', 'svelte', 'dockerfile', 'makefile',
         'ini', 'env', 'dart', 'ex', 'exs', 'clj', 'hs', 'nim', 'zig',
         'proto', 'graphql', 'tf', 'hcl', 'erl', 'ml', 'mli',
         'f90', 'f95', 'vim'].includes(ext)) return 'Code'
    if (['txt', 'log', 'csv', 'tsv', 'cfg', 'conf', 'properties', 'tex', 'latex', 'org'].includes(ext)) return 'Text'
    // Known but unsupported extensions (docx, pdf, image handled separately by detectFileType)
    if (['doc', 'pages', 'key', 'numbers', 'odt', 'rtf',
         'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar', '7z', 'apk', 'exe', 'msi', 'dmg', 'iso',
         'epub', 'mobi', 'azw3', 'djvu'].includes(ext)) return 'Unsupported'
  }
  // Fallback: content-based detection (only when no filename or unknown extension)
  if (!content) return 'Text'
  const trimmed = content.trim()
  if (/^#{1,6}\s/.test(trimmed) || /\*\*.*\*\*/.test(trimmed) || /^\s*[-*+]\s/.test(trimmed) || /^\s*\d+\.\s/.test(trimmed) || /```/.test(trimmed)) return 'Markdown'
  if (/\b(function|const|let|var|class|import|export|return|if|for|while|async|await)\s/.test(trimmed) ||
      /[{}\[\]];?\s*$/.test(trimmed) || /^\s*(def |class |import |from |public |private )/.test(trimmed) ||
      /=>\s*[{(]/.test(trimmed) || /^\s*<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>/i.test(trimmed)) return 'Code'
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

function formatDocSize(chars: number): string {
  if (chars < 1024) return `${chars} chars`
  return `${(chars / 1024).toFixed(1)} KB`
}

// ===== File content loading for file-type items =====
const fileContentLoading = ref(false)
const textContentLoading = ref(false)
const previewContent = ref('')
const previewFileName = ref('')
const previewToc = ref<TocItem[]>([])
const previewImageDataUrl = ref('') // for image file preview

/** Load file content from server for file-type preview */
async function loadFileContent(item: any) {
  if (!item?.id) return

  // ── Step 1: Extract filename from item.content ──
  // item.content can be: {name,paths} JSON | path array JSON | plain path | raw text
  // Strategy: regex scan for a filename with known extension, then JSON parsing
  const knownExts = ['md','markdown','mdx','rst','txt','log','csv','tsv','cfg','conf','properties','tex','latex','org',
    'js','ts','jsx','tsx','py','java','go','rs','c','cpp','h','cs','html','css','scss','less','json','yaml','yml','xml','toml','sql','sh','bash','zsh','ps1','bat','cmd','rb','php','swift','kt','scala','r','lua','vue','svelte','dockerfile','makefile','ini','env','dart','ex','exs','clj','hs','nim','zig','proto','graphql','tf','hcl','erl','ml','mli','f90','f95','vim',
    'doc','docx','pages','key','numbers','odt','rtf','xls','xlsx','ppt','pptx',
    'pdf','epub','mobi','azw3','djvu',
    'png','jpg','jpeg','gif','webp','bmp','svg','ico','tiff','avif','heic']
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
    } catch { /* not JSON */ }

    // Strategy C: plain path or contentPreview fallback
    if (!fileName) {
      const raw = contentStr.split(/[/\\]/).pop()
      if (raw && raw.includes('.')) fileName = raw
      else if ((item as any).contentPreview) {
        const prev = String((item as any).contentPreview).split(/[/\\]/).pop()
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
  // Reset image zoom/rotate for file image preview
  imgZoom.value = 1; imgRotate.value = 0; imgPanX.value = 0; imgPanY.value = 0

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
            const mimeMap: Record<string, string> = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', bmp:'image/bmp', svg:'image/svg+xml', ico:'image/x-icon', tiff:'image/tiff' }
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
            const arrayBuffer = Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer
            if (fileType === 'docx') await renderDocx(arrayBuffer)
            else if (fileType === 'pdf') await renderPdf(arrayBuffer)
            loaded = true
          }
        } catch { /* fallback to download endpoint */ }
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
            } catch { /* file not readable */ }
          }
        } catch { /* not JSON, use as-is */ }
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
  const needsFetch = (!isLocalItem && content.length > 0) &&
    (contentSize === 0 || content.length < contentSize)
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

/** Render code with highlight.js */
function renderCode(content: string, filename?: string): string {
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

// ===== Word (.docx) rendering =====
const docxHtml = ref('')
const docxLoading = ref(false)

async function renderDocx(arrayBuffer: ArrayBuffer) {
  docxLoading.value = true
  try {
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

/** Convert base64 data URL or ArrayBuffer to ArrayBuffer for docx/pdf */
async function contentToArrayBuffer(content: string): Promise<ArrayBuffer | null> {
  // If content is a base64 data URL
  if (content.startsWith('data:')) {
    const resp = await fetch(content)
    return await resp.arrayBuffer()
  }
  // If content is base64 string
  if (/^[A-Za-z0-9+/]/.test(content) && content.length % 4 === 0) {
    try {
      const binary = atob(content)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes.buffer
    } catch { /* not base64 */ }
  }
  // If content is raw text, encode as UTF-8
  return new TextEncoder().encode(content).buffer
}

function handleCloseForgot() {
  fpStep.value = 1; fpEmail.value = ''; fpCode.value = ''; fpNewPwd.value = ''; fpConfirmPwd.value = ''
  emit('close-forgot-pwd')
}

async function handleForgotSend() {
  if (!fpEmail.value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fpEmail.value)) {
    toast.show(t('val_email_invalid'), 'error'); return
  }
  fpSending.value = true
  try {
    const res = await api('POST', '/api/auth/forgot-password', { email: fpEmail.value })
    if (res.ok) { fpStep.value = 2; toast.show(t('toast_pwd_reset'), 'success') }
    else { toast.show(res.error || '', 'error') }
  } catch (e: any) { toast.show(t('auth_failed_op') + String(e), 'error') }
  fpSending.value = false
}

async function handleForgotReset() {
  if (fpNewPwd.value !== fpConfirmPwd.value) { toast.show(t('sp_pwd_mismatch'), 'error'); return }
  fpSending.value = true
  try {
    const res = await api('POST', '/api/auth/reset-password', { email: fpEmail.value, code: fpCode.value, password: fpNewPwd.value })
    if (res.ok) { toast.show(t('toast_pwd_reset'), 'success'); handleCloseForgot() }
    else { toast.show(res.error || t('auth_code_invalid'), 'error') }
  } catch (e: any) { toast.show(t('auth_failed_op') + String(e), 'error') }
  fpSending.value = false
}

// ===== Shortcut Customization =====
// global = registered with Tauri (works when app unfocused/minimized)
// app    = in-app key (only when main window focused), handled by local listeners
const DEFAULT_SHORTCUTS = {
  'quickPaste': ['Ctrl', 'Shift', 'V'],
  'toggleWindow': ['Ctrl', 'Alt', 'Space'],
  'copyClip': ['Enter'],
  'deleteClip': ['Delete'],
  'search': ['Ctrl', 'F'],
}
const GLOBAL_IDS = ['quickPaste', 'toggleWindow']
const STORAGE_KEY = 'clipsync-custom-shortcuts'
type ShortcutId = keyof typeof DEFAULT_SHORTCUTS
let savedShortcuts: Record<string, string[]> = {}
try {
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  // Sanitize each stored key array to clean up any corrupt entries
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) { savedShortcuts[k] = sanitizeKeys(v) }
  }
} catch { /* ignore */ }
const customShortcuts = reactive<Record<string, string[]>>({ ...DEFAULT_SHORTCUTS, ...savedShortcuts })
const recordingId = ref<string | null>(null)
const recorderEl = ref<HTMLElement | null>(null)

const shortcutList = [
  { id: 'quickPaste' as ShortcutId, label: 'sk_quick_paste', global: true },
  { id: 'toggleWindow' as ShortcutId, label: 'sk_toggle_window', global: true },
  { id: 'copyClip' as ShortcutId, label: 'sk_copy_clip', global: false },
  { id: 'deleteClip' as ShortcutId, label: 'sk_delete_clip', global: false },
  { id: 'search' as ShortcutId, label: 'sk_search', global: false },
]

function getKeys(id: string): string[] { return customShortcuts[id] || [] }

function startRecord(id: string) {
  recordingId.value = id
  // Auto-focus the recorder element so keydown events are captured.
  // Double nextTick + type guard: ModalDialog may have enter animation,
  // v-else branch might not be mounted on first tick; ref may resolve
  // to non-DOM object in Tauri webview edge cases.
  // Note: ref inside v-for becomes an array in Vue 3, so we need to handle both cases.
  nextTick(() => {
    nextTick(() => {
      const el = Array.isArray(recorderEl.value) ? recorderEl.value[0] : recorderEl.value
      if (el && typeof el.focus === 'function') {
        el.focus()
      }
    })
  })
}

function stopRecord() {
  if (recordingId.value) {
    recordingId.value = null
  }
}

// Special key display-name mapping (e.code / e.key → human-readable label)
const SPECIAL_KEY_MAP: Record<string, string> = {
  // Whitespace / navigation
  'Space': 'Space', ' ': 'Space',
  'Enter': 'Enter', 'Tab': 'Tab', 'Backspace': 'Backspace', 'Delete': 'Delete',
  'Insert': 'Insert',
  // Function keys
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5', 'F6': 'F6',
  'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
  // Symbols (need explicit mapping because .toUpperCase() mangles some)
  ';': ';', '=': '=', ',': ',', '-': '-', '.': '.', '/': '/', '`': '`',
  '[': '[', '\\\\': '\\\\', ']': ']', '"': '"',
  // Arrow keys (useful for in-app shortcuts)
  'ArrowUp': '↑', 'ArrowDown': '↓', 'ArrowLeft': '←', 'ArrowRight': '→',
  'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
  // Numpad
  'NumLock': 'NumLock', 'ScrollLock': 'ScrollLock', 'Pause': 'Pause',
  'CapsLock': 'CapsLock',
}

function getDisplayKey(raw: string): string {
  return SPECIAL_KEY_MAP[raw] || raw
}

// Display safety: if a key looks like garbage (non-printable, too long, etc.),
// fall back to a placeholder rather than rendering junk.
function safeDisplayKey(k: string): string {
  if (!k || k.length > 12) return '�'  // suspiciously long → replacement char
  // Check for non-printable/control characters (allow space and common symbols)
  if (/[\x00-\x1F\x7F]/.test(k) && k !== ' ' && !SPECIAL_KEY_MAP[k]) return '�'
  return k
}

function resolveMainKey(e: KeyboardEvent): string | null {
  // ── Special-case high-surface-area keys FIRST (before general logic) ──
  // These keys are commonly used in shortcuts but have unreliable e.key/e.code
  // across OS / keyboard layout / WebView2 versions.
  const spaceLike: Record<string, string> = {
    'Space': 'Space', ' ': 'Space',
    'space': 'Space',
    // WebView2 on Windows sometimes reports Space with these codes
    'Spacebar': 'Space',
  }
  if (spaceLike[e.key] || spaceLike[e.code]) return 'Space'

  // Try e.code first (more stable across keyboard layouts), fall back to e.key
  const code = e.code.replace(/^(Key|Digit|Numpad)/, '') // 'KeyA' → 'A', 'Digit3' → '3'
  const rawKey = e.key

  // Single printable character
  if (rawKey.length === 1) return rawKey.toUpperCase()

  // Known special key — use the mapped display name
  const mapped = SPECIAL_KEY_MAP[rawKey] || SPECIAL_KEY_MAP[code]
  if (mapped) return mapped

  // Modifier-only press — ignore
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(rawKey)) return null

  // Fallback: use raw e.key (covers edge cases)
  return rawKey || null
}

// Sanitize a saved shortcut array — remove empty/non-string entries
function sanitizeKeys(keys: string[]): string[] {
  return keys
    .filter(k => k && typeof k === 'string' && k.trim().length > 0)
    .map(k => k.trim())
}

function onKeyDown(e: KeyboardEvent) {
  if (!recordingId.value) return
  e.preventDefault()
  e.stopPropagation()

  // Build key list: modifier keys + main key (ignore modifiers alone)
  const keys: string[] = []
  if (e.ctrlKey || e.metaKey) keys.push(e.metaKey ? 'Cmd' : 'Ctrl')
  if (e.altKey) keys.push('Alt')
  if (e.shiftKey) keys.push('Shift')

  const mainKey = resolveMainKey(e)

  // Must have a non-modifier main key + at least one modifier (for global shortcuts,
  // single keys like Enter/Delete are OK for in-app shortcuts)
  if (!mainKey) return

  keys.push(mainKey)

  // Global shortcuts require at least one modifier; in-app allow bare keys
  const isGlobal = GLOBAL_IDS.includes(recordingId.value!)
  if (isGlobal && keys.length < 2) return

  // Save new shortcut (sanitize to prevent garbage characters)
  const id = recordingId.value!
  const cleanKeys = sanitizeKeys(keys)
  customShortcuts[id] = cleanKeys
  const shortcutStr = cleanKeys.join('+')
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...savedShortcuts, [id]: cleanKeys }))
  } catch {}
  recordingId.value = null

  if (isGlobal) {
    // Global shortcuts: re-register ALL global ones with Tauri.
    const globalMap: Record<string, string> = {}
    for (const gid of GLOBAL_IDS) {
      const ks = customShortcuts[gid]
      if (ks && ks.length) globalMap[gid] = ks.join('+')
    }
    tauri.setGlobalShortcuts(globalMap).then(() => {
      toast.show(`Shortcut updated: ${shortcutStr}`, 'success')
    }).catch((err: any) => {
      toast.show(`Failed to register shortcut: ${err}`, 'error')
    })
  } else {
    // In-app shortcut: persisted only, handled by local key listeners.
    toast.show(`Shortcut updated: ${shortcutStr}`, 'success')
  }
}

function toggleClass(e: Event) {
  (e.currentTarget as HTMLElement).classList.toggle('on')
}

async function handleExportRequest() {
  try {
    const res = await api('GET', '/api/auth/export-data')
    if (res.ok) {
      const jsonStr = JSON.stringify(res.data, null, 2)
      // 使用 File System Access API 让用户选择保存位置
      if ('showSaveFilePicker' in window) {
        try {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: `clipsync-export-${new Date().toISOString().slice(0,10)}.json`,
            types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
          })
          const writable = await handle.createWritable()
          await writable.write(jsonStr)
          await writable.close()
          toast.show(t('export_requested', { email: '' }), 'success')
          emit('close-modal')
          return
        } catch (e: any) {
          if (e.name === 'AbortError') return // 用户取消
        }
      }
      // Fallback: 触发浏览器下载（Tauri webview 中会走系统默认下载目录）
      const blob = new Blob([jsonStr], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `clipsync-export-${new Date().toISOString().slice(0,10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.show(t('export_requested', { email: '' }), 'success')
      emit('close-modal')
    } else {
      toast.show(res.error || t('export_fail'), 'error')
    }
  } catch (e: any) {
    console.warn('Export failed:', e)
    toast.show(t('export_fail'), 'error')
  }
}

// ===== Plan Selection → Payment Flow =====
function selectPlan(planId: string, planName: string, price: number) {
  if (price === 0) { toast.show(t('already_free'), 'info'); return }
  selectedPlan.value = { id: planId, name: planName, price }
  emit('switch-modal', 'payment')
}

async function selectPaymentMethod(method: string) {
  const p = selectedPlan.value
  if (!p) return
  paymentSending.value = true
  try {
    const res = await api('POST', '/api/subscriptions/subscribe', { planId: p.id, billingCycle: 'monthly' })
    if (res.ok) {
      paymentResult.value = { success: true, message: t('sub_success', { n: p.name }) }
      emit('switch-modal', 'payment-result')
    } else {
      paymentResult.value = { success: false, message: res.error || t('sub_fail') }
      emit('switch-modal', 'payment-result')
    }
  } catch (e: any) {
    paymentResult.value = { success: false, message: String(e) }
    emit('switch-modal', 'payment-result')
  } finally {
    paymentSending.value = false
  }
}

// Load invoices from server
async function loadInvoices() {
  loadingInvoices.value = true
  try {
    const res = await api('GET', '/api/invoices')
    if (res.ok && Array.isArray(res.data?.invoices)) {
      invoices.value = res.data.invoices
    }
  } catch { /* ignore */ }
  loadingInvoices.value = false
}

// ===== 二维码扫码配对（手动同步兜底方案）=====
const device = useDevice()

// --- 生成配对码（本机已登录设备）---
const pairingToken = ref('')
const pairingQr = ref('')
const pairingRemaining = ref(0)
let expireTimer: number | undefined

function detectPlatform(): string {
  if (/Mac/i.test(navigator.userAgent)) return 'macos'
  if (/Linux/i.test(navigator.userAgent)) return 'linux'
  return 'windows'
}

async function generatePairing() {
  try {
    const res = await initPairing()
    if (res.ok && res.data) {
      pairingToken.value = res.data.token
      pairingRemaining.value = Math.max(0, Math.ceil((res.data.expiresAt - Date.now()) / 1000))
      pairingQr.value = await (QRCode as any).toDataURL(`clipsync://pair?token=${res.data.token}`, { width: 220, margin: 1 })
      if (expireTimer) clearInterval(expireTimer)
      expireTimer = window.setInterval(() => {
        pairingRemaining.value -= 1
        if (pairingRemaining.value <= 0 && expireTimer) {
          clearInterval(expireTimer)
          expireTimer = undefined
          pairingQr.value = ''
        }
      }, 1000)
    } else {
      toast.show(res.error || t('pair_generate_fail'), 'error')
    }
  } catch (e: any) {
    toast.show(t('pair_generate_fail') + String(e), 'error')
  }
}

function copyPairingToken() {
  if (!pairingToken.value) return
  navigator.clipboard.writeText(pairingToken.value)
    .then(() => toast.show(t('pair_copy_done'), 'success'))
    .catch(() => toast.show(t('pair_copy_fail'), 'error'))
}

// --- 扫描/兑换配对码（扫码设备）---
const videoEl = ref<HTMLVideoElement | null>(null)
const scanning = ref(false)
const manualToken = ref('')
const redeemSending = ref(false)
let mediaStream: MediaStream | null = null
let rafId = 0

function stopScan() {
  scanning.value = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  if (mediaStream) {
    mediaStream.getTracks().forEach(tr => tr.stop())
    mediaStream = null
  }
  if (videoEl.value) videoEl.value.srcObject = null
}

async function startScan() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    if (videoEl.value) {
      videoEl.value.srcObject = mediaStream
      await videoEl.value.play()
    }
    scanning.value = true
    scanLoop()
  } catch (e: any) {
    // 摄像头不可用（无摄像头/未授权/WebView 限制）时优雅降级到手动输入
    toast.show(t('pair_camera_fail') + (e?.message ? `: ${e.message}` : ''), 'error')
  }
}

function scanLoop() {
  if (!scanning.value || !videoEl.value) return
  const video = videoEl.value
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const result = (jsQR as any)(img.data, img.width, img.height)
      if (result?.data) {
        stopScan()
        handlePairingToken(result.data)
        return
      }
    }
  }
  rafId = requestAnimationFrame(scanLoop)
}

function parseToken(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.includes('token=')) {
    return trimmed.split('token=')[1].split(/[&\s]/)[0]
  }
  return trimmed
}

async function handlePairingToken(raw: string) {
  const token = parseToken(raw)
  if (!token) {
    toast.show(t('pair_token_required'), 'error')
    return
  }
  redeemSending.value = true
  try {
    const res = await redeemPairing({
      token,
      deviceName: 'Desktop',
      deviceType: 'desktop',
      platform: detectPlatform(),
    })
    if (res.ok && res.data?.token) {
      await configStore.completeLogin(res.data.token, res.data.user.id)
      await device.loadDevices()
      toast.show(t('pair_redeem_success'), 'success')
      stopScan()
      emit('close-modal')
    } else {
      toast.show(t('pair_redeem_fail') + (res.error || ''), 'error')
    }
  } catch (e: any) {
    toast.show(t('pair_redeem_fail') + String(e), 'error')
  } finally {
    redeemSending.value = false
  }
}

function closePairModals() {
  if (expireTimer) { clearInterval(expireTimer); expireTimer = undefined }
  stopScan()
  emit('close-modal')
}

// 组件卸载（门控关闭）时兜底清理定时器与摄像头，避免泄漏
onUnmounted(() => {
  if (expireTimer) { clearInterval(expireTimer); expireTimer = undefined }
  stopScan()
})

// ===== Sessions (real API) =====
const sessionItems = ref<any[]>([])
const loadingSessions = ref(false)
const revokingId = ref<string | null>(null)

async function loadSessions() {
  if (props.showModalType !== 'sessions') return
  loadingSessions.value = true
  try {
    const res = await api('GET', '/api/sessions')
    if (res.ok && Array.isArray(res.data?.sessions)) {
      // Mark current session
      const currentDeviceId = localStorage.getItem('clipsync-device-id')
      sessionItems.value = (res.data.sessions as any[]).map((s: any) => ({
        ...s,
        isCurrent: s.device_id === currentDeviceId || s.is_current || s.current,
      }))
    } else {
      sessionItems.value = []
    }
  } catch {
    sessionItems.value = [] // API not available → show empty
  }
  loadingSessions.value = false
}

function formatSessionTime(ts: string | number): string {
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60000) return t('just_now')
  if (diff < 3600000) return Math.floor(diff / 60000) + t('m_ago')
  if (diff < 86400000) return Math.floor(diff / 3600000) + t('h_ago')
  return Math.floor(diff / 86400000) + t('d_ago')
}

async function revokeSession(sessionId: string) {
  revokingId.value = sessionId
  try {
    const res = await api('DELETE', `/api/sessions/${sessionId}`)
    if (res.ok) {
      toast.show(t('sess_revoked'), 'success')
      sessionItems.value = sessionItems.value.filter(s => s.id !== sessionId)
    } else {
      toast.show(res.error || 'Failed to revoke session', 'error')
    }
  } catch (e: any) {
    toast.show(t('sess_revoke_fail') + String(e), 'error')
  }
  revokingId.value = null
}

// ===== Version History =====
const versionItems = ref<any[]>([])
const loadingVersions = ref(false)
const restoringId = ref<string | null>(null)
const latestVersionNum = ref(0)

async function loadVersions(clipboardItemId: string) {
  loadingVersions.value = true
  versionItems.value = []
  try {
    const res = await api('GET', `/api/versions/${clipboardItemId}`)
    if (res.ok && Array.isArray(res.data?.versions)) {
      versionItems.value = res.data.versions
      latestVersionNum.value = res.data.versions[0]?.versionNumber || 0
    }
  } catch { /* ignore */ }
  loadingVersions.value = false
}

async function restoreVersion(versionId: string) {
  restoringId.value = versionId
  try {
    const res = await api('POST', `/api/versions/restore/${versionId}`)
    if (res.ok) {
      toast.show(t('ver_restored'), 'success')
      // Reload to reflect the new version
      if (props.versionItemId) await loadVersions(props.versionItemId)
    } else {
      toast.show(res.error || 'Failed to restore', 'error')
    }
  } catch (e: any) {
    toast.show(String(e), 'error')
  }
  restoringId.value = null
}

function formatVersionTime(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60000) return t('just_now')
  if (diff < 3600000) return Math.floor(diff / 60000) + t('m_ago')
  if (diff < 86400000) return Math.floor(diff / 3600000) + t('h_ago')
  return d.toLocaleDateString()
}

// ===== Feedback =====
const fbForm = reactive({ type: 'bug', description: '', contact: '' })
const fbSending = ref(false)
const fbSent = ref(false)
const fbTypes = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: t('fb_type_feature') },
  { value: 'improvement', label: t('fb_type_improvement') },
  { value: 'other', label: t('fb_type_other') },
]
async function handleFeedbackSubmit() {
  if (!fbForm.description.trim()) return
  fbSending.value = true
  try {
    // TODO: POST /api/feedback — requires backend endpoint + email notification service
    // For now, show a message that the feature is not yet connected
    toast.show(t('fb_not_available') || 'Feedback service not yet connected. Please email us directly.', 'info')
    emit('close-modal')
  } finally { fbSending.value = false }
}
</script>

<template>
  <!-- Theme -->
  <ModalDialog :open="showModalType === 'themes'" :title="t('modal_themes')" max-width="520px" @close="emit('close-modal')">
    <div class="theme-grid">
      <div v-for="th in allThemes" :key="th.value" :class="['theme-opt', { active: currentStyle === th.value }]" @click="setStyle(th.value as any); emit('close-modal')">
        <div class="theme-preview" :style="{
          background: th.value === 'vercel' ? 'linear-gradient(135deg,#FAFAFA 0%,#E5E5E5 100%)' : th.value === 'clipsync' ? 'linear-gradient(135deg,#6366F1 0%,#A78BFA 100%)' : th.value === 'notion' ? 'linear-gradient(135deg,#FFFFFF 0%,#EBF4FF 100%)' : th.value === 'linear' ? 'linear-gradient(135deg,#0A0A0A 0%,#1a162d 100%)' : th.value === 'apple' ? 'linear-gradient(135deg,#F5F5F7 0%,#E5F1FF 100%)' : th.value === 'raycast' ? 'linear-gradient(135deg,#07080a 0%,#1b1c1e 100%)' : 'linear-gradient(135deg,#FEFEFE 0%,#F3EEFF 100%)',
          color: ['notion','apple','vercel','arc'].includes(th.value) ? '#111' : '#fff',
          border: th.value === 'notion' ? '1px solid #E8E7E3' : 'none',
        }">{{ th.value === 'vercel' ? 'Vercel ★' : th.label }}</div>
        <div class="theme-name">{{ th.label }}</div>
      </div>
    </div>
  </ModalDialog>

  <!-- Shortcuts -->
  <ModalDialog :open="showModalType === 'shortcuts'" :title="t('modal_shortcuts')" max-width="440px" @close="emit('close-modal')">
    <div class="shortcut-list">
      <div v-for="sk in shortcutList" :key="sk.id" class="sk-item" :class="{ 'sk-recording': recordingId === sk.id }">
        <span class="sk-label-wrap">{{ t(sk.label) }}<span v-if="sk.global" class="sk-global-tag">{{ t('sk_global') }}</span></span>
        <div v-if="recordingId !== sk.id" class="sk-keys" @click="startRecord(sk.id)">
          <kbd v-for="k in getKeys(sk.id)" :key="k">{{ safeDisplayKey(k) }}</kbd>
          <Pencil :size="12" class="sk-edit-ico" />
        </div>
        <div v-else ref="recorderEl" class="sk-recorder" tabindex="0" @blur="stopRecord" @keydown="onKeyDown">
          {{ t('sk_press_keys') }}...
        </div>
      </div>
    </div>
    <div class="sk-hint">
      {{ t('sk_hint') }}
    </div>
  </ModalDialog>

  <!-- Sessions -->
  <ModalDialog :open="showModalType === 'sessions'" :title="t('modal_sessions')" max-width="480px" @close="emit('close-modal'); loadSessions()">
    <div v-if="loadingSessions" class="modal-state">{{ t('sess_loading') }}</div>
    <div v-else-if="sessionItems.length === 0" class="modal-state">{{ t('sess_empty') }}</div>
    <div v-else class="session-list">
      <div v-for="s in sessionItems" :key="s.id" class="session-item">
        <div class="session-icon">
          <Monitor v-if="s.isCurrent" :size="20" />
          <Smartphone v-else :size="20" />
        </div>
        <div class="session-info"><div class="session-name">{{ s.deviceName || s.device_type || 'Unknown Device' }}</div><div class="session-detail">{{ s.isCurrent ? t('sess_current') : formatSessionTime(s.last_active || s.created_at) }}</div></div>
        <span v-if="s.isCurrent" class="session-badge">{{ t('sess_current') }}</span>
        <Button v-else variant="ghost" size="sm" class="session-revoke-btn" :disabled="revokingId === s.id" @click="revokeSession(s.id)">{{ revokingId === s.id ? '...' : t('sess_sign_out_btn') }}</Button>
      </div>
    </div>
  </ModalDialog>

  <!-- Security -->
  <ModalDialog :open="showModalType === 'security'" :title="t('modal_security')" max-width="480px" @close="emit('close-modal')">
    <div class="sec-list">
      <div class="sec-item"><div><div class="sec-label">{{ t('sec_2fa') }}</div><div class="sec-hint">{{ t('sec_2fa_h') }}</div></div><Switch :model-value="secNotif.twoFA" @update:model-value="(v: boolean) => saveSecNotif({ twoFA: v })" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('sec_login_notif') }}</div><div class="sec-hint">{{ t('sec_login_notif_h') }}</div></div><Switch :model-value="secNotif.loginNotification" @update:model-value="(v: boolean) => saveSecNotif({ loginNotification: v })" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('sec_e2ee') }}</div><div class="sec-hint">{{ t('sec_e2ee_pending') }}</div></div><Switch :model-value="false" disabled /></div>
    </div>
  </ModalDialog>

  <!-- Pricing -->
  <ModalDialog :open="showModalType === 'pricing'" :title="t('modal_pricing')" max-width="560px" @close="emit('close-modal')">
    <div class="pricing-grid">
      <div class="price-card" @click="selectPlan('free', t('price_free'), 0)"><div class="pc-name">{{ t('price_free') }}</div><div class="pc-price">¥0<span class="pc-period">{{ t('price_per_mo') }}</span></div><div class="pc-feats">✓ {{ t('feat_3dev') }}<br />✓ {{ t('feat_100hist') }}<br />✓ {{ t('feat_community') }}</div></div>
      <div class="price-card popular" @click="selectPlan('pro', t('price_pro'), 9.9)"><div class="pc-tag">{{ t('price_popular') }}</div><div class="pc-name">{{ t('price_pro') }}</div><div class="pc-price">¥9.9<span class="pc-period">{{ t('price_per_mo') }}</span></div><div class="pc-feats">✓ {{ t('feat_unlimited_dev') }}<br />✓ {{ t('feat_unlimited_hist') }}<br />✓ {{ t('feat_priority') }}</div></div>
      <div class="price-card" @click="selectPlan('enterprise', t('price_enterprise'), 29)"><div class="pc-name">{{ t('price_enterprise') }}</div><div class="pc-price">¥29<span class="pc-period">{{ t('price_per_mo') }}</span></div><div class="pc-feats">✓{{ t('feat_team') }}<br />✓ {{ t('feat_api') }}<br />✓ {{ t('feat_priority') }}</div></div>
    </div>
  </ModalDialog>

  <!-- Payment Method -->
  <ModalDialog :open="showModalType === 'payment'" :title="t('modal_payment')" max-width="420px" @close="emit('close-modal')">
    <div v-if="selectedPlan" class="pay-summary">
      <div class="pay-summary-name">{{ selectedPlan.name }}</div>
      <div class="pay-summary-price">¥{{ selectedPlan.price }}<span class="pay-summary-period">{{ t('price_per_mo') }}</span></div>
    </div>
    <div class="pay-methods">
      <Button variant="outline" class="w-full justify-start payment-option" :disabled="paymentSending" @click="selectPaymentMethod('wechat')">
        <MessageCircle class="pay-icon pay-icon--wechat" /> <span>{{ t('pay_wechat') }}</span>
      </Button>
      <Button variant="outline" class="w-full justify-start payment-option" :disabled="paymentSending" @click="selectPaymentMethod('alipay')">
        <Landmark class="pay-icon pay-icon--alipay" /> <span>{{ t('pay_alipay') }}</span>
      </Button>
    </div>
  </ModalDialog>

  <!-- Payment Result -->
  <ModalDialog :open="showModalType === 'payment-result'" :title="paymentResult?.success ? t('sub_result_success') : t('sub_result_fail')" max-width="400px" @close="emit('close-modal')">
    <div v-if="paymentResult" class="pay-result">
      <div class="pay-result-icon" :class="paymentResult.success ? 'success' : 'fail'">
        <CircleCheck v-if="paymentResult.success" :size="48" />
        <span v-else style="font-size:48px">!</span>
      </div>
      <p class="pay-result-msg">{{ paymentResult.message }}</p>
      <Button class="w-full" @click="emit('close-modal')">{{ t('confirm_t') }}</Button>
    </div>
  </ModalDialog>

  <!-- Cancel Subscription -->
  <ModalDialog :open="showModalType === 'cancel-subscription'" :title="t('sub_cancel')" max-width="420px" @close="emit('close-modal')">
    <div class="modal-center-pad20">
      <p class="cancel-text">{{ t('sub_cancel_h') }}</p>
      <Button variant="destructive" class="w-full" @click="toast.show(t('toast_signup_soon'), 'info')">{{ t('sub_cancel') }}</Button>
    </div>
  </ModalDialog>

  <!-- Billing / Invoices -->
  <ModalDialog :open="showModalType === 'billing'" :title="t('modal_billing')" max-width="480px" @close="emit('close-modal')">
    <div v-if="loadingInvoices" class="modal-state">{{ t('ver_loading') }}</div>
    <div v-else-if="invoices.length === 0" class="billing-empty-box">
      <FileText :size="48" class="billing-ico" />
      <h3 class="billing-title">{{ t('billing_empty') }}</h3>
      <p class="modal-desc">{{ t('billing_empty_desc') }}</p>
    </div>
    <div v-else class="invoice-list">
      <div v-for="inv in invoices" :key="inv.id" class="invoice-item">
        <div class="invoice-info">
          <div class="invoice-no">{{ inv.invoice_no || inv.id }}</div>
          <div class="invoice-date">{{ inv.created_at ? new Date(inv.created_at).toLocaleDateString() : '' }}</div>
        </div>
        <div class="invoice-right">
          <span class="invoice-amount">¥{{ inv.amount || 0 }}</span>
          <Button variant="ghost" size="sm" @click="toast.show(t('fb_not_available'), 'info')">
            <Download :size="14" />
          </Button>
        </div>
      </div>
    </div>
  </ModalDialog>

  <!-- Notifications -->
  <ModalDialog :open="showModalType === 'notifications'" :title="t('modal_notif')" max-width="480px" @close="emit('close-modal')">
    <div class="sec-list">
      <div class="sec-item"><div><div class="sec-label">{{ t('nf_new_device') }}</div><div class="sec-hint">{{ t('nf_new_device_h') }}</div></div><Switch :model-value="secNotif.nfNewDevice" @update:model-value="(v: boolean) => saveSecNotif({ nfNewDevice: v })" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('nf_sync_done') }}</div><div class="sec-hint">{{ t('nf_sync_done_h') }}</div></div><Switch :model-value="secNotif.nfSyncDone" @update:model-value="(v: boolean) => saveSecNotif({ nfSyncDone: v })" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('nf_security') }}</div><div class="sec-hint">{{ t('nf_security_h') }}</div></div><Switch :model-value="secNotif.nfSecurity" @update:model-value="(v: boolean) => saveSecNotif({ nfSecurity: v })" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('nf_updates') }}</div><div class="sec-hint">{{ t('nf_updates_h') }}</div></div><Switch :model-value="secNotif.nfUpdates" @update:model-value="(v: boolean) => saveSecNotif({ nfUpdates: v })" /></div>
    </div>
  </ModalDialog>

  <!-- Updates -->
  <ModalDialog :open="showModalType === 'updates'" :title="t('upd_title')" max-width="420px" @close="emit('close-modal')">
    <div class="upd-box">
      <CircleCheck :size="48" class="upd-ico" />
      <h3 class="upd-title">{{ t('upd_uptodate') }}</h3>
      <p class="upd-version">{{ t('upd_version') }}: v2.4.1</p>
      <p class="upd-latest">{{ t('upd_latest') }}</p>
      <div class="upd-changelog">
        <div class="upd-changelog-h">{{ t('upd_whatsnew') }}</div>
        <div>• {{ t('upd_changelog_1') }}</div><div>• {{ t('upd_changelog_2') }}</div><div>• {{ t('upd_changelog_3') }}</div><div>• {{ t('upd_changelog_4') }}</div>
      </div>
    </div>
  </ModalDialog>

  <!-- Feedback -->
  <ModalDialog :open="showModalType === 'feedback'" :title="t('fb_title')" max-width="480px" @close="emit('close-modal')">
    <div class="fb-form">
      <div class="fb-field">
        <label class="fb-label">{{ t('fb_type') }}</label>
        <div class="fb-type-row">
          <button v-for="ft in fbTypes" :key="ft.value" class="fb-type-btn" :class="{ active: fbForm.type === ft.value }" @click="fbForm.type = ft.value">{{ ft.label }}</button>
        </div>
      </div>
      <div class="fb-field">
        <label class="fb-label">{{ t('fb_desc') }}</label>
        <textarea v-model="fbForm.description" class="fb-textarea" rows="4" :placeholder="t('fb_desc_ph')" maxlength="1000"></textarea>
        <div class="fb-char-count">{{ fbForm.description.length }}/1000</div>
      </div>
      <div class="fb-field">
        <label class="fb-label">{{ t('fb_contact') }} <span class="fb-optional">({{ t('fb_optional') }})</span></label>
        <Input v-model="fbForm.contact" type="text" class="fb-input" :placeholder="t('fb_contact_ph')" />
      </div>
      <Button class="w-full" :disabled="!fbForm.description.trim() || fbSending" @click="handleFeedbackSubmit">
        {{ fbSending ? '...' : t('fb_submit') }}
      </Button>
      <div v-if="fbSent" class="fb-success">{{ t('fb_sent') }}</div>
    </div>
  </ModalDialog>

  <!-- Export -->
  <ModalDialog :open="showModalType === 'export'" :title="t('export_title')" max-width="480px" @close="emit('close-modal')">
    <div class="export-box">
      <div class="export-row">
        <div class="export-ico-box">
          <Download :size="24" class="export-ico" />
        </div>
        <div>
          <p class="export-title">JSON 格式数据包</p>
          <p class="export-desc">{{ t('export_msg') }}</p>
        </div>
      </div>
      <div class="export-feats">
        <span>✓ 剪贴板记录</span><span>✓ 设备信息</span><span>✓ 账户资料</span>
      </div>
      <Button class="w-full export-request-btn" @click="handleExportRequest">
        <Download :size="14" class="btn-ico-left" />
        {{ t('export_request_btn') }}
      </Button>
    </div>
  </ModalDialog>

  <!-- Forgot Password -->
  <ModalDialog :open="!!showForgotPwd" :title="t('fp_title')" max-width="420px" @close="handleCloseForgot">
    <div v-if="fpStep === 1">
      <div class="fp-field"><label class="field-label">{{ t('fp_email_label') }}</label><Input v-model="fpEmail" type="email" class="field-input" :placeholder="t('fp_email_hint')" /></div>
      <Button class="w-full" :disabled="fpSending" @click="handleForgotSend"><span v-if="fpSending" class="btn-spinner" /><span>{{ t('fp_send_code') }}</span></Button>
    </div>
    <div v-else>
      <div class="fp-field"><label class="field-label">{{ t('login_code') }}</label><Input v-model="fpCode" type="text" maxlength="6" class="field-input" :placeholder="t('ph_code_placeholder')" /></div>
      <div class="fp-field"><label class="field-label">{{ t('sp_set_pwd_label') }}</label><Input v-model="fpNewPwd" type="password" class="field-input" :placeholder="t('sp_pwd_hint')" /></div>
      <div class="fp-field fp-field--last"><label class="field-label">{{ t('sp_confirm_pwd') }}</label><Input v-model="fpConfirmPwd" type="password" class="field-input" :placeholder="t('sp_confirm_hint')" /></div>
      <Button class="w-full" :disabled="fpSending" @click="handleForgotReset"><span v-if="fpSending" class="btn-spinner" /><span>{{ t('fp_reset_btn') }}</span></Button>
    </div>
  </ModalDialog>

  <!-- Image Preview -->
  <ModalDialog :open="previewType === 'image'" :title="t('img_preview_title')" max-width="640px" @close="emit('close-preview'); resetImgZoom()">
    <div v-if="previewItem" class="img-preview-wrap">
      <div
        class="img-preview-viewport"
        @wheel.prevent.stop="onImgWheel"
        @pointerdown="onImgPointerDown"
        @pointermove="onImgPointerMove"
        @pointerup="onImgPointerUp"
        @pointercancel="onImgPointerUp"
        :style="{ cursor: isImgDragging ? 'grabbing' : (imgZoom > 1 ? 'grab' : 'zoom-in') }"
      >
        <img
          :src="previewItem.preview || previewItem.content"
          :style="{ transform: `translate(${imgPanX}px, ${imgPanY}px) scale(${imgZoom}) rotate(${imgRotate}deg)`, transition: isImgDragging ? 'none' : 'transform 0.15s ease', maxWidth: '100%', maxHeight: '380px', objectFit: 'contain', pointerEvents: 'none' }"
          alt=""
          draggable="false"
        />
      </div>
      <div class="img-preview-bar">
        <span class="img-preview-label">Image</span>
        <div class="img-preview-zoom">
          <Button variant="outline" size="icon-sm" @click="zoomOut" :disabled="imgZoom <= IMG_ZOOM_MIN" title="缩小">
            <ZoomOut :size="15" />
          </Button>
          <span class="img-zoom-level">{{ Math.round(imgZoom * 100) }}%</span>
          <Button variant="outline" size="icon-sm" @click="zoomIn" :disabled="imgZoom >= IMG_ZOOM_MAX" title="放大">
            <ZoomIn :size="15" />
          </Button>
          <Button v-if="imgZoom !== 1 || imgRotate !== 0" variant="ghost" size="sm" class="ml-1" @click="resetImgZoom" title="重置">1:1</Button>
          <span class="img-preview-sep" />
          <Button variant="outline" size="icon-sm" @click="rotateLeft" title="左旋90度">
            <RotateCcw :size="15" />
          </Button>
          <Button variant="outline" size="icon-sm" @click="rotateRight" title="右旋90度">
            <RotateCw :size="15" />
          </Button>
        </div>
        <Button variant="outline" size="sm" @click="downloadImage" class="modal-action-btn">
          <Download :size="15" />
          <span>{{ t('img_download') }}</span>
        </Button>
      </div>
    </div>
  </ModalDialog>

  <!-- Text / Document / File Detail -->
  <ModalDialog :open="previewType === 'text' || previewType === 'file'" :title="previewType === 'file' ? t('file_preview_title') : t('text_detail_title')" max-width="900px" @close="emit('close-preview')">
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
          <Button variant="ghost" size="icon-sm" :class="{ 'sensitive-locked': previewItem?.metadata?.sensitive }" @click="onToggleSensitive(previewItem)" :title="previewItem?.metadata?.sensitive ? t('sens_unlock') : t('sens_lock')">
            <Lock :size="14" />
          </Button>
        </div>
      </div>

      <!-- Loading state for file / text content -->
      <div v-if="fileContentLoading || textContentLoading" class="doc-loading">
        <div class="doc-loading-spinner" />
        <span>{{ t('preview_loading') }}</span>
      </div>

      <!-- Image file preview (with zoom/rotate controls like image preview modal) -->
      <div v-else-if="detectFileType(previewFileName) === 'image' && previewImageDataUrl" class="doc-image-file-preview">
        <div class="img-zoom-toolbar">
          <Button variant="ghost" size="icon-sm" @click="zoomOut" :disabled="imgZoom <= IMG_ZOOM_MIN" title="缩小">
            <ZoomOut :size="15" />
          </Button>
          <span class="img-zoom-label">{{ Math.round(imgZoom * 100) }}%</span>
          <Button variant="ghost" size="icon-sm" @click="zoomIn" :disabled="imgZoom >= IMG_ZOOM_MAX" title="放大">
            <ZoomIn :size="15" />
          </Button>
          <span class="img-preview-sep" />
          <Button variant="ghost" size="icon-sm" @click="rotateLeft" title="左旋90度">
            <RotateCcw :size="15" />
          </Button>
          <Button variant="ghost" size="icon-sm" @click="rotateRight" title="右旋90度">
            <RotateCw :size="15" />
          </Button>
          <Button v-if="imgZoom !== 1 || imgRotate !== 0" variant="ghost" size="sm" class="ml-1" @click="resetImgZoom" title="重置">1:1</Button>
        </div>
        <div class="img-zoom-area"
          @wheel.prevent="onImgWheel"
          @pointerdown="onImgPointerDown"
          @pointermove="onImgPointerMove"
          @pointerup="onImgPointerUp">
          <img :src="previewImageDataUrl" :alt="previewFileName"
            class="doc-image-file-img"
            :style="{ transform: `scale(${imgZoom}) rotate(${imgRotate}deg) translate(${imgPanX}px, ${imgPanY}px)` }" />
        </div>
      </div>

      <!-- Word (.docx) rendering -->
      <div v-else-if="detectFileType(previewFileName) === 'docx' && docxHtml" class="doc-preview docx-preview markdown-body" v-html="docxHtml"></div>

      <!-- PDF rendering -->
      <div v-else-if="detectFileType(previewFileName) === 'pdf' && pdfPages.length > 0" class="doc-pdf-wrap">
        <div v-if="pdfTotalPages > 20" class="doc-pdf-info">{{ t('preview_pages', { n: pdfTotalPages }) }}</div>
        <div v-for="page in pdfPages" :key="page.num" class="doc-pdf-page">
          <img :src="page.dataUrl" :alt="'Page ' + page.num" class="doc-pdf-img" />
          <span class="doc-pdf-num">{{ page.num }}</span>
        </div>
      </div>

      <!-- PPTX / other unsupported: show raw text content -->
      <div v-else-if="detectFileType(previewFileName) === 'pptx' || (detectDocType(previewContent, previewFileName) === 'Unsupported' && detectFileType(previewFileName) !== 'docx' && detectFileType(previewFileName) !== 'pdf' && detectFileType(previewFileName) !== 'image')" class="doc-preview text-preview">
        <div class="doc-unsupported-hint">{{ t('preview_unsupported') }}</div>
        {{ previewContentLines.join('\n') }}
      </div>

      <!-- Markdown rendering with TOC -->
      <div v-else-if="detectDocType(previewContent, previewFileName) === 'Markdown'" class="doc-markdown-layout">
        <!-- TOC sidebar -->
        <nav v-if="previewToc.length > 0" class="doc-toc">
          <div class="doc-toc-title">{{ t('toc_title') }}</div>
          <a v-for="item in previewToc" :key="item.id" :href="'#' + item.id" class="doc-toc-item"
             :class="'doc-toc-depth-' + item.depth"
             @click.prevent="scrollToHeading(item.id)">
            {{ item.text }}
          </a>
        </nav>
        <!-- Markdown content -->
        <div class="doc-preview markdown-body doc-markdown-content" v-html="renderMarkdown(previewContent)"></div>
      </div>

      <!-- Code with line numbers + syntax highlighting -->
      <div v-else-if="isCodeContent(previewContent, previewFileName)" class="doc-preview code-preview">
        <div class="code-lines">
          <span v-for="(_, i) in previewContentLines" :key="i" class="line-num">{{ i + 1 }}</span>
        </div>
        <pre class="code-content"><code v-html="renderCode(previewContent, previewFileName)"></code></pre>
      </div>

      <!-- HTML safe preview (DOMPurify sanitized, only when content is rich-text HTML) -->
      <div v-else-if="isHtmlContent(previewContent)" class="doc-preview html-preview-doc">
        <HtmlPreview :content="previewContent" />
      </div>

      <!-- Plain text -->
      <div v-else class="doc-preview text-preview">{{ previewContentLines.join('\n') }}</div>

      <div v-if="isTruncated" class="doc-truncated">{{ t('doc_truncated') }}</div>
    </div>
  </ModalDialog>

  <!-- Add Device -->
  <ModalDialog :open="showModalType === 'add-device'" :title="t('modal_add_device')" max-width="420px" @close="emit('close-modal')">
    <div class="modal-center-pad20">
      <div class="add-device-qr">
        <QrCode :size="48" class="add-device-ico" />
      </div>
      <p class="modal-desc">{{ t('add_device_desc') }}</p>
    </div>
  </ModalDialog>

  <!-- QR Pairing: Generate (本机已登录设备) -->
  <ModalDialog :open="showModalType === 'pair-generate'" :title="t('pair_generate')" max-width="420px" @close="closePairModals">
    <div class="pair-gen-box">
      <div v-if="pairingQr" class="pair-qr-box">
        <img :src="pairingQr" class="pair-qr-img" alt="pairing qr" />
      </div>
      <div v-else class="pair-generating">{{ t('pair_generating') }}</div>

      <p class="pair-token-box">{{ pairingToken }}</p>

      <div class="pair-btn-row">
        <Button variant="outline" size="sm" @click="copyPairingToken" :disabled="!pairingToken" class="modal-action-btn">{{ t('pair_copy') }}</Button>
        <Button variant="outline" size="sm" @click="generatePairing" class="modal-action-btn">{{ t('pair_regenerate') }}</Button>
      </div>

      <p class="pair-expire-text">
        <template v-if="pairingRemaining > 0">{{ t('pair_expire', { s: pairingRemaining }) }}</template>
        <template v-else>{{ t('pair_expired') }}</template>
      </p>
      <p class="pair-gen-desc">{{ t('pair_generate_desc') }}</p>
    </div>
  </ModalDialog>

  <!-- QR Pairing: Scan (扫码设备) -->
  <ModalDialog :open="showModalType === 'pair-scan'" :title="t('pair_scan')" max-width="460px" @close="closePairModals">
    <div class="pair-scan-box">
      <p class="pair-scan-desc">{{ t('pair_scan_desc') }}</p>

      <div class="pair-video-box">
        <video ref="videoEl" playsinline class="pair-video" :style="{ display: scanning ? 'block' : 'none' }"></video>
        <div v-if="!scanning" class="pair-camera-hint">{{ t('pair_camera_hint') }}</div>
      </div>

      <div class="pair-scan-btn-row">
        <Button v-if="!scanning" size="sm" @click="startScan" class="modal-action-btn">{{ t('pair_scan_start') }}</Button>
        <Button v-else variant="ghost" size="sm" @click="stopScan" class="modal-action-btn">{{ t('pair_scan_stop') }}</Button>
      </div>

      <div class="pair-manual-sec">
        <p class="pair-manual-label">{{ t('pair_enter_code') }}</p>
        <div class="pair-manual-row">
          <Input v-model="manualToken" class="manual-token-input" :placeholder="t('pair_token_placeholder')" />
          <Button size="sm" :disabled="redeemSending" @click="handlePairingToken(manualToken)" class="modal-action-btn">{{ t('pair_pair_btn') }}</Button>
        </div>
        <p class="pair-scan-hint">{{ t('pair_scan_hint') }}</p>
      </div>
    </div>
  </ModalDialog>

  <!-- Confirm -->
  <ModalDialog :open="showModalType === 'confirm'" :title="t('confirm_title')" max-width="380px" @close="emit('close-modal')">
    <p class="confirm-body">{{ confirmMessage }}</p>
    <template #footer>
      <Button variant="outline" @click="emit('close-modal')">{{ t('btn_cancel_text') }}</Button>
      <Button variant="default" @click="emit('confirm-action')">{{ t('confirm_t') }}</Button>
    </template>
  </ModalDialog>

  <!-- Version History -->
  <ModalDialog :open="showModalType === 'versions'" :title="t('modal_versions')" max-width="520px" @close="emit('close-modal')">
    <div v-if="loadingVersions" class="modal-state">{{ t('ver_loading') }}</div>
    <div v-else-if="versionItems.length === 0" class="modal-state">{{ t('ver_empty') }}</div>
    <div v-else class="version-list">
      <div v-for="(v, vi) in versionItems" :key="v.id" class="version-item">
        <div class="version-head" @click="v._expanded = !v._expanded" style="cursor:pointer">
          <span class="version-num">v{{ v.versionNumber }}</span>
          <span class="version-time">{{ formatVersionTime(v.createdAt) }}</span>
        </div>
        <!-- Collapsed: short preview -->
        <div v-if="!v._expanded" class="version-preview">{{ v.contentPreview || '(empty)' }}</div>
        <!-- Expanded: full content for diff comparison -->
        <div v-else class="version-full">
          <div class="version-full-label">{{ t('ver_current_content') }}</div>
          <pre class="version-code">{{ v.contentPreview || '(empty)' }}</pre>
          <div v-if="vi < versionItems.length - 1" class="version-diff-hint">
            {{ t('ver_diff_hint') }}: v{{ v.versionNumber }} → v{{ versionItems[vi + 1].versionNumber }}
          </div>
        </div>
        <div class="version-foot">
          <span class="version-device">{{ v.sourceDevice?.name || '' }}</span>
          <Button v-if="v.versionNumber !== latestVersionNum" variant="ghost" size="sm" class="version-restore-btn" :disabled="restoringId === v.id" @click="restoreVersion(v.id)">
            {{ restoringId === v.id ? '...' : t('ver_restore') }}
          </Button>
          <span v-else class="version-current">{{ t('ver_current') }}</span>
        </div>
      </div>
    </div>
  </ModalDialog>
</template>

<style scoped>
/* Override button style for inline btns */
.btn-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 6px; }
@keyframes spin { to { transform: rotate(360deg); } }

.modal-action-btn { padding: 0 20px !important; gap: 6px !important; }

.theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
.theme-opt { cursor: pointer; text-align: center; }
.theme-preview { height: 80px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.theme-name { font-size: 12px; color: var(--text-secondary); }
.theme-opt.active .theme-name { color: var(--accent); font-weight: 500; }

.shortcut-list { display: flex; flex-direction: column; gap: 8px; }
.sk-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border-subtle); font-size: 13px; }
.sk-item:last-child { border-bottom: none; }
.sk-item.sk-recording { background: var(--accent-light); border-radius: var(--radius-sm); padding: 10px 12px; }
.sk-label-wrap { display: inline-flex; align-items: center; gap: 6px; }
.sk-global-tag { font-size: 9px; font-weight: 600; line-height: 1; padding: 2px 5px; border-radius: 9999px; background: var(--accent-light); color: var(--accent); text-transform: uppercase; letter-spacing: .03em; }
.sk-keys { display: inline-flex; align-items: center; gap: 4px; flex-wrap: nowrap; flex-shrink: 0; }
.sk-keys kbd { font-size: 11px; background: var(--bg-hover); border: 1px solid var(--border-default); border-radius: 3px; padding: 2px 6px; font-family: monospace; cursor: pointer; transition: all .15s; }
.sk-keys kbd:hover { border-color: var(--accent); color: var(--accent); }
.sk-recorder { padding: 6px 14px; border-radius: var(--radius-sm); border: 2px dashed var(--accent); font-size: 13px; font-weight: 500; color: var(--accent); outline: none; min-width: 120px; text-align: center; animation: pulse-border 1.5s infinite; }

.session-list { display: flex; flex-direction: column; gap: 8px; }
.session-item { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border-subtle); }
.session-item:last-child { border-bottom: none; }
.session-icon { flex-shrink: 0; color: var(--text-secondary); }
.session-info { flex: 1; }
.session-name { font-size: 13px; font-weight: 500; }
.session-detail { font-size: 11px; color: var(--text-tertiary); margin-top: 2px; }
.session-badge { font-size: 10px; font-weight: 600; text-transform: uppercase; color: var(--accent); background: var(--accent-light); padding: 2px 8px; border-radius: 8px; }

.sec-list { display: flex; flex-direction: column; gap: 12px; }
.sec-item { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--border-subtle); }
.sec-item:last-child { border-bottom: none; }
.sec-label { font-size: 13px; font-weight: 500; }
.sec-hint { font-size: 11px; color: var(--text-tertiary); margin-top: 2px; }

.pricing-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.payment-option { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-surface); cursor: pointer; font-size: 14px; color: var(--text-primary); transition: all 150ms; }
.payment-option:hover { border-color: var(--accent); background: var(--bg-hover); }
.pay-icon { width: 22px; height: 22px; flex-shrink: 0; }
.pay-icon--wechat { color: #07C160; }
.pay-icon--alipay { color: #1677FF; }
.price-card { padding: 20px; border: 1px solid var(--border-default); border-radius: var(--radius-md); cursor: pointer; position: relative; }
.price-card:hover { border-color: var(--accent); }
.price-card.popular { border-color: var(--accent); background: var(--accent-light); }
.pc-tag { position: absolute; top: -8px; left: 50%; transform: translateX(-50%); font-size: 10px; font-weight: 600; color: var(--text-inverse); background: var(--accent); padding: 2px 10px; border-radius: 8px; }
.pc-name { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.pc-price { font-size: 24px; font-weight: 700; margin-bottom: 12px; }
.pc-period { font-size: 12px; font-weight: 400; color: var(--text-tertiary); }
.pc-feats { font-size: 12px; color: var(--text-secondary); line-height: 1.8; }

.field-input { width:100%; height: 38px; padding: 0 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-default); background: var(--bg-base); color: var(--text-primary); font-size: 14px; outline: none; font-family: inherit; box-sizing:border-box; }
.manual-token-input { flex:1; height:32px; padding:0 10px; border-radius:var(--radius-sm); border:1px solid var(--border-default); background:var(--bg-surface); color:var(--text-primary); font-size:13px; outline:none; box-sizing:border-box; }

/* Image Preview Zoom */
.img-preview-wrap { display:flex; flex-direction:column; gap:12px; }
.img-preview-viewport { position:relative; overflow:hidden; border-radius:var(--radius-md); background:var(--bg-hover); display:flex; align-items:center; justify-content:center; max-height:420px; cursor:grab; }
.img-preview-bar { display:flex; align-items:center; gap:12px; font-size:12px; color:var(--text-secondary); }
.img-preview-label { font-weight:500; color:var(--text-secondary); }
.img-preview-zoom { display:inline-flex; align-items:center; gap:6px; margin-left:auto; }
.img-zoom-level { min-width:40px; text-align:center; font-size:11px; font-weight:600; color:var(--text-tertiary); font-variant-numeric:tabular-nums; }
.img-preview-sep { width:1px; height:16px; background:var(--border-default); margin:0 4px; }

/* Shortcut recorder pulse animation */
@keyframes pulse-border {
  0%, 100% { border-color: var(--accent); opacity: 1; }
  50% { border-color: var(--text-tertiary); opacity: 0.6; }
}

/* ============================================================
   Batch 4: extracted inline styles → classes (maintainability)
   ============================================================ */

/* Shortcuts */
.sk-edit-ico { margin-left:4px; opacity:.4; cursor:pointer; }
.sk-hint { margin-top:12px; padding:8px 10px; background:var(--bg-hover); border-radius:var(--radius-sm); font-size:11px; color:var(--text-tertiary); line-height:1.6; }

/* Sessions */
.session-revoke-btn { color: var(--danger); }

/* Payment */
.pay-summary { margin-bottom:16px; padding:12px; background:var(--bg-hover); border-radius:var(--radius-sm); }
.pay-summary-name { font-size:13px; font-weight:600; color:var(--text-primary); }
.pay-summary-price { font-size:20px; font-weight:700; color:var(--text-primary); margin-top:4px; }
.pay-summary-period { font-size:13px; font-weight:400; color:var(--text-tertiary); }
.pay-methods { display:flex; flex-direction:column; gap:10px; }

/* Generic modal text helpers */
.modal-state { text-align:center; padding:24px; color:var(--text-tertiary); }
.modal-center-pad20 { text-align:center; padding:20px 0; }
.modal-desc { font-size:13px; color:var(--text-secondary); }

/* Cancel subscription */
.cancel-text { font-size:14px; color:var(--text-secondary); margin-bottom:20px; }

/* Billing */
.billing-empty-box { text-align:center; padding:40px 20px; }
.billing-ico { display: block; margin: 0 auto 12px; color: var(--text-tertiary); }
.billing-title { font-size:15px; font-weight:600; margin-bottom:4px; }

/* Updates */
.upd-box { text-align:center; padding:16px 0; }
.upd-ico { display: block; margin: 0 auto 12px; color: var(--success); }
.upd-title { font-size:16px; font-weight:600; margin-bottom:4px; }
.upd-version { font-size:13px; color:var(--text-secondary); margin-bottom:8px; }
.upd-latest { font-size:13px; color:var(--text-tertiary); }
.upd-changelog { margin-top:16px; text-align:left; font-size:12px; color:var(--text-secondary); line-height:1.8; padding:12px; background:var(--bg-hover); border-radius:var(--radius-sm); }
.upd-changelog-h { font-weight:600; margin-bottom:4px; }

/* Export */
.export-box { display:flex; flex-direction:column; gap:16px; padding:4px 0; }
.export-row { display:flex; gap:16px; align-items:flex-start; }
.export-ico-box { width:48px; height:48px; border-radius:12px; background:var(--bg-hover); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.export-ico { color: var(--accent); }
.export-title { font-size:13px; font-weight:600; color:var(--text-primary); margin-bottom:4px; }
.export-desc { font-size:12px; color:var(--text-secondary); line-height:1.6; }
.export-feats { display:flex; gap:8px; font-size:11px; color:var(--text-tertiary); }
.export-request-btn { margin-top:4px; }
.btn-ico-left { margin-right:6px; }

/* Forgot password */
.fp-field { margin-bottom:12px; }
.fp-field.fp-field--last { margin-bottom:16px; }

/* Image / Text preview */
.text-preview-content { font-size:13px; line-height:1.7; background:var(--bg-hover); padding:16px; border-radius:var(--radius-md); white-space:pre-wrap; word-break:break-word; max-height:400px; overflow-y:auto; color:var(--text-primary); }

/* Add device */
.add-device-qr { width:120px; height:120px; margin:0 auto 16px; background:var(--bg-hover); border-radius:var(--radius-md); display:flex; align-items:center; justify-content:center; }
.add-device-ico { color: var(--text-tertiary); }

/* Pairing: generate */
.pair-gen-box { text-align:center; padding:12px 0; }
.pair-qr-box { width:220px; height:220px; margin:0 auto 16px; background:#fff; border-radius:var(--radius-md); display:flex; align-items:center; justify-content:center; padding:8px; }
.pair-qr-img { width:100%; height:100%; object-fit:contain; }
.pair-generating { color:var(--text-tertiary); padding:48px 0; }
.pair-token-box { font-size:12px; color:var(--text-secondary); word-break:break-all; background:var(--bg-hover); padding:8px 10px; border-radius:var(--radius-sm); min-height:32px; }
.pair-btn-row { display:flex; gap:12px; justify-content:center; margin-top:16px; }
.pair-expire-text { font-size:12px; color:var(--text-tertiary); margin-top:10px; }
.pair-gen-desc { font-size:12px; color:var(--text-secondary); margin-top:6px; }

/* Pairing: scan */
.pair-scan-box { padding:8px 0; }
.pair-scan-desc { font-size:13px; color:var(--text-secondary); margin-bottom:12px; }
.pair-video-box { position:relative; width:100%; max-width:300px; margin:0 auto; border-radius:var(--radius-md); overflow:hidden; background:#000; aspect-ratio:1/1; display:flex; align-items:center; justify-content:center; }
.pair-video { width:100%; height:100%; object-fit:cover; }
.pair-camera-hint { color:#888; font-size:13px; text-align:center; padding:20px; }
.pair-scan-btn-row { display:flex; gap:12px; justify-content:center; margin-top:14px; }
.pair-manual-sec { margin-top:20px; border-top:1px solid var(--border-subtle); padding-top:14px; }
.pair-manual-label { font-size:12px; color:var(--text-tertiary); margin-bottom:8px; }
.pair-manual-row { display:flex; gap:10px; }
.pair-scan-hint { font-size:11px; color:var(--text-tertiary); margin-top:10px; }

/* Confirm */
.confirm-body { font-size:14px; line-height:1.6; }

/* Version History */
.version-list { display:flex; flex-direction:column; gap:8px; max-height:360px; overflow-y:auto; }
.version-item { padding:12px; border-radius:var(--radius-md); background:var(--bg-hover); border:1px solid var(--border-subtle); }
.version-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
.version-num { font-size:13px; font-weight:600; color:var(--accent); }
.version-time { font-size:11px; color:var(--text-tertiary); }
.version-preview { font-size:13px; color:var(--text-secondary); line-height:1.5; max-height:3em; overflow:hidden; text-overflow:ellipsis; word-break:break-all; }
.version-full { margin-top:6px; }
.version-full-label { font-size:11px; color:var(--text-tertiary); margin-bottom:4px; }
.version-code { font-size:12px; background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:8px; white-space:pre-wrap; word-break:break-all; max-height:120px; overflow-y:auto; font-family:'SF Mono',monospace; color:var(--text-secondary); margin:0; }
.version-diff-hint { font-size:11px; color:var(--accent); margin-top:6px; }
.version-foot { display:flex; align-items:center; justify-content:space-between; margin-top:8px; }
.version-device { font-size:11px; color:var(--text-tertiary); }
.version-restore-btn { font-size:12px; color:var(--accent); }
.version-current { font-size:11px; color:var(--text-tertiary); font-weight:500; }

/* Payment Result */
.pay-result { text-align:center; padding:16px 0; }
.pay-result-icon { margin-bottom:16px; }
.pay-result-icon.success { color:var(--success); }
.pay-result-icon.fail { color:var(--danger); }
.pay-result-msg { font-size:14px; color:var(--text-secondary); margin-bottom:20px; line-height:1.5; }

/* Invoice List */
.invoice-list { display:flex; flex-direction:column; gap:8px; max-height:300px; overflow-y:auto; }
.invoice-item { display:flex; align-items:center; justify-content:space-between; padding:12px; border-radius:var(--radius-md); background:var(--bg-hover); border:1px solid var(--border-subtle); }
.invoice-info { display:flex; flex-direction:column; gap:2px; }
.invoice-no { font-size:13px; font-weight:500; color:var(--text-primary); }
.invoice-date { font-size:11px; color:var(--text-tertiary); }
.invoice-right { display:flex; align-items:center; gap:8px; }
.invoice-amount { font-size:14px; font-weight:600; color:var(--text-primary); }

/* Document Preview */
/* Document Preview — base */
.doc-preview-wrap { display:flex; flex-direction:column; gap:10px; }
.doc-type-bar { display:flex; align-items:center; justify-content:space-between; }
.doc-type-badge { font-size:11px; font-weight:600; padding: 2px 10px; }
.doc-size { font-size:11px; color:var(--text-tertiary); }
.doc-preview { background:var(--bg-hover); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:16px; max-height:500px; overflow-y:auto; font-size:13px; line-height:1.7; }
.text-preview { white-space:pre-wrap; word-break:break-word; color:var(--text-primary); }

/* Loading state */
.doc-loading { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:40px; color:var(--text-tertiary); font-size:13px; }
.doc-loading-spinner { width:24px; height:24px; border:2px solid var(--border-default); border-top-color:var(--accent); border-radius:50%; animation:spin .6s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }

/* Unsupported file type hint (shown above raw text content) */
.doc-unsupported-hint { font-size:12px; color:var(--text-tertiary); margin-bottom:8px; padding-bottom:8px; border-bottom:1px solid var(--border-subtle); }

/* Code with line numbers */
.code-preview { display:flex; gap:0; padding:0; overflow:auto; max-height:500px; }
.code-lines { display:flex; flex-direction:column; padding:14px 0 14px 12px; border-right:1px solid var(--border-subtle); user-select:none; flex-shrink:0; }
.line-num { font-size:11px; color:var(--text-tertiary); line-height:1.65; text-align:right; min-width:32px; padding-right:8px; }
.code-content { margin:0; padding:14px; font-family:'SF Mono','Monaco','Consolas',monospace; font-size:12px; line-height:1.65; color:var(--text-primary); white-space:pre; overflow-x:auto; flex:1; }
.doc-truncated { font-size:11px; color:var(--text-tertiary); text-align:center; padding:8px 0; border-top:1px solid var(--border-subtle); }

/* Markdown + TOC layout */
.doc-markdown-layout { display:flex; gap:0; border:1px solid var(--border-subtle); border-radius:var(--radius-md); overflow:hidden; max-height:500px; }
.doc-toc { width:200px; min-width:160px; flex-shrink:0; border-right:1px solid var(--border-subtle); background:var(--bg-surface); padding:12px 0; overflow-y:auto; }
.doc-toc-title { font-size:11px; font-weight:600; color:var(--text-tertiary); text-transform:uppercase; letter-spacing:.04em; padding:0 14px 8px; }
.doc-toc-item { display:block; font-size:12px; color:var(--text-secondary); text-decoration:none; padding:3px 14px; cursor:pointer; transition:color .15s, background .15s; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.5; }
.doc-toc-item:hover { color:var(--accent); background:var(--bg-hover); }
.doc-toc-depth-1 { font-weight:600; padding-left:14px; }
.doc-toc-depth-2 { padding-left:24px; }
.doc-toc-depth-3 { padding-left:34px; font-size:11px; }
.doc-toc-depth-4,.doc-toc-depth-5,.doc-toc-depth-6 { padding-left:44px; font-size:11px; color:var(--text-tertiary); }
.doc-markdown-content { flex:1; overflow-y:auto; border:none; border-radius:0; max-height:500px; }

/* Image file preview with zoom/rotate */
.doc-image-file-preview { display:flex; flex-direction:column; border:1px solid var(--border-subtle); border-radius:var(--radius-md); overflow:hidden; }
.doc-image-file-preview .img-zoom-toolbar { display:flex; align-items:center; gap:4px; padding:6px 12px; border-bottom:1px solid var(--border-subtle); background:var(--bg-surface); flex-shrink:0; }
.doc-image-file-preview .img-zoom-label { font-size:12px; color:var(--text-secondary); min-width:40px; text-align:center; }
.doc-image-file-preview .img-preview-sep { width:1px; height:16px; background:var(--border-default); margin:0 4px; }
.doc-image-file-preview .img-zoom-area { position:relative; overflow:auto; cursor:grab; display:flex; align-items:center; justify-content:center; min-height:300px; max-height:500px; background:var(--bg-hover); }
.doc-image-file-preview .img-zoom-area:active { cursor:grabbing; }
.doc-image-file-img { max-width:100%; transform-origin:center center; transition:transform 0.1s ease; user-select:none; }

/* Word (.docx) preview */
.docx-preview { max-height:500px; overflow-y:auto; }
.docx-preview table { border-collapse:collapse; width:100%; margin:8px 0; }
.docx-preview th,.docx-preview td { border:1px solid var(--border-default); padding:4px 8px; text-align:left; font-size:12px; }
.docx-preview th { background:var(--bg-hover); font-weight:600; }
.docx-preview p { margin:4px 0; }
.docx-preview ul,.docx-preview ol { padding-left:20px; margin:4px 0; }

/* PDF preview */
.doc-pdf-wrap { display:flex; flex-direction:column; gap:8px; align-items:center; max-height:500px; overflow-y:auto; padding:8px 0; }
.doc-pdf-info { font-size:11px; color:var(--text-tertiary); text-align:center; padding:4px 0; }
.doc-pdf-page { position:relative; display:inline-block; }
.doc-pdf-img { max-width:100%; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); }
.doc-pdf-num { position:absolute; bottom:4px; right:8px; font-size:10px; color:var(--text-tertiary); background:var(--bg-surface); padding:1px 6px; border-radius:8px; }

/* Feedback */
.fb-form { display:flex; flex-direction:column; gap:16px; }
.fb-field { display:flex; flex-direction:column; gap:6px; }
.fb-label { font-size:13px; font-weight:500; color:var(--text-primary); }
.fb-optional { font-size:11px; color:var(--text-tertiary); font-weight:400; }
.fb-type-row { display:flex; gap:8px; }
.fb-type-btn { font-size:12px; padding:6px 14px; border-radius:var(--radius-md); border:1px solid var(--border-default); background:var(--bg-surface); color:var(--text-secondary); cursor:pointer; transition:all .15s; }
.fb-type-btn:hover { border-color:var(--accent); color:var(--text-primary); }
.fb-type-btn.active { background:var(--accent); color:#fff; border-color:var(--accent); }
.fb-textarea { width:100%; padding:10px; border:1px solid var(--border-default); border-radius:var(--radius-md); font-size:13px; resize:vertical; background:var(--bg-surface); color:var(--text-primary); font-family:inherit; }
.fb-textarea:focus { outline:none; border-color:var(--border-focus); box-shadow:0 0 0 3px var(--accent-light); }
.fb-char-count { font-size:11px; color:var(--text-tertiary); text-align:right; }
.fb-input { width:100%; padding-left:12px !important; }
.fb-success { font-size:13px; color:var(--success); text-align:center; margin-top:8px; }

/* Privacy: sensitive content mask in modal preview */
.doc-mask-overlay {
  position: absolute; inset: 0; z-index: 10;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-hover); border-radius: var(--radius-md);
}
.doc-mask-content { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.doc-mask-icon { color: var(--text-tertiary); opacity: 0.6; }
.doc-mask-text { font-size: 13px; color: var(--text-secondary); }
.doc-peek-btn { padding: 6px 16px; border-radius: 9999px; border: 1px solid var(--border-default); background: var(--bg-surface); font-size: 12px; color: var(--accent); cursor: pointer; transition: all 0.12s; }
.doc-peek-btn:hover { background: var(--accent-bg); border-color: var(--accent); }

/* Ensure doc-preview-wrap is position:relative for the overlay */
.doc-preview-wrap { position: relative; }

/* HTML safe preview wrapper in detail modal */
.html-preview-doc { max-height: 70vh; overflow: auto; }
</style>

<!-- Non-scoped styles: needed for v-html rendered content (markdown-body) -->
<style>
.markdown-body { color:var(--text-primary); font-size:14px; line-height:1.7; word-wrap:break-word; }
.markdown-body > :first-child { margin-top:0 !important; }
.markdown-body > :last-child { margin-bottom:0 !important; }
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body h5,.markdown-body h6 { margin:24px 0 16px; font-weight:600; line-height:1.35; scroll-margin-top:8px; }
.markdown-body h1 { font-size:26px; padding-bottom:8px; border-bottom:1px solid var(--border-subtle); }
.markdown-body h2 { font-size:22px; padding-bottom:6px; border-bottom:1px solid var(--border-subtle); }
.markdown-body h3 { font-size:18px; }
.markdown-body h4 { font-size:16px; }
.markdown-body h5 { font-size:14px; }
.markdown-body h6 { font-size:14px; color:var(--text-secondary); }
.markdown-body p { margin:12px 0; }
.markdown-body a { color:var(--accent); text-decoration:none; }
.markdown-body a:hover { text-decoration:underline; }
.markdown-body strong { font-weight:600; }
.markdown-body em { font-style:italic; }
.markdown-body del { text-decoration:line-through; color:var(--text-tertiary); }
.markdown-body code { background:rgba(175,184,193,0.15); padding:2px 7px; border-radius:6px; font-family:'SF Mono','Monaco','Consolas','Liberation Mono',monospace; font-size:85%; }
.markdown-body pre { background:var(--bg-hover); border:1px solid var(--border-subtle); border-radius:8px; padding:16px; overflow-x:auto; margin:16px 0; line-height:1.5; }
.markdown-body pre code { background:none; padding:0; border-radius:0; font-size:12.5px; font-family:'SF Mono','Monaco','Consolas','Liberation Mono',monospace; color:var(--text-primary); white-space:pre; }
.markdown-body ul,.markdown-body ol { padding-left:2em; margin:12px 0; }
.markdown-body li { margin:4px 0; line-height:1.7; }
.markdown-body li + li { margin-top:4px; }
.markdown-body ul ul,.markdown-body ul ol,.markdown-body ol ul,.markdown-body ol ol { margin:4px 0; }
.markdown-body input[type="checkbox"] { margin-right:6px; vertical-align:middle; }
.markdown-body blockquote { margin:16px 0; padding:8px 16px; border-left:4px solid var(--accent); color:var(--text-secondary); background:transparent; }
.markdown-body blockquote > :first-child { margin-top:0; }
.markdown-body blockquote > :last-child { margin-bottom:0; }
.markdown-body table { border-collapse:collapse; border-spacing:0; margin:16px 0; width:100%; display:block; overflow:auto; }
.markdown-body table th,.markdown-body table td { padding:8px 16px; border:1px solid var(--border-default); font-size:13px; }
.markdown-body table th { font-weight:600; background:var(--bg-hover); }
.markdown-body table tr:nth-child(2n) { background:var(--bg-hover); }
.markdown-body table tr { background:var(--bg-surface); }
.markdown-body hr { border:none; border-top:2px solid var(--border-subtle); margin:24px 0; height:0; overflow:hidden; }
.markdown-body img { max-width:100%; border-radius:6px; }
.markdown-body details { margin:12px 0; padding:8px 12px; border:1px solid var(--border-subtle); border-radius:6px; }
.markdown-body details summary { cursor:pointer; font-weight:600; padding:4px 0; }
.markdown-body details[open] summary { margin-bottom:8px; }
.markdown-body .hljs { background:transparent; color:var(--text-primary); }
.markdown-body .hljs-keyword { color:#cf222e; }
.markdown-body .hljs-string { color:#0a3069; }
.markdown-body .hljs-comment { color:var(--text-tertiary); font-style:italic; }
.markdown-body .hljs-number { color:#0550ae; }
.markdown-body .hljs-function { color:#8250df; }
.markdown-body .hljs-title { color:#8250df; }
.markdown-body .hljs-built_in { color:#e36209; }
.markdown-body .hljs-type { color:#953800; }
.markdown-body .hljs-attr { color:#0550ae; }
.markdown-body .hljs-meta { color:#6e7781; }
.markdown-body .hljs-literal { color:#0550ae; }
</style>
