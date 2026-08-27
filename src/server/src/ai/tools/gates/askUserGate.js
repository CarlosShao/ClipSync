// ============ aiTools 分域拆分：ask_user 交互提问门控（askUserGate） ============
// 自 routes/aiTools.js 逐字迁移（纯重构，禁止改写业务逻辑）。
// 职责：ask_user 工具定义 + pendingAskUserRequests 全局表 + 提问门控执行/响应/清理。
// 跨表清理（cancelPendingForStream / cancelPendingForUser）同时操作确认表 pendingRequests
// 与提问表 pendingAskUserRequests，故引用 confirmGate 导出的 pendingRequests。

import { v4 as uuidv4 } from 'uuid'
import { logger } from '../../../utils/logger.js'
import { pendingRequests, resolveStreamToken } from './confirmGate.js'

// ask_user 工具定义（TOOLS 数组第一项，逐字迁移）
export const askUserToolDef = {
  type: 'function',
  function: {
    name: 'ask_user',
    description: '向用户提问、提供选项让用户做出选择、或者一次性提出多个连续问题（分页问卷式交互卡片）时调用。支持单选/多选、支持用户在每道题下选择"其他"并自定义填写、支持分页切换多道问题、并在末页提供"补充说明"大输入框供用户输入附加要求。调用此工具后 Agent 工作流会安全暂停，等待用户在界面卡片上做出选择并提交。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '问题列表（支持 1 到多个问题供用户分页作答）',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '问题标题或指引说明' },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: '供用户选择的预设选项列表（无需手动写"其他"，前端卡片默认自带"其他(自定义输入)"选项）'
              },
              is_multi_select: { type: 'boolean', description: '是否允许多选，默认 false（单选）' },
              context: { type: 'string', description: '该问题的背景提示说明（可选）' }
            },
            required: ['question', 'options']
          }
        },
        question: { type: 'string', description: '单问题模式：问题标题' },
        options: { type: 'array', items: { type: 'string' }, description: '单问题模式：选项列表' },
        is_multi_select: { type: 'boolean', description: '单问题模式：是否多选' },
        context: { type: 'string', description: '总体背景说明（可选）' }
      }
    }
  }
}

const pendingAskUserRequests = new Map()
const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟超时

/**
 * ask_user 交互提问门控：
 * 下发 SSE 交互卡片事件并挂起 Promise，等待前端用户在卡片上点击选择并提交（通过 POST /api/ai/chat/respond_ask_user 回调）。
 * 提交后此 Promise 立刻 resolve，工作流直接无缝继续执行下一轮（单会话闭环，不产生多余用户消息气泡）。
 */
export async function runAskUserGate(toolName, args, userId, role, requestId, opts = {}) {
  const sendDelta = opts.sendDelta
  const rid = requestId || uuidv4()

  if (!sendDelta) {
    return { user_response: '非流式环境跳过交互卡片', skipped: true, requestId: rid }
  }

  const entry = {
    requestId: rid,
    tool: toolName,
    args,
    userId,
    role,
    settled: false,
    timer: null,
    heartbeat: null,
    settle: () => {},
  }
  // D1：登记归属流标识（与确认门控同一口径），供 cancelPendingForStream 按流结算
  entry.streamToken = resolveStreamToken(opts)
  const onReqClose = () => entry.settle({ user_response: '用户关闭了连接', cancelled: true })

  return new Promise((resolveOuter) => {
    entry.settle = (outcome) => {
      if (entry.settled) return
      entry.settled = true
      clearTimeout(entry.timer)
      clearInterval(entry.heartbeat)
      if (opts.req && typeof opts.req.removeListener === 'function') {
        opts.req.removeListener('close', onReqClose)
      }
      pendingAskUserRequests.delete(rid)
      resolveOuter(outcome)
    }

    entry.timer = setTimeout(() => {
      logger.warn('[AI] ask_user timed out waiting for user choice:', rid)
      entry.settle({ user_response: '等待用户选择超时（5分钟未操作）', timeout: true })
    }, ASK_USER_TIMEOUT_MS)

    pendingAskUserRequests.set(rid, entry)

    // 15 秒心跳保活 SSE 流（前端据此维持"流活跃"状态，避免被无响应看门狗误杀）
    entry.heartbeat = setInterval(() => {
      try {
        sendDelta({ meta: { type: 'heartbeat', timestamp: Date.now() } })
      } catch {
        /* ignore */
      }
    }, 15000)

    // 下发 SSE 交互卡片元数据（前端兜底渲染：无同 id tool_call 时合成 ask_user 卡片）
    sendDelta({
      meta: {
        type: 'ask_user_action',
        requestId: rid,
        questions: Array.isArray(args.questions) ? args.questions : [{ question: args.question, options: args.options, is_multi_select: args.is_multi_select, context: args.context }],
        context: args.context || '',
      },
    })

    // 客户端断开时结算等待（用户关页面/取消流 → 门控立即释放，不残留 5 分钟）
    if (opts.req && typeof opts.req.on === 'function') {
      opts.req.on('close', onReqClose)
    }
  })
}

