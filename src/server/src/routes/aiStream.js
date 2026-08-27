/**
 * AI 流式工具集（被单代理 / 多代理编排共同复用）
 *
 * 这里只放「与具体编排无关」的底层 SSE 解析 + 单轮工具执行逻辑：
 * - parseSSEEvent：把一段 raw SSE block 解析成 {event, data}
 * - collectToolCallsFromStream：边流式下发 thinking/content，边收集 tool_calls
 * - handleToolCalls：统一工具执行管线（串行），tool_call → 执行 → tool_result 事件时序契约
 *
 * 所有「增量」都通过调用方传入的 sendDelta 下发，本模块不关心 SSE 连接的开关。
 * agentId 可选：多代理编排时给每个增量打上所属子代理的标识，便于前端路由。
 */
import { executeTool } from './aiTools.js'
import { logger } from '../utils/logger.js'

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
  let thinking = ''
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
            thinking += reasoning
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
  return { content, thinking, toolCalls, finishReason, usage }
}

/**
 * 把 OpenAI Responses 协议的 usage 归一化为下游 aiChatCore 使用的 OpenAI 兼容形状：
 *   input_tokens → prompt_tokens；input_tokens_details.cached_tokens → prompt_tokens_details.cached_tokens；
 *   output_tokens → completion_tokens；output_tokens_details.reasoning_tokens → completion_tokens_details.reasoning_tokens。
 */
export function normalizeResponsesUsage(u) {
  if (!u) return null
  const inputTokens = u.input_tokens ?? 0
  const outputTokens = u.output_tokens ?? 0
  return {
    prompt_tokens: inputTokens,
    prompt_tokens_details: {
      cached_tokens: u.input_tokens_details?.cached_tokens ?? 0,
    },
    completion_tokens: outputTokens,
    completion_tokens_details: {
      reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    },
    total_tokens: u.total_tokens ?? (inputTokens + outputTokens),
  }
}

/**
 * 从 OpenAI Responses 协议的 SSE 流中收集 tool_calls（同时流式发送 thinking 和 content）。
 *
 * Responses 协议事件（均以 type 字段区分）：
 * - response.output_text.delta               → 流式 content
 * - response.reasoning_summary_text.delta    → 流式 thinking
 * - response.output_item.added（function_call）→ 登记 tool_call 骨架（id/name）
 * - response.function_call.delta             → 补充 name（部分网关仅此处带 name）
 * - response.function_call_arguments.delta   → 累积 arguments
 * - response.output_item.done（function_call）→ 核对 id/name/arguments 兜底
 * - response.completed                       → 流结束，带上最终 usage 并终止
 *
 * @param {ReadableStreamDefaultReader} reader
 * @param {TextDecoder} decoder
 * @param {Function} sendDelta 增量下发函数
 * @param {Function} [logChunk]
 * @returns {Promise<{ content: string, thinking: string, toolCalls: Array, finishReason: string, usage: object|null }>}
 */
