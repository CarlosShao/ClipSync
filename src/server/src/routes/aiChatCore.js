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
import logger from '../utils/logger.js'
import { buildUpstreamChat, getPreset, getContextWindow, safeUpstreamFetch } from '../utils/aiProviders.js'
import { collectToolCallsFromStream, handleToolCalls } from './aiStream.js'
import { pool } from '../db/pool.js'

/**
 * 读取指定对话最近的"上下文自动压缩摘要"。
 * 用于 runChatLoop 入口将之前压缩的要点重新注入到 system 之后，让 AI 在后续轮次中
 * 无感延续记忆（即使前端 messages 已被前端过滤掉 system 角色）。
 * @returns {Promise<string|null>}
 */
export async function fetchLatestContextSummary(conversationId) {
  if (!conversationId) return null
  try {
    const res = await pool.query(
      `SELECT content FROM ai_messages
       WHERE conversation_id = $1 AND role = 'system'
         AND COALESCE(metadata->>'is_context_summary','false') = 'true'
       ORDER BY created_at DESC LIMIT 1`,
      [conversationId],
    )
    return res.rows[0]?.content || null
  } catch (e) {
    logger.warn('[AI] fetchLatestContextSummary failed:', e.message)
    return null
  }
}

/**
 * 持久化上下文压缩摘要到 ai_messages。
 * 供 compressConversationHistory 在摘要生成后调用，使下次进入对话时仍能"无感"接上。
 * 这里刻意写 role='system' + metadata.is_context_summary=true 双重标记，
 * 让前端 messages 保存路径（全量替换）能够保留这条摘要而不被误删。
 * @returns {Promise<boolean>} 是否成功
 */
export async function persistContextSummary(conversationId, summary) {
  if (!conversationId || !summary) return false
  try {
    await pool.query(
      `INSERT INTO ai_messages (conversation_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3::jsonb)`,
      [conversationId, summary, JSON.stringify({ is_context_summary: true })],
    )
    return true
  } catch (e) {
    logger.warn('[AI] persistContextSummary failed:', e.message)
    return false
  }
}

/**
 * 手动压缩指定对话（由用户 /compact 命令触发）。
 * 加载该对话的全量历史，过滤掉之前自动注入的"上下文压缩摘要"行（避免重复摘要），
 * 重新构造 messages 数组并复用 compressConversationHistory 的核心压缩逻辑。
 * 成功后把新摘要持久化到 ai_messages（role=system, metadata.is_context_summary=true）。
 *
 * @param {string} conversationId
 * @param {string} userId
 * @param {object} providerRow  - 该对话绑定的 AI 供应商（用于调 LLM 生成摘要）
 * @param {string} apiKey       - 供应商 API key（明文，已解密）
 * @param {string} role         - 'user' | 'admin' | 'super_admin'
 * @returns {Promise<
 *   | { ok: true, removed: number, summaryTokens: number, beforeTokens: number, afterTokens: number, summary: string }
 *   | { ok: false, reason: 'too_short' | 'not_found' | 'no_provider' | 'no_key' | 'failed', message?: string }
 * >}
 */
export async function manualCompactConversation({ conversationId, userId, providerRow, apiKey, role }) {
  if (!conversationId) return { ok: false, reason: 'not_found', message: 'conversationId required' }
  if (!providerRow) return { ok: false, reason: 'no_provider', message: '未选择供应商' }
  if (!apiKey) return { ok: false, reason: 'no_key', message: '供应商未配置 API key' }

  // 1. 加载该对话的 ownership（system_prompt 存在 messages 表中 role='system' 行，
  //    ai_conversations 没有此列 —— 不在此读取）。
  const convRes = await pool.query(
    `SELECT id, user_id FROM ai_conversations WHERE id = $1 LIMIT 1`,
    [conversationId],
  )
  if (convRes.rowCount === 0 || convRes.rows[0].user_id !== userId) {
    return { ok: false, reason: 'not_found', message: '对话不存在或不属于当前用户' }
  }
  const msgRes = await pool.query(
    `SELECT id, role, content, thinking, tool_calls, tool_results, metadata
     FROM ai_messages
     WHERE conversation_id = $1
       AND COALESCE(metadata->>'is_context_summary', 'false') <> 'true'
     ORDER BY created_at ASC`,
    [conversationId],
  )

  // 2. 重建 messages 数组（与前端 useAiConversations.select 行为一致）
  const messages = msgRes.rows.map((m) => ({
    role: m.role,
    content: m.content || '',
    thinking: m.thinking || undefined,
    toolCalls: m.tool_calls || [],
    toolResults: m.tool_results || [],
  }))

  if (messages.length < 6) {
    return { ok: false, reason: 'too_short', message: '当前对话历史太短，无需压缩' }
  }

  // 3. 估算压缩前 token 数
  const beforeTokens = estimateMessagesTokens(messages)

  // 4. 复用核心压缩逻辑（只生成摘要，不替换 messages：返回的 messages 数组用户也用不到）
  const res = await compressConversationHistory(messages, {
    providerRow,
    apiKey,
    userId,
    abortSignal: undefined,
    role: role || 'user',
    conversationId, // 内部会 persistContextSummary 把新摘要写进 ai_messages
  })
  if (!res) {
    return { ok: false, reason: 'failed', message: '模型未能生成摘要（可能上游异常）' }
  }

  return {
    ok: true,
    removed: res.removed,
    summaryTokens: res.summaryTokens,
    beforeTokens,
    afterTokens: res.estimatedTokens,
    summary: typeof res.messages === 'string' ? res.messages : '', // 备用：通常为空数组，留作未来拓展
  }
}

