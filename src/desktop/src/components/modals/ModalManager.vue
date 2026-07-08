<script setup lang="ts">
import { ref, watch, reactive, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useToast } from '@/composables/useToast'
import { useTheme } from '@/composables/useTheme'
import { QrCode, MessageCircle, Landmark } from 'lucide-vue-next'
import { api } from '@/api/client'
import { useConfigStore } from '@/stores/configStore'
import { useDevice } from '@/composables/useDevice'
import { initPairing, redeemPairing } from '@/api/device'
import { useNotifications } from '@/composables/useNotifications'
import * as tauri from '@/lib/tauri'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Switch from '@/components/ui/switch/Switch.vue'
import { Pencil, Monitor, Smartphone, FileText, CircleCheck, Download, ZoomIn, ZoomOut } from 'lucide-vue-next'

const props = defineProps<{
  showModalType: string
  showForgotPwd?: boolean
  previewItem?: any
  previewType?: string
  confirmMessage?: string
}>()
const emit = defineEmits<{
  'close-modal': []
  'close-forgot-pwd': []
  'close-preview': []
  'confirm-action': []
  'switch-modal': [type: string]
}>()

// 打开「生成配对码」弹窗时自动创建二维码；离开配对类弹窗时清理计时器与摄像头
watch(() => props.showModalType, (type) => {
  if (type === 'pair-generate') {
    generatePairing()
  } else if (type !== 'pair-scan') {
    if (expireTimer) { clearInterval(expireTimer); expireTimer = undefined }
    stopScan()
  }
  if (type === 'sessions') loadSessions()
  if (type === 'notifications') loadPreferencesInto(secNotif)
})

const { t } = useI18n()
const toast = useToast()
const { allThemes, setStyle, currentStyle } = useTheme()
const { savePreference, loadPreferencesInto, PREF_TYPE_BY_KEY } = useNotifications()

// Plan selection state (for pricing → payment flow)
const selectedPlan = ref<{ id: string; name: string; price: number } | null>(null)
const paymentSending = ref(false)

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

// ===== Image Preview Zoom + Pan =====
const imgZoom = ref(1)
const imgPanX = ref(0)
const imgPanY = ref(0)
const IMG_ZOOM_MIN = 0.5
const IMG_ZOOM_MAX = 4
const IMG_ZOOM_STEP = 0.3

// Drag state for panning when zoomed in
let isImgDragging = false
let imgDragStartX = 0
let imgDragStartY = 0
let imgPanStartX = 0
let imgPanStartY = 0

function resetImgZoom() { imgZoom.value = 1; imgPanX.value = 0; imgPanY.value = 0 }
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
    toast.show(t('sub_processing'), 'info')
    const res = await api('POST', '/api/subscriptions/subscribe', { planId: p.id, billingCycle: 'monthly' })
    if (res.ok) {
      toast.show(t('sub_success', { n: p.name }), 'success')
      emit('close-modal')
    } else {
      toast.show(t('sub_fail') + (res.error || ''), 'error')
    }
  } catch (e: any) {
    toast.show(t('sub_fail') + String(e), 'error')
  } finally {
    paymentSending.value = false
  }
}

