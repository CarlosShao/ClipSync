// ============ aiTools 分域拆分：破坏性操作确认门控（confirmGate） ============
// 自 routes/aiTools.js 逐字迁移（纯重构，禁止改写业务逻辑）。
// 职责：DESTRUCTIVE_CONFIRM_NEEDED 集合 + pendingRequests 全局表 + 确认门控执行/批准/作废。

import { v4 as uuidv4 } from 'uuid'
import { logger } from '../../../utils/logger.js'
import { logAuditEvent } from '../../../utils/audit.js'

// ============ Agent-C：破坏性操作确认门控 ============
// 需用户在前端明确确认后才能执行的破坏性工具集合（写工具先按此协议演进）。
// 命中集合的工具不会直接被 executeToolInner 执行，而是：
//   1) 登记全局 pendingRequests（requestId → entry）；
//   2) 通过 SSE 下发 confirm_tool_action 事件等用户确认；
//   3) 批准后执行并写审计；拒绝/超时/断流则返回 REJECTED_BY_USER。
export const DESTRUCTIVE_CONFIRM_NEEDED = new Set([
  'destroy_clips',
  // RBAC 管理域破坏性/敏感写（feature/ai-rbac-backend，需用户确认）
  // B7：disable_user 直接冻结账号并吊销全部会话，属破坏性操作，纳入确认集
  'delete_user',
  'update_user_role',
  'reset_user_password',
  'disable_user',
  'update_system_config',
  'toggle_feature',
  'unpair_device',
  'downgrade_subscription',
  // W1-C 工具域 A：删除收藏夹（级联删除 ltree 后代）为破坏性操作
  'delete_collection',
  // W2-D 工具域 B：解绑设备 / 踢出会话 / 恢复版本 为破坏性/敏感操作，需用户确认
  'unpair_own_device',
  'terminate_session',
  'restore_version',
])

// 确认超时（工单 D3：从 120s 收敛到 90s）。必须小于 aiStream.handleToolCalls 的
// TOOL_EXEC_TIMEOUT_MS（120s）：让"等用户确认"先于管线超时自然到期；即便走到管线
// 超时，aiStream 的 withTimeout 失败分支也会调 abortPendingConfirm 作废 pending，
// 迟到的批准只能命中过期墓碑，绝不产生"孤儿执行"。
const CONFIRM_TIMEOUT_MS = 90_000

// 全局待确认请求表：requestId → entry。
// D1：entry.streamToken 记录归属流标识（req 或 sendDelta 引用）——流结束只结算本流；
//     cancelPendingForUser 保留作登出兜底（全量清空该用户 pending）。
// D2：并发上限从「全局 1」改为「per-user 1」，不同用户的确认互不阻塞。
// D3：任何结局结算后用「墓碑」顶替原条目：迟到的 approve 一律命中 expired，
//     而不是因条目已被删除被当作 notFound 后再走一次执行（孤儿执行窗口）；墓碑 TTL 自动清理。
export const pendingRequests = new Map()
const CONFIRM_TOMBSTONE_TTL_MS = 60_000

/**
 * D1：解析一次 SSE 流的稳定唯一归属标识（引用相等即同一流）。
 *   - 优先 opts.req：编排链路显式透传请求对象，天然每请求唯一；
 *   - 其次 opts.sendDelta：runChatLoop 链路里同一个回调闭包贯穿整条流；
 *   - 都没有则生成随机串（永不匹配，仅防崩溃；无通道的门控本来也不会进入等待态）。
 */
export function resolveStreamToken(opts = {}) {
  if (opts.req && typeof opts.req === 'object') return opts.req
  if (typeof opts.sendDelta === 'function') return opts.sendDelta
  return `sid:${uuidv4()}`
}

/**
 * D2：统计某用户当前处于等待态的确认请求数（跳过已结算与墓碑）。
 */
function countActiveConfirmsForUser(userId) {
  let n = 0
  for (const e of pendingRequests.values()) {
    if (!e.settled && !e.tombstone && e.userId === userId) n++
  }
  return n
}

/**
 * D3：结算后种下过期墓碑——requestId 保持可命中（approve → expired），TTL 后异步清理。
 */
function plantConfirmTombstone(rid, srcEntry) {
  pendingRequests.set(rid, {
    requestId: rid,
    tool: srcEntry.tool,
    userId: srcEntry.userId,
    settled: true,
    tombstone: true,
  })
  const t = setTimeout(() => {
    const cur = pendingRequests.get(rid)
    if (cur && cur.tombstone) pendingRequests.delete(rid)
  }, CONFIRM_TOMBSTONE_TTL_MS)
  // 不阻止进程退出（vitest 下定时器不挂测试进程）
  if (typeof t.unref === 'function') t.unref()
}

