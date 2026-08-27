// ============ aiTools 分域拆分：executeToolInner + execute（审计包装器） ============
// 自 routes/aiTools.js 逐字迁移（纯重构，禁止改写业务逻辑）。
// 职责：
//   1) executeToolInner：RBAC 再校验后按工具名分发到各域 handler（switch → 查表，行为一致）
//   2) executeTool：审计包装器（计时 + 确认门控 + 审计写库），对外导出面不变
// 保持所有注释与原文件一致，仅分发从 switch 改为 HANDLERS 查表（default 分支语义相同）。

import { logger } from '../../utils/logger.js'
import { assertToolAllowed } from '../../utils/aiSystemPrompt.js'
import { logToolAudit } from '../../utils/audit.js'
import { clipIdsLimitError, MAX_CLIP_IDS } from './shared.js'
import { DESTRUCTIVE_CONFIRM_NEEDED, runConfirmGate } from './gates/confirmGate.js'
import { runAskUserGate } from './gates/askUserGate.js'

// 导入各域 handlers
import { collectionsTagsHandlers } from './handlers/collectionsTagsHandler.js'
import { clipsHandlers } from './handlers/clipsHandler.js'
import { protectiveMediaHandlers } from './handlers/protectiveMediaHandler.js'
import { templatesHandlers } from './handlers/templatesHandler.js'
import { sharingDevicesHandlers } from './handlers/sharingDevicesHandler.js'
import { notificationsWorkflowHandlers } from './handlers/notificationsWorkflowHandler.js'
import { accountSubscriptionHandlers } from './handlers/accountSubscriptionHandler.js'
import { adminRbacHandlers } from './handlers/adminRbacHandler.js'
import { operationsKnowledgeHandlers } from './handlers/operationsKnowledgeHandler.js'

// 聚合所有 handlers 到一个查表对象
const HANDLERS = {
  ...collectionsTagsHandlers,
  ...clipsHandlers,
  ...protectiveMediaHandlers,
  ...templatesHandlers,
  ...sharingDevicesHandlers,
  ...notificationsWorkflowHandlers,
  ...accountSubscriptionHandlers,
  ...adminRbacHandlers,
  ...operationsKnowledgeHandlers,
}

/**
 * 执行工具调用（实际执行体）——原 executeToolInner
 * @param {string} toolName
 * @param {object} args
 * @param {string} userId
 * @param {string} [role] 角色键（'super_admin'|'admin'|'user'），用于敏感工具权限闸门
 */
export async function executeToolInner(toolName, args, userId, role) {
  try {
    // ✅ RBAC（#213 / 第三层安全闸门）：敏感工具执行前再校验一次角色权限。
    // 即便上游因工具清单未及时收敛而调到了敏感工具，也在此处硬性拦截。
    const roleCheck = assertToolAllowed(role, toolName)
    if (!roleCheck.allowed) {
      logger.warn(`[AI] tool "${toolName}" blocked for role "${role}": missing ${roleCheck.missing.join(',')}`)
      return {
        error: 'FORBIDDEN: your role cannot access this tool',
        code: 'ROLE_FORBIDDEN',
        missing: roleCheck.missing,
      }
    }

    // 说明：ask_user 不在 executeToolInner 内实现——executeTool 顶部将其拦截进
    // runAskUserGate（人类在回路门控），此处的分发只处理"立即执行型"工具。
    const handler = HANDLERS[toolName]
    if (!handler) {
      return { error: `Unknown tool: ${toolName}` }
    }
    return await handler(args, userId, role)
  } catch (err) {
    logger.error('Tool execution error:', err)
    return { error: err.message }
  }
}

