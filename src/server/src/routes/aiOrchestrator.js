/**
 * 多代理并行编排（跨轮次 / 子代理）。
 *
 * 流程：
 *   1) Coordinator：一次模型调用，同时挂 dispatch_agents + 业务工具（tool_choice=auto）。
 *      - 若模型调用 dispatch_agents → 解析出 2~4 个独立子代理计划，走并行子代理。
 *      - 若任务是单一连贯任务 → 协调器直接调业务工具取数并流式给出最终回答（主气泡），
 *        单次请求内自闭环，无需再跑一次单代理循环（#1 修复：原实现每个单任务都被迫
 *        额外调用一次单代理，延迟与 token 接近翻倍）。
 *   2) Workers：Promise.allSettled 并行跑 N 个独立子代理；每个子代理自带多轮工具循环，
 *      但只配发【只读】工具，写入类操作（收藏/删除/记忆/工作流）一律不在子代理层发生。
 *   3) Synthesis：一次模型调用，把各子代理结论融合成最终回答（无工具，物理禁用）。
 *
 * 并发安全：写入类工具只在协调器（串行）执行，子代理只读 → 无并发写竞争。
 * 失败隔离：单个子代理失败不影响其他，综合阶段会标注该部分不可用。
 *
 * 已知边界（v1）：Anthropic 协议族在 buildUpstreamChat 中不下发 tools，因此协调器在该
 * 类供应商下收不到 dispatch_agents，会自动降级为单代理直答（等价于短路）。
 */
import { buildUpstreamChat, getPreset, getContextWindow } from '../utils/aiProviders.js'
import { logger } from '../utils/logger.js'
import { collectToolCallsFromStream, collectToolCallsFromResponsesStream, collectToolCallsFromAnthropicStream, handleToolCalls } from './aiStream.js'
import { runChatLoop, openUpstreamStream, looksLikeToolIntent } from './aiChatCore.js'
import { TOOLS, getWorkerTools } from './aiTools.js'
import { getToolsForRole } from '../utils/aiSystemPrompt.js'

const MAX_AGENTS = 4
// 工单 A12：子代理注入的主对话历史上限（含其后的 tool 结果配对完整）
const WORKER_MAX_HISTORY_MESSAGES = 20

/**
 * 工单 A12：子代理上下文裁剪。
 * worker 只注入最近 N 条历史（N=WORKER_MAX_HISTORY_MESSAGES），不再复制全量对话：
 * - 剔除主对话的 system 消息（子代理只用自己的 WORKER_SYSTEM，避免提示词重复注入）；
 * - 裁剪起点向后滚动跳过头部孤儿 tool 结果（协议要求 tool 消息必须紧跟带 tool_calls 的 assistant），
 *   保证窗口内 assistant.tool_calls ↔ tool 结果配对完整；
 * - 图片 base64 等大头载荷随早期消息一起被裁掉，显著降低并行子代理 token 开销。
 */
function buildWorkerMessages(messages, agent) {
  const history = (Array.isArray(messages) ? messages : []).filter((m) => m && m.role !== 'system')
  let start = Math.max(0, history.length - WORKER_MAX_HISTORY_MESSAGES)
  while (start < history.length && history[start].role === 'tool') start++
  return [{ role: 'system', content: WORKER_SYSTEM(agent) }, ...history.slice(start)]
}

// 协调器专用规划工具（唯一被允许触发的"元工具"）
const DISPATCH_AGENTS_TOOL = {
  type: 'function',
  function: {
    name: 'dispatch_agents',
    description: '将复杂请求拆解为多个彼此独立、无依赖的子任务，调度多个子代理并行执行。仅当任务可自然分治时使用（例如既要查收藏夹、又要查设备、又要查统计，且互不依赖）。如果任务本身是单一连贯任务或各子任务强依赖，不要调用此工具，直接回答即可。',
    parameters: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          description: '子代理列表，2~4 个',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '子代理唯一标识，英文小写数字下划线，如 research_agent' },
              name: { type: 'string', description: '人类可读名称，如「收藏夹调研」' },
              objective: { type: 'string', description: '该子代理要独立完成的具体目标' },
              focus_tools: {
                type: 'array',
                items: { type: 'string' },
                description: '可选：建议优先使用的工具名',
              },
            },
            required: ['id', 'name', 'objective'],
          },
        },
      },
      required: ['agents'],
    },
  },
}

