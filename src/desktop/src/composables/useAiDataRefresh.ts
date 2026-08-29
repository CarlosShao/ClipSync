/**
 * AI 数据刷新事件系统
 *
 * 当 AI Agent 执行工具操作（创建收藏夹、写入剪贴板、归档等）完成后，
 * 通过此模块触发相应的数据刷新事件，实现无感刷新。
 */

// 数据刷新事件类型
// 说明：W2-E 登记收口时按「域」扩展了类型联合，覆盖 W1-C/W2-D 各域写工具对应的刷新目标。
// 消费方（clipboardLoad.ts / useCollections.ts 等）均按具体 type 精确匹配，新增枚举不会破坏既有订阅。
export type AiDataRefreshType =
  | 'clipboard' // 剪贴板数据变更（新增、归档、删除等）
  | 'collections' // 收藏夹变更
  | 'tags' // 标签变更
  | 'templates' // 模板变更
  | 'shared_links' // 分享链接变更
  | 'protection' // 保护（PIN/高级密码）变更
  | 'devices' // 设备变更
  | 'notifications' // 通知设置/已读状态变更
  | 'sessions' // 会话变更
  | 'versions' // 版本历史变更
  | 'workflows' // 自动化规则变更
  | 'template_variables' // 模板变量变更
  | 'profile' // 账号资料变更
  | 'subscriptions' // 订阅变更
  | 'surveys' // 满意度调查提交
  | 'all' // 全量刷新

export interface AiDataRefreshEvent {
  type: AiDataRefreshType
  toolName: string
  result?: any
  timestamp: number
}

const REFRESH_EVENT = 'clipsync:ai-data-refresh'

/**
 * 派发 AI 数据刷新事件
 */
export function dispatchAiDataRefresh(type: AiDataRefreshType, toolName: string, result?: any) {
  if (typeof window === 'undefined') return

  const event: AiDataRefreshEvent = {
    type,
    toolName,
    result,
    timestamp: Date.now(),
  }

  window.dispatchEvent(new CustomEvent(REFRESH_EVENT, { detail: event }))
}

/**
 * 监听 AI 数据刷新事件
 */
export function onAiDataRefresh(handler: (event: AiDataRefreshEvent) => void): () => void {
  if (typeof window === 'undefined') return () => {}

  const listener = (e: Event) => {
    const detail = (e as CustomEvent).detail as AiDataRefreshEvent
    handler(detail)
  }

  window.addEventListener(REFRESH_EVENT, listener)
  return () => window.removeEventListener(REFRESH_EVENT, listener)
}

/**
 * 根据工具名称判断需要刷新的数据类型
 */
export function getRefreshTypeFromTool(toolName: string): AiDataRefreshType[] {
  // 剪贴板域写工具（新增、归档、软删、物理删、元数据/敏感/使用计数更新）
  const clipboardTools = [
    'write_clip',
    'tag_items',
    'archive_items',
    'unarchive_items',
    'update_clip_meta',
    'batch_favorite',
    'batch_delete',
    'destroy_clips',
    'ocr_clip_image',
    // W1-C：剪贴板正文/敏感标记/使用计数
    'update_clip',
    'mark_sensitive',
    'mark_clip_used',
  ]

  // 收藏夹 / 条目 / 标签写工具（重命名、移动、排序、级联删除、单归属移动、标签全量替换/删除）
  const collectionTools = [
    'create_collection',
    'create_sub_collection',
    // W1-C：收藏夹条目 / 标签 / 重命名 / 移动 / 排序 / 删除
    'delete_collection',
    'update_collection',
    'move_collection',
    'reorder_collections',
    'add_item_to_collection',
    'remove_item_from_collection',
    'update_collection_tags',
    'delete_tag',
  ]

  const templateTools = [
    'create_template',
    'update_template',
    // W2-D：模板删除
    'delete_template',
  ]

  const sharedLinkTools = [
    'create_shared_link',
    // W2-D：共享链接删除
    'delete_shared_link',
  ]

  // W1-C：保护域（PIN / 高级密码）
  const protectionTools = ['set_item_protection', 'remove_item_protection']

  // W2-D：设备域
  const deviceTools = ['update_device', 'unpair_own_device']

  // W2-D：通知域
  const notificationTools = ['update_notification_preferences', 'mark_notification_read']

  // W2-D：会话域
  const sessionTools = ['terminate_session']

  // W2-D：版本历史域
  const versionTools = ['restore_version']

  // W2-D：自动化规则（工作流）域
  const workflowTools = ['create_workflow_rule', 'update_workflow_rule', 'delete_workflow_rule']

  // W2-D：模板变量域
  const templateVariableTools = ['upsert_template_variables', 'delete_template_variable']

  // W2-D：账号资料域
  const profileTools = ['update_profile']

  // W2-D 可选：订阅域 / 调查域
  const subscriptionTools = ['cancel_subscription', 'resume_subscription']
  const surveyTools = ['submit_survey']

  if (clipboardTools.includes(toolName)) return ['clipboard']
  if (collectionTools.includes(toolName)) return ['collections']
  if (templateTools.includes(toolName)) return ['templates']
  if (sharedLinkTools.includes(toolName)) return ['shared_links']
  if (protectionTools.includes(toolName)) return ['protection']
  // 媒体上传（upload_image / upload_file）即时返回 URL，调用方直接把结果展示给用户，
  // 无列表需刷新，故不参与本事件映射。
  if (deviceTools.includes(toolName)) return ['devices']
  if (notificationTools.includes(toolName)) return ['notifications']
  if (sessionTools.includes(toolName)) return ['sessions']
  if (versionTools.includes(toolName)) return ['versions']
  if (workflowTools.includes(toolName)) return ['workflows']
  if (templateVariableTools.includes(toolName)) return ['template_variables']
  if (profileTools.includes(toolName)) return ['profile']
  if (subscriptionTools.includes(toolName)) return ['subscriptions']
  if (surveyTools.includes(toolName)) return ['surveys']

  return []
}

/**
 * 工具执行完成后触发相应的数据刷新
 */
export function triggerRefreshAfterTool(toolName: string, result?: any) {
  const types = getRefreshTypeFromTool(toolName)
  for (const type of types) {
    dispatchAiDataRefresh(type, toolName, result)
  }
}
