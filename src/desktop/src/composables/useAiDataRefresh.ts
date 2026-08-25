/**
 * AI 数据刷新事件系统
 * 
 * 当 AI Agent 执行工具操作（创建收藏夹、写入剪贴板、归档等）完成后，
 * 通过此模块触发相应的数据刷新事件，实现无感刷新。
 */

// 数据刷新事件类型
export type AiDataRefreshType = 
  | 'clipboard'      // 剪贴板数据变更（新增、归档、删除等）
  | 'collections'    // 收藏夹变更
  | 'tags'           // 标签变更
  | 'templates'      // 模板变更
  | 'shared_links'   // 分享链接变更
  | 'all'            // 全量刷新

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
  const clipboardTools = [
    'write_clip', 'tag_items', 'archive_items', 'unarchive_items',
    'update_clip_meta', 'batch_favorite', 'batch_delete', 'destroy_clips',
    'ocr_clip_image',
  ]
  
  const collectionTools = ['create_collection']
  const templateTools = ['create_template', 'update_template']
  const sharedLinkTools = ['create_shared_link']
  
  if (clipboardTools.includes(toolName)) return ['clipboard']
  if (collectionTools.includes(toolName)) return ['collections']
  if (templateTools.includes(toolName)) return ['templates']
  if (sharedLinkTools.includes(toolName)) return ['shared_links']
  
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
