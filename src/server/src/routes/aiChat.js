import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { decrypt } from '../utils/encryption.js'
import { buildUpstreamChat, getPreset } from '../utils/aiProviders.js'
import { logger } from '../utils/logger.js'
import { TOOLS, executeTool } from './aiTools.js'

const router = Router()

/**
 * 解析 SSE 事件
 */
function parseSSEEvent(block) {
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

// 思考能力由前端 <think> 标签提示词 + 上游 reasoning_content 自动下发实现，无需后端模型匹配表。

/**
 * 从 SSE 流中收集 tool_calls（同时流式发送 thinking 和 content）
 */
async function collectToolCallsFromStream(reader, decoder, sendDelta, logChunk) {
  let buffer = ''
  let content = ''
  let toolCalls = []
  let finishReason = ''
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
      } catch { /* ignore */ }
    }
  }

  toolCalls = toolCalls.filter(tc => tc && tc.function?.name)
  return { content, toolCalls, finishReason }
}

/**
 * 执行工具调用
 */
async function handleToolCalls(toolCalls, userId, sendDelta) {
  const results = []
  for (const tc of toolCalls) {
    if (!tc.function?.name) continue

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
          }
        },
        index: 0
      }]
    })

    // 执行工具
    const result = await executeTool(toolName, args, userId)

    // 通知前端工具执行结果
    sendDelta({
      choices: [{
        delta: {
          tool_result: {
            tool_call_id: tc.id,
            content: JSON.stringify(result)
          }
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

// POST /api/ai/chat - SSE 流式代理（支持多轮 tool calling）
router.post('/chat', apiLimiter, async (req, res) => {
  try {
    const { providerId, messages, options } = req.body || {}
    if (!providerId) return res.status(400).json({ error: 'providerId is required' })
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required' })
    }

    const result = await pool.query('SELECT * FROM ai_providers WHERE id = $1 AND user_id = $2', [providerId, req.userId])
    if (result.rowCount === 0) return res.status(404).json({ error: 'Provider not found' })
    const providerRow = result.rows[0]
    if (!providerRow.api_key_encrypted) return res.status(400).json({ error: 'Provider has no API key' })

    const apiKey = decrypt(providerRow.api_key_encrypted)
    const thinkingEnabled = options?.thinking || false
    const thinkingStrength = options?.thinkingStrength || 'medium'
    const isAgentMode = options?.mode === 'agent'

    // SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    // 禁用 Nagle：确保每个增量块立刻发到 socket，杜绝攒批导致“一次性蹦出”
    res.socket?.setNoDelay?.(true)

    const streamStartAt = Date.now()
    let chunkCount = 0
    const sendDelta = (obj) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    }
    const logChunk = ({ bytes, sinceLastMs }) => {
      chunkCount++
      if (chunkCount <= 20 || chunkCount % 50 === 0) {
        logger.debug(`[AI] SSE chunk #${chunkCount} +${sinceLastMs}ms ${bytes}B total=${Date.now() - streamStartAt}ms`)
      }
    }

    const finish = () => {
      res.write('data: [DONE]\n\n')
      res.flush?.()
      res.end()
    }

    try {
      let currentMessages = [...messages]

      // 上游整体超时保护（覆盖连接 + 全部轮次 + 流读取）：
      // 避免上游卡死导致后端 reader.read() 永久阻塞、前端一直卡在“思考 N 秒”不动。
      const upstreamAbort = new AbortController()
      const upstreamTimer = setTimeout(() => upstreamAbort.abort(), 180_000)

      // 最多执行 5 轮 tool calling
      for (let round = 0; round < 5; round++) {
        const chatOptions = { ...options }

        // thinking 支持：仅 Anthropic 协议需要显式 thinking 参数
        // OpenAI 兼容族（DeepSeek/StepFun/Qwen 等）由 reasoning_content 自动下发，
        // 传 thinking 顶层参数会触发上游 request_params_invalid
        const preset = getPreset(providerRow.provider)
        if (thinkingEnabled && preset?.family === 'anthropic') {
          chatOptions.thinking = true
          chatOptions.thinkingBudget = thinkingStrength === 'low' ? 1024 : thinkingStrength === 'high' ? 8192 : 4096
        }

        // 记忆工具在 ask/agent 模式下都可用：让模型能主动保存用户偏好/项目事实等长期记忆。
        // 其他 Agent 工作流工具只在 agent 模式下暴露。
        const MEMORY_TOOL_NAMES = ['get_memories', 'save_memory']
        const memoryTools = TOOLS.filter((t) => MEMORY_TOOL_NAMES.includes(t.function.name))
        const agentTools = TOOLS.filter((t) => !MEMORY_TOOL_NAMES.includes(t.function.name))
        chatOptions.tools = isAgentMode ? [...memoryTools, ...agentTools] : memoryTools
        chatOptions.tool_choice = 'auto'

        const upstream = buildUpstreamChat({
          provider: providerRow.provider,
          baseUrl: providerRow.base_url,
          model: providerRow.model,
          apiKey,
          messages: currentMessages,
          options: chatOptions,
        })

        logger.info(`[AI] upstream request: ${upstream.url} model=${providerRow.model}`)
        logger.info(`[AI] upstream body: ${JSON.stringify(upstream.body).slice(0, 3000)}`)

        let upstreamRes
        try {
          upstreamRes = await fetch(upstream.url, {
            method: 'POST',
            headers: { ...upstream.headers, Accept: 'text/event-stream' },
            body: JSON.stringify(upstream.body),
            signal: upstreamAbort.signal,
          })
        } catch (fetchErr) {
          if (fetchErr?.name === 'AbortError') {
            logger.error('[AI] upstream timeout (180s)')
            sendDelta({ error: '上游模型响应超时（180s），请稍后重试或换用其他模型' })
            finish()
            return
          }
          throw fetchErr
        }

        if (!upstreamRes.ok || !upstreamRes.body) {
          const text = await upstreamRes.text().catch(() => '')
          logger.error(`[AI] upstream error ${upstreamRes.status}: ${text.slice(0, 2000)}`)
          sendDelta({ error: `Upstream error: ${upstreamRes.status}`, detail: text.slice(0, 1500) })
          finish()
          return
        }

        const reader = upstreamRes.body.getReader()
        const decoder = new TextDecoder()

        // 流式发送 thinking 和 content，同时收集 tool_calls
        const response = await collectToolCallsFromStream(reader, decoder, sendDelta, logChunk)

        // 如果有 tool calls（记忆工具在 ask/agent 都可用），执行工具并继续下一轮
        if (response.toolCalls.length > 0) {
          const toolResults = await handleToolCalls(response.toolCalls, req.userId, sendDelta)

          // 将 assistant 回复添加到消息历史
          currentMessages.push({
            role: 'assistant',
            content: response.content || '',
            tool_calls: response.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments
              }
            }))
          })

          // 将工具结果添加到消息历史
          currentMessages.push(...toolResults)

          // 继续下一轮
          continue
        }

        // 没有 tool calls，结束
        finish()
        return
      }

      // 循环结束
      sendDelta({ error: 'Too many tool calling rounds' })
      finish()
    } catch (streamErr) {
      logger.error('AI chat stream error:', streamErr)
      if (!res.headersSent) {
        res.status(500).json({ error: 'AI chat failed', detail: streamErr.message })
      } else {
        finish()
      }
    } finally {
      clearTimeout(upstreamTimer)
    }
  } catch (err) {
    logger.error('AI chat proxy error:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI chat failed', detail: err.message })
    } else {
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }
})

export default router
