/**
 * 幻觉式完成防护回归测试（真实案例 2026-08-28）：
 *
 * 用户在工作流模式连续两轮批量创建子目录成功后，第三轮要求"再在 test2 下面创建 test2.1-2.5"，
 * 模型（step-explore）没有发出任何 tool_calls，直接复刻历史模板回复"全部创建成功 ✅"+编造的 UUID 表格。
 * 证据：ai_messages 该轮 tool_calls=0 / tool_results=0；audit_logs 无 ai_tool_call；
 *       favorite_collections 无 test2.x 行。
 *
 * 根因：runChatLoop 的"只说不做"安全网（looksLikeToolIntent）刻意放行过去时成功汇报——
 * "零工具调用轮次里的过去时成功声明"落在所有防护的盲区。
 *
 * 本测试锁定新防护契约：
 *  1. round 0 且最后一条 user 消息含操作意图时，纯文本成功声明 → 注入矫正 system 消息重跑一轮；
 *  2. 矫正后模型真的调用工具 → 正常收敛，最终回答不带警告；
 *  3. 矫正后仍纯文本虚报 → 最终回答追加显式"未经工具验证"警告；
 *  4. 纯查询类请求（无操作动词/疑问句）不触发矫正。
 *
 * 全离线：vi.mock safeUpstreamFetch（脚本化 SSE 流）+ pool（工具执行不触真实 DB）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/utils/aiProviders.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, safeUpstreamFetch: vi.fn() }
})

vi.mock('../src/db/pool.js', () => {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }
  return { pool, default: pool }
})

import { safeUpstreamFetch } from '../src/utils/aiProviders.js'
import {
  runChatLoop,
  looksLikeUnverifiedSuccessClaim,
  lastUserMessageRequestsAction,
} from '../src/routes/aiChatCore.js'

const providerRow = {
  provider: 'custom',
  api_format: 'openai',
  model: 'test-model',
  base_url: 'http://upstream.test/v1',
  context_window: 128000,
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_sub_collection',
      description: '创建子收藏夹',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, parent_id: { type: 'string' } },
        required: ['name', 'parent_id'],
      },
    },
  },
]

// 把一轮模型输出编码为 SSE Response（OpenAI 兼容格式）
function sseResponse(events) {
  const body =
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(body))
      c.close()
    },
  })
  return { ok: true, body: stream, text: async () => '' }
}

const textChunk = (t) => ({ choices: [{ delta: { content: t }, index: 0 }] })
const toolCallChunk = (id, name) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '{}' } }] } }],
})

// 请求体里第 n 次上游调用的 messages 数组
function nthRequestMessages(n) {
  const call = safeUpstreamFetch.mock.calls[n]
  return JSON.parse(call[1].body).messages
}

const CLAIM = '全部创建成功 ✅ 在 test2 收藏夹下已创建 5 个子目录：\n\n| 名称 | ID |\n|---|---|\n| test2.1 | d4b2de6d-33f2-4bd5-a551-675d83f2f334 |'
const ACTION_MSG = '再在test2下面创建test2.1-2.5的子目录'

function baseMessages(userContent) {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: userContent },
  ]
}

async function runLoop(userContent) {
  return runChatLoop({
    messages: baseMessages(userContent),
    options: { temperature: 0.2 },
    providerRow,
    apiKey: 'test-key',
    tools: TOOLS,
    userId: '00000000-0000-0000-0000-000000000001',
    role: 'user',
    sendDelta: () => {},
    abortSignal: undefined,
    maxRounds: 5,
    allowCompress: false,
    conversationId: null,
  })
}

beforeEach(() => {
  safeUpstreamFetch.mockReset()
})

describe('纯函数：幻觉声明与操作意图检测', () => {
  it('looksLikeUnverifiedSuccessClaim：过去时成功声明命中，提问/思维链不命中', () => {
    expect(looksLikeUnverifiedSuccessClaim(CLAIM)).toBe(true)
    expect(looksLikeUnverifiedSuccessClaim('已成功删除 3 个条目。')).toBe(true)
    expect(looksLikeUnverifiedSuccessClaim('我接下来将创建子目录。')).toBe(false)
    expect(looksLikeUnverifiedSuccessClaim('test2 下还没有子目录。')).toBe(false)
    // <think> 推演里的字样不算声明
    expect(looksLikeUnverifiedSuccessClaim('<think>用户要求创建，我先调用工具</think>好的，我现在开始创建。')).toBe(false)
  })

  it('lastUserMessageRequestsAction：操作句命中，查询/疑问句不命中', () => {
    expect(lastUserMessageRequestsAction(baseMessages(ACTION_MSG))).toBe(true)
    expect(lastUserMessageRequestsAction(baseMessages('现在创建一个根test收藏夹'))).toBe(true)
    expect(lastUserMessageRequestsAction(baseMessages('查询test2收藏夹下有哪些目录？'))).toBe(false)
    expect(lastUserMessageRequestsAction(baseMessages('test2.1 创建了吗？'))).toBe(false)
    expect(lastUserMessageRequestsAction([])).toBe(false)
  })
})

describe('runChatLoop 幻觉完成防护', () => {
  it('矫正有效：虚报 → 注入矫正重跑 → 模型实际调用工具 → 正常收敛且无警告', async () => {
    safeUpstreamFetch
      .mockImplementationOnce(() => Promise.resolve(sseResponse([textChunk(CLAIM)])))
      .mockImplementationOnce(() =>
        Promise.resolve(sseResponse([toolCallChunk('tc_1', 'create_sub_collection')])),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(sseResponse([textChunk('已成功创建 5 个子目录（test2.1 - test2.5）。')])),
      )

    const res = await runLoop(ACTION_MSG)

    // 第一次虚报后注入了矫正 system 消息并重跑
    expect(safeUpstreamFetch).toHaveBeenCalledTimes(3)
    const second = nthRequestMessages(1)
    const corrective = second.find((m) => m.role === 'system' && m.content.includes('没有发生任何工具调用'))
    expect(corrective).toBeTruthy()
    // 工具真实执行后收敛：最终回答不带警告
    expect(res.finalContent).not.toContain('⚠️')
    expect(res.finalContent).toContain('已成功创建')
  })

  it('矫正无效：两轮都虚报 → 最终回答追加"未经工具验证"警告', async () => {
    safeUpstreamFetch
      .mockImplementationOnce(() => Promise.resolve(sseResponse([textChunk(CLAIM)])))
      .mockImplementationOnce(() => Promise.resolve(sseResponse([textChunk(CLAIM)])))

    const res = await runLoop(ACTION_MSG)

    expect(safeUpstreamFetch).toHaveBeenCalledTimes(2)
    expect(res.finalContent).toContain('未检测到对应的工具调用记录')
  })

  it('纯查询不触发矫正：模型文本回答后直接收敛', async () => {
    safeUpstreamFetch
      .mockImplementationOnce(() =>
        Promise.resolve(sseResponse([textChunk('根据查询结果，test2 下暂无子目录。已查询完成。')])),
      )

    const res = await runLoop('查询test2收藏夹下有哪些目录？')

    expect(safeUpstreamFetch).toHaveBeenCalledTimes(1)
    expect(res.finalContent).not.toContain('⚠️')
  })
})
