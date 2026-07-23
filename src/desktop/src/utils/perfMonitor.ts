/**
 * Lightweight performance monitoring for ClipSync desktop.
 *
 * Captures:
 * - Startup time (app mount → first data loaded)
 * - Memory usage (renderer process, sampled periodically)
 * - WebSocket latency (round-trip ping measurement)
 * - Long tasks (>50ms blocking)
 *
 * All metrics stored in memory; accessible via window.__clipSyncPerf.
 */

import { logger } from './logger'

export interface PerfMetrics {
  startupMs: number
  firstDataLoadMs: number
  memoryMB: number
  wsLatencyMs: number
  longTaskCount: number
  lastLongTaskMs: number
}

const metrics: PerfMetrics = {
  startupMs: 0,
  firstDataLoadMs: 0,
  memoryMB: 0,
  wsLatencyMs: 0,
  longTaskCount: 0,
  lastLongTaskMs: 0,
}

let perfStart = 0
let memoryInterval: ReturnType<typeof setInterval> | null = null

/** Call at app mount to start timing. */
export function perfStartTimer() {
  perfStart = performance.now()
}

/** Call after first data load completes. */
export function perfFirstDataLoad() {
  if (metrics.firstDataLoadMs === 0) {
    metrics.firstDataLoadMs = Math.round(performance.now() - perfStart)
    logger.debug(`[Perf] First data load: ${metrics.firstDataLoadMs}ms`)
  }
}

/** Record WebSocket round-trip latency. */
export function perfRecordWsLatency(ms: number) {
  metrics.wsLatencyMs = Math.round(ms)
}

/** Sample memory usage periodically (every 30s). */
function sampleMemory() {
  if ((performance as any).memory) {
    const used = (performance as any).memory.usedJSHeapSize
    metrics.memoryMB = Math.round(used / 1024 / 1024)
  }
}

/** Detect long tasks (>50ms) via PerformanceObserver. */
function observeLongTasks() {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 50) {
          metrics.longTaskCount++
          metrics.lastLongTaskMs = Math.round(entry.duration)
        }
      }
    })
    observer.observe({ type: 'longtask', buffered: true })
  } catch {
    /* longtask not supported */
  }
}

/** Initialize all perf monitoring. */
export function initPerfMonitor() {
  perfStartTimer()
  observeLongTasks()
  memoryInterval = setInterval(sampleMemory, 30000)
  sampleMemory()
  metrics.startupMs = Math.round(performance.now())
  ;(window as any).__clipSyncPerf = metrics
  logger.debug('[Perf] Performance monitoring initialized')
}

/** Stop all monitoring (cleanup). */
export function stopPerfMonitor() {
  if (memoryInterval) {
    clearInterval(memoryInterval)
    memoryInterval = null
  }
}

/** Get current metrics snapshot. */
export function getPerfMetrics(): Readonly<PerfMetrics> {
  return { ...metrics }
}
