// ============ aiTools 分域拆分：聚合出口（index） ============
// 自 routes/aiTools.js 逐字迁移（纯重构，禁止改写业务逻辑）。
// 职责：保持原 aiTools.js 的对外导出面完全兼容——
//   TOOLS（按原数组顺序重排 9 域 definitions + ask_user）、WRITE_TOOL_NAMES、
//   READONLY_TOOLS、WORKER_BLOCKED_TOOLS、getWorkerTools、DESTRUCTIVE_CONFIRM_NEEDED、
//   approveToolRequest、runAskUserGate、respondAskUserRequest、cancelPendingForStream、
//   abortPendingConfirm、peekPendingConfirmTool、cancelPendingForUser、executeTool、default router。

import { Router } from 'express'
import { getToolsForRole } from '../../utils/aiSystemPrompt.js'

import { askUserToolDef } from './gates/askUserGate.js'
import { collectionsTagsDefs } from './definitions/collectionsTagsDef.js'
import { clipsDefs } from './definitions/clipsDef.js'
import { protectiveMediaDefs } from './definitions/protectiveMediaDef.js'
import { templatesDefs } from './definitions/templatesDef.js'
import { sharingDevicesDefs } from './definitions/sharingDevicesDef.js'
import { notificationsWorkflowDefs } from './definitions/notificationsWorkflowDef.js'
import { accountSubscriptionDefs } from './definitions/accountSubscriptionDef.js'
import { adminRbacDefs } from './definitions/adminRbacDef.js'
import { operationsKnowledgeDefs } from './definitions/operationsKnowledgeDef.js'

import { DESTRUCTIVE_CONFIRM_NEEDED, approveToolRequest, abortPendingConfirm, peekPendingConfirmTool } from './gates/confirmGate.js'
import { runAskUserGate, respondAskUserRequest, cancelPendingForStream, cancelPendingForUser } from './gates/askUserGate.js'
import { executeTool } from './execute.js'

const router = Router()

/**
 * ClipSync 工具定义（聚合出口）
 * 这些工具可以被 AI Agent 调用来执行实际操作。
 * 顺序与迁移前 TOOLS 数组完全一致（混排多域：域 A/B/I/E/G/D...，按原文件行号顺序重排）。
 */
function buildTools() {
  const byName = new Map()
  const tools = [askUserToolDef, ...collectionsTagsDefs, ...clipsDefs, ...protectiveMediaDefs, ...templatesDefs, ...sharingDevicesDefs, ...notificationsWorkflowDefs, ...accountSubscriptionDefs, ...adminRbacDefs, ...operationsKnowledgeDefs]
  for (const t of tools) byName.set(t.function.name, t)
  // 迁移前的原始顺序（按原 aiTools.js TOOLS 数组行号）：
  const ORDER = [
    'ask_user',
    'find_duplicates', 'batch_move_to_collection', 'export_data', 'show_diff_preview',
    'get_clipboard_stats', 'get_ai_context', 'search_clips', 'get_clip_details', 'ocr_clip_image',
    'get_recent_clips', 'analyze_clip_usage', 'get_collections', 'get_tags', 'get_devices',
    'get_templates', 'get_shared_links', 'get_memories', 'save_memory', 'write_clip',
    'tag_items', 'archive_items', 'unarchive_items', 'update_clip_meta', 'create_collection',
    'create_template', 'update_template', 'create_shared_link', 'batch_favorite', 'batch_delete',
    'destroy_clips', 'organize_by_type', 'read_clip_content', 'get_clip_meta', 'get_protected_clips',
    'get_archived_clips', 'get_subscription_details', 'get_security_overview', 'get_template_variables', 'get_notifications',
    'explain_feature', 'explain_privacy_model', 'explain_deployment', 'get_project_architecture', 'list_users',
    'create_user', 'update_user_role', 'delete_user', 'reset_user_password', 'disable_user',
    'get_system_config', 'update_system_config', 'toggle_feature', 'get_audit_logs', 'list_all_devices',
    'unpair_device', 'upgrade_subscription', 'downgrade_subscription', 'create_sub_collection', 'delete_collection',
    'update_collection', 'move_collection', 'reorder_collections', 'get_collection_items', 'add_item_to_collection',
    'remove_item_from_collection', 'update_collection_tags', 'delete_tag', 'update_clip', 'mark_sensitive',
    'mark_clip_used', 'get_frequent_clips', 'set_item_protection', 'remove_item_protection', 'get_protection_status',
    'upload_image', 'upload_file', 'delete_template', 'delete_shared_link', 'get_workflow_rules',
    'create_workflow_rule', 'update_workflow_rule', 'delete_workflow_rule', 'get_notification_preferences', 'update_notification_preferences',
    'mark_notification_read', 'update_device', 'unpair_own_device', 'list_my_sessions', 'terminate_session',
    'get_version_history', 'restore_version', 'upsert_template_variables', 'delete_template_variable', 'get_profile',
    'update_profile', 'get_subscription_plans', 'cancel_subscription', 'resume_subscription', 'submit_survey',
    'get_slow_queries',
  ]
  return ORDER.map((name) => byName.get(name)).filter(Boolean)
}

