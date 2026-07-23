// === 剪贴板事件上传队列（并发控制核心）===
// 问题：Rust monitor 每 700ms 轮询并立即 emit 事件；之前用 isProcessingEvent 布尔锁直接
// 丢弃并发事件，导致用户快速连续复制多个文件时只有一个能上传。
// 方案：所有事件/轮询检测到的内容先捕获并入队，队列串行消费，确保每个文件/图片/文本
// 都按序上传，互不抢占。
import { items, recentUploadHashes, HASH_TTL } from './clipboardState'
import { normalizePath, isClipboardChangeFromInternalCopy } from './clipboardDedup'
import { simpleHash, uploadToServer, uploadImageToServer, uploadFileToServer } from './clipboardUpload'
import { logger } from '@/utils/logger'

interface ClipboardTask {
  type: 'file' | 'image' | 'text'
  payload: any
}

const clipboardQueue: ClipboardTask[] = []
let isProcessingQueue = false

export function enqueueClipboardTask(task: ClipboardTask) {
  if (task.type === 'file') {
    const paths = task.payload as string[]
    const normalized = JSON.stringify(paths.map(normalizePath))
    if (
      clipboardQueue.some(
        (t) => t.type === 'file' && JSON.stringify((t.payload as string[]).map(normalizePath)) === normalized,
      )
    ) {
      logger.debug('[Clipboard] queue: skip duplicate file task', paths)
      return
    }
  } else if (task.type === 'text') {
    const text = task.payload as string
    if (clipboardQueue.some((t) => t.type === 'text' && t.payload === text)) {
      logger.debug('[Clipboard] queue: skip duplicate text task')
      return
    }
  } else if (task.type === 'image') {
    const p = task.payload as { dataUrl?: string; hash?: string }
    const key = p.hash || p.dataUrl
    if (
      key &&
      clipboardQueue.some(
        (t) =>
          t.type === 'image' &&
          ((t.payload as { dataUrl?: string; hash?: string }).hash || (t.payload as { dataUrl?: string }).dataUrl) ===
            key,
      )
    ) {
      logger.debug('[Clipboard] queue: skip duplicate image task')
      return
    }
  }
  clipboardQueue.push(task)
  logger.debug('[Clipboard] queue: task enqueued', task.type, 'length:', clipboardQueue.length)
  processClipboardQueue().catch((e) => console.warn('[Clipboard] processClipboardQueue error:', e))
}

async function processClipboardQueue() {
  if (isProcessingQueue) return
  isProcessingQueue = true
  try {
    while (clipboardQueue.length > 0) {
      const task = clipboardQueue.shift()
      if (!task) continue
      logger.debug('[Clipboard] queue: processing task', task.type, 'remaining:', clipboardQueue.length)
      try {
        if (task.type === 'file') {
          const paths = task.payload as string[]
          const payload = JSON.stringify(paths)
          const payloadHash = simpleHash(payload)
          const alreadyUploading =
            recentUploadHashes.has(payloadHash) && Date.now() - (recentUploadHashes.get(payloadHash) || 0) < HASH_TTL
          if (!alreadyUploading && !items.value.some((i) => i.type === 'file' && i.content === payload)) {
            await uploadFileToServer(payload)
          } else {
            logger.debug('[Clipboard] queue: skip file already uploading or exists', paths)
          }
        } else if (task.type === 'text') {
          const text = task.payload as string
          const isUrl = /^https?:\/\/\S+$/.test(text.trim())
          const itemType = isUrl ? 'link' : 'text'
          // 先从 copiedTexts/copiedItems 判断：这是自己刚复制出去的内容，必须跳过。
          // 不能仅靠 items.value.some(i.content === text) 去重，因为列表里可能是预览内容，
          // 而剪贴板/服务端已经是完整内容，导致复制长文本后又被当作新内容重复上传。
          if (isClipboardChangeFromInternalCopy({ content: text }, undefined)) {
            logger.debug('[Clipboard] queue: skip text from internal copy')
            continue
          }
          if (!items.value.some((i) => (i.type === 'text' || i.type === 'link') && i.content === text)) {
            await uploadToServer(text, itemType)
          } else {
            logger.debug('[Clipboard] queue: skip text already exists')
          }
        } else if (task.type === 'image') {
          const { dataUrl, hash } = task.payload as { dataUrl: string; size: number; hash?: string }
          if (dataUrl) {
            await uploadImageToServer(dataUrl, hash)
          }
        }
      } catch (e) {
        console.warn('[Clipboard] queue: task error', task.type, e)
      }
    }
  } finally {
    isProcessingQueue = false
    // 处理期间可能有新任务入队，触发再消费
    if (clipboardQueue.length > 0) {
      processClipboardQueue().catch((e) => console.warn('[Clipboard] processClipboardQueue restart error:', e))
    }
  }
}
