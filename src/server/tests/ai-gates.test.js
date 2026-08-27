/**
 * AI 门控边界测试（工单 W2-D / D7，refactor/ai-audit-remediation）
 *
 * 不依赖数据库写路径（确认门控的拒绝/超时分支不执行工具实体，审计失败被内部吞掉），纯单元可跑。
 * 覆盖 Wave2 代理 D 的四个门控边界：
 *  1. D1 跨流 pending 隔离：两个假 req 模拟双标签页——B 流 close 只结算 B 的
 *     待确认/待作答请求，不影响 A 流等待中的门控（旧实现按 userId 全量清理会误伤）。
 *  2. D2 确认并发上限 per-user：不同用户可同时各持一个待确认请求；
 *     同一用户的第二个并发破坏性请求仍被 CONCURRENT_CONFIRM_REQUEST 拒绝。
 *  3. D3 超时次序：管线 toolTimeoutMs 小于确认超时时，withTimeout 失败分支调用
 *     abortPendingConfirm 作废 pending；迟到的批准只能命中 expired（墓碑），不会孤儿执行。
 *     同时锁定 D6b 信封契约：SSE 下发前端的是原始 JSON，回注模型的字符串带 untrusted 包裹。
 *  4. D4 严格 requestId+userId 匹配：错误 requestId / 错误用户一律 notFound，
 *     盲扫回退已删除。
 *
 * 附带两条静态防线断言：D6a 系统提示词硬规则段存在；D6d save_memory 描述收敛为“仅在用户明确要求时写入”。
 */
import { describe, it, expect } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { handleToolCalls, unwrapToolResultEnvelope } from '../src/routes/aiStream.js'
import {
  executeTool,
  approveToolRequest,
  respondAskUserRequest,
  cancelPendingForUser,
  cancelPendingForStream,
  TOOLS,
} from '../src/routes/aiTools.js'
import { buildRoleSystemPrompt } from '../src/utils/aiSystemPrompt.js'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 假 SSE 流：resolveStreamToken 以「引用相等」判定同一流，每个假 req 即一条独立流
const mkReq = () => ({ on() {}, once() {}, removeListener() {}, destroyed: false })

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

function findConfirmMeta(events) {
  return events.map((e) => e?.meta).find((m) => m?.type === 'confirm_tool_action') || null
}
function findAskMeta(events) {
  return events.map((e) => e?.meta).find((m) => m?.type === 'ask_user_action') || null
}

