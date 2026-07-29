/**
 * 多代理并行编排（跨轮次 / 子代理）。
 *
 * 流程：
 *   1) Coordinator：一次模型调用，仅挂 dispatch_agents 规划工具（tool_choice=auto）。
 *      - 若模型不调用 dispatch_agents（单任务）→ 直接把协调器回答作为最终答案（短路，零额外开销）。
 *      - 若调用 → 解析出 2~4 个独立子代理计划。
 *   2) Workers：Promise.allSettled 并行跑 N 个独立子代理；每个子代理自带多轮工具循环，
 *      但只配发【只读】工具，写入类操作（收藏/删除/记忆/工作流）一律不在子代理层发生。
 *   3) Synthesis：一次模型调用，把各子代理结论融合成最终回答（无工具，物理禁用）。
 *
 * 并发安全：写入类工具只在协调器/综合阶段（串行）执行，子代理只读 → 无并发写竞争。
 * 失败隔离：单个子代理失败不影响其他，综合阶段会标注该部分不可用。
 *
 * 已知边界（v1）：Anthropic 协议族在 buildUpstreamChat 中不下发 tools，因此协调器在该
 * 类供应商下收不到 dispatch_agents，会自动降级为单代理直答（等价于短路）。
 */
import { buildUpstreamChat } from '../utils/aiProviders.js'
import { logger } from '../utils/logger.js'
import { collectToolCallsFromStream } from './aiStream.js'
import { runChatLoop } from './aiChatCore.js'
import { TOOLS, READONLY_TOOLS } from './aiTools.js'

const MAX_AGENTS = 4

// 协调器专用规划工具（唯一被允许触发的“元工具”）
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

const COORDINATOR_SYSTEM = `你是一个任务编排协调器（Coordinator）。
你的唯一职责是：判断用户请求是否可以被拆解为多个彼此独立、无依赖的子任务。
- 如果可以被并行拆解，调用 dispatch_agents 规划 2~4 个子代理并行执行。
- 如果任务本身是一个单一连贯任务（一轮对话、单个工具调用即可完成、或各子任务强依赖），【不要调用 dispatch_agents】，直接给出你的回答即可。
注意：子代理只能使用只读工具；写入类操作（收藏/删除/记忆/工作流）由你（协调器）在最后统一执行。`

const WORKER_SYSTEM = (agent) => `你是一个并行子代理「${agent.name}」。
你的专属目标：${agent.objective}
你只能使用【只读】工具（查询/搜索/读取），严禁调用任何写入类工具。
请基于上下文独立完成任务，给出简洁、自包含的结论。不要尝试协调其他子代理。`

const SYNTHESIS_SYSTEM = `你是一个结果综合器（Synthesis）。
下面是一组并行子代理各自独立完成的结论。请把它们融合成一份连贯、完整、面向用户的回答。
要求：
- 去重、消除矛盾、按逻辑组织；
- 不要逐字复述每个子代理，而是提炼要点；
- 不要暴露“子代理”之类的内部实现词，自然呈现结论；
- 如某个子代理失败（标记为 FAILED），在回答中说明该部分不可用即可。
你没有任何工具，直接输出最终回答。`

/**
 * 协调器单次调用：只挂 dispatch_agents，收集 content + toolCalls（不下发增量）。
 */