const COORDINATOR_SYSTEM = `你是 ClipSync 的任务编排协调器（Coordinator）。

## 决策原则

1. 【默认直答】绝大多数问题直接回答；单一查询、深度推理、单问句一律不派发子代理，直接用业务工具完成。
2. 【派发条件】仅当用户明确要求"同时"处理多个互不依赖的事项、且单一任务无法一次工具调用完成时，调用 dispatch_agents（2~4 个子代理）。派发后停止，不再作答。子代理只有只读工具；写入操作由你（协调器）随后统一执行。
3. 【需要用户选择时 → ask_user】删除目标、方案二选一、多候选项决策：先用查询工具（get_collections / search_clips 等）拿到真实候选列表，紧接着【立即调用 ask_user】发起界面选择卡片（options 传候选数组，如 ["只删除 test2.1", "只删除 test2.2", "全部删除", "取消"]）。绝不在纯文本中罗列选项或写"请选择"后停止——纯文本不会生成卡片，卡片唯一由 ask_user tool_call 触发。用户的选择会作为工具结果返回给你，据此继续执行。

## 去伪存真

- 回答必须且只能基于工具返回的真实数据；工具未返回的数据明确说"暂不可用"，不编造、不推测不存在的 ID/文件名/数值。`

const WORKER_SYSTEM = (agent) => `你是一个并行子代理「${agent.name}」。
你的专属目标：${agent.objective}
你只能使用【只读】工具（查询/搜索/读取），严禁调用任何写入类工具。

【去伪存真 · 强制要求】
- 你的结论必须且只能基于工具返回的真实数据。未通过工具获取的信息，绝不在结论中呈现为事实。
- 如果工具未返回某项数据，明确标注"数据不可用"，而非编造内容。
- 不要推测不存在的文件名、ID、数值或其他具体细节。宁可说"不确定"也不要说错。

请基于上下文独立完成任务，给出简洁、自包含的结论。不要尝试协调其他子代理。`

const SYNTHESIS_SYSTEM = `你是一个结果综合器（Synthesis）。
下面是一组并行子代理各自独立完成的结论。请把它们融合成一份连贯、完整、面向用户的回答。
要求：
- 去重、消除矛盾、按逻辑组织；
- 不要逐字复述每个子代理，而是提炼要点；
- 不要暴露"子代理"之类的内部实现词，自然呈现结论；
- 如某个子代理失败（标记为 FAILED），在回答中说明该部分不可用即可；
- 【去伪存真】：只综合子代理基于工具返回的真实数据得出的结论。如果某个子代理的结论中包含"未查到""不确定""数据不可用"等表述，保留这些不确定性，不要自行补充或美化。不得添加子代理未提供的信息。
你没有任何工具，直接输出最终回答。`

/**
 * 协调器：单任务自闭环 / 多任务委派。
 * - 同时挂 dispatch_agents + 业务工具（按角色过滤后的完整工具集）。
 * - 单任务：直接调业务工具取数并流式给出最终回答（主气泡），单次请求内自闭环。
 * - 多任务：调用 dispatch_agents 返回计划，由 runOrchestration 走并行子代理。
 * 增量直接透传到主气泡（agentId=null）；dispatch_agents 元工具调用被过滤，不向用户暴露。
 */
