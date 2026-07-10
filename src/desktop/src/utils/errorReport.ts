/**
 * Global error capture for ClipSync desktop.
 *
 * Captures uncaught JS errors and unhandled Promise rejections,
 * logs structured info to console, and persists recent errors
 * to localStorage (survives app restart).
 *
 * Access via: window.__clipSyncErrors
 */

export interface ErrorEntry {
  id: string
  type: 'error' | 'unhandledrejection'
  message: string
  stack?: string
  source?: string
  lineno?: number
  colno?: number
  timestamp: number
}

const STORAGE_KEY = 'clipsync-errors'
const MAX_STORED = 50

function loadErrors(): ErrorEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveErrors(errors: ErrorEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(errors.slice(-MAX_STORED)))
  } catch { /* quota exceeded — drop oldest */ }
}

function store(entry: ErrorEntry) {
  const errors = loadErrors()
  errors.push(entry)
  saveErrors(errors)
  // Also keep in-memory reference for immediate access
  recentErrors.push(entry)
  if (recentErrors.length > MAX_STORED) recentErrors.shift()
}

const recentErrors: ErrorEntry[] = []

function formatEntry(e: ErrorEntry): string {
  const time = new Date(e.timestamp).toISOString()
  const loc = e.source && e.lineno ? ` at ${e.source}:${e.lineno}:${e.colno}` : ''
  return `[${time}] ${e.type}: ${e.message}${loc}`
}

export function initErrorCapture() {
  // Load persisted errors on startup
  const persisted = loadErrors()
  recentErrors.push(...persisted)

  // Uncaught synchronous errors
  window.onerror = (message, source, lineno, colno, error) => {
    const entry: ErrorEntry = {
      id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'error',
      message: String(message),
      stack: error?.stack || undefined,
      source: source || undefined,
      lineno: lineno || undefined,
      colno: colno || undefined,
      timestamp: Date.now(),
    }
    store(entry)
    console.error('[ClipSync Error]', formatEntry(entry))
    if (error?.stack) console.error(error.stack)
  }

  // Unhandled Promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const message = reason instanceof Error ? reason.message : String(reason)
    const stack = reason instanceof Error ? reason.stack : undefined
    const entry: ErrorEntry = {
      id: `rej_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'unhandledrejection',
      message,
      stack,
      timestamp: Date.now(),
    }
    store(entry)
    console.error('[ClipSync UnhandledRejection]', formatEntry(entry))
    if (stack) console.error(stack)
  })

  // Expose for diagnostics: window.__clipSyncErrors
  ;(window as any).__clipSyncErrors = recentErrors

  console.log('[ClipSync] Error capture initialized (persisted to localStorage)')
}

/** Get all stored errors (for export/diagnostics). */
export function getStoredErrors(): ErrorEntry[] {
  return loadErrors()
}

/** Clear all stored errors. */
export function clearStoredErrors() {
  localStorage.removeItem(STORAGE_KEY)
  recentErrors.length = 0
}
