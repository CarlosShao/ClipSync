/**
 * TextBuffer — 思考静息期的文本缓冲与定时释放
 *
 * 当模型仍在「思考」阶段（thinkingActive=true）输出 token 时，
 * 正文（text）增量先暂存在 buffer 中，等思考静默期结束后一次性释放。
 * 这解决了"思考折叠面板还在打字，正文就抢着出来"的观感问题。
 *
 * 从 useAiChat.ts 的 streamChat 闭包内提取（appendTextDelta / flushTextBuffer / flushAllTextBuffers）
 * 关键变更：flushAllTextBuffers 通过参数接收 assistantMsg 引用，
 * 替代原闭包捕获方式，使模块保持无外部依赖。
 */

const THINKING_SILENCE_MS = 600

interface TextBufferSlot {
  buffer: string
  lastThinkingAt: number
  flushTimer: number | null
}

const bufferByBucket = new WeakMap<object, TextBufferSlot>()

function getOrCreateSlot(bucket: object): TextBufferSlot {
  let s = bufferByBucket.get(bucket)
  if (!s) {
    s = { buffer: '', lastThinkingAt: 0, flushTimer: null }
    bufferByBucket.set(bucket, s)
  }
  return s
}

/**
 * 思考增量到达 → 更新心跳时间并取消待定的 flush 定时器，
 * 确保 text 不会在思考仍在活跃时被释放。
 */
export function markThinkingHeartbeat(bucket: object) {
  const slot = getOrCreateSlot(bucket)
  slot.lastThinkingAt = Date.now()
  if (slot.flushTimer !== null) {
    window.clearTimeout(slot.flushTimer)
    slot.flushTimer = null
  }
}

/**
 * 判断 bucket 所属的思考是否仍处于活跃期。
 * 活跃条件：thinkingActive !== false 且距上次思考心跳 < 1200ms
 */
export function isThinkingStillLive(bucket: any): boolean {
  if (bucket.thinkingActive === false) return false
  const slot = bufferByBucket.get(bucket)
  if (!slot) return false
  return Date.now() - slot.lastThinkingAt < 1200
}

/**
 * 把 text 增量追加到 bucket.content。
 * 思考活跃时先Buffers以暂停显示；思考静默后定时释放。
 */
export function appendTextDelta(bucket: any, delta: string) {
  if (!delta) return
  const slot = getOrCreateSlot(bucket)

  if (isThinkingStillLive(bucket)) {
    // 思考仍在活跃输出 → text 先暂存 buffer，静默期后释放
    slot.buffer += delta
    if (slot.flushTimer === null) {
      slot.flushTimer = window.setTimeout(() => {
        slot.flushTimer = null
        if (bucket.thinkingActive !== false) {
          bucket.thinkingActive = false
          bucket.sealThinkingSegment?.(bucket)
        }
        flushTextBuffer(bucket)
      }, 1250)
    }
  } else {
    // 思考已暂停/结束 → 先 flush 残余 buffer，再直接追加
    flushTextBuffer(bucket)
    bucket.content = (bucket.content || '') + delta
  }
}

/**
 * 强制释放当前 bucket 的 text buffer（工具调用时 / 流结束时调用），
 * 防止内容卡在 buffer 里丢失。
 */
export function flushTextBuffer(bucket: any) {
  const slot = bufferByBucket.get(bucket)
  if (!slot || !slot.buffer) return
  if (slot.flushTimer !== null) {
    window.clearTimeout(slot.flushTimer)
    slot.flushTimer = null
  }
  bucket.content = (bucket.content || '') + slot.buffer
  slot.buffer = ''
}

/**
 * 对所有已知 bucket 统一 flush（onDone / onError / onInterrupt 兜底清理）。
 * @param assistantMsg 主助手消息（包含 agentRuns）
 * @param sealFn 思考封段函数（可选，flush 截断时调用）
 */
export function flushAllTextBuffers(assistantMsg: any, sealFn?: (bucket: any) => void) {
  flushTextBuffer(assistantMsg)
  for (const run of assistantMsg.agentRuns || []) {
    if (sealFn) sealFn(run)
    flushTextBuffer(run)
  }
}