/**
 * 执行工具调用（审计包装器，对外导出名保持 executeTool 不变）
 * 对 executeToolInner 做计时 + 成功/失败路径均写审计，语义与原先完全一致：
 * 返回 { error: ... } 的对象原样透传、异常仍向上抛出，调用方无需改动。
 * Agent-C 叠加：对 DESTRUCTIVE_CONFIRM_NEEDED 集合内的破坏性工具先走确认门控
 * （SSE 确认卡片 → approve 入口），批准后才执行 Inner 并审计；拒绝/超时/断流返回 REJECTED_BY_USER。
 * @param {string} toolName
 * @param {object} args
 * @param {string} userId
 * @param {string} [role] 角色键
 * @param {string} [requestId] 关联 requestId（确认门控透传），无则内部生成
 * @param {object} [opts] { sendDelta, req } SSE 通道与请求对象（确认事件下发 / 断流清理用）
 */
export async function executeTool(toolName, args, userId, role, requestId, opts = {}) {
  const start = Date.now()
  let result
  // 破坏性工具确认门控生成的 requestId → 审计与 confirm 事件同 requestId 可追溯。
  let confirmRequestId = requestId
  try {
    if (toolName === 'ask_user') {
      // 交互式提问门控：下发 SSE 卡片并在当前流内阻塞等待前端用户作答
      const gate = await runAskUserGate(toolName, args, userId, role, requestId, opts)
      confirmRequestId = gate.requestId || requestId
      result = {
        // 超时/断流必须显式标注，status:'completed' 会误导模型把超时当作用户已作答
        status: gate.timeout ? 'timeout' : gate.cancelled ? 'cancelled' : 'completed',
        user_response: gate.user_response || '用户已在界面卡片做出选择',
        questions: args.questions || [{ question: args.question, options: args.options }],
      }
    } else {
      // B8：数组参数上限在确认门控之前校验——超限直接返回参数错误，
      // 不进入等待态（否则 archive_items 201 条会先挂进确认流程才暴露错误）。
      const limitErr = clipIdsLimitError(args?.clip_ids, MAX_CLIP_IDS)
      if (limitErr) {
        result = limitErr
      } else {
        // 确认门控：
        //   1) DESTRUCTIVE_CONFIRM_NEEDED 集合内的工具（如 destroy_clips）
        //   2) archive_items / unarchive_items 操作多条（>1）时，需用户确认
        const needsConfirm = DESTRUCTIVE_CONFIRM_NEEDED.has(toolName)
          || ((toolName === 'archive_items' || toolName === 'unarchive_items')
              && Array.isArray(args?.clip_ids) && args.clip_ids.length > 1)
        if (needsConfirm) {
          const gate = await runConfirmGate(toolName, args, userId, role, requestId, opts)
          confirmRequestId = gate.requestId
          if (gate.approved && gate.result !== undefined) {
            // 批准后 approve 入口已执行 Inner，结果回填到这里；沿用门控 requestId 写审计。
            result = gate.result
          } else {
            // 拒绝 / 超时 / 断流 / 并发被拒：返回 REJECTED_BY_USER（并发场景带更明确错误）。
            result = (gate.result && gate.result.error === 'CONCURRENT_CONFIRM_REQUEST')
              ? gate.result
              : { error: 'REJECTED_BY_USER' }
          }
        } else {
          result = await executeToolInner(toolName, args, userId, role)
        }
      }
    }
  } catch (err) {
    await logToolAudit({
      userId,
      role,
      tool: toolName,
      argsSummary: args,
      resultSummary: null,
      ok: false,
      durationMs: Date.now() - start,
      requestId: confirmRequestId,
    })
    throw err // 不改变既有语义：异常仍向上抛出
  }
  // ok 由 result 是否含 error 字段判定（executeToolInner 成功返回不带 error，失败返回 { error }）
  const ok = !(result && typeof result === 'object' && 'error' in result)
  await logToolAudit({
    userId,
    role,
    tool: toolName,
    argsSummary: args,
    resultSummary: result,
    ok,
    durationMs: Date.now() - start,
    requestId: confirmRequestId,
  })
  return result
}