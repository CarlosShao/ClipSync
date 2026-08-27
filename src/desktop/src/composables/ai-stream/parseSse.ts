/**
 * ParseSse — 原始 SSE buffer 解析器
 *
 * 从 api/ai.ts 的 streamChat / processBuffer 逻辑提取、适配为无副作用的纯函数。
 * processBuffer 是闭包内的可变状态操作，parseSseChunk 将其包装为
 * 输入 buffer → 输出 ParsedEvent[] 的统计式解析。
 *
 * 使用方式：
 *   let buffer = ''
 *   buffer += chunk
 *   const events = parseSseChunk(buffer)   // 返回完整事件的列表
 *   // 解析器不消费未完整的事件（末尾不带 \n\n 的 partial）；
 *   // 调用方需自行保留剩余 buffer。
 *
 *  注意：parseSseChunk 会解析 buffer 中所有用 \n\n 分隔的完整事件，
 *  但不 mutate buffer——调用方决定如何切片/截断。
 */

export interface ParsedSseMeta {
  agentId?: string
  agent?: {
    id: string
    name: string
    status: string
    kind?: string
    error?: string
  }
  usage?: {
    contextWindow: number
    totalTokens: number
    promptTokens: number
    completionTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    cacheHitRate?: number
    thinkingTokens?: number
    replyTokens?: number
  }
  type?: string
  requestId?: string
  tool?: string
  argsSummary?: string
  impact?: string
  imageHash?: string
  existingId?: string
  createdAt?: string
  preview?: string
  removedMessages?: number
  savedTokens?: number
  beforeTokens?: number
  afterTokens?: number
}

export interface ParsedSseDelta {
  thinking?: string
  tool_call?: any
  tool_result?: any
  content?: string
}

export interface ParsedEvent {
  type: 'delta' | 'meta' | 'done'
  delta?: ParsedSseDelta
  meta?: ParsedSseMeta
}

interface RawSseEvent {
  dataLines: string[]
}

function extractRawEvents(buffer: string): RawSseEvent[] {
  const events: RawSseEvent[] = []
  let remaining = buffer
  while (true) {
    const idx = remaining.indexOf('\n\n')
    if (idx === -1) break
    const raw = remaining.slice(0, idx)
    remaining = remaining.slice(idx + 2)
    const dataLines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
    events.push({ dataLines })
  }
  return events
}

function parseEventFromLines(dataLines: string[]): ParsedEvent | null {
  for (const data of dataLines) {
    if (!data) continue
    if (data === '[DONE]') return { type: 'done' }
    try {
      const parsed = JSON.parse(data)
      if (parsed.error) {
        // 错误事件用 meta 包装，调用方决定如何处理
        return { type: 'meta', meta: { type: 'error' as string, ...parsed } }
      }
      if (parsed.meta) {
        const meta: ParsedSseMeta = { ...parsed.meta }
        return { type: 'meta', meta }
      }
      const delta: ParsedSseDelta = {}
      if (parsed.choices?.[0]?.delta) {
        const d = parsed.choices[0].delta
        if (d.thinking) delta.thinking = d.thinking
        if (d.tool_call) delta.tool_call = d.tool_call
        if (d.tool_result) delta.tool_result = d.tool_result
        if (d.content) delta.content = d.content
      }
      if (Object.keys(delta).length === 0) return null
      const meta: ParsedSseMeta = {}
      const d = parsed.choices?.[0]?.delta
      if (d?.agent_id) meta.agentId = d.agent_id
      if (d?.agent) meta.agent = d.agent
      return { type: 'delta', delta, meta: Object.keys(meta).length > 0 ? meta : undefined }
    } catch {
      /* 跳过无法解析的行 */
    }
  }
  return null
}

/**
 * 从完整缓冲中提取所有 SSE 事件。
 * 调用方负责传入 buffer & 消费剩余未完整事件。
 */
export function parseSseChunk(buffer: string): ParsedEvent[] {
  const rawEvents = extractRawEvents(buffer)
  const result: ParsedEvent[] = []
  for (const evt of rawEvents) {
    const parsed = parseEventFromLines(evt.dataLines)
    if (parsed) result.push(parsed)
  }
  return result
}