/**
 * 打开上游 SSE 流并复用统一的错误处理（超时 / 状态码）。
 * 抽出供 runChatLoop 与多代理协调器共用，避免两套 fetch 逻辑漂移。
 * @returns {{ reader: ReadableStreamDefaultReader, decoder: TextDecoder }}
 */
export async function openUpstreamStream(upstream, abortSignal, label = 'Upstream') {
  let upstreamRes
  try {
    upstreamRes = await safeUpstreamFetch(upstream.url, {
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
    throw new Error(`${label} error: ${upstreamRes.status} ${text.slice(0, 1500)}`)
  }
  return { reader: upstreamRes.body.getReader(), decoder: new TextDecoder() }
}

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
 * 上下文自动压缩相关常量与工具。
 * 当上下文占用逼近模型窗口上限时，把较早的历史对话压缩成一份极简摘要，
 * 仅保留 system 提示与最近几轮，避免超出上下文窗口（与主流 agent 工具行为一致）。
 */
const CONTEXT_COMPRESS_THRESHOLD = 0.8 // 占用 ≥ 80% 触发压缩
const CONTEXT_COMPRESS_KEEP_RECENT = 2 // 至少保留最近 2 个 user 轮次（含其后的 assistant/tool 交换）不压缩

/**
 * 粗略估算单条消息内容的 token 数（无 tokenizer 依赖）。
 * 中文按 ~1.6 字符/token，英文/符号按 ~4 字符/token；图片按固定开销估算。
 */
function estimateTokensOfContent(content) {
  if (!content) return 0
  if (typeof content === 'string') {
    const cjk = (content.match(/[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/g) || []).length
    const latin = content.length - cjk
    return Math.ceil(cjk / 1.6 + latin / 4)
  }
  if (Array.isArray(content)) {
    let t = 0
    for (const part of content) {
      if (part.type === 'text') t += estimateTokensOfContent(part.text || '')
      else if (part.type === 'image_url') t += 800 // 一张截图粗略估算
      else t += 50
    }
    return t
  }
  return 0
}

/** 估算整段 messages 的 token 数（含每条消息的结构开销）。 */
function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0
  let t = 0
  for (const m of messages) t += estimateTokensOfContent(m.content)
  return t + messages.length * 4
}

/**
 * 把较早的对话历史压缩为一份极简中文摘要，返回替换后的 messages。
 * - system 提示原样保留；
 * - 最近若干 user 轮次及其之后的所有消息原样保留（保证 tool_calls/tool 配对完整、不丢失最新请求）；
 * - 二者之间的较早历史交给模型压缩成摘要，并合并进 tail 的第一条 user 消息（避免 Anthropic 连续同角色报错）。
 * @returns {{ messages: Array, removed: number, summaryTokens: number, estimatedTokens: number }|null}
 */
async function compressConversationHistory(messages, opts) {
  const { providerRow, apiKey, userId, abortSignal, role, conversationId } = opts
  const systemIdx = messages.findIndex((m) => m.role === 'system')
  const systemMsg = systemIdx >= 0 ? messages[systemIdx] : null
  const rest = systemIdx >= 0 ? messages.slice(systemIdx + 1) : messages.slice()
  if (rest.length < 6) return null // 历史过短，不值得压缩

  // 收集所有 user 消息位置，至少保留最近 CONTEXT_COMPRESS_KEEP_RECENT 个 user 轮次
  const userPositions = []
  for (let i = 0; i < rest.length; i++) if (rest[i].role === 'user') userPositions.push(i)
  if (userPositions.length === 0) return null
  const keepFrom = userPositions[Math.max(0, userPositions.length - CONTEXT_COMPRESS_KEEP_RECENT)]
  const tail = rest.slice(keepFrom)
  const toSummarize = rest.slice(0, keepFrom)
  if (toSummarize.length < 2) return null

  const transcript = toSummarize
    .map((m) => {
      let txt = ''
      if (typeof m.content === 'string') txt = m.content
      else if (Array.isArray(m.content)) txt = m.content.map((p) => (p.type === 'text' ? p.text : p.type === 'image_url' ? '[图片]' : '')).join('')
      const label = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role === 'tool' ? '工具结果' : m.role
      return `【${label}】\n${txt}`
    })
    .join('\n\n')

  const summarySystem = '你是一个对话历史压缩器。请把给定的较早对话记录压缩为一份极简的中文结构化摘要，只保留关键事实、用户意图、已完成的操作、重要结论与待办，删除寒暄与冗余。用要点列表输出，不超过 500 字。只输出摘要正文，不要任何前缀或解释。'
  let summary = ''
  try {
    const r = await runChatLoop({
      messages: [
        { role: 'system', content: summarySystem },
        { role: 'user', content: `=== 需要压缩的较早对话 ===\n${transcript}` },
      ],
      // 注意：runChatLoop 始终走流式解析（openUpstreamStream 固定按 SSE 读取），
      // 因此不要传 stream:false（否则上游返回单条 JSON，SSE 解析器拿不到 content）。
      options: { temperature: 0, max_tokens: 700 },
      providerRow,
      apiKey,
      tools: [],
      userId,
      role: role || 'user',
      sendDelta: () => {},
      abortSignal,
      maxRounds: 1,
      allowCompress: false,
    })
    summary = typeof r.finalContent === 'string' ? r.finalContent.trim() : ''
  } catch (e) {
    logger.warn('[AI] context auto-compress summarization failed:', e.message)
    return null
  }
  if (!summary) return null
  // 持久化摘要到 ai_messages，让下次进入对话时仍能"无感延续记忆"
  if (conversationId) {
    try {
      await persistContextSummary(
        conversationId,
        `【历史对话压缩摘要 · 时间 ${new Date().toISOString()}】\n${summary}`,
      )
    } catch (e) {
      logger.warn('[AI] persistContextSummary skipped:', e.message)
    }
  }

  const note = `【历史对话压缩摘要】以下为较早对话的压缩要点（完整原文已不再保留）：\n${summary}`
  // 合并进 tail 的第一条 user 消息，避免连续 user 消息（兼容 Anthropic 交替规则）
  const newTail = tail.slice()
  if (newTail.length && newTail[0].role === 'user') {
    const first = newTail[0]
    if (typeof first.content === 'string') {
      newTail[0] = { ...first, content: `${note}\n\n${first.content}` }
    } else if (Array.isArray(first.content)) {
      newTail[0] = { ...first, content: [{ type: 'text', text: note }, ...first.content] }
    } else {
      newTail.unshift({ role: 'user', content: note })
    }
  } else {
    newTail.unshift({ role: 'user', content: note })
  }
  const newMessages = []
  if (systemMsg) newMessages.push(systemMsg)
  newMessages.push(...newTail)
  return {
    messages: newMessages,
    removed: toSummarize.length,
    summaryTokens: estimateTokensOfContent(note),
    estimatedTokens: estimateMessagesTokens(newMessages),
  }
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
  allowCompress = true,
  conversationId = null,
}) {
  const preset = getPreset(providerRow.provider)
  let currentMessages = [...messages]
  // 安全网计数器：防止模型“只说要调工具”却不 emit tool_calls 导致任务半途而废
  let continuationRetries = 0
  const MAX_CONTINUATION_RETRIES = 1
  // 上一轮真实 prompt token 数（来自上游 usage）；用于估计当前上下文占用、决定是否压缩。
  let lastPromptTokens = 0

  // ===== 把上一次自动压缩的摘要注入到对话开头（system 之后）=====
  // 实现"无感延续记忆"：之前压缩留下的摘要会持续生效，避免下一轮再次触发压缩
  // （把刚刚写入的摘要再压缩一次），也避免用户感觉 AI "忘了"先前的上下文。
  const priorSummary = await fetchLatestContextSummary(conversationId)
  if (priorSummary) {
    const anchorIndex = currentMessages.findIndex((m) => m.role === 'system')
    const note = `【先前对话要点摘要（来自自动压缩，请把它当作历史延续记忆，不再重新压缩）】\n${priorSummary}`
    const summaryMsg = { role: 'system', content: note }
    if (anchorIndex >= 0) currentMessages.splice(anchorIndex + 1, 0, summaryMsg)
    else currentMessages.unshift(summaryMsg)
  }

  // ===== 异步自动压缩状态 =====
  // 上下文超限时，压缩在后台进行（不阻塞当前流式输出，用户任务"无感"继续，类似 WorkBuddy）；
  // 压缩完成后，把压缩后的 messages 应用到后续轮次。
  let compressInFlight = false
  let compressResult = null // { messages, estimatedTokens, removed, summaryTokens }

  for (let round = 0; round < maxRounds; round++) {
    // 若上一轮触发的后台压缩已完成，则应用压缩结果（缩小上下文继续后续轮次）
    if (compressResult) {
      currentMessages = compressResult.messages
      lastPromptTokens = compressResult.estimatedTokens
      compressResult = null
    }
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

    // ===== 上下文自动压缩门控（异步，不阻塞当前任务）=====
    // 当估计占用 ≥ 上下文窗口的 CONTEXT_COMPRESS_THRESHOLD 时，把较早历史压缩成摘要，
    // 仅保留 system 与最近几轮（与主流 agent 工具行为一致）。优先用上一轮真实 prompt_tokens
    // 估计；首轮用内容估算兜底。
    //
    // 关键行为：压缩在后台异步执行（不 await），当前轮次继续按原 messages 流式输出，
    // 用户任务"无感"继续；压缩完成后把结果应用到后续轮次（见 for 循环开头）。
    if (allowCompress !== false && !compressInFlight) {
      const ctxWindow = getContextWindow(providerRow.model, providerRow.context_window)
      const estTokens = lastPromptTokens > 0 ? lastPromptTokens : estimateMessagesTokens(currentMessages)
      // 已经注入的前置摘要视作"已压缩"状态，不再次触发压缩（避免重复摘要）
      const hasPriorSummary = currentMessages.some(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('先前对话要点摘要（来自自动压缩'),
      )
      if (estTokens > Math.floor(ctxWindow * CONTEXT_COMPRESS_THRESHOLD) && !hasPriorSummary) {
        compressInFlight = true
        // 通知前端显示"上下文压缩中"过渡提示（分割线 + 扫光动画）
        if (sendDelta) {
          sendDelta({
            meta: {
              type: 'context_compress_started',
              beforeTokens: estTokens,
              contextWindow: ctxWindow,
              percentBefore: Math.round((estTokens / ctxWindow) * 100),
            },
          })
        }
        // 快照当前 messages（避免压缩期间 currentMessages 被工具结果继续追加导致数据错乱）
        const snapshot = currentMessages.map((m) => ({ ...m, tool_calls: m.tool_calls ? [...m.tool_calls] : m.tool_calls }))
        // 后台执行：不 await，任务继续流式输出
        compressConversationHistory(snapshot, {
          providerRow, apiKey, userId, abortSignal, role, conversationId,
        })
          .then((res) => {
            compressInFlight = false
            if (res) {
              compressResult = res
              if (sendDelta) {
                sendDelta({
                  meta: {
                    type: 'context_compressed',
                    removedMessages: res.removed,
                    summaryTokens: res.summaryTokens,
                    beforeTokens: estTokens,
                    afterTokens: res.estimatedTokens,
                    contextWindow: ctxWindow,
                    percentBefore: Math.round((estTokens / ctxWindow) * 100),
                  },
                })
              }
            }
          })
          .catch((e) => {
            compressInFlight = false
            logger.warn('[AI] context auto-compress skipped:', e.message)
          })
      }
    }

    const upstream = buildUpstreamChat({
      provider: providerRow.provider,
      baseUrl: providerRow.base_url,
      model: providerRow.model,
      apiKey,
      messages: currentMessages,
      options: chatOptions,
    })

    const { reader, decoder } = await openUpstreamStream(upstream, abortSignal, 'Upstream')

    // 流式发送 thinking 和 content，同时收集 tool_calls
    const response = await collectToolCallsFromStream(reader, decoder, sendDelta, logChunk)

    // 下发 token 用量元信息（前端圆环展示上下文占用百分比）。
    // 取本轮 usage 的最新值；前端保留「最近一次」调用，即最能代表当前上下文大小的数值。
    if (response.usage) {
      const ctxWindow = getContextWindow(providerRow.model, providerRow.context_window)
      const u = response.usage
      const promptTokens = u.prompt_tokens || 0
      lastPromptTokens = promptTokens // 记录真实 prompt token，供下一轮压缩估计使用
      const completionTokens = u.completion_tokens || 0
      const cacheReadTokens = u.prompt_tokens_details?.cached_tokens || u.prompt_tokens_details?.cache_read_tokens || 0
      const cacheWriteTokens = u.prompt_tokens_details?.cache_written_tokens || u.prompt_tokens_details?.cache_write_tokens || 0
      const thinkingTokens = u.completion_tokens_details?.reasoning_tokens || 0
      sendDelta({
        meta: {
          type: 'usage',
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: u.total_tokens || promptTokens + completionTokens,
            contextWindow: ctxWindow,
            // 缓存命中/写入：OpenAI 兼容协议的 prompt_tokens_details。
            cacheReadTokens,
            cacheWriteTokens,
            thinkingTokens,
            replyTokens: Math.max(0, completionTokens - thinkingTokens),
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