async function runCoordinator({ messages, providerRow, apiKey, userId, role, req, abortSignal, sendDelta, logChunk, thinkingEnabled, thinkingStrength, businessTools }) {
  const preset = getPreset(providerRow.provider)
  const coMessages = [{ role: 'system', content: COORDINATOR_SYSTEM }, ...messages]
  const tools = [DISPATCH_AGENTS_TOOL, ...businessTools]
  let currentMessages = coMessages
  // 安全网计数器：防止协调器模型"只说要调工具"却不 emit tool_calls。
  // 阶梯与 runChatLoop 对齐：0 次 tool_choice=auto → 1 次 auto + system 提醒 → ≥2 次 required 强制工具调用。
  let continuationRetries = 0
  const MAX_CONTINUATION_RETRIES = 2

  // 透传增量到主气泡，但隐藏 dispatch_agents 元工具（内部规划调用，不应呈现给用户）
  const wrappedSend = (obj) => {
    const d = obj?.choices?.[0]?.delta
    if (!d) {
      sendDelta(obj)
      return
    }
    if (d.tool_call && d.tool_call.name === 'dispatch_agents') return
    // A11：混发推迟时为 dispatch 合成的"deferred"工具结果只回注模型，不下发前端时间线
    if (d.tool_result && d.tool_result.name === 'dispatch_agents') return
    sendDelta(obj)
  }

  const family = preset?.provider === 'custom'
    ? (providerRow.api_format === 'anthropic' ? 'anthropic' : providerRow.api_format === 'responses' ? 'responses' : 'openai')
    : (preset?.family || 'openai')

  for (let round = 0; round < 5; round++) {
    const chatOptions = {
      tools,
      tool_choice: continuationRetries >= 2 ? (family === 'anthropic' ? 'any' : 'required') : 'auto',
    }
    // 思考支持：与 runChatLoop 对齐，仅 Anthropic 协议需显式 thinking 参数
    if (thinkingEnabled && preset?.family === 'anthropic') {
      chatOptions.thinking = true
      chatOptions.thinkingStrength = thinkingStrength
      chatOptions.thinkingBudget = thinkingStrength === 'low' ? 1024 : thinkingStrength === 'high' ? 8192 : 4096
    }

    logger.info('[AI][orchestrator] tools count:', tools.length, 'continuationRetries:', continuationRetries, 'tool_choice:', chatOptions.tool_choice)
    const upstream = buildUpstreamChat({
      provider: providerRow.provider,
      baseUrl: providerRow.base_url,
      model: providerRow.model,
      apiKey,
      messages: currentMessages,
      options: chatOptions,
      apiFormat: providerRow.api_format,
    })
    const { reader, decoder, cleanup: releaseRound } = await openUpstreamStream(upstream, abortSignal, 'Coordinator')
    logger.info('[AI][orchestrator] coordinator upstream family:', family, 'provider:', providerRow.provider, 'api_format:', providerRow.api_format)
    let resp
    try {
      resp = family === 'responses'
        ? await collectToolCallsFromResponsesStream(reader, decoder, wrappedSend, logChunk)
        : family === 'anthropic'
          ? await collectToolCallsFromAnthropicStream(reader, decoder, wrappedSend, logChunk)
          : await collectToolCallsFromStream(reader, decoder, wrappedSend, logChunk)
    } finally {
      // 读完本轮流后立即释放 per-call 定时器：等待用户确认的间隙不计入超时
      if (typeof releaseRound === 'function') releaseRound()
    }

    // 下发 token 用量元信息（与 runChatLoop 同格式），由编排层聚合后统一下发，保持主气泡圆环更新
    if (resp.usage) {
      const ctxWindow = getContextWindow(providerRow.model, providerRow.context_window)
      const u = resp.usage
      const promptTokens = u.prompt_tokens || 0
      const completionTokens = u.completion_tokens || 0
      const cacheReadTokens = u.prompt_tokens_details?.cached_tokens || u.prompt_tokens_details?.cache_read_tokens || 0
      const cacheWriteTokens = u.prompt_tokens_details?.cache_written_tokens || u.prompt_tokens_details?.cache_write_tokens || 0
      const thinkingTokens = u.completion_tokens_details?.reasoning_tokens || 0
      wrappedSend({
        meta: {
          type: 'usage',
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: u.total_tokens || promptTokens + completionTokens,
            contextWindow: ctxWindow,
            cacheReadTokens,
            cacheWriteTokens,
            thinkingTokens,
            replyTokens: Math.max(0, completionTokens - thinkingTokens),
          },
        },
      })
    }

    // ===== 触发多任务委派（工单 A11：混发丢弃修复）=====
    const dispatch = resp.toolCalls.find((tc) => tc.function?.name === 'dispatch_agents')
    const businessCalls = resp.toolCalls.filter((tc) => tc.function?.name !== 'dispatch_agents')

    if (dispatch && businessCalls.length === 0) {
      // 纯 dispatch：解析计划，交由编排层走并行子代理
      return { isDispatch: true, dispatchArgs: dispatch.function.arguments || '{}', content: resp.content }
    }

    if (dispatch && businessCalls.length > 0) {
      // 同轮混发（dispatch_agents + 业务工具）：旧实现直接取 dispatch 计划，业务工具调用被
      // 静默丢弃。修复：先执行业务工具并回填结果；dispatch 计划推迟到下一轮重新判断——
      // 为 dispatch 的 tool_call 合成一条"deferred"结果回注模型，维持协议 tool_calls↔result 配对，
      // 让模型消化业务工具结果后自行决定是否再单独发起 dispatch。
      logger.info('[AI][orchestrator] mixed dispatch deferred: business tools execute first, dispatch decision postponed',
        'business:', businessCalls.map((t) => t.function?.name).join(','))
      currentMessages.push({
        role: 'assistant',
        content: resp.content || '',
        tool_calls: resp.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      })
      const toolResults = await handleToolCalls(businessCalls, userId, wrappedSend, null, role, { abortSignal, req })
      toolResults.push({
        role: 'tool',
        tool_call_id: dispatch.id,
        content: JSON.stringify({
          deferred: true,
          reason: 'dispatch_agents 与其他业务工具调用出现在同一轮。本轮业务工具已执行、其结果已在上方 tool 结果中返回。请先消化这些结果再重新判断：确需拆分多个独立子任务时，请单独再次调用 dispatch_agents；否则直接回答用户。',
        }),
      })
      currentMessages.push(...toolResults)
      if (abortSignal?.aborted) {
        logger.info('[AI][orchestrator] stream aborted, stopping coordinator loop')
        return { isDispatch: false, dispatchArgs: '', content: '' }
      }
      continue
    }

    // 有业务工具调用：走统一执行管线后继续下一轮（单任务自闭环）。
    // 管线保证 tool_call 先于执行下发（ask_user 卡片/时间线依赖该时序），结果收敛后发 tool_result。
    if (resp.toolCalls.length > 0) {
      currentMessages.push({
        role: 'assistant',
        content: resp.content || '',
        tool_calls: resp.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      })
      const toolResults = await handleToolCalls(resp.toolCalls, userId, wrappedSend, null, role, { abortSignal, req })
      currentMessages.push(...toolResults)
      if (abortSignal?.aborted) {
        logger.info('[AI][orchestrator] stream aborted, stopping coordinator loop')
        return { isDispatch: false, dispatchArgs: '', content: '' }
      }
      continue
    }

    // 安全网：协调器模型写了"我要调用 X"但没有输出 tool_calls，或只有思考过程却未输出正文/工具
    const contentHasIntent = looksLikeToolIntent(resp.content)
    const thinkingHasIntent = looksLikeToolIntent(resp.thinking || '')
    const emptyContentAfterThinking = Boolean(resp.thinking && (!resp.content || !resp.content.trim()) && resp.toolCalls.length === 0)
    if (
      continuationRetries < MAX_CONTINUATION_RETRIES &&
      (contentHasIntent || thinkingHasIntent || emptyContentAfterThinking)
    ) {
      logger.info('[AI][orchestrator] safety net triggered: tool intent or empty content after thinking.',
        'content_has_intent:', contentHasIntent,
        'thinking_has_intent:', thinkingHasIntent,
        'emptyContentAfterThinking:', emptyContentAfterThinking,
        'content_snippet:', (resp.content || '').substring(0, 100),
        'thinking_snippet:', (resp.thinking || '').substring(0, 100))
      continuationRetries++
      if (resp.content) {
        currentMessages.push({ role: 'assistant', content: resp.content || '' })
      }
      currentMessages.push({
        role: 'system',
        content: '你刚才在思考中准备调用工具，但尚未输出 tool_calls。请立即输出你的 tool_calls（例如 ask_user）！严禁只输出思考过程而不发出工具调用。',
      })
      continue
    }

    // 无 tool calls：最终回答
    return { isDispatch: false, dispatchArgs: '', content: resp.content }
  }

  return { isDispatch: false, dispatchArgs: '', content: '' }
}