export async function collectToolCallsFromResponsesStream(reader, decoder, sendDelta, logChunk) {
  let buffer = ''
  let content = ''
  let thinking = ''
  let usage = null
  let lastChunkAt = Date.now()
  // 工单 A6 解析端：response.completed 时若因 max_output_tokens 截断，归一为 'length'
  let responsesFinishReason = ''
  // 以 output_index 为键保存 tool_call，保证多工具并行时的顺序与增量累积正确
  const toolMap = new Map()

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
    let completed = false
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const ev = parseSSEEvent(rawEvent)
      if (!ev || !ev.data) continue

      try {
        const obj = JSON.parse(ev.data)
        const type = obj.type

        if (type === 'response.output_text.delta') {
          const d = obj.delta || ''
          if (d) {
            content += d
            sendDelta({ choices: [{ delta: { content: d }, index: 0 }] })
          }
        } else if (type === 'response.reasoning_summary_text.delta') {
          const d = obj.delta || ''
          if (d) {
            thinking += d
            sendDelta({ choices: [{ delta: { thinking: d }, index: 0 }] })
          }
        } else if (type === 'response.output_item.added') {
          const item = obj.item
          if (item && item.type === 'function_call') {
            const oi = typeof obj.output_index === 'number' ? obj.output_index : toolMap.size
            toolMap.set(oi, {
              id: item.id || item.call_id || `fc_${oi}`,
              type: 'function',
              function: { name: item.name || '', arguments: '' },
            })
          }
        } else if (type === 'response.function_call.delta') {
          const oi = typeof obj.output_index === 'number' ? obj.output_index : toolMap.size - 1
          const tc = toolMap.get(oi)
          if (tc && obj.name) tc.function.name = obj.name
        } else if (type === 'response.function_call_arguments.delta') {
          const oi = typeof obj.output_index === 'number' ? obj.output_index : toolMap.size - 1
          let tc = toolMap.get(oi)
          if (!tc) {
            // 兜底：未等来 output_item.added 时按 item_id 创建
            tc = { id: obj.item_id || `fc_${oi}`, type: 'function', function: { name: '', arguments: '' } }
            toolMap.set(oi, tc)
          }
          tc.function.arguments += (obj.delta || '')
        } else if (type === 'response.output_item.done') {
          const item = obj.item
          if (item && item.type === 'function_call') {
            const oi = typeof obj.output_index === 'number' ? obj.output_index : toolMap.size - 1
            let tc = toolMap.get(oi)
            if (!tc) tc = { id: item.id || item.call_id || `fc_${oi}`, type: 'function', function: { name: item.name || '', arguments: item.arguments || '' } }
            if (item.name) tc.function.name = item.name
            if (item.id) tc.id = item.id
            if (item.arguments) tc.function.arguments = item.arguments
            toolMap.set(oi, tc)
          }
        } else if (type === 'response.completed') {
          const resp = obj.response || {}
          usage = normalizeResponsesUsage(resp.usage || obj.usage)
          // 工单 A6 解析端：输出被 max_output_tokens 截断时归一为 'length'，供 runChatLoop 截断防护
          if (resp.incomplete_details?.reason === 'max_output_tokens') {
            responsesFinishReason = 'length'
          }
          completed = true
        }
      } catch { /* ignore */ }
    }
    if (completed) break
  }

  const toolCalls = Array.from(toolMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, tc]) => tc)
    .filter((tc) => tc && tc.function?.name)

  return { content, thinking, toolCalls, finishReason: responsesFinishReason, usage }
}

/**
 * 从 Anthropic Messages 协议的 SSE 流中收集 tool_calls（同时流式发送 thinking 和 content）。
 *
 * Anthropic SSE 事件类型：
 * - message_start         → 初始化 usage.input_tokens
 * - content_block_start   → 识别 block 类型（text / thinking / tool_use）
 * - content_block_delta   → 累积文本/推理文本/tool_use 的 input JSON
 * - content_block_stop    → 收尾当前 block（tool_use 时登记 tool_call）
 * - message_delta         → 累计 usage.output_tokens
 * - message_stop          → 流结束
 *
 * StepFun Explore 等第三方兼容网关也遵循该协议（仅认证头不同）。
 *
 * @param {ReadableStreamDefaultReader} reader
 * @param {TextDecoder} decoder
 * @param {Function} sendDelta 增量下发函数
 * @param {Function} [logChunk]
 * @returns {Promise<{ content: string, thinking: string, toolCalls: Array, finishReason: string, usage: object|null }>}
 */
