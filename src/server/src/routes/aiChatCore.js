/**
 * 通用多轮工具调用对话循环（单代理 / 多代理子代理共用）。
 *
 * 职责：给定消息 + 工具集，循环调用上游模型，流式下发增量，遇到 tool_calls 就
 * 执行工具并把结果塞回上下文，直到某轮不再产生 tool_calls（即最终回答）或达到
 * maxRounds 上限。
 *
 * 关键点：
 * - 不直接操作 SSE 连接的开关（safeFinish 由调用方负责）。
 * - 通过 agentId 给所有增量打标（多代理路由用），单代理传 null。
 * - 上游异常（含 180s 超时 AbortError）向上抛出，由调用方决定降级策略。
 */
import { buildUpstreamChat, getPreset } from '../utils/aiProviders.js'
import { collectToolCallsFromStream, handleToolCalls } from './aiStream.js'

/**
 * 执行一轮完整对话循环。
 * @returns {{ messages: Array, finalContent: string }}
 */
export async function runChatLoop({
  messages,
  options = {},
  providerRow,
  apiKey,
  tools,
  userId,
  sendDelta,
  logChunk,
  agentId = null,
  abortSignal,
  maxRounds = 5,
  thinkingEnabled = false,
  thinkingStrength = 'medium',
}) {
  const preset = getPreset(providerRow.provider)
  let currentMessages = [...messages]

  for (let round = 0; round < maxRounds; round++) {
    const chatOptions = { ...options }

    // thinking 支持：仅 Anthropic 协议需要显式 thinking 参数（OpenAI 兼容族由 reasoning_content 自动下发）
    if (thinkingEnabled && preset?.family === 'anthropic') {
      chatOptions.thinking = true
      chatOptions.thinkingBudget = thinkingStrength === 'low' ? 1024 : thinkingStrength === 'high' ? 8192 : 4096
    }

    // 工具集：传入非空才挂工具 + tool_choice=auto；synthesis 传 [] 即物理禁用工具。
    if (tools && tools.length) {
      chatOptions.tools = tools
      chatOptions.tool_choice = 'auto'
    }

    const upstream = buildUpstreamChat({
      provider: providerRow.provider,
      baseUrl: providerRow.base_url,
      model: providerRow.model,
      apiKey,
      messages: currentMessages,
      options: chatOptions,
    })

    let upstreamRes
    try {
      upstreamRes = await fetch(upstream.url, {
        method: 'POST',
        headers: { ...upstream.headers, Accept: 'text/event-stream' },
        body: JSON.stringify(upstream.body),
        signal: abortSignal,
      })
    } catch (fetchErr) {
      if (fetchErr?.name === 'AbortError') throw new Error('UPSTREAM_TIMEOUT')
      throw fetchErr
    }

    if (!upstreamRes.ok || !upstreamRes.body) {
      const text = await upstreamRes.text().catch(() => '')
      throw new Error(`Upstream error: ${upstreamRes.status} ${text.slice(0, 1500)}`)
    }

    const reader = upstreamRes.body.getReader()
    const decoder = new TextDecoder()

    // 流式发送 thinking 和 content，同时收集 tool_calls
    const response = await collectToolCallsFromStream(reader, decoder, sendDelta, logChunk)

    // 有 tool calls：执行后继续下一轮
    if (response.toolCalls.length > 0) {
      const toolResults = await handleToolCalls(response.toolCalls, userId, sendDelta, agentId)

      currentMessages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      })
      currentMessages.push(...toolResults)
      continue
    }

    // 无 tool calls：最终回答，退出循环
    return { messages: currentMessages, finalContent: response.content }
  }

  // 达到最大轮次仍未收敛
  return { messages: currentMessages, finalContent: '' }
}
