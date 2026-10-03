import { Router } from 'express'
import bcrypt from 'bcryptjs'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { decrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { logAuditEvent } from '../utils/audit.js'
import { TOOLS, approveToolRequest, respondAskUserRequest, cancelPendingForUser } from './aiTools.js'
import { runChatLoop } from './aiChatCore.js'
import { isValidUUID } from '../validation/validator.js'
// AN-03：providerId 缺省兜底路由（ai_default_provider）+ 禁用供应商统一过滤
import { resolveUserProvider } from '../utils/aiRuntimeConfig.js'
import { buildAiFailure, providerPrecheckFailure } from '../utils/aiFailure.js'
import { runOrchestration } from './aiOrchestrator.js'
import { updateConversationUsage } from './aiConversations.js'
import {
  buildSystemPrompt,
  getToolsForRole,
} from '../utils/aiSystemPrompt.js'
import { extractImageHashes, hashImageDataUrl } from '../utils/imageHash.js'
// 统一取模型（契约：小功能也要吃模型级 enabled —— 主模型被停用就改用另一个已启用模型）
import { resolveEffectiveModel } from '../utils/aiModelSettings.js'
// 契约 v6：X-UI-Locale → 生成内容的语言（每个会产出自然语言的功能都要注入语言指令）
import {
  resolveRequestLocale,
  appendTrailingLanguageRequirement,
  summarizeSystemPrompt,
  similaritySystemPrompt,
  refactorSystemPrompt,
  refactorUserContent,
  suggestCollectionHint,
  suggestBatchSystemPrompt,
  suggestSingleSystemPrompt,
  suggestBatchUserPrompt,
  favoriteMarker,
} from '../utils/aiLocale.js'

const router = Router()

// 思考能力由前端 <think> 标签提示词 + 上游 reasoning_content 自动下发实现，无需后端模型匹配表。

/**
 * AI 小功能统一取模型：把 `providerRow.model` 换成"当前真正可用的那个模型"
 * （优先级与模型级 enabled 校验见 utils/aiModelSettings.pickEffectiveModel）。
 *
 * · 显式传入且合法的 `model` 仍然最优先（/chat 的既有校验逻辑保留）——那种情况下**不要**调本函数；
 * · 其它情况（未指定 / 指定了但不合法 / 小功能没有 model 入参）一律用它兜底；
 * · 取不到时保持原值（函数保证永不失败：④ 兜底主模型）。
 *
 * ⚠️ 供应商层兜底链的既有差异（本次**只记录不改**，见任务说明）：本文件的 /chat、/summarize、
 * /suggest、/similarity、/refactor-prompt 只调 `resolveUserProvider`（用户 is_default →
 * 全局 ai_default_provider 族），拿不到就 404 `ai_no_provider`；而 routes/aiInline.js 额外兜底
 * "任一 enabled 且有 key 的供应商"（页内结果卡不应因没设默认而整体不可用）。二者都是既有设计，
 * 差异**只影响"用哪个供应商"，不影响"用哪个模型"**，故本次不统一（避免顺手改动 chat 的 404 语义）。
 */
async function applyEffectiveModel({ userId, providerId, providerRow }) {
  const eff = await resolveEffectiveModel({ userId, providerId, providerRow })
  if (eff?.model) providerRow.model = eff.model
  return eff
}

// POST /api/ai/chat - SSE 流式代理（支持多轮 tool calling + 多代理并行编排）
router.post('/chat', apiLimiter, async (req, res) => {
  logger.info('[AI] /chat received', { userId: req.userId, providerId: req.body?.providerId, mode: req.body?.options?.mode, model: req.body?.options?.model, msgCount: (req.body?.messages || []).length })
  try {
    const { providerId, messages, options } = req.body || {}
    const conversationId = options?.conversationId
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required' })
    }

    // 归属校验：conversationId 必须属于当前用户；不存在/不属于一律 404（不泄漏资源是否存在）
    if (conversationId !== undefined && conversationId !== null) {
      if (!isValidUUID(conversationId)) {
        return res.status(404).json({ error: 'Conversation not found' })
      }
      const own = await pool.query(
        'SELECT 1 FROM ai_conversations WHERE id = $1 AND user_id = $2',
        [conversationId, req.userId],
      )
      if (own.rowCount === 0) {
        return res.status(404).json({ error: 'Conversation not found' })
      }
    }

    // AN-03：providerId 缺省时兜底路由（用户 is_default → 全局 ai_default_provider 供应商族）；
    // 管理台禁用的供应商（enabled=FALSE）在此统一视为不存在
    const providerRow = await resolveUserProvider(req.userId, providerId)
    if (!providerRow) { const f = providerPrecheckFailure('no_provider'); return res.status(f.httpStatus).json(f.body) }
    if (!providerRow.api_key_encrypted) { const f = providerPrecheckFailure('no_key', providerRow); return res.status(f.httpStatus).json(f.body) }

    const apiKey = decrypt(providerRow.api_key_encrypted)
    const thinkingEnabled = options?.thinking || false
    const thinkingStrength = options?.thinkingStrength || 'medium'
    const isAgentMode = options?.mode === 'agent'

    // ✅ RBAC（#212/#Agent-F）：后端统一组装完整 system 提示词，覆盖前端传入的 system 消息。
    // 组成：角色提示词 + 产品知识 + 脱敏统计 + 按开关的记忆 + thinking/Agent 增强（见 buildSystemPrompt）。
    // 覆盖是强制性的，前端提示词不再可信。
    const role = req.user.roleKey || 'user'
    // 契约 v6：界面语言（X-UI-Locale）—— 生成内容跟随语言（英文界面 ⇒ 英文回答）
    const locale = resolveRequestLocale(req)
    const systemContent = await buildSystemPrompt(req.userId, role, {
      thinking: thinkingEnabled,
      thinkingStrength,
      agentMode: isAgentMode,
      model: providerRow.model,
      locale,
    })
    // 覆盖 messages 首条（system）；若前端未传 system 消息则插入。
    if (messages[0] && messages[0].role === 'system') {
      messages[0].content = systemContent
    } else {
      messages.unshift({ role: 'system', content: systemContent })
    }
    // 契约 v6：**末尾强化** —— system 段里的语言要求虽然已是该段的最后，但它后面还有整段用户内容
    // （本产品常见：中文长文本/多模态数组）⇒ 再把要求追加到最后一条消息末尾，位置最权威。
    // （Anthropic/Responses 协议会把 system 抽取到最前，只有追加到最后一条 user 内容才真正"在最后"。）
    appendTrailingLanguageRequirement(messages, locale)
    // 按角色过滤下发给 LLM 的工具集（普通/管理员角色看不到敏感工具）
    const scopedTools = getToolsForRole(role, TOOLS)

    // 图片历史重复检测（#225）：扫描用户消息中的图片，按明文内容哈希比对剪贴板历史。
    // 命中则注入系统提示让 AI 在回答开头友善提示「该图片已存在于历史」，并下发 meta 事件供前端提示。
    let duplicateImageMeta = null
    try {
      const imageEntries = extractImageHashes(messages)
      for (const entry of imageEntries) {
        const h = entry.hash || hashImageDataUrl(entry.url)
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
            type: 'duplicate_image',
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
    // 显式且合法的 model **仍然最优先**（既有逻辑保留）；未指定或指定不合法时，
    // 回退到统一取模型（模型级 enabled 生效：主模型被停用 ⇒ 改用另一个已启用模型）。
    let explicitModelApplied = false
    if (options?.model && typeof options.model === 'string' && options.model.trim().length > 0) {
      const requested = options.model.trim()
      const allowed = Array.isArray(providerRow.models) ? providerRow.models : []
      const isAllowed = allowed.includes(requested) || requested === providerRow.model
      if (isAllowed) {
        providerRow.model = requested
        explicitModelApplied = true
      } else {
        logger.warn(`[AI] requested model "${requested}" not in provider models (${allowed.join(',')}); ignoring override`)
      }
    }
    if (!explicitModelApplied) {
      await applyEffectiveModel({ userId: req.userId, providerId, providerRow })
    }

    // SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    // 禁用 Nagle：确保每个增量块立刻发到 socket，杜绝攒批导致“一次性蹦出”
    res.socket?.setNoDelay?.(true)

    const upstreamAbort = new AbortController()
    const upstreamTimer = setTimeout(() => upstreamAbort.abort(), 30 * 60_000)

    // SSE 心跳：上游长思考/工具间隙可能 30s+ 无输出，无心跳会被中间件
    // 请求超时掐断（req.destroy，前端表现为静默断流）。每 15s 写一条 SSE
    // 注释帧（以 : 开头，客户端按规范忽略），既保活 socket 也喂饱超时计时。
    // 有真实增量时重置计时，避免心跳与内容挤在一起。
    let heartbeatTimer = null
    const resetHeartbeat = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer)
      heartbeatTimer = setTimeout(() => {
        if (!res.writableEnded) {
          try {
            res.write(': ping\n\n')
            if (typeof res.flush === 'function') res.flush()
          } catch {
            /* socket 已死，下次 sendDelta/safeFinish 会收敛 */
          }
        }
        resetHeartbeat()
      }, 15_000)
    }
    resetHeartbeat()
    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer)
        heartbeatTimer = null
      }
    }

    // Agent-C：客户端断开时立刻中止上游生成并清空该用户残留的 pending。
    req.on('close', () => {
      upstreamAbort.abort()
      cancelPendingForUser(req.userId)
    })

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
      stopHeartbeat()
      // Agent-C：流结束（含正常结束/异常）时清掉该用户残留的待确认破坏性请求，
      // 避免 SSE 已断开仍残留 pending（确认卡片已无发送通道）。
      cancelPendingForUser(req.userId)
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
        // 有真实增量 → 心跳计时重置（避免心跳与内容挤在一起）
        resetHeartbeat()
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
      sendDelta({ meta: duplicateImageMeta })
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
          req,
          sendDelta: trackedSendDelta,
          logChunk,
          safeFinish,
          abortSignal: upstreamAbort.signal,
          thinkingEnabled,
          thinkingStrength,
          locale,
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
          conversationId,
          sendDelta: trackedSendDelta,
          logChunk,
          agentId: null,
          abortSignal: upstreamAbort.signal,
          maxRounds: 5,
          thinkingEnabled,
          thinkingStrength,
          locale,
        })
        safeFinish()
      }
    } catch (streamErr) {
      logger.error('AI chat stream error:', streamErr)
      if (!res.headersSent) {
        res.status(500).json({ error: 'AI chat failed', detail: streamErr.message })
      } else {
        // 把上游异常透传给前端，不要闷掉 —— 上游 LLM 抛 fetch failed / 401 / 429 / 5xx 时，
        // 前端 useAiChat 见到 SSE data: {"error":"..."} 会把消息展示给用户，
        // 并把最后一条 assistant 设 isError=true（红框）。这是产品可见性。
        // 解包 Node 内置 fetch 抛的 TypeError("fetch failed")，从 e.cause 拿到具体 errno。
        const upstreamCause = streamErr?.cause
          ? { code: streamErr.cause.code, message: streamErr.cause.message, syscall: streamErr.cause.syscall }
          : null
        const errPayload = {
          error: streamErr.message || 'AI chat failed',
          detail: upstreamCause ? `[cause] ${upstreamCause.syscall || ''} ${upstreamCause.code || ''} ${upstreamCause.message || ''}`.trim() : undefined,
        }
        try {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(errPayload)}\n\n`)
        } catch { /* ignore */ }
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
      const f = buildAiFailure(err, null, 'AI chat failed')
      res.status(f.httpStatus).json(f.body)
    } else {
      safeFinish()
    }
  }
})

// POST /api/ai/summarize - 轻量剪贴板内容摘要（非流式，供桌面复制后 AI 摘要浮窗使用）
router.post('/summarize', apiLimiter, async (req, res) => {
  // catch 里也要用它构造失败响应（告知是哪个供应商出了问题），所以提到 try 外
  let providerRow = null
  try {
    const { providerId, content } = req.body || {}
    if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content is required' })

    // AN-03：providerId 缺省时兜底路由（用户 is_default → 全局 ai_default_provider 供应商族）；
    // 管理台禁用的供应商（enabled=FALSE）在此统一视为不存在
    providerRow = await resolveUserProvider(req.userId, providerId)
    if (!providerRow) { const f = providerPrecheckFailure('no_provider'); return res.status(f.httpStatus).json(f.body) }
    if (!providerRow.api_key_encrypted) { const f = providerPrecheckFailure('no_key', providerRow); return res.status(f.httpStatus).json(f.body) }

    const apiKey = decrypt(providerRow.api_key_encrypted)
    // 统一取模型：主模型被停用（模型级 enabled=false）时改用另一个已启用模型
    await applyEffectiveModel({ userId: req.userId, providerId, providerRow })
    const locale = resolveRequestLocale(req)
    const MAX_SUMMARY_INPUT = 4000
    const truncated = content.slice(0, MAX_SUMMARY_INPUT)
    const messages = [
      { role: 'system', content: summarizeSystemPrompt(locale) },
      { role: 'user', content: truncated },
    ]
    // 契约 v6：末尾强化（system 段之后还有整段用户内容，要求必须紧贴生成位置）
    appendTrailingLanguageRequirement(messages, locale)

    const { finalContent } = await runChatLoop({
      messages,
      options: { temperature: 0.3, max_tokens: 120 },
      providerRow,
      apiKey,
      tools: [],
      userId: req.userId,
      sendDelta: () => {},
      role: 'user',
      locale,
    })

    return res.json({ summary: (finalContent || '').trim().slice(0, 200) })
  } catch (err) {
    logger.error('[AI] summarize error:', err)
    const f = buildAiFailure(err, providerRow, 'Summary failed')
    res.status(f.httpStatus).json(f.body)
  }
})

// POST /api/ai/similarity - 语义相似度检测（任务 #236）：
// 判断一段内容与候选条目中哪些"语义重复"（改写/同义/部分重叠），
// 输出命中列表 + 原因。非流式，供前端选中条目后提示重复。
router.post('/similarity', apiLimiter, async (req, res) => {
  // catch 里也要用它构造失败响应（告知是哪个供应商出了问题），所以提到 try 外
  let providerRow = null
  try {
    const { providerId, content, candidates = [] } = req.body || {}
    if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content is required' })
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return res.json({ duplicates: [], checked: 0 })
    }
    // 最多比对 10 条候选，避免一次调用消耗过多 token
    const limited = candidates
      .filter((c) => c && typeof c.id === 'string' && typeof c.text === 'string' && c.text.trim())
      .slice(0, 10)
      .map((c) => ({ id: c.id.slice(0, 64), text: c.text.slice(0, 200) }))
    if (limited.length === 0) return res.json({ duplicates: [], checked: 0 })

    // AN-03：providerId 缺省时兜底路由 + 禁用供应商统一过滤（见 utils/aiRuntimeConfig.js）
    providerRow = await resolveUserProvider(req.userId, providerId)
    if (!providerRow) { const f = providerPrecheckFailure('no_provider'); return res.status(f.httpStatus).json(f.body) }
    if (!providerRow.api_key_encrypted) { const f = providerPrecheckFailure('no_key', providerRow); return res.status(f.httpStatus).json(f.body) }

    const apiKey = decrypt(providerRow.api_key_encrypted)
    // 统一取模型：主模型被停用（模型级 enabled=false）时改用另一个已启用模型
    await applyEffectiveModel({ userId: req.userId, providerId, providerRow })
    const locale = resolveRequestLocale(req)
    const truncated = content.slice(0, 4000)

    const messages = [
      {
        role: 'system',
        content: similaritySystemPrompt(locale, limited.map((c) => `${c.id}: ${c.text}`)),
      },
      { role: 'user', content: truncated },
    ]
    // 契约 v6：末尾强化（追加到最后一条 user 内容末尾；JSON 结构不受影响）
    appendTrailingLanguageRequirement(messages, locale)

    const { finalContent } = await runChatLoop({
      messages,
      options: { temperature: 0.1, max_tokens: 300 },
      providerRow,
      apiKey,
      tools: [],
      userId: req.userId,
      sendDelta: () => {},
      role: 'user',
      locale,
    })

    const raw = (finalContent || '').trim()
    let jsonStr = raw
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenced) jsonStr = fenced[1].trim()
    else {
      const arrStart = raw.indexOf('[')
      const arrEnd = raw.lastIndexOf(']')
      if (arrStart >= 0 && arrEnd > arrStart) jsonStr = raw.slice(arrStart, arrEnd + 1)
    }
    let list = null
    try {
      list = JSON.parse(jsonStr)
    } catch {
      list = null
    }
    const validIds = new Set(limited.map((c) => c.id))
    const duplicates = Array.isArray(list)
      ? list
          .filter((d) => d && typeof d.id === 'string' && validIds.has(d.id))
          .map((d) => ({
            id: d.id,
            reason: String(d.reason || '').slice(0, 200),
            degree: d.degree === 'high' ? 'high' : 'medium',
          }))
      : []
    return res.json({ duplicates, checked: limited.length })
  } catch (err) {
    logger.error('[AI] similarity error:', err)
    const f = buildAiFailure(err, providerRow, 'Similarity failed')
    res.status(f.httpStatus).json(f.body)
  }
})

/**
 * POST /api/ai/refactor-prompt
 * 提示词改写（不进入对话历史，不发起对话）。行为对齐 WorkBuddy：点 Sparkles 图标
 * → 调 LLM 优化输入框里的草稿 → 把结果覆盖回去，让用户手工复核再发。
 *
 * Body: { providerId, content }
 * Res: SSE 流（每条 delta 推送优化后的文本）；流结束返回 refactored 全文。
 * 失败同样把 fetch failed 等上游异常透传到 SSE data: {"error":...}，前端用 onError 渲染。
 */
router.post('/refactor-prompt', apiLimiter, async (req, res) => {
  // catch 里也要用它构造失败响应（告知是哪个供应商出了问题），所以提到 try 外
  let providerRow = null
  try {
    const { providerId, content } = req.body || {}
    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content is required' })
    }

    // AN-03：providerId 缺省时兜底路由 + 禁用供应商统一过滤（见 utils/aiRuntimeConfig.js）
    providerRow = await resolveUserProvider(req.userId, providerId)
    if (!providerRow) {
      const f1 = providerPrecheckFailure('no_provider')
      return res.status(f1.httpStatus).json(f1.body)
    }
    if (!providerRow.api_key_encrypted) {
      const f2 = providerPrecheckFailure('no_key', providerRow)
      return res.status(f2.httpStatus).json(f2.body)
    }
    const apiKey = decrypt(providerRow.api_key_encrypted)
    const role = req.user.roleKey || 'user'
    // 统一取模型：主模型被停用（模型级 enabled=false）时改用另一个已启用模型
    await applyEffectiveModel({ userId: req.userId, providerId, providerRow })
    // 契约 v6：界面语言（提示词与 user 消息都要跟着切换；JSON 键名/枚举保持稳定 code）
    const locale = resolveRequestLocale(req)

    // SSE 响应头（与 /chat 一致）
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    // 客户端断开时立刻停止 LLM
    const upstreamAbort = new AbortController()
    req.on('close', () => {
      try { upstreamAbort.abort() } catch { /* ignore */ }
    })

    const refactorSystem = refactorSystemPrompt(locale)
    const refactorMessages = [
      { role: 'system', content: refactorSystem },
      // 草稿用定界符包住：末尾强化指令追加在定界符之后，模型只改写标记之间文本，不会把指令写进结果
      { role: 'user', content: refactorUserContent(locale, content.trim()) },
    ]
    // 契约 v6：末尾强化（要求出现在最后一条 user 内容末尾）
    appendTrailingLanguageRequirement(refactorMessages, locale)

    let finalText = ''
    let sentError = false
    const safeFinish = () => {
      if (res.writableEnded) return
      try {
        res.write('data: [DONE]\n\n')
        res.end()
      } catch { /* ignore */ }
    }

    try {
      await runChatLoop({
        messages: refactorMessages,
        options: {
          temperature: 0.4,
          max_tokens: 2000,
          abortSignal: upstreamAbort.signal,
          model: providerRow.model,
        },
      providerRow,
      apiKey,
      userId: req.userId,
      role,
      sendDelta: (obj) => {
        // runChatLoop → aiStream.collectToolCallsFromStream 调 sendDelta 传 OpenAI 风格对象：
        //   { choices: [{ delta: { content: 'xxx' } }] }    —— 流式文本 delta
        //   { meta: { type: 'usage', usage: {...} } }         —— 元信息（不关心）
        //   { meta: { type: 'context_compress_started', ... } } —— 压缩事件（refactor 不应触发，但兜底也不消费）
        // 我们只把 content 文本 delta 转成 SSE 推给前端；同时累积 finalText 供后端日志和兜底用。
        // Bug 修复：之前的实现是 `if (typeof text === 'string')` 永远为 false，导致
        // 前端 streamRefactorPrompt 永远收不到 delta、输入框看不到变化。
        const delta = obj?.choices?.[0]?.delta
        const piece = delta?.content
        if (typeof piece === 'string' && piece.length) {
          finalText += piece
          try {
            if (!res.writableEnded) {
              // 直接透传 OpenAI 风格对象，前端用 `delta?.content` 拿增量
              res.write(`data: ${JSON.stringify(obj)}\n\n`)
            }
          } catch { /* ignore */ }
        }
      },
    })
    safeFinish()
    } catch (streamErr) {
      // 把上游异常透传给前端（如 mimo 抛 fetch failed / 401 / 429）— 不要闷掉
      logger.error('[AI][refactor-prompt] stream error:', streamErr)
      const upstreamCause = streamErr?.cause
        ? { code: streamErr.cause.code, message: streamErr.cause.message, syscall: streamErr.cause.syscall }
        : null
      const detailMsg = upstreamCause
        ? `[cause] ${upstreamCause.syscall || ''} ${upstreamCause.code || ''} ${upstreamCause.message || ''}`.trim()
        : undefined
      try {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: streamErr.message || 'refactor failed', detail: detailMsg })}\n\n`)
        }
      } catch { /* ignore */ }
      sentError = true
      safeFinish()
    }

    // 给日志留个尾，方便回溯
    logger.info('[AI][refactor-prompt] done:', { length: content.length, outLen: finalText.length, errored: sentError })
  } catch (err) {
    logger.error('[AI] refactor-prompt error:', err)
    if (!res.headersSent) {
      const f = buildAiFailure(err, providerRow, 'Refactor failed')
    res.status(f.httpStatus).json(f.body)
    } else {
      try {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: err.message || 'refactor failed' })}\n\n`)
        }
      } catch { /* ignore */ }
      try { res.end() } catch { /* ignore */ }
    }
  }
})

// POST /api/ai/suggest - 主动建议（任务 #230）：根据剪贴板内容给出"是否值得收藏 /
// 建议分类 / 建议清理"的结构化建议。非流式，供前端选中条目后展示 AI 建议。
//
// 支持两种调用形态：
//   - 单条：{ providerId, content, collections }            → 返回 { suggestion }
//   - 批量：{ providerId, items: [{id, content}], collections } → 返回 { suggestions: [{id, suggestion}, ...] }
//
// 批量场景：用户勾选 N 条文本后一次性获取所有条目的建议，避免单条接口串行慢。
// AI 一次返回 N 个建议的 JSON 数组（按 items 顺序），前端展示为列表。
router.post('/suggest', apiLimiter, async (req, res) => {
  // catch 里也要用它构造失败响应（告知是哪个供应商出了问题），所以提到 try 外
  let providerRow = null
  try {
    const { providerId, content, collections = [], items } = req.body || {}
    // 契约 v6：界面语言（收藏夹提示 / 提示词 / [已收藏] 标记 / user 消息全部跟着切换）
    const locale = resolveRequestLocale(req)

    const collectionNames = Array.isArray(collections) ? collections.filter((x) => typeof x === 'string' && x.trim()).slice(0, 30) : []
    const collectionHint = suggestCollectionHint(locale, collectionNames)

    // === 形态分发 ===
    const isBatch = Array.isArray(items) && items.length > 0
    if (!isBatch) {
      if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content is required' })
    } else if (items.length > 20) {
      // 上限 20 条，避免一次 LLM 调用 input 过大；超出截断并提示
      return res.status(400).json({ error: '批量建议最多 20 条，请减少勾选数' })
    }

    // AN-03：providerId 缺省时兜底路由 + 禁用供应商统一过滤（见 utils/aiRuntimeConfig.js）
    providerRow = await resolveUserProvider(req.userId, providerId)
    if (!providerRow) { const f = providerPrecheckFailure('no_provider'); return res.status(f.httpStatus).json(f.body) }
    if (!providerRow.api_key_encrypted) { const f = providerPrecheckFailure('no_key', providerRow); return res.status(f.httpStatus).json(f.body) }

    const apiKey = decrypt(providerRow.api_key_encrypted)
    // 统一取模型：主模型被停用（模型级 enabled=false）时改用另一个已启用模型
    await applyEffectiveModel({ userId: req.userId, providerId, providerRow })
    const MAX_SUGGEST_INPUT = 4000
    // 归一化一条输入（裁剪 / 校验）
    const normalize = (s) => (typeof s === 'string' ? s.slice(0, MAX_SUGGEST_INPUT) : '')

    let messages
    let returnShape // { kind: 'single' | 'batch', parsed: fn }

    if (isBatch) {
      const cleanedItems = items
        .filter((it) => it && typeof it.id === 'string' && it.id && typeof it.content === 'string' && it.content.trim())
        .slice(0, 20)
        .map((it) => ({ id: it.id, content: normalize(it.content), isFavorite: !!it.isFavorite }))

      if (cleanedItems.length === 0) {
        return res.status(400).json({ error: 'items 不能为空' })
      }

      // 给 AI 一个"索引 → 内容预览 + 已收藏标记"对照表（不传全文，避免拼 prompt 超长）
      // 契约 v6：预览标签与"已收藏"标记必须与提示词同语言（提示词里引用了 [favorited]/[已收藏]）
      const favMarkText = favoriteMarker(locale)
      const previewLabel = locale === 'en' ? 'preview' : '预览'
      const itemListForPrompt = cleanedItems
        .map((it, i) => {
          const preview = (it.content || '').slice(0, 120).replace(/\s+/g, ' ')
          const favMark = it.isFavorite ? favMarkText : ''
          return `[${i}] id=${it.id}${favMark} ${previewLabel}：${preview}`
        })
        .join('\n')

      messages = [
        { role: 'system', content: suggestBatchSystemPrompt(locale, cleanedItems.length, collectionHint) },
        { role: 'user', content: suggestBatchUserPrompt(locale, cleanedItems.length, itemListForPrompt) },
      ]

      returnShape = {
        kind: 'batch',
        parsed: (arr, raw) => {
          const map = new Map()
          if (Array.isArray(arr)) {
            arr.forEach((row) => {
              const idx = Number(row?.index)
              if (Number.isInteger(idx) && idx >= 0 && idx < cleanedItems.length) {
                map.set(cleanedItems[idx].id, cleanSuggestion(row))
              }
            })
          }
          // 按 items 顺序输出，未命中的给 null
          return cleanedItems.map((it) => ({ id: it.id, suggestion: map.get(it.id) || null }))
        },
      }
    } else {
      const truncated = normalize(content)
      messages = [
        { role: 'system', content: suggestSingleSystemPrompt(locale, collectionHint) },
        { role: 'user', content: truncated },
      ]

      returnShape = {
        kind: 'single',
        parsed: (obj) => cleanSuggestion(obj),
      }
    }

    // 契约 v6：末尾强化（单条/批量两条分支共用一次；追加到最后一条 user 内容末尾，
    // JSON 键名与 keep/archive/cleanup 枚举不受影响）
    appendTrailingLanguageRequirement(messages, locale)

    const { finalContent } = await runChatLoop({
      messages,
      options: { temperature: 0.2, max_tokens: isBatch ? 300 * Math.max(1, items.length) : 300 },
      providerRow,
      apiKey,
      tools: [],
      userId: req.userId,
      sendDelta: () => {},
      role: 'user',
      locale,
    })

    // 容错解析：AI 可能带 markdown 包裹或前后多余文字
    const raw = (finalContent || '').trim()
    let jsonStr = raw
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenced) jsonStr = fenced[1].trim()
    else {
      const first = jsonStr[0]
      if (first === '[') {
        const start = jsonStr.indexOf('[')
        const end = jsonStr.lastIndexOf(']')
        if (start >= 0 && end > start) jsonStr = jsonStr.slice(start, end + 1)
      } else {
        const start = jsonStr.indexOf('{')
        const end = jsonStr.lastIndexOf('}')
        if (start >= 0 && end > start) jsonStr = jsonStr.slice(start, end + 1)
      }
    }
    let parsed
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      parsed = null
    }
    if (!parsed) {
      return res.json(returnShape.kind === 'batch'
        ? { suggestions: [], raw, error: 'AI 未返回结构化建议' }
        : { suggestion: null, raw, error: 'AI 未返回结构化建议' })
    }
    if (returnShape.kind === 'batch') {
      return res.json({ suggestions: returnShape.parsed(parsed, raw), raw: undefined })
    }
    return res.json({ suggestion: returnShape.parsed(parsed), raw: undefined })
  } catch (err) {
    logger.error('[AI] suggest error:', err)
    const f = buildAiFailure(err, providerRow, 'Suggestion failed')
    res.status(f.httpStatus).json(f.body)
  }
})

// 归一化建议字段（单条 / 批量共用）
function cleanSuggestion(s) {
  if (!s || typeof s !== 'object') return null
  const worthFav = Boolean(s.worth_favorite)
  return {
    worth_favorite: worthFav,
    reason: String(s.reason || '').slice(0, 300),
    suggested_collection:
      worthFav && typeof s.suggested_collection === 'string' && s.suggested_collection.trim()
        ? s.suggested_collection.trim().slice(0, 60)
        : null,
    action: ['keep', 'archive', 'cleanup'].includes(s.action) ? s.action : 'keep',
    action_reason: String(s.action_reason || '').slice(0, 300),
    // 防御性归一化：worth_favorite=false 时，suggested_tags 强制清空
    // （不应该给"不值得收藏"的内容推荐标签）
    suggested_tags: worthFav && Array.isArray(s.suggested_tags)
      ? s.suggested_tags
          .filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim().slice(0, 20))
          .slice(0, 5)
      : [],
  }
}

/**
 * POST /api/ai/chat/approve —— 破坏性操作确认入口（Agent-C）
 * 由前端在收到 confirm_tool_action SSE 事件后调用。已在路由挂载层受 authenticateToken + csrfProtection 保护。
 *
 * Body: { requestId, allow, password? }
 *  - allow=true  → 批准：执行被确认的破坏性工具（destroy_clips），返回 { accepted: true, final }
 *  - allow=false → 拒绝：不执行，向等待中的 executeTool 结算 REJECTED_BY_USER，返回 { accepted: false }
 *  - password    → 可选超管二次验证口令：
 *      * 前端未启用该能力时（不传 password）保持向后兼容，不强制二次验证，直接走原流程；
 *      * 超管在确认高权限破坏性操作（如 delete_user / update_role / reset_password 等）被要求二次确认时
 *        传入 password，后端即强制校验口令一致性，防止已授权会话被他人复用后静默执行高权限动作。
 *
 * 归属校验：pending 项记录 userId，仅该用户自身能审批其请求（禁跨用户）。
 */
router.post('/chat/approve', apiLimiter, async (req, res) => {
  try {
    const { requestId, allow, password } = req.body || {}
    if (!requestId || typeof requestId !== 'string') {
      return res.status(400).json({ error: 'requestId is required' })
    }

    // 超管敏感操作二次验证（可选）：
    // 仅当请求体携带非空 password 时才强制校验，否则保持原批准流程（向后兼容）。
    if (typeof password === 'string' && password.length > 0) {
      try {
        const userRes = await pool.query(
          'SELECT password_hash, is_active FROM users WHERE id = $1',
          [req.userId]
        )
        const user = userRes.rows[0]
        if (!user || user.is_active === false) {
          return res.status(401).json({ error: 'user_not_found_or_disabled' })
        }
        const ok = await bcrypt.compare(password, user.password_hash)
        if (!ok) {
          // 二次验证失败：写审计，不执行批准，也不改 pending 状态（用户可重试）。
          await logAuditEvent({
            userId: req.userId,
            action: 'approve_password_verify_failed',
            resourceType: 'ai_tool_approve',
            details: { requestId },
            status: 'failure',
            errorMessage: '二次验证密码错误',
          })
          return res.status(401).json({ error: 'password_verify_failed', message: '二次验证密码错误' })
        }
      } catch (verifyErr) {
        logger.error('[AI] approve password verify error:', verifyErr)
        return res.status(500).json({ error: 'Approve failed', detail: '二次验证查询失败' })
      }
    }

    const out = await approveToolRequest(requestId, req.userId, allow === true)
    if (out.notFound) {
      return res.status(404).json({ accepted: false, error: 'NOT_FOUND', message: '该确认请求不存在或不属于当前用户，可能已处理或已超时。' })
    }
    if (out.expired) {
      return res.status(409).json({ accepted: false, error: 'EXPIRED', message: '该确认请求已处理或已超时。' })
    }
    if (out.accepted) {
      return res.json({ accepted: true, final: out.final })
    }
    return res.json({ accepted: false, error: 'REJECTED' })
  } catch (err) {
    logger.error('[AI] approve error:', err)
    res.status(500).json({ error: 'Approve failed', detail: err.message })
  }
})

/**
 * POST /api/ai/chat/respond_ask_user —— 响应 ask_user 交互卡片用户选择
 * 由前端在用户点击卡片"提交选择"时调用。已在路由挂载层受 authenticateToken + csrfProtection 保护。
 *
 * Body: { requestId, userResponse }
 */
router.post('/chat/respond_ask_user', apiLimiter, async (req, res) => {
  try {
    const { requestId, userResponse } = req.body || {}
    if (!requestId || typeof requestId !== 'string') {
      return res.status(400).json({ error: 'requestId is required' })
    }

    const out = await respondAskUserRequest(requestId, req.userId, userResponse || '')
    if (out.notFound) {
      return res.status(404).json({ accepted: false, error: 'NOT_FOUND', message: '该选择请求不存在或不属于当前用户，可能已超时。' })
    }
    if (out.expired) {
      return res.status(409).json({ accepted: false, error: 'EXPIRED', message: '该选择请求已处理或已超时。' })
    }
    return res.json({ accepted: true })
  } catch (err) {
    logger.error('[AI] respond_ask_user error:', err)
    res.status(500).json({ error: 'Failed to respond', detail: err.message })
  }
})

export default router