export async function collectToolCallsFromAnthropicStream(reader, decoder, sendDelta, logChunk) {
  let buffer = ''
  let content = ''
  let thinking = ''
  let usage = null
  let lastChunkAt = Date.now()

  // 当前正在累积的 block 元数据
  let currentBlock = null // { type: 'text'|'thinking'|'tool_use', index, toolId?, toolName?, toolInput? }
  // 当前消息里已经登记的 tool_calls（按 index 排序）
  const toolCallsByIndex = new Map()
  // 工单 A5：协议层 error 事件不再拼进正文，改为记录后统一抛出（走调用方 SSE 错误透传）
  let streamError = null
  // 工单 A6 解析端：message_delta.delta.stop_reason 归一后的结束原因
  let anthropicFinishReason = ''

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
    let finished = false
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const ev = parseSSEEvent(rawEvent)
      if (!ev || !ev.data) continue

      try {
        const obj = JSON.parse(ev.data)
        const type = obj.type
        // DEBUG: 记录每个事件类型和关键字段，排查 Step Explore 协议差异
        if (type) {
          const shortData = JSON.stringify(obj).substring(0, 300)
          logger.info('[DEBUG-AnthropicStream] event:', type, 'data:', shortData)
        }

        if (type === 'message_start') {
          const m = obj.message || {}
          usage = {
            prompt_tokens: m.usage?.input_tokens || 0,
            completion_tokens: 0,
            total_tokens: 0,
          }
          // 工单 A7：message_start 也可能携带缓存字段（官方 API 在此下发），归一到标准位
          const startCacheRead = m.usage?.cache_read_input_tokens ?? m.usage?.cache_read_tokens
          const startCacheWrite = m.usage?.cache_creation_input_tokens ?? m.usage?.cache_creation_tokens
          if (startCacheRead != null || startCacheWrite != null) {
            usage.prompt_tokens_details = {
              cached_tokens: startCacheRead ?? 0,
              cache_written_tokens: startCacheWrite ?? 0,
            }
          }
        } else if (type === 'content_block_start') {
          const cb = obj.content_block || {}
          currentBlock = {
            index: obj.index ?? 0,
            type: cb.type,
          }
          if (cb.type === 'tool_use') {
            currentBlock.toolId = cb.id
            currentBlock.toolName = cb.name
            currentBlock.toolInput = ''
            logger.info('[DEBUG-AnthropicStream] tool_use block started: index=', obj.index, 'id=', cb.id, 'name=', cb.name)
          } else {
            logger.info('[DEBUG-AnthropicStream] content_block_start: index=', obj.index, 'type=', cb.type, 'keys=', Object.keys(cb).join(','))
          }
        } else if (type === 'content_block_delta') {
          const delta = obj.delta || {}
          if (!currentBlock) continue
          // 兼容处理：Step Explore 等第三方网关可能使用不同的 delta type 或字段名
          const deltaType = delta.type || 'unknown'
          // text 类字段：delta.text 或 delta.thinking
          const textField = delta.text || delta.thinking || ''
          // JSON 类字段：delta.partial_json 或 delta.text
          const jsonField = delta.partial_json || delta.text || ''

          if (currentBlock.type === 'text') {
            // text block：尝试 text_delta（标准），或回退到直接取 text 字段
            const t = delta.text || ''
            if (t) {
              content += t
              sendDelta({ choices: [{ delta: { content: t }, index: 0 }] })
            }
          } else if (currentBlock.type === 'thinking') {
            // thinking block：尝试 thinking_delta.thinking（标准），或 delta.thinking，或 delta.text
            const t = delta.thinking || delta.text || ''
            if (t) {
              thinking += t
              sendDelta({ choices: [{ delta: { thinking: t }, index: 0 }] })
            }
          } else if (currentBlock.type === 'tool_use') {
            // tool_use block：尝试 input_json_delta.partial_json（标准），或任何字段
            currentBlock.toolInput = (currentBlock.toolInput || '') + jsonField
            if (jsonField) {
              logger.info('[DEBUG-AnthropicStream] tool_use input delta:', deltaType, 'len=', jsonField.length, 'sample=', jsonField.substring(0, 100))
            }
          } else {
            // 未知 block type：记录日志
            if (obj.index < 3) {
              logger.info('[DEBUG-AnthropicStream] unknown content block delta: currentBlock_type=', currentBlock.type, 'delta_type=', deltaType, 'keys=', Object.keys(delta).join(','))
            }
          }
        } else if (type === 'content_block_stop') {
          if (currentBlock && currentBlock.type === 'tool_use') {
            const tc = {
              id: currentBlock.toolId,
              type: 'function',
              function: {
                name: currentBlock.toolName || '',
                arguments: currentBlock.toolInput || '{}',
              },
            }
            logger.info('[DEBUG-AnthropicStream] tool_use block completed: index=', currentBlock.index, 'name=', tc.function.name, 'args_len=', (currentBlock.toolInput || '').length)
            toolCallsByIndex.set(currentBlock.index ?? toolCallsByIndex.size, tc)
          } else if (currentBlock) {
            logger.info('[DEBUG-AnthropicStream] content_block_stop: type=', currentBlock.type, 'index=', currentBlock.index)
          }
          currentBlock = null
        } else if (type === 'message_delta') {
          const u = obj.usage || {}
          // 工单 A6 解析端：stop_reason='max_tokens' 归一为 OpenAI 风格 finishReason='length'，
          // 供 runChatLoop 做截断防护（参数被截断的 tool_calls 不执行）。
          const stopReason = obj.delta?.stop_reason || obj.stop_reason
          anthropicFinishReason = stopReason === 'max_tokens'
            ? 'length'
            : stopReason === 'tool_use' ? 'tool_use' : 'end_turn'
          if (usage) {
            usage.completion_tokens = u.output_tokens ?? usage.completion_tokens
            usage.total_tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)
            if (u.input_tokens) usage.prompt_tokens = u.input_tokens
            if (u.total_tokens) usage.total_tokens = u.total_tokens
            // 工单 A7：缓存字段归一到 OpenAI 兼容标准位（消费端零改动即可读取）：
            //   cache_read → prompt_tokens_details.cached_tokens
            //   cache_creation → prompt_tokens_details.cache_written_tokens
            const cacheRead = u.cache_read_input_tokens ?? u.cache_read_tokens
            const cacheWrite = u.cache_creation_input_tokens ?? u.cache_creation_tokens
            if (cacheRead != null || cacheWrite != null) {
              usage.prompt_tokens_details = {
                ...(usage.prompt_tokens_details || {}),
                cached_tokens: cacheRead ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
                cache_written_tokens: cacheWrite ?? usage.prompt_tokens_details?.cache_written_tokens ?? 0,
              }
              // 旧顶层字段保留（向后兼容），但消费端已不再依赖
              if (cacheRead != null) usage.cacheReadTokens = cacheRead
              if (u.cache_creation_input_tokens != null) usage.cacheCreationTokens = u.cache_creation_input_tokens
            }
          } else {
            usage = {
              prompt_tokens: u.input_tokens || 0,
              completion_tokens: u.output_tokens || 0,
              total_tokens: u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0)),
            }
            const fallbackCacheRead = u.cache_read_input_tokens ?? u.cache_read_tokens
            const fallbackCacheWrite = u.cache_creation_input_tokens ?? u.cache_creation_tokens
            if (fallbackCacheRead != null || fallbackCacheWrite != null) {
              usage.prompt_tokens_details = {
                cached_tokens: fallbackCacheRead ?? 0,
                cache_written_tokens: fallbackCacheWrite ?? 0,
              }
            }
          }
        } else if (type === 'message_stop') {
          finished = true
        } else if (type === 'error') {
          // 工单 A5：协议层错误（上游/网关回 4xx/5xx 时以 error 事件下发）不再把
          // `[upstream error:...]` 拼进正文——那会让前端把报错当普通回答渲染（无红框提示）。
          // 改为记录后抛出，走 aiChat.js 统一 SSE 错误透传。
          const raw = obj.error ?? obj.message
          const msg = typeof raw === 'string' && raw ? raw : (raw?.message || 'upstream error')
          logger.error('[AnthropicStream] upstream error event:', msg)
          streamError = new Error(`Upstream error: ${msg}`)
          finished = true
        }
      } catch { /* ignore malformed event */ }
    }
    if (finished) break
  }

  const toolCalls = Array.from(toolCallsByIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, tc]) => tc)
    .filter((tc) => tc && tc.function?.name)

  // 工单 A5：上游以 error 事件终止 → 抛错，由 aiChatCore.runChatLoop 向上传导，
  // 最终走 aiChat.js 的 SSE `{"error":...}` 统一透传（前端红框展示）。
  if (streamError) throw streamError

  // DEBUG: 流结束后记录收集到的工具调用情况
  logger.info('[DEBUG-AnthropicStream] stream completed:',
    'content_len=', content.length,
    'thinking_len=', thinking.length,
    'toolCalls_count=', toolCalls.length,
    'tool_names=', toolCalls.map((t) => t.function?.name).join(',') || 'NONE',
    'finishReason=', anthropicFinishReason || (toolCalls.length > 0 ? 'tool_use' : 'end_turn'))

  return { content, thinking, toolCalls, finishReason: anthropicFinishReason || (toolCalls.length > 0 ? 'tool_use' : 'end_turn'), usage }
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
// 注意：ask_user 豁免该超时（见 handleToolCalls），否则会在等待用户作答时被误判超时掐断。
const TOOL_EXEC_TIMEOUT_MS = 120_000

