import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useConfigStore } from '@/stores/configStore'

const PIN_KEY = 'clipsync-privacy-pin'
const PIN_TIMEOUT_KEY = 'clipsync-privacy-timeout'
const DEFAULT_PIN_TIMEOUT = 30000 // 30 seconds
const CLIPBOARD_CLEAR_DELAY = 5000 // 5 seconds

// ── Module-level shared state (all instances share the same refs) ──
const _pinSet = ref(false)
const _pinVerified = ref(false)
const _peekItemId = ref<string | null>(null)
const _pinExpiresAt = ref<number>(0) // timestamp when PIN verification expires
let _peekTimer: ReturnType<typeof setTimeout> | null = null
let _clipboardTimer: ReturnType<typeof setTimeout> | null = null

export function usePrivacy() {
  const configStore = useConfigStore()

  // Load PIN from localStorage — NO default PIN
  function loadPin() {
    const saved = localStorage.getItem(PIN_KEY)
    _pinSet.value = !!saved && saved.length >= 4
  }

  // Set a new PIN (4-6 digits)
  function setPin(pin: string): boolean {
    if (!/^\d{4,6}$/.test(pin)) return false
    localStorage.setItem(PIN_KEY, pin)
    _pinSet.value = true
    _pinVerified.value = true
    _pinExpiresAt.value = Date.now() + getPinTimeout()
    return true
  }

  // Verify PIN
  function verifyPin(pin: string): boolean {
    const saved = localStorage.getItem(PIN_KEY)
    const ok = saved !== null && saved === pin
    if (ok) {
      _pinVerified.value = true
      _pinExpiresAt.value = Date.now() + getPinTimeout()
    }
    return ok
  }

  // Reset PIN
  function resetPin() {
    const oldPinSet = _pinSet.value
    localStorage.removeItem(PIN_KEY)
    _pinSet.value = false
    _pinVerified.value = false
    _peekItemId.value = null
    _pinExpiresAt.value = 0
    if (_peekTimer) {
      clearTimeout(_peekTimer)
      _peekTimer = null
    }
  }

  // Get/set PIN timeout (ms), persisted in localStorage
  function getPinTimeout(): number {
    const raw = localStorage.getItem(PIN_TIMEOUT_KEY)
    const parsed = raw ? Number(raw) : NaN
    if (!isNaN(parsed) && parsed >= 5000 && parsed <= 3600000) return parsed
    return DEFAULT_PIN_TIMEOUT
  }
  function setPinTimeout(ms: number) {
    if (ms < 5000 || ms > 3600000) return
    localStorage.setItem(PIN_TIMEOUT_KEY, String(ms))
  }

  // Remaining time before PIN expires (ms), or 0 if not verified
  function getPinRemaining(): number {
    if (!_pinVerified.value) return 0
    return Math.max(0, _pinExpiresAt.value - Date.now())
  }

  // Peek: temporarily reveal sensitive content
  // ALWAYS requires PIN if set — without PIN, locked content stays masked
  function startPeek(itemId: string): boolean {
    const remaining = getPinRemaining()
    if (!_pinSet.value) return false
    if (_pinVerified.value && remaining > 0) {
      _peekItemId.value = itemId
      if (_peekTimer) clearTimeout(_peekTimer)
      _peekTimer = setTimeout(() => {
        _pinVerified.value = false
        _peekItemId.value = null
        _pinExpiresAt.value = 0
      }, remaining)
      return true
    }
    if (_pinVerified.value && remaining <= 0) {
      _pinVerified.value = false
      _pinExpiresAt.value = 0
    }
    return false
  }

  // Can copy sensitive content? ALWAYS requires PIN if set and not expired
  function canCopySensitive(): boolean {
    if (!_pinSet.value) return false // no PIN → cannot copy any sensitive content
    if (_pinVerified.value && getPinRemaining() > 0) return true
    return false
  }

  // Auto-blur on window lose focus
  function onWindowBlur() {
    if (configStore.autoBlur) {
      _pinVerified.value = false
      _peekItemId.value = null
      if (_peekTimer) {
        clearTimeout(_peekTimer)
        _peekTimer = null
      }
    }
  }

  // Clipboard auto-clear after copy
  function scheduleClipboardClear() {
    if (_clipboardTimer) clearTimeout(_clipboardTimer)
    _clipboardTimer = setTimeout(() => {
      if (navigator.clipboard) {
        navigator.clipboard.writeText('').catch(() => {})
      }
    }, CLIPBOARD_CLEAR_DELAY)
  }

  // Detect sensitive content by regex patterns
  function isSensitiveContent(text: string): boolean {
    if (!text || text.length > 5000) return false
    const t = text.trim()
    if (/\b(AKIA|AIza|sk-or-v1-|sk-proj-|sk-ant-|sk-)[A-Za-z0-9]{16,}\b/.test(t)) return true
    if (/\bghp_[A-Za-z0-9]{36}\b/.test(t)) return true
    if (/\bsk_live_[A-Za-z0-9]{24,}\b/.test(t)) return true
    if (/\bxox[baprs]-[A-Za-z0-9-]+/.test(t)) return true
    if (/Bearer\s+[A-Za-z0-9_.-]{20,}/i.test(t)) return true
    if (/-----BEGIN\s+(RSA|EC|OPENSSH|DSA|PGP)\s+PRIVATE\s+Key-----/.test(t)) return true
    if (/^(password|passwd|pwd|secret|api[_-]?key)\s*[:=]\s*.{4,}$/im.test(t)) return true
    // Long base64-looking secrets (40+ chars). Require mixed case and digits
    // *inside the token itself* so file paths/filenames made of separate words
    // (e.g. CursorUserSetup + stepfun-desktop-0.3.22...) are not flagged.
    const longTokens = t.match(/\b[A-Za-z0-9_-]{40,}\b/g)
    if (longTokens && longTokens.some((token) => /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token)))
      return true
    if (/(mongodb|mysql|postgres|redis|amqp):\/\/[^:]+:([^@]+)@/.test(t)) return true
    return false
  }

  // Check if item is sensitive: manual lock ALWAYS respected. Auto-detect only
  // applies to text-like types (text/link/code); file paths and images are not
  // considered secrets and should not trigger false positives.
  function isItemSensitive(item: any): boolean {
    const manualLock = item.metadata?.sensitive === true
    const itemType = item.type || item.contentType
    const textLikeTypes = ['text', 'link', 'code']
    const autoDetect =
      configStore.privacyMode && textLikeTypes.includes(itemType) && isSensitiveContent(item.content || '')
    return manualLock || autoDetect
  }

  onMounted(() => {
    loadPin()
    window.addEventListener('blur', onWindowBlur)
  })

  onUnmounted(() => {
    window.removeEventListener('blur', onWindowBlur)
    if (_peekTimer) {
      clearTimeout(_peekTimer)
      _peekTimer = null
    }
    if (_clipboardTimer) {
      clearTimeout(_clipboardTimer)
      _clipboardTimer = null
    }
  })

  return {
    pinSet: computed(() => _pinSet.value),
    pinVerified: computed(() => _pinVerified.value),
    peekItemId: computed(() => _peekItemId.value),
    pinRemaining: computed(() => getPinRemaining()),
    loadPin,
    setPin,
    verifyPin,
    resetPin,
    getPinTimeout,
    setPinTimeout,
    startPeek,
    canCopySensitive,
    scheduleClipboardClear,
    isSensitiveContent,
    isItemSensitive,
  }
}
