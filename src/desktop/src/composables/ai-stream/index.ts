/**
 * Barrel export for ai-stream composable modules.
 *
 * Layout:
 *   parseSse.ts    — 原始 SSE buffer 解析（从 streamChat 的 processBuffer 模式提取）
 *   thinkTagger.ts — <think> / <Thought> 标签增量拆包，状态机式
 *   textBuffer.ts  — 思考静息期的文本缓冲与定时释放
 *   useAgentRuns.ts — 多代理并行运行状态的 upsert / settle / watchdog
 *   send.ts        — send() 主体编排：构造历史、调用 streamChat、按 delta 类型分发、收尾持久化
 */

export { parseSseChunk } from './parseSse'
export type { ParsedEvent } from './parseSse'

export { processThinkContent, resetThinkState, appendThinkingDelta, sealThinkingSegment, sealAllThinkingSegments } from './thinkTagger'
export type { ThinkResult, ThinkingSegment } from './thinkTagger'

export {
  appendTextDelta,
  flushTextBuffer,
  flushAllTextBuffers,
  markThinkingHeartbeat,
  isThinkingStillLive,
} from './textBuffer'

export {
  useAgentRuns,
} from './useAgentRuns'
export type { AgentRunHandle } from './useAgentRuns'

export {
  runStream,
} from './send'
export type { SendStreamParams } from './send'