/**
 * 统一工具执行管线（单代理 / 协调器 / 子代理共用）。
 *
 * 事件时序契约（前端渲染依赖，勿改）：
 *   1) tool_call delta            —— 执行【前】下发。前端时间线立即渲染"调用中"条目；
 *                                    ask_user 的交互选择卡片也由该事件驱动（AiMessage.askUserStep ← message.toolCalls）。
 *   2) meta.ask_user_action       —— 仅 ask_user：门控打开时下发，前端兜底合成卡片（已有同 id tool_call 时忽略）。
 *   3) meta.confirm_tool_action   —— 仅破坏性工具：确认门控卡片（executeTool 内部下发）。
 *   4) tool_result delta          —— 执行【后】下发，时间线收敛为完成态，结果回传模型上下文。
 *
 * 历史教训（ask_user 死锁）：协调器曾绕过本管线直接 executeTool 且不下发 tool_call——
 * ask_user 在执行期阻塞等待用户点卡片，而卡片恰恰要等 tool_call/tool_result 才渲染，
 * 形成"服务端等用户 → 用户等卡片 → 卡片等事件"的循环等待。所有路径必须走本管线。
 *
 * 执行策略：同一轮内【串行】执行。
 *   - ask_user / 破坏性确认是 UI 阻塞型交互，必须独占等待（旧并行实现下第二个破坏性
 *     工具会因 pendingRequests 并发上限被误拒 CONCURRENT_CONFIRM_REQUEST）；
 *   - 串行保证 tool_result 顺序与模型上下文一致；本地 DB/查询工具耗时极低，延迟损失可忽略。
 *
 * 超时策略：普通工具 toolTimeoutMs（默认 120s）兜底；ask_user 豁免——门控自带
 * 5min 等待计时（ASK_USER_TIMEOUT_MS），在用户作答前掐断属于逻辑错误。
 *
 * @param {Array} toolCalls 已收集好的工具调用列表
 * @param {string} userId   当前用户 id
 * @param {Function} sendDelta 增量下发函数
 * @param {string|null} agentId 多代理模式下所属子代理 id（打在增量上），主线程传 null
 * @param {string} [role] 角色键，透传给 executeTool 做实工具权限闸门
 * @param {object} [opts] { abortSignal, req, toolTimeoutMs } 中断信号 / 断连清理用请求对象 / 超时覆盖（测试用）
 */