// args 摘要脱敏：content/password/apiKey/token 等不做全文透传，仅给受控摘要，避免明文落 SSE。
function getArgsSummary(args) {
  if (!args || typeof args !== 'object') return {}
  const SENSITIVE_KEYS = ['content', 'password', 'apikey', 'token', 'secret']
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    if (SENSITIVE_KEYS.includes(String(k).toLowerCase())) {
      const s = String(v ?? '')
      out[k] = s.length > 40 ? `${s.slice(0, 40)}…(${s.length}字)` : s
    } else {
      out[k] = v
    }
  }
  return out
}

// 破坏性动作影响描述：供确认卡片展示。
function getImpact(toolName, args) {
  const n = Array.isArray(args?.clip_ids) ? args.clip_ids.length : 0
  if (toolName === 'destroy_clips') {
    return `将永久物理删除 ${n} 条剪贴板条目，该操作不可恢复。`
  }
  if (toolName === 'archive_items' && n > 1) {
    return `将归档 ${n} 条剪贴板条目。若只需归档部分条目，请先取消并明确指定。`
  }
  if (toolName === 'unarchive_items' && n > 1) {
    return `将从归档中恢复 ${n} 条剪贴板条目。`
  }
  if (toolName === 'delete_user') {
    return `将物理删除用户 ${args?.user_id || ''} 及其全部级联数据（剪贴板/设备/订阅/文件等），该操作不可恢复。`
  }
  if (toolName === 'update_user_role') {
    return `将把用户 ${args?.user_id || ''} 的角色修改为「${args?.role || ''}」。`
  }
  if (toolName === 'reset_user_password') {
    return `将重置用户 ${args?.user_id || ''} 的密码为一次性临时密码，其现有会话登录将失效。`
  }
  if (toolName === 'update_system_config') {
    return `将更新系统配置项「${args?.config_key || ''}」。`
  }
  if (toolName === 'toggle_feature') {
    return `将${args?.enabled ? '开启' : '关闭'}功能开关「${args?.flag_key || ''}」。`
  }
  if (toolName === 'unpair_device') {
    return `将删除设备 ${args?.device_id || ''} 的配对记录。`
  }
  if (toolName === 'downgrade_subscription') {
    return `将把用户 ${args?.user_id || ''} 的订阅降级为「${args?.plan || ''}」。`
  }
  if (toolName === 'delete_collection') {
    return `将删除收藏夹 ${args?.collection_id || ''} 及其所有子收藏夹（级联删除层级结构）。该操作不可恢复，需要用户确认。`
  }
  if (toolName === 'unpair_own_device') {
    return `将解绑（删除）你的设备 ${args?.device_id || ''} 的配对记录，该设备将无法再同步本账号剪贴板。`
  }
  if (toolName === 'terminate_session') {
    return `将强制下线会话 ${args?.session_id || ''}，其登录状态立即失效（JWT 吊销）。`
  }
  if (toolName === 'restore_version') {
    return `将把剪贴板条目恢复到历史版本 ${args?.version_id || ''}（内容写回条目并生成新版本记录）。`
  }
  return undefined
}

/**
 * 执行破坏性工具所需的「确认门控」。
 * 返回 Promise<{ approved: boolean, requestId: string, result?: any }>：
 *  - 批准后 resolve({ approved:true, requestId, result })（result 由 approve 入口执行 Inner 后回填）；
 *  - 拒绝/超时/断流 resolve({ approved:false, requestId })。
 */
export async function runConfirmGate(toolName, args, userId, role, requestId, opts = {}) {
  const sendDelta = opts.sendDelta
  const rid = requestId || uuidv4()

  // 无 SSE 通道（如单测、非流式等）时直接拒绝，不进入等待和 pending
  if (!sendDelta) {
    return { approved: false, requestId: rid }
  }

  // D2：并发上限 per-user——同一用户同时只允许一个待确认的破坏性请求（避免同用户
  // 多张确认卡竞争）；不同用户的确认互不阻塞（旧全局 size>0 会让多标签页互相挤掉）。
  if (countActiveConfirmsForUser(userId) > 0) {
    logger.warn('[AI] destructive confirm rejected: user already has a pending confirm', { userId })
    return {
      approved: false,
      requestId: rid,
      result: {
        error: 'CONCURRENT_CONFIRM_REQUEST',
        message: '已有待确认的破坏性操作，请先在前端确认或等待其超时，再发起新的破坏性请求。',
      },
    }
  }

  const entry = {
    requestId: rid,
    tool: toolName,
    args,
    userId,
    role,
    settled: false,
    timer: null,
    settle: () => {}, // 占位，下方赋值
  }
  // D1：登记归属流标识（req 优先，退化为 sendDelta 引用），供 cancelPendingForStream 按流结算
  entry.streamToken = resolveStreamToken(opts)
  const onReqClose = () => entry.settle({ approved: false, requestId: rid })

  return new Promise((resolveOuter) => {
    // 统一结算：置位、销毁定时器、移除 req close 监听、resolve 外层 Promise，
    // 并以墓碑顶替原条目（D3：迟到 approve 只能命中 expired）。
    entry.settle = (outcome) => {
      if (entry.settled) return
      entry.settled = true
      clearTimeout(entry.timer)
      if (opts.req && typeof opts.req.removeListener === 'function') {
        opts.req.removeListener('close', onReqClose)
      }
      resolveOuter(outcome)
      plantConfirmTombstone(rid, entry)
    }
    entry.timer = setTimeout(() => {
      logger.warn('[AI] destructive confirm timed out:', rid)
      entry.settle({ approved: false, requestId: rid })
    }, CONFIRM_TIMEOUT_MS)

    pendingRequests.set(rid, entry)

    // 无 SSE 通道（如 summarize/suggest 等非流式入口）时直接拒绝，不进入等待。
    if (!sendDelta) {
      entry.settle({ approved: false, requestId: rid })
      return
    }

    // 下发 SSE 确认事件供前端渲染确认卡片。
    sendDelta({
      meta: {
        type: 'confirm_tool_action',
        requestId: rid,
        tool: toolName,
        argsSummary: getArgsSummary(args),
        impact: getImpact(toolName, args),
      },
    })

    // 客户端断开时清空对应 pending，不残留。
    if (opts.req && typeof opts.req.on === 'function') {
      opts.req.on('close', onReqClose)
    }
  })
}

