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
import { buildUpstreamChat, getPreset, getContextWindow } from '../utils/aiProviders.js'
import { collectToolCallsFromStream, handleToolCalls } from './aiStream.js'

/**
 * 检测模型是否“只说不做”：文字里表示还要调用工具，但没有实际输出 tool_calls。
 * 用于 runChatLoop 的安全网，避免模型说完“让我再调用 X”就直接结束流。
 */
function looksLikeToolIntent(content) {
  if (!content || typeof content !== 'string') return false
  const c = content.toLowerCase()
  // 中英文常见“我要调用工具”意图表达
  const intentKeywords = ['调用', 'call', '使用工具', 'use the tool', '使用', 'use', '让我', 'let me', '我要', 'i will', 'i need to', '执行', 'execute']
  return intentKeywords.some((k) => c.includes(k))
}

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
  role = 'user',
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
  // 安全网计数器：防止模型“只说要调工具”却不 emit tool_calls 导致任务半途而废
  let continuationRetries = 0
  const MAX_CONTINUATION_RETRIES = 1

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

    // 下发 token 用量元信息（前端圆环展示上下文占用百分比）。
    // 取本轮 usage 的最新值；前端保留「最近一次」调用，即最能代表当前上下文大小的数值。
    if (response.usage) {
      const ctxWindow = getContextWindow(providerRow.model)
      const u = response.usage
      sendDelta({
        meta: {
          type: 'usage',
          usage: {
            promptTokens: u.prompt_tokens || 0,
            completionTokens: u.completion_tokens || 0,
            totalTokens:
              u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
            contextWindow: ctxWindow,
            // 缓存命中：上游 prompt_tokens_details.cached_tokens（OpenAI 兼容协议）。
            // 命中越高说明越多 prompt 命中了提示缓存（prompt caching），节省 token 成本。
            cacheReadTokens: u.prompt_tokens_details?.cached_tokens || 0,
          },
        },
      })
    }

    // 安全网：模型写了"我要调用 X"但最终没有输出 tool_calls。
    // 追加 system 提醒并再试一轮（限一次），避免任务半途而废。
    if (
      response.toolCalls.length === 0 &&
      tools && tools.length > 0 &&
      continuationRetries < MAX_CONTINUATION_RETRIES &&
      looksLikeToolIntent(response.content)
    ) {
      continuationRetries++
      currentMessages.push({ role: 'assistant', content: response.content || '' })
      currentMessages.push({
        role: 'system',
        content: '你刚才的回复表示还需要调用工具，但没有实际输出 tool_calls。如果你确实需要继续调用工具，请立即停止文字解释，直接输出 tool_calls；如果不需要，请直接给出最终答案，不要只说"我要调用"。',
      })
      continue
    }

    // 有 tool calls：执行后继续下一轮
    if (response.toolCalls.length > 0) {
      // 真正调用了工具，重置“只说不做”重试计数
      continuationRetries = 0
      const toolResults = await handleToolCalls(response.toolCalls, userId, sendDelta, agentId, role)

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