/**
 * 并行执行所有子代理（Promise.allSettled 隔离失败）。
 * @returns {Promise<Array<{id,name,objective,tools,status,content,error?,duration?}>>}
 */
async function runWorkers({ agents, messages, providerRow, apiKey, userId, role = 'user', abortSignal, sendDelta, logChunk, thinkingEnabled, thinkingStrength }) {
  // ✅ RBAC（#214）：子代理只配发按角色过滤后的只读工具，且剔除 UI 阻塞型门控工具
  //（ask_user 卡片只挂在主消息上，子代理调用会形成"等待永不出现的卡片"死锁）
  const scopedReadonly = getWorkerTools(role)
  const promises = agents.map((agent) => {
    // 每个子代理独立的 AbortController，根超时时一并中止
    const workerAbort = new AbortController()
    const onRoot = () => workerAbort.abort()
    abortSignal.addEventListener('abort', onRoot)

    // 记录执行开始时间
    const startedAt = Date.now()

    // 给该子代理的所有增量打上 agent_id（已带 agent_id / agent 生命周期事件的跳过）
    const wrappedSendBase = (obj) => {
      const d = obj?.choices?.[0]?.delta
      if (d && !d.agent_id && !d.agent) d.agent_id = agent.id
      sendDelta(obj)
    }

    const runAttempt = (attemptSend) =>
      runChatLoop({
        messages: buildWorkerMessages(messages, agent), // 工单 A12：只注入最近 N 条 + 自身 system
        options: {},
        providerRow,
        apiKey,
        tools: scopedReadonly,
        role,
        userId,
        sendDelta: attemptSend,
        logChunk,
        agentId: agent.id,
        abortSignal: workerAbort.signal,
        maxRounds: 4,
        // #4：子代理继承主对话思考设置（Anthropic 协议下真正生效），默认关闭时行为不变
        thinkingEnabled,
        thinkingStrength,
      })

    // 工单 A10：每次尝试独立计数——记录该次尝试向下发了多少条增量。
    // 只有"未向用户下发任何内容"的失败才允许重试，否则重试会把已流式输出的
    // 内容/工具时间线重复输出一遍。
    let currentAttempt = null
    const beginAttempt = () => {
      let deltaCount = 0
      const send = (obj) => {
        deltaCount++
        wrappedSendBase(obj)
      }
      currentAttempt = { getDeltaCount: () => deltaCount }
      return send
    }

    const settleDone = (r) => {
      const duration = Date.now() - startedAt
      sendDelta({
        choices: [{ delta: { agent: { id: agent.id, name: agent.name, objective: agent.objective, status: 'done', kind: 'worker', duration } } }],
      })
      return { id: agent.id, name: agent.name, objective: agent.objective, tools: [], status: 'done', content: r.finalContent, duration }
    }

    const settleFailed = (err) => {
      const duration = Date.now() - startedAt
      const msg = String(err?.message || err)
      sendDelta({
        choices: [{ delta: { agent: { id: agent.id, name: agent.name, objective: agent.objective, status: 'failed', kind: 'worker', error: msg, duration } } }],
      })
      return { id: agent.id, name: agent.name, objective: agent.objective, tools: [], status: 'failed', content: '', error: msg, duration }
    }

    sendDelta({
      choices: [{ delta: { agent: { id: agent.id, name: agent.name, objective: agent.objective, status: 'working', kind: 'worker' } } }],
    })

    return runAttempt(beginAttempt())
      .then(settleDone)
      .catch((err) => {
        // 工单 A10：子代理重试修正——
        //   ① abortSignal 已中止 → 绝不重试（重试会顶着已取消的流继续烧上游 token）；
        //   ② 首轮已下发过任何内容 → 不重试（避免重复输出）；
        // 仅当首轮完全没发出任何增量时才有限重试一次。
        const aborted = abortSignal.aborted || workerAbort.signal.aborted
        const delivered = (currentAttempt?.getDeltaCount() ?? 0) > 0
        if (aborted) {
          logger.warn(`[AI][orchestrator] worker ${agent.id} aborted; not retrying`)
          return settleFailed(err)
        }
        if (delivered) {
          logger.warn(`[AI][orchestrator] worker ${agent.id} failed after streaming ${currentAttempt.getDeltaCount()} deltas; not retrying:`, err.message)
          return settleFailed(err)
        }
        logger.warn(`[AI][orchestrator] worker ${agent.id} failed with no delivered content, retrying once:`, err.message)
        return runAttempt(beginAttempt())
          .then(settleDone)
          .catch(settleFailed)
      })
      .finally(() => {
        abortSignal.removeEventListener('abort', onRoot)
      })
  })

  const settled = await Promise.allSettled(promises)
  return settled.map((s) => s.value || { status: 'failed', content: '', error: 'unknown' })
}