async function runCoordinatorCall({ messages, providerRow, apiKey, abortSignal }) {
  const coMessages = [{ role: 'system', content: COORDINATOR_SYSTEM }, ...messages]
  const chatOptions = { tools: [DISPATCH_AGENTS_TOOL], tool_choice: 'auto' }

  const upstream = buildUpstreamChat({
    provider: providerRow.provider,
    baseUrl: providerRow.base_url,
    model: providerRow.model,
    apiKey,
    messages: coMessages,
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
    throw new Error(`Coordinator upstream error: ${upstreamRes.status} ${text.slice(0, 1500)}`)
  }

  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  const noop = () => {}
  const resp = await collectToolCallsFromStream(reader, decoder, noop, noop)
  return { content: resp.content, toolCalls: resp.toolCalls }
}

/**
 * 并行执行所有子代理（Promise.allSettled 隔离失败）。
 * @returns {Promise<Array<{id,name,status,content,error?}>>}
 */
async function runWorkers({ agents, messages, providerRow, apiKey, userId, abortSignal, sendDelta, logChunk }) {
  const promises = agents.map((agent) => {
    // 每个子代理独立的 AbortController，根超时时一并中止
    const workerAbort = new AbortController()
    const onRoot = () => workerAbort.abort()
    abortSignal.addEventListener('abort', onRoot)

    // 给该子代理的所有增量打上 agent_id（已带 agent_id / agent 生命周期事件的跳过）
    const wrappedSend = (obj) => {
      const d = obj?.choices?.[0]?.delta
      if (d && !d.agent_id && !d.agent) d.agent_id = agent.id
      sendDelta(obj)
    }

    sendDelta({
      choices: [{ delta: { agent: { id: agent.id, name: agent.name, status: 'working', kind: 'worker' } } }],
    })

    return runChatLoop({
      messages: [{ role: 'system', content: WORKER_SYSTEM(agent) }, ...messages],
      options: {},
      providerRow,
      apiKey,
      tools: READONLY_TOOLS,
      userId,
      sendDelta: wrappedSend,
      logChunk,
      agentId: agent.id,
      abortSignal: workerAbort.signal,
      maxRounds: 4,
      thinkingEnabled: false,
      thinkingStrength: 'medium',
    })
      .then((r) => {
        sendDelta({
          choices: [{ delta: { agent: { id: agent.id, name: agent.name, status: 'done', kind: 'worker' } } }],
        })
        return { id: agent.id, name: agent.name, status: 'done', content: r.finalContent }
      })
      .catch((err) => {
        const msg = String(err?.message || err)
        sendDelta({
          choices: [{ delta: { agent: { id: agent.id, name: agent.name, status: 'failed', kind: 'worker', error: msg } } }],
        })
        return { id: agent.id, name: agent.name, status: 'failed', content: '', error: msg }
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

  const synthMessages = [
    { role: 'system', content: SYNTHESIS_SYSTEM },
    ...messages,
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
 * 编排入口（由 aiChat.js 在 options.parallel 时调用）。
 * 负责协调器/子代理/综合三阶段，并在结束时调用 safeFinish。
 */
export async function runOrchestration({
  messages,
  options,
  providerRow,
  apiKey,
  userId,
  sendDelta,
  logChunk,
  safeFinish,
  abortSignal,
  thinkingEnabled,
  thinkingStrength,
}) {
  // —— 阶段一：协调器 ——
  sendDelta({
    choices: [{ delta: { agent: { id: 'coordinator', name: '协调器', status: 'planning', kind: 'coordinator' } } }],
  })

  let coordinator
  try {
    coordinator = await runCoordinatorCall({ messages, providerRow, apiKey, abortSignal })
  } catch (e) {
    // 协调器失败：降级为单代理直答（完整工具集）
    logger.warn('[AI][orchestrator] coordinator failed, fallback to single chat:', e.message)
    sendDelta({
      choices: [{ delta: { agent: { id: 'coordinator', name: '协调器', status: 'failed', kind: 'coordinator', error: e.message } } }],
    })
    await runChatLoop({
      messages, options, providerRow, apiKey, tools: TOOLS, userId,
      sendDelta, logChunk, agentId: null, abortSignal, maxRounds: 5, thinkingEnabled, thinkingStrength,
    })
    safeFinish()
    return
  }

  // 没有触发 dispatch_agents → 单任务短路，降级为单代理直答（带完整工具集）。
  // 协调器本身只挂 dispatch_agents，不挂实际工具；若直接采用协调器文本回答，
  // 它只会说“我来帮你查”却不会真查。因此必须再跑一次单代理工具循环。
  const dispatch = coordinator.toolCalls.find((tc) => tc.function?.name === 'dispatch_agents')
  if (!dispatch) {
    sendDelta({
      choices: [{ delta: { agent: { id: 'coordinator', name: '协调器', status: 'done', kind: 'coordinator' } } }],
    })
    await runChatLoop({
      messages, options, providerRow, apiKey, tools: TOOLS, userId,
      sendDelta, logChunk, agentId: null, abortSignal, maxRounds: 5, thinkingEnabled, thinkingStrength,
    })
    safeFinish()
    return
  }

  // 解析计划
  let plan = {}
  try {
    plan = JSON.parse(dispatch.function.arguments || '{}')
  } catch { /* ignore */ }
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
    sendDelta({
      choices: [{ delta: { agent: { id: 'coordinator', name: '协调器', status: 'done', kind: 'coordinator' } } }],
    })
    await runChatLoop({
      messages, options, providerRow, apiKey, tools: TOOLS, userId,
      sendDelta, logChunk, agentId: null, abortSignal, maxRounds: 5, thinkingEnabled, thinkingStrength,
    })
    safeFinish()
    return
  }

  logger.info(`[AI][orchestrator] dispatching ${agents.length} agents: ${agents.map((a) => a.id).join(', ')}`)

  // 协调器已完成规划（已成功拆解并下发子代理），显式标记 done，
  // 否则协调器卡片会永远停留在“规划中”转圈（前端 spinner 只看 status）。
  sendDelta({
    choices: [{ delta: { agent: { id: 'coordinator', name: '协调器', status: 'done', kind: 'coordinator' } } }],
  })

  // —— 阶段二：并行子代理 ——
  const workerResults = await runWorkers({
    agents, messages, providerRow, apiKey, userId, abortSignal, sendDelta, logChunk,
  })

  // —— 阶段三：综合 ——
  sendDelta({
    choices: [{ delta: { agent: { id: 'synthesis', name: '综合', status: 'working', kind: 'synthesis' } } }],
  })
  try {
    await runSynthesis({ messages, workerResults, providerRow, apiKey, userId, abortSignal, sendDelta, logChunk })
  } catch (e) {
    logger.warn('[AI][orchestrator] synthesis failed, fallback to raw concat:', e.message)
    const fallback = workerResults
      .map((r) => `## ${r.name}\n${r.status === 'failed' ? '[FAILED] ' + (r.error || '') : (r.content || '(无结论)')}`)
      .join('\n\n')
    sendDelta({ choices: [{ delta: { content: fallback } }] })
  }
  sendDelta({
    choices: [{ delta: { agent: { id: 'synthesis', name: '综合', status: 'done', kind: 'synthesis' } } }],
  })
  // 关键修复：synthesis done 事件写入后，等待 IO 事件循环 tick 确保数据进入 socket 缓冲区
  // 避免 write 被 Nagle 算法合并或延迟导致前端收不到 done 事件
  await new Promise((r) => setImmediate(r))
  safeFinish()
}