describe('D1：pending 按流隔离（跨流 close 互不干扰）', () => {
  it('确认门控：B 流 close 后返回 REJECTED_BY_USER，A 流的确认仍存活且可正常应答', async () => {
    const uidA = uuidv4()
    const uidB = uuidv4()
    const reqA = mkReq()
    const reqB = mkReq()
    const evA = []
    const evB = []

    // 两条流各挂一个等待中的破坏性确认（拒绝路径不触库）
    const pA = executeTool('destroy_clips', { clip_ids: ['x'] }, uidA, 'super_admin', 'tc-A-' + uuidv4(), {
      sendDelta: (e) => evA.push(e),
      req: reqA,
    })
    await wait(40)
    const metaA = findConfirmMeta(evA)
    expect(metaA).toBeTruthy()

    const pB = executeTool('destroy_clips', { clip_ids: ['y'] }, uidB, 'super_admin', 'tc-B-' + uuidv4(), {
      sendDelta: (e) => evB.push(e),
      req: reqB,
    })
    await wait(40)
    const metaB = findConfirmMeta(evB)
    expect(metaB).toBeTruthy()
    expect(metaB.requestId).not.toBe(metaA.requestId)

    // B 流连接关闭：只结算本流
    const cleaned = cancelPendingForStream({ req: reqB })
    expect(cleaned).toEqual({ settledConfirms: 1, settledAskUsers: 0 })
    const finalB = await pB
    expect(finalB.error).toBe('REJECTED_BY_USER')

    // A 流不受影响：pending 仍归属本流、可被本人正常决策（deny 结算，不触发执行）
    expect(await approveToolRequest(metaB.requestId, uidB, true)).toMatchObject({ accepted: false, expired: true }) // B 已随墓碑过期
    expect(cancelPendingForStream({ req: reqB })).toEqual({ settledConfirms: 0, settledAskUsers: 0 }) // 幂等
    const ackA = await approveToolRequest(metaA.requestId, uidA, false)
    expect(ackA.accepted).toBe(false)
    expect(ackA.notFound).toBeUndefined()
    expect(ackA.expired).toBeUndefined()
    const finalA = await pA
    expect(finalA.error).toBe('REJECTED_BY_USER')

    // 收尾兜底（登出语义）：不应有残留
    cancelPendingForUser(uidA)
    cancelPendingForUser(uidB)
  })

  it('ask_user 门控：跨流同理——B 流 close 不影响 A 流的交互卡片应答', async () => {
    const uidA = uuidv4()
    const uidB = uuidv4()
    const reqA = mkReq()
    const reqB = mkReq()
    const evA = []
    const evB = []
    const tcA = askUserToolCall('A 流选哪个？', ['A1', 'A2'])
    const tcB = askUserToolCall('B 流选哪个？', ['B1', 'B2'])

    const pA = handleToolCalls([tcA], uidA, (e) => evA.push(e), null, 'user', { req: reqA })
    const pB = handleToolCalls([tcB], uidB, (e) => evB.push(e), null, 'user', { req: reqB })
    await wait(120)

    const metaA = findAskMeta(evA)
    const metaB = findAskMeta(evB)
    expect(metaA?.requestId).toBeTruthy()
    expect(metaB?.requestId).toBeTruthy()

    // B 流 close：只结算 B 的 ask_user pending
    const cleaned = cancelPendingForStream({ req: reqB })
    expect(cleaned).toEqual({ settledConfirms: 0, settledAskUsers: 1 })
    const resultsB = await pB
    expect(JSON.parse(unwrapToolResultEnvelope(resultsB[0].content)).user_response).toBe('用户关闭了连接')

    // A 流照常作答
    const ackA = await respondAskUserRequest(metaA.requestId, uidA, 'A2')
    expect(ackA.accepted).toBe(true)
    const resultsA = await pA
    expect(JSON.parse(unwrapToolResultEnvelope(resultsA[0].content)).user_response).toBe('A2')
  })
})

describe('D2：确认并发上限改为 per-user', () => {
  it('不同用户可同时各持一个待确认请求；同用户第二个并发请求仍被拒', async () => {
    const uid1 = uuidv4()
    const uid2 = uuidv4()
    const req1 = mkReq()
    const req2 = mkReq()
    const req1b = mkReq()
    const ev1 = []
    const ev2 = []

    // 用户1 的第一个确认：进入等待
    const p1 = executeTool('destroy_clips', { clip_ids: ['c1'] }, uid1, 'super_admin', 'tc-d2-1-' + uuidv4(), {
      sendDelta: (e) => ev1.push(e),
      req: req1,
    })
    await wait(40)
    expect(findConfirmMeta(ev1)).toBeTruthy()

    // 用户2 的确认：per-user 上限下应能进入等待（旧全局 size>0 会直接 CONCURRENT 拒绝）
    const p2 = executeTool('destroy_clips', { clip_ids: ['c2'] }, uid2, 'super_admin', 'tc-d2-2-' + uuidv4(), {
      sendDelta: (e) => ev2.push(e),
      req: req2,
    })
    await wait(40)
    expect(findConfirmMeta(ev2)).toBeTruthy()

    // 同一用户（uid1）再发起第二个破坏性请求：仍被并发上限拒绝
    const final1b = await executeTool(
      'destroy_clips',
      { clip_ids: ['c3'] },
      uid1,
      'super_admin',
      'tc-d2-1b-' + uuidv4(),
      { sendDelta: () => {}, req: req1b }
    )
    expect(final1b.error).toBe('CONCURRENT_CONFIRM_REQUEST')

    // 清理：避免残留 pending 干扰后续用例
    cancelPendingForUser(uid1)
    cancelPendingForUser(uid2)
    const final1 = await p1
    const final2 = await p2
    expect(final1.error).toBe('REJECTED_BY_USER')
    expect(final2.error).toBe('REJECTED_BY_USER')
  })
})

