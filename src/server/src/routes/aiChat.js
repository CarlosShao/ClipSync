import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { decrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { TOOLS } from './aiTools.js'
import { runChatLoop } from './aiChatCore.js'
import { runOrchestration } from './aiOrchestrator.js'
import { updateConversationUsage } from './aiConversations.js'
import {
  buildRoleSystemPrompt,
  getToolsForRole,
  enhanceSystemPrompt,
} from '../utils/aiSystemPrompt.js'
import { extractImageDataUrls, hashImageDataUrl } from '../utils/imageHash.js'

const router = Router()

// 思考能力由前端 <think> 标签提示词 + 上游 reasoning_content 自动下发实现，无需后端模型匹配表。

// POST /api/ai/chat - SSE 流式代理（支持多轮 tool calling + 多代理并行编排）
router.post('/chat', apiLimiter, async (req, res) => {
  try {
    const { providerId, messages, options } = req.body || {}
    const conversationId = options?.conversationId
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

    // ✅ RBAC（#212）：后端角色系统提示词覆盖前端传入的 system 消息。
    // 角色决定模型能讨论什么、能调哪些工具；覆盖是强制性的，前端提示词不再可信。
    const role = req.user.roleKey || 'user'
    const roleBase = buildRoleSystemPrompt(role, req.userId)
    const systemContent = enhanceSystemPrompt(roleBase, {
      thinking: thinkingEnabled,
      thinkingStrength,
      agentMode: isAgentMode,
      model: providerRow.model,
    })
    // 覆盖 messages 首条（system）；若前端未传 system 消息则插入。
    if (messages[0] && messages[0].role === 'system') {
      messages[0].content = systemContent
    } else {
      messages.unshift({ role: 'system', content: systemContent })
    }
    // 按角色过滤下发给 LLM 的工具集（普通/管理员角色看不到敏感工具）
    const scopedTools = getToolsForRole(role, TOOLS)

    // 图片历史重复检测（#225）：扫描用户消息中的图片，按明文内容哈希比对剪贴板历史。
    // 命中则注入系统提示让 AI 在回答开头友善提示「该图片已存在于历史」，并下发 meta 事件供前端提示。
    let duplicateImageMeta = null
    try {
      const imageUrls = extractImageDataUrls(messages)
      for (const url of imageUrls) {
        const h = hashImageDataUrl(url)
        if (!h) continue
        const dup = await pool.query(
          `SELECT id, created_at, content_preview FROM clipboard_items
           WHERE user_id = $1 AND image_hash = $2 AND image_hash IS NOT NULL
           ORDER BY created_at ASC LIMIT 1`,
          [req.userId, h]
        )
        if (dup.rows.length > 0) {
          const row = dup.rows[0]
          duplicateImageMeta = {
            imageHash: h,
            existingId: row.id,
            createdAt: row.created_at,
            preview: row.content_preview,
          }
          const when = row.created_at ? new Date(row.created_at).toLocaleString('zh-CN') : ''
          const hint = `\n\n[系统提示] 用户刚刚发送的图片，与 TA 剪贴板历史中已有的图片内容完全相同（最早记录于 ${when}）。请在回答开头用一句话友善地提示用户：这张图片已经在 TA 的历史剪贴板中存在了，无需重复保存。`
          systemContent += hint
          const sysMsg = messages.find((m) => m.role === 'system')
          if (sysMsg) sysMsg.content = systemContent
          break
        }
      }
    } catch (e) {
      logger.warn('[AI] duplicate image detection skipped:', e.message)
    }

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

    // 捕获本次 SSE 流最终下发的 usage 元信息，流结束后持久化到 ai_conversations。
    let capturedUsage = null
    const trackedSendDelta = (obj) => {
      if (obj?.meta?.type === 'usage' && obj.meta.usage) {
        capturedUsage = obj.meta.usage
      }
      sendDelta(obj)
    }

    // 图片重复检测提示事件（#225）：供前端展示「该图片已在历史剪贴板中」
    if (duplicateImageMeta) {
      sendDelta({ meta: { type: 'duplicate_image', duplicate: duplicateImageMeta } })
    }

    try {
      if (options?.mode === 'agent') {
        // Agent 模式下由模型自己决定是否派发子代理：
        // 协调器同时挂 dispatch_agents + 业务工具。单任务时直接调工具取数并自闭环回答（单次请求）；
        // 多任务时调用 dispatch_agents 触发并行子代理编排。
        await runOrchestration({
          messages,
          options,
          providerRow,
          apiKey,
          userId: req.userId,
          role,
          sendDelta: trackedSendDelta,
          logChunk,
          safeFinish,
          abortSignal: upstreamAbort.signal,
          thinkingEnabled,
          thinkingStrength,
        })
      } else {
        // Ask 模式：单代理直答（按角色过滤后的工具集）。
        await runChatLoop({
          messages,
          options,
          providerRow,
          apiKey,
          tools: scopedTools,
          role,
          userId: req.userId,
          sendDelta: trackedSendDelta,
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
      // 流结束后异步持久化用量；不阻塞响应结束，失败只记日志。
      if (conversationId && capturedUsage) {
        updateConversationUsage(conversationId, req.userId, capturedUsage).catch((err) => {
          logger.warn('[aiChat] persist usage error:', err.message)
        })
      }
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
