// === ClipSync 内部复制去重（精确内容匹配） ===
// 用户铁律：从 ClipSync UI 复制任何条目，都不应再次产生重复记录。
// 策略1: 时间戳跳过（复制后短时间内不处理剪贴板变化）
// 策略2: 精确内容匹配（复制时记录会写入剪贴板的内容/文件路径，monitor 检测到匹配内容时跳过）
import { setSkipPollUntil, type ClipItem } from './clipboardState'
import { logger } from '@/utils/logger'

// 记录从 ClipSync UI 复制出去的内容：文件路径 或 文本/链接内容
const copiedFilePaths = new Map<string, number>()
export const copiedTexts = new Map<string, number>()
export const copiedItems = new Map<string, { type: string; content: string; timestamp: number }>()
const COPIED_CONTENT_TTL = 15000

export function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/')
}

function extractFilenameFromPreview(preview: string): string {
  const match = preview.match(/\[文件\]\s+(.+?)\s*(?:\(|$)/)
  return match ? match[1].trim() : preview.trim()
}

export function skipNextPolls(ms = 6000) {
  setSkipPollUntil(Date.now() + ms)
}

export function cleanupCopiedContent() {
  const now = Date.now()
  for (const [k, t] of copiedFilePaths) {
    if (now - t > COPIED_CONTENT_TTL) copiedFilePaths.delete(k)
  }
  for (const [k, t] of copiedTexts) {
    if (now - t > COPIED_CONTENT_TTL) copiedTexts.delete(k)
  }
  for (const [k, t] of copiedItems) {
    if (now - t.timestamp > COPIED_CONTENT_TTL) copiedItems.delete(k)
  }
}

// 复制时记录该条目对应的真实剪贴板内容，用于 monitor 去重
export function markContentCopiedFromClipSync(item: ClipItem) {
  const now = Date.now()
  copiedItems.set(item.id, { type: item.type, content: item.content, timestamp: now })
  if (item.type === 'file') {
    try {
      const parsed = JSON.parse(item.content)
      const paths = Array.isArray(parsed) ? parsed : parsed?.paths
      if (Array.isArray(paths)) {
        paths.forEach((p: string) => copiedFilePaths.set(normalizePath(p), now))
      }
    } catch { /* ignore */ }
  } else if (item.type === 'text' || item.type === 'link') {
    copiedTexts.set(item.content, now)
  }
  cleanupCopiedContent()
}

// 检查 monitor/poll 检测到的内容是否正是刚从 ClipSync 内部复制出去的
export function isClipboardChangeFromInternalCopy(payload: any, contentType?: string): boolean {
  cleanupCopiedContent()
  if (contentType === 'file') {
    const paths = payload?.filePaths as string[] | undefined
    if (paths?.some(p => copiedFilePaths.has(normalizePath(p)))) {
      logger.debug('[Clipboard] skip file upload: path matches internal copy', paths)
      return true
    }
    // Fallback: 路径未精确匹配（大小写/规范化差异），用文件名兜底
    const preview = payload?.content as string | undefined
    if (preview) {
      const filename = extractFilenameFromPreview(preview)
      for (const [id, info] of copiedItems) {
        if (info.type !== 'file') continue
        try {
          const parsed = JSON.parse(info.content)
          const name = parsed?.name || (Array.isArray(parsed) ? parsed[0]?.split(/[/\\]/).pop() : '')
          if (name && filename && (filename === name || filename.includes(name))) {
            logger.debug('[Clipboard] skip file upload: filename matches internal copy', filename)
            return true
          }
        } catch { /* ignore */ }
      }
    }
  }
  if (!contentType) {
    const text = payload?.content as string | undefined
    if (text ? copiedTexts.has(text) : false) {
      logger.debug('[Clipboard] skip text upload: content matches internal copy')
      return true
    }
  }
  return false
}