export async function handleToolCalls(toolCalls, userId, sendDelta, agentId = null, role = 'user', opts = {}) {
  const agentField = agentId ? { agent_id: agentId } : {}
  const abortSignal = opts.abortSignal
  const toolTimeoutMs = opts.toolTimeoutMs ?? TOOL_EXEC_TIMEOUT_MS
  const results = []

  for (const tc of toolCalls || []) {
    if (!tc?.function?.name) continue
    // 中断（前端断开/整体取消）：不再执行后续工具，已执行结果保持已下发状态
    if (abortSignal?.aborted) {
      logger.info(`[tool] ${tc.function.name} skipped: stream aborted before execution`)
      break
    }

    const toolName = tc.function.name
    let args = {}
    try {
      args = JSON.parse(tc.function.arguments || '{}')
    } catch { /* ignore */ }

    // 1) 先下发 tool_call：时间线"调用中"状态 + ask_user 交互卡片都依赖该事件
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

    // 2) 执行工具：ask_user 豁免管线超时（门控自带等待计时），其余工具超时兜底
    let result
    try {
      const exec = executeTool(toolName, args, userId, role, tc.id, { sendDelta, req: opts.req })
      result = toolName === 'ask_user'
        ? await exec
        : await withTimeout(exec, toolTimeoutMs, `tool ${toolName} timed out after ${toolTimeoutMs}ms`)
    } catch (err) {
      // 原始错误仅留档给运维，绝不回传给前端 / LLM，避免泄露 SQL 等内部细节
      logger.error(`[tool] ${toolName} execution failed:`, err)
      const timedOut = /timed out/i.test(String(err?.message || ''))
      result = {
        error: timedOut ? '工具执行超时，请稍后重试。' : '工具执行失败，请稍后重试或换个问法。',
        timedOut,
      }
    }

    // 3) 后下发 tool_result：时间线收敛 + 结果回传模型（content 为 JSON 字符串）
    sendDelta({
      choices: [{
        delta: {
          tool_result: {
            tool_call_id: tc.id,
            name: toolName,
            content: JSON.stringify(result)
          },
          ...agentField
        },
        index: 0
      }]
    })

    results.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify(result)
    })
  }

  return results
}
