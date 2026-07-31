/**
 * AI 流式工具集（被单代理 / 多代理编排共同复用）
 *
 * 这里只放「与具体编排无关」的底层 SSE 解析 + 单轮工具执行逻辑：
 * - parseSSEEvent：把一段 raw SSE block 解析成 {event, data}
 * - collectToolCallsFromStream：边流式下发 thinking/content，边收集 tool_calls
 * - handleToolCalls：并行执行同一轮内的多个工具，逐个推送 tool_call / tool_result
 *
 * 所有「增量」都通过调用方传入的 sendDelta 下发，本模块不关心 SSE 连接的开关。
 * agentId 可选：多代理编排时给每个增量打上所属子代理的标识，便于前端路由。
 */
import { executeTool } from './aiTools.js'
import logger from '../utils/logger.js'

/**
 * 解析 SSE 事件
 */
export function parseSSEEvent(block) {
  let eventName
  const dataLines = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }
  return { event: eventName, data: dataLines.join('\n') }
}

/**
 * 从 SSE 流中收集 tool_calls（同时流式发送 thinking 和 content）
 */
export async function collectToolCallsFromStream(reader, decoder, sendDelta, logChunk) {
  let buffer = ''
  let content = ''
  let toolCalls = []
  let finishReason = ''
  let usage = null
  let lastChunkAt = Date.now()

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const chunkSize = value ? value.byteLength : 0
    const now = Date.now()
    const sinceLast = now - lastChunkAt
    lastChunkAt = now
    if (logChunk) logChunk({ bytes: chunkSize, sinceLastMs: sinceLast })
    buffer += decoder.decode(value, { stream: true })

    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const ev = parseSSEEvent(rawEvent)
      if (!ev || !ev.data || ev.data === '[DONE]') continue

      try {
        const obj = JSON.parse(ev.data)
        const delta = obj?.choices?.[0]?.delta
        const choice = obj?.choices?.[0]

        if (delta) {
          // 流式发送 thinking / reasoning_content（统一成 thinking 字段下发）
          const reasoning = delta.thinking || delta.reasoning_content
          if (reasoning) {
            sendDelta({ choices: [{ delta: { thinking: reasoning }, index: 0 }] })
          }
          // 流式发送 content
          if (delta.content) {
            content += delta.content
            sendDelta({ choices: [{ delta: { content: delta.content }, index: 0 }] })
          }
          // 收集 tool_calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index || 0
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } }
              }
              if (tc.id) toolCalls[idx].id = tc.id
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
            }
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
        // 顶层 usage（OpenAI 流式在最后一个 chunk 携带）：记录 token 用量供前端展示
        if (obj.usage) usage = obj.usage
      } catch { /* ignore */ }
    }
  }

  toolCalls = toolCalls.filter(tc => tc && tc.function?.name)
  return { content, toolCalls, finishReason, usage }
}

/**
 * 给 promise 加超时：超过 ms 毫秒未完成则 reject，避免某个工具/上游调用永久挂起，
 * 把整个多代理编排（含 Promise.allSettled）拖死，造成流永不关闭、子代理卡片永久转圈。
 */
function withTimeout(promise, ms, msg) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// 单工具执行超时（必须显著小于 aiChat.js 的 180s 上游整体超时，保证编排能在上游超时前收敛）。
// 工具多为本地 DB / 内部查询，120s 已极其宽裕；真正卡死时按失败处理而非无限等待。
const TOOL_EXEC_TIMEOUT_MS = 120_000

/**
 * 执行同一轮内的多个工具调用（并行，互不依赖，缩短整体延迟）
 * 每个工具完成即向前端推送 tool_call / tool_result 增量，保证时间线实时刷新。
 *
 * @param {Array} toolCalls 已收集好的工具调用列表
 * @param {string} userId   当前用户 id
 * @param {Function} sendDelta 增量下发函数
 * @param {string|null} agentId 多代理模式下所属子代理 id（打在增量上）
 * @param {string} [role] 角色键，透传给 executeTool 做实工具权限闸门
 */
export async function handleToolCalls(toolCalls, userId, sendDelta, agentId = null, role = 'user') {
  const agentField = agentId ? { agent_id: agentId } : {}
  const settled = await Promise.all(
    toolCalls.map(async (tc) => {
      if (!tc.function?.name) return null

      const toolName = tc.function.name
      let args = {}
      try {
        args = JSON.parse(tc.function.arguments || '{}')
      } catch { /* ignore */ }

      // 通知前端正在执行工具
      sendDelta({
        choices: [{
          delta: {
            tool_call: {
              id: tc.id,
              name: toolName,
              arguments: tc.function.arguments
            },
            ...agentField
          },
          index: 0
        }]
      })

      // 执行工具（同一轮内并行），带超时保护，避免挂起拖垮整个编排
      let result
      try {
        result = await withTimeout(
          executeTool(toolName, args, userId, role),
          TOOL_EXEC_TIMEOUT_MS,
          `tool ${toolName} timed out after ${TOOL_EXEC_TIMEOUT_MS}ms`,
        )
      } catch (err) {
        // 原始错误仅留档给运维，绝不回传给前端 / LLM，避免泄露 SQL 等内部细节
        logger.error(`[tool] ${toolName} execution failed:`, err)
        const timedOut = /timed out/i.test(String(err?.message || ''))
        result = {
          error: timedOut ? '工具执行超时，请稍后重试。' : '工具执行失败，请稍后重试或换个问法。',
          timedOut,
        }
      }

      // 通知前端工具执行结果
      sendDelta({
        choices: [{
          delta: {
            tool_result: {
              tool_call_id: tc.id,
              content: JSON.stringify(result)
            },
            ...agentField
          },
          index: 0
        }]
      })

      return {
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result)
      }
    })
  )

  // 保持与入参一致的顺序，供下一轮上下文拼接
  return settled.filter(Boolean)
}
