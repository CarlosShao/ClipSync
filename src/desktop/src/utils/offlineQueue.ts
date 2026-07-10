/**
 * Offline action queue for ClipSync desktop.
 *
 * When the network is unavailable, clipboard create/delete operations
 * are queued to localStorage. On reconnection, the queue is flushed
 * to the server in order.
 *
 * Queue entry shape:
 * { id, type: 'create'|'delete', payload, timestamp, synced: false }
 */

import { api } from '@/api/client'

export interface OfflineAction {
  id: string
  type: 'create' | 'delete'
  payload: any
  timestamp: number
  synced?: boolean
}

const QUEUE_KEY = 'clipsync-offline-queue'
const MAX_QUEUE_SIZE = 200

function loadQueue(): OfflineAction[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveQueue(queue: OfflineAction[]) {
  // Enforce size limit — drop oldest if exceeded
  if (queue.length > MAX_QUEUE_SIZE) {
    queue = queue.slice(queue.length - MAX_QUEUE_SIZE)
  }
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch { /* quota exceeded — drop oldest entries */
    const half = queue.slice(Math.floor(queue.length / 2))
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(half)) } catch {}
  }
}

let flushing = false

/** Add an action to the offline queue. */
export function enqueue(action: Omit<OfflineAction, 'id' | 'timestamp'>) {
  const entry: OfflineAction = {
    id: `off_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ...action,
    timestamp: Date.now(),
  }
  const queue = loadQueue()
  queue.push(entry)
  saveQueue(queue)
  console.log(`[OfflineQueue] Enqueued ${action.type} (queue size: ${queue.length})`)
}

/** Flush pending actions to the server. Called automatically on reconnect. */
export async function flushQueue(): Promise<number> {
  if (flushing) return 0
  flushing = true
  let synced = 0

  try {
    const queue = loadQueue()
    const pending = queue.filter(a => !a.synced)
    if (pending.length === 0) { flushing = false; return 0 }

    console.log(`[OfflineQueue] Flushing ${pending.length} pending actions...`)

    for (const action of pending) {
      try {
        let res
        if (action.type === 'create') {
          res = await api('POST', '/api/clipboard', action.payload)
        } else if (action.type === 'delete') {
          res = await api('DELETE', `/api/clipboard/${action.payload.id}`)
        }
        if (res?.ok) {
          action.synced = true
          synced++
        }
      } catch (e) {
        console.warn(`[OfflineQueue] Failed to sync ${action.id}:`, e)
        break // Stop on first failure to preserve order
      }
    }

    // Remove synced entries
    const remaining = queue.filter(a => !a.synced)
    saveQueue(remaining)

    if (synced > 0) {
      console.log(`[OfflineQueue] Synced ${synced} actions, ${remaining.length} remaining`)
    }
  } finally {
    flushing = false
  }

  return synced
}

/** Get current queue size (for UI display). */
export function getQueueSize(): number {
  return loadQueue().filter(a => !a.synced).length
}

/** Clear the entire queue (used on logout). */
export function clearQueue() {
  localStorage.removeItem(QUEUE_KEY)
}

/** Watch for online status changes and auto-flush. */
export function initOfflineSync(onFlush?: (count: number) => void) {
  // Listen for Tauri connectivity events if available
  window.addEventListener('online', () => {
    console.log('[OfflineQueue] Network restored, flushing...')
    flushQueue().then(count => { if (count > 0 && onFlush) onFlush(count) })
  })

  // Also flush on app focus (network may have恢复d while app was backgrounded)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      flushQueue().then(count => { if (count > 0 && onFlush) onFlush(count) })
    }
  })

  // Initial flush attempt
  flushQueue().then(count => { if (count > 0 && onFlush) onFlush(count) })
}