// ===== 二维码扫码配对（手动同步兜底方案）=====
const configStore = useConfigStore()
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
          <Pencil :size="12" style="margin-left:4px;opacity:.4;cursor:pointer;" />
        </div>
        <div v-else ref="recorderEl" class="sk-recorder" tabindex="0" @blur="stopRecord" @keydown="onKeyDown">
          {{ t('sk_press_keys') }}...
        </div>
      </div>
    </div>
    <div style="margin-top:12px;padding:8px 10px;background:var(--bg-hover);border-radius:var(--radius-sm);font-size:11px;color:var(--text-tertiary);line-height:1.6;">
      {{ t('sk_hint') }}
    </div>
  </ModalDialog>

  <!-- Sessions -->
  <ModalDialog :open="showModalType === 'sessions'" :title="t('modal_sessions')" max-width="480px" @close="emit('close-modal'); loadSessions()">
    <div v-if="loadingSessions" style="text-align:center;padding:24px;color:var(--text-tertiary);">{{ t('sess_loading') }}</div>
    <div v-else-if="sessionItems.length === 0" style="text-align:center;padding:24px;color:var(--text-tertiary);">{{ t('sess_empty') }}</div>
    <div v-else class="session-list">
      <div v-for="s in sessionItems" :key="s.id" class="session-item">
        <div class="session-icon">
          <Monitor v-if="s.isCurrent" :size="20" />
          <Smartphone v-else :size="20" />
        </div>
        <div class="session-info"><div class="session-name">{{ s.deviceName || s.device_type || 'Unknown Device' }}</div><div class="session-detail">{{ s.isCurrent ? t('sess_current') : formatSessionTime(s.last_active || s.created_at) }}</div></div>
        <span v-if="s.isCurrent" class="session-badge">{{ t('sess_current') }}</span>
        <Button v-else variant="ghost" size="sm" style="color:var(--danger)" :disabled="revokingId === s.id" @click="revokeSession(s.id)">{{ revokingId === s.id ? '...' : t('sess_sign_out_btn') }}</Button>
      </div>
    </div>
  </ModalDialog>

  <!-- Security -->
  <ModalDialog :open="showModalType === 'security'" :title="t('modal_security')" max-width="480px" @close="emit('close-modal')">
    <div class="sec-list">
      <div class="sec-item"><div><div class="sec-label">{{ t('sec_2fa') }}</div><div class="sec-hint">{{ t('sec_2fa_h') }}</div></div><Switch :model-value="secNotif.twoFA" @update:model-value="(v: boolean) => saveSecNotif({ twoFA: v })" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('sec_login_notif') }}</div><div class="sec-hint">{{ t('sec_login_notif_h') }}</div></div><Switch :model-value="secNotif.loginNotification" @update:model-value="(v: boolean) => saveSecNotif({ loginNotification: v })" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('sec_e2ee') }}</div><div class="sec-hint">{{ t('sec_e2ee_h') }}</div></div><Switch :model-value="true" disabled /></div>
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
    <div v-if="selectedPlan" style="margin-bottom:16px;padding:12px;background:var(--bg-hover);border-radius:var(--radius-sm);">
      <div style="font-size:13px;font-weight:600;color:var(--text-primary);">{{ selectedPlan.name }}</div>
      <div style="font-size:20px;font-weight:700;color:var(--text-primary);margin-top:4px;">¥{{ selectedPlan.price }}<span style="font-size:13px;font-weight:400;color:var(--text-tertiary);">{{ t('price_per_mo') }}</span></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <Button variant="outline" class="w-full justify-start payment-option" :disabled="paymentSending" @click="selectPaymentMethod('wechat')">
        <MessageCircle class="pay-icon pay-icon--wechat" /> <span>{{ t('pay_wechat') }}</span>
      </Button>
      <Button variant="outline" class="w-full justify-start payment-option" :disabled="paymentSending" @click="selectPaymentMethod('alipay')">
        <Landmark class="pay-icon pay-icon--alipay" /> <span>{{ t('pay_alipay') }}</span>
      </Button>
    </div>
  </ModalDialog>

  <!-- Cancel Subscription -->
  <ModalDialog :open="showModalType === 'cancel-subscription'" :title="t('sub_cancel')" max-width="420px" @close="emit('close-modal')">
    <div style="text-align:center;padding:20px 0;">
      <p style="font-size:14px;color:var(--text-secondary);margin-bottom:20px;">{{ t('sub_cancel_h') }}</p>
      <Button variant="destructive" class="w-full" @click="toast.show(t('toast_signup_soon'), 'info')">{{ t('sub_cancel') }}</Button>
    </div>
  </ModalDialog>

  <!-- Billing -->
  <ModalDialog :open="showModalType === 'billing'" :title="t('modal_billing')" max-width="480px" @close="emit('close-modal')">
    <div style="text-align:center;padding:40px 20px;">
      <FileText :size="48" style="color:var(--text-tertiary);margin-bottom:12px;" />
      <h3 style="font-size:15px;font-weight:600;margin-bottom:4px;">{{ t('billing_empty') }}</h3>
      <p style="font-size:13px;color:var(--text-secondary);">{{ t('billing_empty_desc') }}</p>
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
    <div style="text-align:center;padding:16px 0;">
      <CircleCheck :size="48" style="color:var(--success);margin-bottom:12px;" />
      <h3 style="font-size:16px;font-weight:600;margin-bottom:4px;">{{ t('upd_uptodate') }}</h3>
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">{{ t('upd_version') }}: v2.4.1</p>
      <p style="font-size:13px;color:var(--text-tertiary);">{{ t('upd_latest') }}</p>
      <div style="margin-top:16px;text-align:left;font-size:12px;color:var(--text-secondary);line-height:1.8;padding:12px;background:var(--bg-hover);border-radius:var(--radius-sm);">
        <div style="font-weight:600;margin-bottom:4px;">{{ t('upd_whatsnew') }}</div>
        <div>• {{ t('upd_changelog_1') }}</div><div>• {{ t('upd_changelog_2') }}</div><div>• {{ t('upd_changelog_3') }}</div><div>• {{ t('upd_changelog_4') }}</div>
      </div>
    </div>
  </ModalDialog>

  <!-- Export -->
  <ModalDialog :open="showModalType === 'export'" :title="t('export_title')" max-width="480px" @close="emit('close-modal')">
    <div style="display:flex;flex-direction:column;gap:16px;padding:4px 0;">
      <div style="display:flex;gap:16px;align-items:flex-start;">
        <div style="width:48px;height:48px;border-radius:12px;background:var(--bg-hover);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <Download :size="24" style="color:var(--accent);" />
        </div>
        <div>
          <p style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:4px;">JSON 格式数据包</p>
          <p style="font-size:12px;color:var(--text-secondary);line-height:1.6;">{{ t('export_msg') }}</p>
        </div>
      </div>
      <div style="display:flex;gap:8px;font-size:11px;color:var(--text-tertiary);">
        <span>✓ 剪贴板记录</span><span>✓ 设备信息</span><span>✓ 账户资料</span>
      </div>
      <Button class="w-full" style="margin-top:4px;" @click="handleExportRequest">
        <Download :size="14" style="margin-right:6px;" />
        {{ t('export_request_btn') }}
      </Button>
    </div>
  </ModalDialog>

  <!-- Forgot Password -->
  <ModalDialog :open="!!showForgotPwd" :title="t('fp_title')" max-width="420px" @close="handleCloseForgot">
    <div v-if="fpStep === 1">
      <div style="margin-bottom:12px;"><label class="field-label">{{ t('fp_email_label') }}</label><Input v-model="fpEmail" type="email" class="field-input" :placeholder="t('fp_email_hint')" /></div>
      <Button class="w-full" :disabled="fpSending" @click="handleForgotSend"><span v-if="fpSending" class="btn-spinner" /><span>{{ t('fp_send_code') }}</span></Button>
    </div>
    <div v-else>
      <div style="margin-bottom:12px;"><label class="field-label">{{ t('login_code') }}</label><Input v-model="fpCode" type="text" maxlength="6" class="field-input" :placeholder="t('ph_code_placeholder')" /></div>
      <div style="margin-bottom:12px;"><label class="field-label">{{ t('sp_set_pwd_label') }}</label><Input v-model="fpNewPwd" type="password" class="field-input" :placeholder="t('sp_pwd_hint')" /></div>
      <div style="margin-bottom:16px;"><label class="field-label">{{ t('sp_confirm_pwd') }}</label><Input v-model="fpConfirmPwd" type="password" class="field-input" :placeholder="t('sp_confirm_hint')" /></div>
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
        style="overflow:hidden;border-radius:var(--radius-md);background:var(--bg-hover);display:flex;align-items:center;justify-content:center;max-height:420px;cursor:grab;"
        :style="{ cursor: isImgDragging ? 'grabbing' : (imgZoom > 1 ? 'grab' : 'zoom-in') }"
      >
        <img
          :src="previewItem.preview || previewItem.content"
          :style="{ transform: `translate(${imgPanX}px, ${imgPanY}px) scale(${imgZoom})`, transition: isImgDragging ? 'none' : 'transform 0.15s ease', maxWidth: '100%', maxHeight: '380px', objectFit: 'contain', pointerEvents: 'none' }"
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
          <Button v-if="imgZoom !== 1" variant="ghost" size="sm" class="ml-1" @click="resetImgZoom" title="重置">1:1</Button>
        </div>
        <Button variant="outline" size="sm" @click="downloadImage" class="modal-action-btn">
          <Download :size="15" />
          <span>{{ t('img_download') }}</span>
        </Button>
      </div>
    </div>
  </ModalDialog>

  <!-- Text Detail -->
  <ModalDialog :open="previewType === 'text'" :title="t('text_detail_title')" max-width="640px" @close="emit('close-preview')">
    <div v-if="previewItem" style="font-size:13px;line-height:1.7;background:var(--bg-hover);padding:16px;border-radius:var(--radius-md);white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto;color:var(--text-primary);">{{ previewItem.content }}</div>
  </ModalDialog>

  <!-- Add Device -->
  <ModalDialog :open="showModalType === 'add-device'" :title="t('modal_add_device')" max-width="420px" @close="emit('close-modal')">
    <div style="text-align:center;padding:20px 0;">
      <div style="width:120px;height:120px;margin:0 auto 16px;background:var(--bg-hover);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;">
        <QrCode :size="48" style="color:var(--text-tertiary);" />
      </div>
      <p style="font-size:13px;color:var(--text-secondary);">{{ t('add_device_desc') }}</p>
    </div>
  </ModalDialog>

  <!-- QR Pairing: Generate (本机已登录设备) -->
  <ModalDialog :open="showModalType === 'pair-generate'" :title="t('pair_generate')" max-width="420px" @close="closePairModals">
    <div style="text-align:center;padding:12px 0;">
      <div v-if="pairingQr" style="width:220px;height:220px;margin:0 auto 16px;background:#fff;border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;padding:8px;">
        <img :src="pairingQr" style="width:100%;height:100%;object-fit:contain;" alt="pairing qr" />
      </div>
      <div v-else style="color:var(--text-tertiary);padding:48px 0;">{{ t('pair_generating') }}</div>

      <p style="font-size:12px;color:var(--text-secondary);word-break:break-all;background:var(--bg-hover);padding:8px 10px;border-radius:var(--radius-sm);min-height:32px;">{{ pairingToken }}</p>

      <div style="display:flex;gap:12px;justify-content:center;margin-top:16px;">
        <Button variant="outline" size="sm" @click="copyPairingToken" :disabled="!pairingToken" class="modal-action-btn">{{ t('pair_copy') }}</Button>
        <Button variant="outline" size="sm" @click="generatePairing" class="modal-action-btn">{{ t('pair_regenerate') }}</Button>
      </div>

      <p style="font-size:12px;color:var(--text-tertiary);margin-top:10px;">
        <template v-if="pairingRemaining > 0">{{ t('pair_expire', { s: pairingRemaining }) }}</template>
        <template v-else>{{ t('pair_expired') }}</template>
      </p>
      <p style="font-size:12px;color:var(--text-secondary);margin-top:6px;">{{ t('pair_generate_desc') }}</p>
    </div>
  </ModalDialog>

  <!-- QR Pairing: Scan (扫码设备) -->
  <ModalDialog :open="showModalType === 'pair-scan'" :title="t('pair_scan')" max-width="460px" @close="closePairModals">
    <div style="padding:8px 0;">
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">{{ t('pair_scan_desc') }}</p>

      <div style="position:relative;width:100%;max-width:300px;margin:0 auto;border-radius:var(--radius-md);overflow:hidden;background:#000;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;">
        <video ref="videoEl" playsinline style="width:100%;height:100%;object-fit:cover;" :style="{ display: scanning ? 'block' : 'none' }"></video>
        <div v-if="!scanning" style="color:#888;font-size:13px;text-align:center;padding:20px;">{{ t('pair_camera_hint') }}</div>
      </div>

      <div style="display:flex;gap:12px;justify-content:center;margin-top:14px;">
        <Button v-if="!scanning" size="sm" @click="startScan" class="modal-action-btn">{{ t('pair_scan_start') }}</Button>
        <Button v-else variant="ghost" size="sm" @click="stopScan" class="modal-action-btn">{{ t('pair_scan_stop') }}</Button>
      </div>

      <div style="margin-top:20px;border-top:1px solid var(--border-subtle);padding-top:14px;">
        <p style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px;">{{ t('pair_enter_code') }}</p>
        <div style="display:flex;gap:10px;">
          <Input v-model="manualToken" class="manual-token-input" :placeholder="t('pair_token_placeholder')" />
          <Button size="sm" :disabled="redeemSending" @click="handlePairingToken(manualToken)" class="modal-action-btn">{{ t('pair_pair_btn') }}</Button>
        </div>
        <p style="font-size:11px;color:var(--text-tertiary);margin-top:10px;">{{ t('pair_scan_hint') }}</p>
      </div>
    </div>
  </ModalDialog>

  <!-- Confirm -->
  <ModalDialog :open="showModalType === 'confirm'" :title="t('confirm_title')" max-width="380px" @close="emit('close-modal')">
    <p style="font-size:14px;line-height:1.6;">{{ confirmMessage }}</p>
    <template #footer>
      <Button variant="outline" @click="emit('close-modal')">{{ t('btn_cancel_text') }}</Button>
      <Button variant="destructive" @click="emit('confirm-action')">{{ t('confirm_t') }}</Button>
    </template>
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
.img-preview-viewport { position:relative; }
.img-preview-bar { display:flex; align-items:center; gap:12px; font-size:12px; color:var(--text-secondary); }
.img-preview-label { font-weight:500; color:var(--text-secondary); }
.img-preview-zoom { display:inline-flex; align-items:center; gap:6px; margin-left:auto; }
.img-zoom-level { min-width:40px; text-align:center; font-size:11px; font-weight:600; color:var(--text-tertiary); font-variant-numeric:tabular-nums; }

/* Shortcut recorder pulse animation */
@keyframes pulse-border {
  0%, 100% { border-color: var(--accent); opacity: 1; }
  50% { border-color: var(--text-tertiary); opacity: 0.6; }
}
</style>
