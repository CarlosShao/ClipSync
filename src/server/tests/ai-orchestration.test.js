/**
 * Agent 编排统一执行管线测试（refactor/agent-orchestration）
 *
 * 覆盖重构核心契约（不依赖数据库 / 上游 LLM，纯单元）：
 *  1. 事件时序：tool_call 必须先于执行下发（ask_user 交互卡片渲染依赖该事件），
 *     ask_user_action meta 紧随门控打开，tool_result 在完成后收敛——顺序严格单调。
 *  2. ask_user 豁免管线超时：toolTimeoutMs 远小于用户作答延迟时，作答仍成功返回
 *    （历史 bug：120s 管线超时会在用户作答前掐断 ask_user）。
 *  3. 同轮多工具串行执行：两个 ask_user 按序打开/结算，事件不交错
 *    （旧并行实现下第二个破坏性/交互门控会被并发上限误拒）。
 *  4. abortSignal 已中止时不再执行任何工具。
 *  5. 子代理工具集（getWorkerTools）剔除 ask_user（阻塞型门控只允许主线程使用）。
 *
 * 说明：ask_user 路径不触库（审计写失败被 logToolAudit 内部吞掉），可无 DB 运行。
 */
import { describe, it, expect } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { handleToolCalls } from '../src/routes/aiStream.js'
import { respondAskUserRequest, getWorkerTools } from '../src/routes/aiTools.js'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function askUserToolCall(question, options) {
  return {
    id: 'tc_' + uuidv4(),
    type: 'function',
    function: {
      name: 'ask_user',
      arguments: JSON.stringify({ question, options }),
    },
  }
}

// 从增量流里提取扁平事件序列：'tool_call' | 'tool_result' | meta.type
function eventKinds(events) {
  return events
    .map((e) => {
      const delta = e?.choices?.[0]?.delta
      if (delta?.tool_call) return 'tool_call'
      if (delta?.tool_result) return 'tool_result'
      if (e?.meta?.type) return e.meta.type
      return null
    })
    .filter(Boolean)
}

describe('统一工具执行管线（handleToolCalls）', () => {
  it('ask_user：先发 tool_call，门控打开发 ask_user_action，作答后收敛 tool_result', async () => {
    const uid = uuidv4()
    const events = []
    const sendDelta = (obj) => events.push(obj)
    const tc = askUserToolCall('删除哪个子目录？', ['只删除 A', '只删除 B', '取消'])

    const pending = handleToolCalls([tc], uid, sendDelta, null, 'user')
    await wait(120) // 等门控打开（SSE meta 已下发、pending 已登记）

    const kinds = eventKinds(events)
    expect(kinds[0]).toBe('tool_call')
    expect(kinds).toContain('ask_user_action')
    expect(kinds.indexOf('tool_call')).toBeLessThan(kinds.indexOf('ask_user_action'))
    // 未作答前不得出现 tool_result
    expect(kinds).not.toContain('tool_result')

    // 前端卡片提交：requestId = tool_call id，userId 必须匹配（隔离）
    const ack = await respondAskUserRequest(tc.id, uid, '我已做出选择：只删除 B')
    expect(ack.accepted).toBe(true)

    const results = await pending
    // 流结束后重取事件序列（events 为同一引用，作答后的 tool_result 在尾部追加）
    const kindsAfter = eventKinds(events)
    expect(kindsAfter).toContain('tool_result')
    expect(kindsAfter.indexOf('ask_user_action')).toBeLessThan(kindsAfter.indexOf('tool_result'))
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ role: 'tool', tool_call_id: tc.id })
    const parsed = JSON.parse(results[0].content)
    expect(parsed.user_response).toBe('我已做出选择：只删除 B')
  })

  it('ask_user 豁免管线超时：toolTimeoutMs=80 而作答在 200ms 后到达，仍成功返回', async () => {
    const uid = uuidv4()
    const events = []
    const tc = askUserToolCall('选一个方案', ['方案一', '方案二'])

    const pending = handleToolCalls([tc], uid, (e) => events.push(e), null, 'user', { toolTimeoutMs: 80 })
    await wait(200) // 远超 80ms：若未豁免会被判超时
    const ack = await respondAskUserRequest(tc.id, uid, '方案二')
    expect(ack.accepted).toBe(true)

    const results = await pending
    const parsed = JSON.parse(results[0].content)
    expect(parsed.error).toBeUndefined()
    expect(parsed.user_response).toBe('方案二')
  })

  it('同轮多个 ask_user 串行执行：事件严格成对不交错，第二个不被并发上限误拒', async () => {
    const uid = uuidv4()
    const events = []
    const sendDelta = (obj) => events.push(obj)
    const tc1 = askUserToolCall('第一问', ['A1', 'B1'])
    const tc2 = askUserToolCall('第二问', ['A2', 'B2'])

    const pending = handleToolCalls([tc1, tc2], uid, sendDelta, null, 'user')
    await wait(120)
    const ack1 = await respondAskUserRequest(tc1.id, uid, 'A1')
    expect(ack1.accepted).toBe(true)
    await wait(120) // 等第一个工具完成、第二个门控打开
    const ack2 = await respondAskUserRequest(tc2.id, uid, 'B2')
    expect(ack2.accepted).toBe(true)

    const results = await pending
    expect(results).toHaveLength(2)

    // 事件严格成对：call1 → meta1 → result1 → call2 → meta2 → result2
    const kinds = eventKinds(events)
    const seq = kinds.filter((k) => k === 'tool_call' || k === 'tool_result' || k === 'ask_user_action')
    expect(seq).toEqual([
      'tool_call', 'ask_user_action', 'tool_result',
      'tool_call', 'ask_user_action', 'tool_result',
    ])
    // 结果与各自的 tool_call 一一对应
    expect(results.map((r) => r.tool_call_id)).toEqual([tc1.id, tc2.id])
    expect(JSON.parse(results[0].content).user_response).toBe('A1')
    expect(JSON.parse(results[1].content).user_response).toBe('B2')
  })

  it('abortSignal 已中止：不执行任何工具（连 tool_call 都不下发）', async () => {
    const uid = uuidv4()
    const events = []
    const controller = new AbortController()
    controller.abort()

    const results = await handleToolCalls([askUserToolCall('q', ['a'])], uid, (e) => events.push(e), null, 'user', {
      abortSignal: controller.signal,
    })
    expect(results).toHaveLength(0)
    expect(events).toHaveLength(0)
  })
})

describe('子代理工具集收敛（getWorkerTools）', () => {
  it('所有角色下都剔除阻塞型门控工具 ask_user，只读查询工具保留', () => {
    for (const role of ['user', 'admin', 'super_admin']) {
      const tools = getWorkerTools(role)
      const names = tools.map((t) => t.function?.name)
      expect(names).not.toContain('ask_user')
      // 只读工具仍对子代理可用（协调器提示词引导子代理只做查询）
      if (role === 'super_admin') {
        expect(names).toContain('get_clipboard_stats')
      }
    }
  })
})