/**
 * 综合阶段：把各子代理结论融合成最终回答（无工具，主气泡）。
 */
async function runSynthesis({ messages, workerResults, providerRow, apiKey, userId, abortSignal, sendDelta, logChunk }) {
  const summary = workerResults
    .map((r) => {
      if (r.status === 'failed') return `## ${r.name}\n[FAILED] ${r.error || '子代理执行失败'}`
      return `## ${r.name}\n${r.content || '(无结论)'}`
    })
    .join('\n\n')

  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const userReq = typeof lastUser?.content === 'string' ? lastUser.content : ''
  const synthUser = `用户原始请求：\n${userReq}\n\n=== 各并行子代理的结论 ===\n${summary}\n\n请综合以上结论，给出最终回答。`

  // #3：综合阶段只注入系统提示 + 用户原始请求 + 子代理结论（synthUser 已内含），
  // 不再重复塞入完整对话历史，避免长对话 + 多子代理长结论叠加导致超上下文窗口。
  const synthMessages = [
    { role: 'system', content: SYNTHESIS_SYSTEM },
    { role: 'user', content: synthUser },
  ]

  await runChatLoop({
    messages: synthMessages,
    options: {},
    providerRow,
    apiKey,
    tools: [], // 物理禁用工具
    userId,
    sendDelta,
    logChunk,
    agentId: null,
    abortSignal,
    maxRounds: 3,
    thinkingEnabled: false,
    thinkingStrength: 'medium',
  })
}