/**
 * 响应 ask_user 用户选择（POST /api/ai/chat/respond_ask_user 调用）：
 * D4：删除旧实现「requestId 查不到时按 userId 盲扫第一条未结算请求」的回退——
 * 盲扫会把用户的回答写进另一张卡片（错题卡/串流）。现严格 requestId+userId 匹配，
 * 匹配不到一律 notFound（HTTP 404），前端提示"该选择请求不存在或已超时"即可重试。
 */
export async function respondAskUserRequest(requestId, userId, userResponse) {
  const entry = requestId ? pendingAskUserRequests.get(requestId) : null
  if (!entry || entry.userId !== userId) {
    return { accepted: false, notFound: true }
  }
  if (entry.settled) {
    return { accepted: false, expired: true }
  }
  entry.settle({ success: true, user_response: userResponse })
  return { accepted: true }
}

/**
 * D1：按流结算 pending——SSE close/safeFinish 只清「本流」的待确认/待作答请求。
 * 归属判定与 resolveStreamToken 同口径：streamId 字符串 / req 对象 / sendDelta 引用，
 * 三类候选任一命中即结算。跨流的 pending 不受影响（双标签页互不干扰）。
 */
export function cancelPendingForStream(hints = {}) {
  const tokens = []
  if (hints.streamId != null && hints.streamId !== '') tokens.push(`sid:${hints.streamId}`)
  if (hints.req && typeof hints.req === 'object') tokens.push(hints.req)
  if (typeof hints.sendDelta === 'function') tokens.push(hints.sendDelta)
  if (tokens.length === 0) return { settledConfirms: 0, settledAskUsers: 0 }

  let confirms = 0
  let askUsers = 0
  for (const [rid, e] of pendingRequests) {
    if (e.settled || e.tombstone) continue
    if (!tokens.includes(e.streamToken)) continue
    e.settle({ approved: false, requestId: rid, cancelled: true })
    confirms++
  }
  for (const [rid, e] of pendingAskUserRequests) {
    if (e.settled) continue
    if (!tokens.includes(e.streamToken)) continue
    e.settle({ user_response: '用户关闭了连接', cancelled: true, requestId: rid })
    askUsers++
  }
  return { settledConfirms: confirms, settledAskUsers: askUsers }
}

/**
 * 供 SSE 流关闭（safeFinish / req close）时清理该用户残留的 pending 项。
 * D1 之后保留作「登出等全量兜底」场景——常规断流清理请使用 cancelPendingForStream。
 */
export function cancelPendingForUser(userId) {
  for (const [rid, e] of pendingRequests) {
    if (e.userId === userId && !e.settled) {
      e.settle({ approved: false, requestId: rid, cancelled: true })
    }
  }
  for (const [rid, e] of pendingAskUserRequests) {
    if (e.userId === userId && !e.settled) {
      e.settle({ user_response: '用户关闭了连接', cancelled: true, requestId: rid })
    }
  }
}