/**
 * 确认入口（POST /api/ai/chat/approve 调用）：
 * 校验 requestId 归属（userId 隔离，禁止跨用户审批）。
 *  - allow=false：拒绝，向等待中的 executeTool 结算 REJECTED_BY_USER。
 *  - allow=true：执行 Inner（破坏性工具实做），结果作为 final 返回，并同时结算给 executeTool 做审计。
 * D5：approve/reject 决策各写一条 audit_logs（action='ai_tool_approve'，含 requestId/tool/allow，
 *     不含明文密码——密码校验在路由层完成，password 不进入本函数）。
 * @returns {{ accepted, notFound?, expired?, final? }}
 */
export async function approveToolRequest(requestId, userId, allow) {
  const entry = pendingRequests.get(requestId)
  if (!entry || (!entry.tombstone && entry.userId !== userId)) {
    return { accepted: false, notFound: true }
  }
  // 墓碑（含其它已结算残影）：一律 expired——迟到批准不再触发二次执行
  if (entry.tombstone || entry.settled) {
    return { accepted: false, expired: true }
  }
  // D5：决策审计——批准与拒绝各记一条成功处理的决策行（status=success 表示"决策已记录"）。
  try {
    await logAuditEvent({
      userId,
      action: 'ai_tool_approve',
      resourceType: 'ai_tool_approve',
      details: { requestId, tool: entry.tool, allow: allow === true },
      status: 'success',
    })
  } catch (auditErr) {
    logger.warn('[AI] approve decision audit failed:', auditErr?.message)
  }
  if (allow !== true) {
    entry.settle({ approved: false, requestId })
    return { accepted: false }
  }
  // 批准：先将该请求从全局 Map 移除，防止并发第二次 approve 重复执行 Inner
  // （并发第二请求将因 get() 返回 undefined 而收到 notFound；结算后的墓碑则命中 expired）。
  // 随后执行 Inner 并把结果经 entry.settle 结算给等待中的 executeTool（含审计）。
  clearTimeout(entry.timer)
  pendingRequests.delete(requestId)
  try {
    const { executeToolInner } = await import('../execute.js')
    const result = await executeToolInner(entry.tool, entry.args, userId, entry.role)
    entry.settle({ approved: true, requestId, result })
    return { accepted: true, final: result }
  } catch (err) {
    logger.error('[AI] approve execution failed:', err.message)
    entry.settle({ approved: true, requestId, result: { error: err.message } })
    return { accepted: true, final: { error: err.message } }
  }
}

/**
 * D3：管线超时联动入口（aiStream.handleToolCalls 的 withTimeout 失败分支调用）。
 * 立刻作废等待中的破坏性确认 pending，使其迟到批准只能命中 expired 墓碑，
 * 杜绝"管线已报超时、迟到的批准仍孤儿执行 Inner"的窗口。
 * @returns {boolean} 是否确实作废了一个等待中的确认
 */
export function abortPendingConfirm(requestId) {
  const rid = String(requestId || '')
  const entry = pendingRequests.get(rid)
  if (!entry || entry.tombstone || entry.settled) return false
  entry.settle({ approved: false, requestId: rid, aborted: true })
  logger.warn('[AI] pending confirm aborted by pipeline timeout:', rid)
  return true
}

/**
 * D5 辅助（供 /chat/approve 路由判断 L3 强制密码）：严格 userId 匹配地查询
 * 某个等待中确认请求对应的工具名；不存在/非本人返回 null。只读不改状态。
 */
export function peekPendingConfirmTool(requestId, userId) {
  const entry = pendingRequests.get(String(requestId || ''))
  if (!entry || entry.tombstone || entry.settled || entry.userId !== userId) return null
  return entry.tool || null
}