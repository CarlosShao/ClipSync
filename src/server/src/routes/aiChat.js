import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { decrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { TOOLS } from './aiTools.js'
import { runChatLoop } from './aiChatCore.js'
import { runOrchestration } from './aiOrchestrator.js'

const router = Router()

// 思考能力由前端 <think> 标签提示词 + 上游 reasoning_content 自动下发实现，无需后端模型匹配表。

// POST /api/ai/chat - SSE 流式代理（支持多轮 tool calling + 多代理并行编排）
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

    // 模型覆盖：前端可在请求里指定本次使用的模型（多选标签场景）。
    // 校验规则：必须属于该供应商 models 列表，或与已存 model 一致（避免拼错/越权）。
    if (options?.model && typeof options.model === 'string' && options.model.trim().length > 0) {
      const requested = options.model.trim()
      const allowed = Array.isArray(providerRow.models) ? providerRow.models : []
      const isAllowed = allowed.includes(requested) || requested === providerRow.model
      if (isAllowed) {
        providerRow.model = requested
      } else {
        logger.warn(`[AI] requested model "${requested}" not in provider models (${allowed.join(',')}); ignoring override`)
      }
    }

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
    let thinkingChunks = 0
    let contentChunks = 0
    let lastDiagAt = Date.now()

    // 跟踪各 agent 生命周期状态：确保流结束前，所有“已发出但非终态”的 agent 卡片
    // 都被收敛为终态（failed），否则前端对应卡片会因永远收不到 done/failed 而永久转圈。
    // 覆盖两类场景：① 编排中途异常抛出（走 catch→safeFinish）；② 上游/工具挂起被超时中止。
    const agentLifecycle = new Map()

    // 幂等结束：流已结束时绝不再次 write，杜绝 ERR_STREAM_WRITE_AFTER_END 把 SSE 连接异常撕断。
    // 这直接对应"思考卡在小半程 → 突然一下全出来"的现象：连接中途崩溃后客户端只能延迟 reconcile 状态。
    const safeFinish = () => {
      if (res.writableEnded) return
      try {
        // 先收敛残留非终态 agent：避免前端卡片永久转圈
        for (const [id, status] of agentLifecycle) {
          if (status === 'planning' || status === 'working' || status === 'synthesis') {
            try {
              res.write(
                `data: ${JSON.stringify({
                  choices: [{ delta: { agent: { id, status: 'failed', error: 'stream closed before completion' } } }],
                })}\n\n`,
              )
            } catch {
              /* ignore */
            }
          }
        }
        // 关键修复：使用 write 的回调确保数据已写入 socket 后再 end()
        // 避免最后一个 agent 的 done 事件在 Windows socket 缓冲区丢失
        res.write('data: [DONE]\n\n', () => {
          // write 回调触发说明数据已进入 OS 缓冲区，现在可以安全关闭
          res.flush?.()
          res.end()
        })
        // 兜底：如果 write 回调 1s 内未触发（极端情况），强制关闭避免泄漏
        setTimeout(() => {
          if (!res.writableEnded) {
            try { res.end() } catch { /* ignore */ }
          }
        }, 1000)
      } catch (e) {
        logger.warn('[AI] safeFinish write skipped (stream already closed):', e.message)
      }
    }

    const diagLog = (type, n) => {
      const now = Date.now()
      const since = now - lastDiagAt
      lastDiagAt = now
      if (n <= 30 || n % 100 === 0) {
        logger.info(`[AI][diag] forwarded ${type} delta #${n} +${since}ms elapsed=${now - streamStartAt}ms`)
      }
    }

    const sendDelta = (obj) => {
      if (res.writableEnded) return
      const delta = obj?.choices?.[0]?.delta
      // 记录 agent 生命周期状态，供 safeFinish 收敛残留卡片
      if (delta?.agent?.id) {
        agentLifecycle.set(delta.agent.id, delta.agent.status)
      }
      if (delta?.thinking) {
        thinkingChunks++
        diagLog('thinking', thinkingChunks)
      } else if (delta?.content) {
        contentChunks++
        diagLog('content', contentChunks)
      } else if (delta?.tool_call) {
        logger.info(`[AI][diag] tool_call -> ${delta.tool_call.name}`)
      } else if (delta?.tool_result) {
        logger.info(`[AI][diag] tool_result <- ${delta.tool_result.tool_call_id}`)
      }
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
        // 强制 flush：SSE 必须逐块到达客户端，避免服务器缓冲导致“一下子蹦出来”。
        // compression 对 /api/ai/chat 已禁用，flush 可能不存在；存在时立即调用。
        if (typeof res.flush === 'function') res.flush()
      } catch (e) {
        logger.warn('[AI] sendDelta write skipped (stream already closed):', e.message)
      }
    }

    // 原始上游网络块诊断（info 级、节流）：用于判断上游是把思考一次性下发还是分片流式下发。
    const logChunk = ({ bytes, sinceLastMs }) => {
      chunkCount++
      const elapsed = Date.now() - streamStartAt
      if (chunkCount <= 30 || chunkCount % 100 === 0) {
        logger.info(`[AI][diag] upstream net chunk #${chunkCount} +${sinceLastMs}ms ${bytes}B elapsed=${elapsed}ms (thinking=${thinkingChunks} content=${contentChunks})`)
      }
    }

    // 上游整体超时保护（覆盖连接 + 全部轮次/子代理 + 流读取）：
    // 避免上游卡死导致后端 reader.read() 永久阻塞、前端一直卡在“思考 N 秒”不动。
    const upstreamAbort = new AbortController()
    const upstreamTimer = setTimeout(() => upstreamAbort.abort(), 180_000)

    try {
      if (options?.parallel) {
        // 多代理并行编排：协调器 → 并行子代理（只读工具）→ 综合。
        // 协调器若不触发 dispatch_agents，会在内部短路为单代理直答（零额外开销）。
        await runOrchestration({
          messages,
          options,
          providerRow,
          apiKey,
          userId: req.userId,
          sendDelta,
          logChunk,
          safeFinish,
          abortSignal: upstreamAbort.signal,
          thinkingEnabled,
          thinkingStrength,
        })
      } else {
        // 单代理直答（完整工具集，原有路径，完全保留，零回归）。
        await runChatLoop({
          messages,
          options,
          providerRow,
          apiKey,
          tools: TOOLS,
          userId: req.userId,
          sendDelta,
          logChunk,
          agentId: null,
          abortSignal: upstreamAbort.signal,
          maxRounds: 5,
          thinkingEnabled,
          thinkingStrength,
        })
        safeFinish()
      }
    } catch (streamErr) {
      logger.error('AI chat stream error:', streamErr)
      if (!res.headersSent) {
        res.status(500).json({ error: 'AI chat failed', detail: streamErr.message })
      } else {
        safeFinish()
      }
    } finally {
      clearTimeout(upstreamTimer)
    }
  } catch (err) {
    logger.error('AI chat proxy error:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI chat failed', detail: err.message })
    } else {
      safeFinish()
    }
  }
})

export default router
