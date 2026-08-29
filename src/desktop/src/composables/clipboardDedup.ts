// === ClipSync 内部复制去重（精确内容匹配） ===
// 用户铁律：从 ClipSync UI 复制任何条目，都不应再次产生重复记录。
// 策略1: 时间戳跳过（复制后短时间内不处理剪贴板变化）
// 策略2: 精确内容匹配（复制时记录会写入剪贴板的内容/文件路径，monitor 检测到匹配内容时跳过）
import { setSkipPollUntil, pollIntervalMs, type ClipItem } from './clipboardState'
import { logger } from '@/utils/logger'

// 记录从 ClipSync UI 复制出去的内容：文件路径 或 文本/链接内容
const copiedFilePaths = new Map<string, number>()
export const copiedTexts = new Map<string, number>()
export const copiedItems = new Map<string, { type: string; content: string; timestamp: number }>()
// 图片回写去重：key 是 data URL 的哈希（与 useClipboard 的 lastImageHash 同族）。
// 图片不能像文本那样按内容精确比对 —— 写回剪贴板的字节与 monitor 读回后重新编码的
// data URL 未必逐字节相等，但同一族哈希在稳定编码路径下一致，足以拦住自身回写。
const copiedImageHashes = new Map<string, number>()
const COPIED_CONTENT_TTL_BASE = 15000
// 去重窗口必须至少覆盖一次兜底轮询：syncInterval（B8）可以被调到 5/15 分钟，
// 若窗口仍固定 15s，下一次轮询落在窗口外就会把「刚从 ClipSync 复制出去的内容」
// 当成外部新内容重新上传一条。
function copiedContentTtl(): number {
  const interval = pollIntervalMs.value
  if (!Number.isFinite(interval) || interval <= 0) return COPIED_CONTENT_TTL_BASE
  return Math.max(COPIED_CONTENT_TTL_BASE, interval + 5000)
}

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
  const ttl = copiedContentTtl()
  for (const [k, t] of copiedFilePaths) {
    if (now - t > ttl) copiedFilePaths.delete(k)
  }
  for (const [k, t] of copiedTexts) {
    if (now - t > ttl) copiedTexts.delete(k)
  }
  for (const [k, t] of copiedItems) {
    if (now - t.timestamp > ttl) copiedItems.delete(k)
  }
  for (const [k, t] of copiedImageHashes) {
    if (now - t > ttl) copiedImageHashes.delete(k)
  }
}

/**
 * 登记一次图片回写：传入 data URL 的哈希（simpleHash，与 lastImageHash 同族）。
 * copyItem 写回图片后会同时登记「写入内容」与「读回内容」两把哈希 —— 后者才是
 * 兜底轮询真正会看到的值，两把都登记才能真正拦住自身回写被重新上传。
 */
export function markImageCopiedFromClipSync(...hashes: (string | undefined | null)[]) {
  const now = Date.now()
  for (const h of hashes) {
    if (h) copiedImageHashes.set(h, now)
  }
  cleanupCopiedContent()
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
    } catch {
      /* ignore */
    }
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
    if (paths?.some((p) => copiedFilePaths.has(normalizePath(p)))) {
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
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (contentType === 'image') {
    const hash = payload?.hash as string | undefined
    if (hash ? copiedImageHashes.has(hash) : false) {
      logger.debug('[Clipboard] skip image upload: hash matches internal copy')
      return true
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