/**
 * 编排入口（由 aiChat.js 在 Agent 模式下调用，由协调器模型自行决定是否派发子代理）。
 * 负责协调器/子代理/综合三阶段，并在结束时调用 safeFinish。
 */
export async function runOrchestration({
  messages,
  options,
  providerRow,
  apiKey,
  userId,
  role = 'user',
  req,
  sendDelta,
  logChunk,
  safeFinish,
  abortSignal,
  thinkingEnabled,
  thinkingStrength,
}) {
  // ✅ RBAC（#214）：按角色过滤下发给各阶段的工具集
  // （子代理工具集在 runWorkers 内经 getWorkerTools 二次收敛，剔除 ask_user 等阻塞型工具）
  const scopedTools = getToolsForRole(role, TOOLS)

  // #7：编排层聚合 usage（取上下文峰值），避免多 agent 各自下发 token 用量导致前端圆环抖动。
  // 所有 usage 元信息在此拦截，safeFinish 前统一下发一次。
  let aggregatedUsage = null
  const sendDeltaWrapped = (obj) => {
    const meta = obj?.meta
    if (meta?.type === 'usage' && meta.usage) {
      const u = meta.usage
      if (!aggregatedUsage || (u.totalTokens || 0) > (aggregatedUsage.totalTokens || 0)) aggregatedUsage = u
      return
    }

    const delta = obj?.choices?.delta || obj?.choices?.[0]?.delta
    // 过滤协调器和综合的生命周期事件（planning/done/failed等内部概念）
    // 但保留工具调用(content/tool_call/tool_result)给用户看
    if (delta?.agent?.kind === 'coordinator' || delta?.agent?.kind === 'synthesis') {
      // 只过滤纯生命周期事件，不过滤工具调用和内容
      if (!delta?.content && !delta?.tool_call && !delta?.tool_result && !delta?.thinking) {
        return
      }
    }
    sendDelta(obj)
  }
  const flushUsage = () => {
    if (aggregatedUsage) {
      try {
        sendDelta({ meta: { type: 'usage', usage: aggregatedUsage } })
      } catch {
        /* ignore */
      }
    }
  }

  // —— 阶段一：协调器 ——
  // 注意：协调器事件已被 sendDeltaWrapped 过滤，不会发送到前端

  let coordinator
  try {
    coordinator = await runCoordinator({
      messages,
      providerRow,
      apiKey,
      userId,
      role,
      req,
      abortSignal,
      sendDelta: sendDeltaWrapped,
      logChunk,
      thinkingEnabled,
      thinkingStrength,
      businessTools: scopedTools,
    })
  } catch (e) {
    // 协调器失败：降级为单代理直答（完整工具集）
    const causeInfo = e?.cause ? { code: e.cause.code, message: e.cause.message, syscall: e.cause.syscall } : null
    logger.warn('[AI][orchestrator] coordinator failed, fallback to single chat:', e.message, '| cause:', causeInfo)
    await runChatLoop({
      messages, options, providerRow, apiKey, tools: scopedTools, role, userId,
      sendDelta: sendDeltaWrapped, logChunk, agentId: null, abortSignal, maxRounds: 5, thinkingEnabled, thinkingStrength,
    })
    flushUsage()
    safeFinish()
    return
  }

  // #1：单任务已在协调器内自闭环（runCoordinator 已流式下发主气泡回答），无需再跑单代理循环。
  if (!coordinator.isDispatch) {
    flushUsage()
    safeFinish()
    return
  }

  // 解析计划
  let plan = {}
  try {
    plan = JSON.parse(coordinator.dispatchArgs || '{}')
  } catch {
    /* ignore */
  }
  let agents = Array.isArray(plan.agents) ? plan.agents : []
  agents = agents
    .filter((a) => a && a.id && a.name && a.objective)
    .map((a) => ({
      id: String(a.id).replace(/[^a-zA-Z0-9_-]/g, '_'),
      name: String(a.name),
      objective: String(a.objective),
    }))
    .filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i) // 去重 id
    .slice(0, MAX_AGENTS)

  if (agents.length === 0) {
    // 协调器调用了 dispatch_agents 但解析不出合法子代理 → 同样降级为单代理直答
    await runChatLoop({
      messages, options, providerRow, apiKey, tools: scopedTools, role, userId,
      sendDelta: sendDeltaWrapped, logChunk, agentId: null, abortSignal, maxRounds: 5, thinkingEnabled, thinkingStrength,
    })
    flushUsage()
    safeFinish()
    return
  }

  logger.info(`[AI][orchestrator] dispatching ${agents.length} agents: ${agents.map((a) => a.id).join(', ')}`)

  // —— 阶段二：并行子代理 ——
  const workerResults = await runWorkers({
    agents, messages, providerRow, apiKey, userId, role, abortSignal, sendDelta: sendDeltaWrapped, logChunk, thinkingEnabled, thinkingStrength,
  })

  // —— 阶段三：综合 ——
  // 注意：综合事件已被 sendDeltaWrapped 过滤，不会发送到前端
  try {
    await runSynthesis({ messages, workerResults, providerRow, apiKey, userId, abortSignal, sendDelta: sendDeltaWrapped, logChunk })
  } catch (e) {
    logger.warn('[AI][orchestrator] synthesis failed, fallback to raw concat:', e.message)
    const fallback = workerResults
      .map((r) => `## ${r.name}\n${r.status === 'failed' ? '[FAILED] ' + (r.error || '') : (r.content || '(无结论)')}`)
      .join('\n\n')
    sendDeltaWrapped({ choices: [{ delta: { content: fallback } }] })
  }
  // #9：去掉脆弱的 setImmediate 补丁——safeFinish 已通过 write 回调 + setNoDelay 保证 DONE 进入 socket 缓冲区，
  // 此处无需再等待 IO tick（反而可能引入不确定行为）。
  flushUsage()
  safeFinish()
}