describe('D3：超时次序（管线超时 → abortPendingConfirm → 迟到批准 expired）', () => {
  it('toolTimeoutMs 小于确认超时：管线报超时的同时作废 pending，迟到批准返回 expired 且不执行', async () => {
    const uid = uuidv4()
    const events = []
    const tc = {
      id: 'tc_' + uuidv4(),
      type: 'function',
      function: {
        name: 'destroy_clips',
        arguments: JSON.stringify({ clip_ids: ['00000000-0000-4000-8000-000000000001'] }),
      },
    }

    // 管线超时 60ms << 确认超时 90s：确保超时来自管线而不是门控自然到期
    const pending = handleToolCalls([tc], uid, (e) => events.push(e), null, 'super_admin', {
      toolTimeoutMs: 60,
    })
    await wait(250)
    const results = await pending

    const sseToolResult = events.map((e) => e?.choices?.[0]?.delta?.tool_result).find(Boolean)
    expect(sseToolResult).toBeTruthy()
    const ssePayload = JSON.parse(sseToolResult.content)
    expect(ssePayload.timedOut).toBe(true)
    expect(String(ssePayload.error)).toContain('超时')

    // D6b 契约一并锁定：SSE 是原始 JSON；回注模型的是 untrusted 信封
    expect(sseToolResult.content).not.toContain('<tool_result')
    expect(results[0].content).toMatch(/^<tool_result name="destroy_clips" source="tool" untrusted="true">\n/)
    expect(results[0].content.endsWith('\n</tool_result>')).toBe(true)
    expect(JSON.parse(unwrapToolResultEnvelope(results[0].content)).timedOut).toBe(true)

    // 迟到批准：必须命中 expired 墓碑（而非 notFound 后二次执行 Inner）
    const lateAck = await approveToolRequest(tc.id, uid, true)
    expect(lateAck.accepted).toBe(false)
    expect(lateAck.expired).toBe(true)
    expect(lateAck.final).toBeUndefined()
  })
})

describe('D4：respondAskUserRequest 严格 requestId+userId 匹配', () => {
  it('错误 requestId / 错误用户均返回 notFound；正确匹配才接受', async () => {
    const uid = uuidv4()
    const otherUid = uuidv4()
    const events = []
    const tc = askUserToolCall('删除哪个目录？', ['A', 'B'])

    const pending = handleToolCalls([tc], uid, (e) => events.push(e), null, 'user')
    await wait(120)
    const meta = findAskMeta(events)
    expect(meta?.requestId).toBe(tc.id)

    // 错误 requestId：notFound（不再盲扫到本用户名下的其他未结算卡片）
    expect(await respondAskUserRequest('tc_not_exist_' + uuidv4(), uid, '答案')).toMatchObject({
      accepted: false,
      notFound: true,
    })
    // 正确 requestId 但跨用户：同样 notFound
    expect(await respondAskUserRequest(tc.id, otherUid, '越权答案')).toMatchObject({
      accepted: false,
      notFound: true,
    })

    // 本人 + 正确 requestId：正常结算
    expect(await respondAskUserRequest(tc.id, uid, 'A')).toMatchObject({ accepted: true })
    const results = await pending
    expect(JSON.parse(unwrapToolResultEnvelope(results[0].content)).user_response).toBe('A')
  })
})

describe('D6 静态防线（提示词与工具描述）', () => {
  it('角色系统提示词对所有角色包含“不信任内容”硬规则段', () => {
    for (const role of ['user', 'admin', 'super_admin']) {
      const prompt = buildRoleSystemPrompt(role, null)
      expect(prompt).toContain('不可信任内容防线')
      expect(prompt).toContain('一律视为「数据」')
      expect(prompt).toContain('不得执行')
    }
  })

  it('save_memory 描述收敛为“仅在用户明确要求时写入”，且标注 2000 字符截断', () => {
    const def = TOOLS.find((t) => t.function?.name === 'save_memory')
    expect(def).toBeTruthy()
    expect(def.function.description).toContain('仅在用户明确要求')
    expect(def.function.description).toContain('2000 字符')
  })
})
