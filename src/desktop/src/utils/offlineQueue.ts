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
import { logger } from './logger'

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
  } catch {
    return []
  }
}

function saveQueue(queue: OfflineAction[]) {
  // Enforce size limit — drop oldest if exceeded
  if (queue.length > MAX_QUEUE_SIZE) {
    queue = queue.slice(queue.length - MAX_QUEUE_SIZE)
  }
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch {
    /* quota exceeded — drop oldest entries */
    const half = queue.slice(Math.floor(queue.length / 2))
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(half))
    } catch (e) {
      console.warn('[OfflineQueue] persist failed after trim:', e)
    }
  }
}

let flushing = false

/**
 * 串行锁：所有对 localStorage 队列的读写（enqueue / flushQueue 的 load→改→save）
 * 都通过该 promise 链串行化，杜绝竞态。
 *
 * 原 bug：enqueue 的 loadQueue→saveQueue 与 flushQueue 的 loadQueue→（网络 await）→saveQueue
 * 没有互斥。若 enqueue 发生在 flush 读取快照之后、flush 写回之前，enqueue 写入的项会被
 * flush 的 saveQueue(remaining) 盲写覆盖 → 永久丢失。
 * 现在两者都进入同一队列，enqueue 必然在 flush 的 save 之后才执行 → 不再丢写。
 */
let queueChain: Promise<unknown> = Promise.resolve()

function withQueueLock<T>(fn: () => T | Promise<T>): Promise<T> {
  // 无论前序任务成功/失败都执行 fn；把自身挂到 chain 上，并吞掉自身 rejection 防止污染 chain
  const run = queueChain.then(
    () => fn(),
    () => fn(),
  )
  queueChain = run.then(
    () => {},
    () => {},
  )
  return run
}

/** Add an action to the offline queue. */
export function enqueue(action: Omit<OfflineAction, 'id' | 'timestamp'>) {
  return withQueueLock(() => {
    const entry: OfflineAction = {
      id: `off_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ...action,
      timestamp: Date.now(),
    }
    const queue = loadQueue()
    queue.push(entry)
    saveQueue(queue)
    logger.debug(`[OfflineQueue] Enqueued ${action.type} (queue size: ${queue.length})`)
    return entry
  })
}

/** Flush pending actions to the server. Called automatically on reconnect. */
export async function flushQueue(): Promise<number> {
  if (flushing) return 0
  flushing = true
  try {
    return await withQueueLock(async () => {
      const queue = loadQueue()
      const pending = queue.filter((a) => !a.synced)
      if (pending.length === 0) return 0

      logger.debug(`[OfflineQueue] Flushing ${pending.length} pending actions...`)

      let synced = 0
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
      const remaining = queue.filter((a) => !a.synced)
      saveQueue(remaining)

      if (synced > 0) {
        logger.debug(`[OfflineQueue] Synced ${synced} actions, ${remaining.length} remaining`)
      }
      return synced
    })
  } finally {
    flushing = false
  }
}

/** Get current queue size (for UI display). */
export function getQueueSize(): number {
  return loadQueue().filter((a) => !a.synced).length
}

/** Clear the entire queue (used on logout). */
export function clearQueue() {
  localStorage.removeItem(QUEUE_KEY)
}

/** Watch for online status changes and auto-flush. */
export function initOfflineSync(onFlush?: (count: number) => void) {
  // Listen for Tauri connectivity events if available
  window.addEventListener('online', () => {
    logger.debug('[OfflineQueue] Network restored, flushing...')
    flushQueue().then((count) => {
      if (count > 0 && onFlush) onFlush(count)
    })
  })

  // Also flush on app focus (network may have恢复d while app was backgrounded)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      flushQueue().then((count) => {
        if (count > 0 && onFlush) onFlush(count)
      })
    }
  })

  // Initial flush attempt
  flushQueue().then((count) => {
    if (count > 0 && onFlush) onFlush(count)
  })
}