export const TOOLS = buildTools()

/**
 * 写类工具子集：供主线程识别可写工具。
 * 与迁移前 WRITE_TOOL_NAMES 内容一致（Set 成员不要求顺序）。
 */
export const WRITE_TOOL_NAMES = new Set([
  'save_memory',
  'write_clip',
  'tag_items',
  'archive_items',
  'unarchive_items',
  'update_clip_meta',
  'create_collection',
  'create_template',
  'update_template',
  'create_shared_link',
  'batch_favorite',
  'batch_delete',
  'destroy_clips',
  'ocr_clip_image',
  // RBAC 管理域写类（feature/ai-rbac-backend）
  'create_user',
  'update_user_role',
  'delete_user',
  'reset_user_password',
  'disable_user',
  'update_system_config',
  'toggle_feature',
  'unpair_device',
  'upgrade_subscription',
  'downgrade_subscription',
  'create_sub_collection',
  // W1-C 工具域 A 写类（15 个）：收藏夹 / 条目 / 标签 / 剪贴板 / 保护 / 媒体
  'delete_collection',
  'update_collection',
  'move_collection',
  'reorder_collections',
  'add_item_to_collection',
  'remove_item_from_collection',
  // B3 热修：批量移动也是写操作，缺登记会让子代理拿到"只读"假象并发写收藏夹
  'batch_move_to_collection',
  'update_collection_tags',
  'delete_tag',
  'update_clip',
  'mark_sensitive',
  'mark_clip_used',
  'set_item_protection',
  'remove_item_protection',
  'upload_image',
  'upload_file',
  // W2-D 工具域 B 写类（17 个）：模板 / 共享链接 / 设备 / 通知 / 会话 / 版本 / 工作流 / 模板变量 / 账号 / 订阅 / 调查
  'delete_template',
  'delete_shared_link',
  'create_workflow_rule',
  'update_workflow_rule',
  'delete_workflow_rule',
  'update_notification_preferences',
  'mark_notification_read',
  'update_device',
  'unpair_own_device',
  'terminate_session',
  'restore_version',
  'upsert_template_variables',
  'delete_template_variable',
  'update_profile',
  'cancel_subscription',
  'resume_subscription',
  'submit_survey',
])

/**
 * 只读工具子集：供并行子代理使用，杜绝子代理并发触发写入/破坏性操作。
 * 与 TOOLS 同步维护——新增写入类工具时必须加入 WRITE_TOOL_NAMES，否则会被误判为只读。
 */
export const READONLY_TOOLS = TOOLS.filter((t) => !WRITE_TOOL_NAMES.has(t.function.name))

/**
 * 子代理禁用工具集合：UI 阻塞型门控工具只允许在主线程（单代理 / 协调器）使用。
 * ask_user 的交互卡片只渲染在主消息上（AiMessage.askUserStep ← message.toolCalls），
 * 子代理的增量被路由进独立 agent 卡片——若子代理调用 ask_user，会形成
 * "门控等待用户 → 用户等卡片 → 卡片永远不会出现"的死锁，直至 5 分钟超时。
 */
export const WORKER_BLOCKED_TOOLS = new Set(['ask_user'])

/**
 * 子代理工具集：角色过滤后的只读工具，再剔除阻塞型门控工具。
 * 供 aiOrchestrator.runWorkers 使用，保证并行子代理永不触发人类在回路等待。
 */
export function getWorkerTools(role) {
  return getToolsForRole(role, READONLY_TOOLS).filter((t) => !WORKER_BLOCKED_TOOLS.has(t.function.name))
}

export {
  DESTRUCTIVE_CONFIRM_NEEDED,
  approveToolRequest,
  abortPendingConfirm,
  peekPendingConfirmTool,
  runAskUserGate,
  respondAskUserRequest,
  cancelPendingForStream,
  cancelPendingForUser,
  executeTool,
}

export default router