import { api } from '@/api/client'
import { uploadSharedFile } from '@/api/client'
import * as tauri from '@/lib/tauri'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useClipItemDisplay } from '@/composables/useClipItemDisplay'
import type { ClipItem } from '@/composables/useClipboard'

/**
 * 构建分享链接的请求体：按条目类型（文本/链接/图片/文件）取完整内容或上传文件。
 * 从 ClipboardView 抽出的纯数据逻辑，不含 UI/PIN 流程。
 */
export function useSharePayload() {
  const { t } = useI18n()
  const toast = useSonner()
  const display = useClipItemDisplay()

  async function buildSharePayload(item: ClipItem): Promise<{
    content: string
    title: string
    contentType: string
    fileKey?: string
    fileName?: string
    fileSize?: number
  } | null> {
    const isLocalItem = /^local-|^text-|^file-|^img-|^browser-/.test(item.id)
    const contentSize = item.contentSize || 0

    // 文本 / 链接：确保拿到完整内容，不分享被截断的预览
    if (item.type === 'text' || item.type === 'link') {
      let textContent = item.content
      const needsFetch =
        !isLocalItem && textContent.length > 0 && (contentSize === 0 || textContent.length < contentSize)
      if (needsFetch) {
        try {
          const full = await api<{ contentEncrypted: string }>('GET', `/api/clipboard/${item.id}/content`)
          if (full.ok && full.data?.contentEncrypted) {
            textContent = full.data.contentEncrypted
          }
        } catch (e: any) {
          console.warn('[Clipboard] failed to fetch full content for share:', e?.message || e)
        }
      }
      if (!textContent) return null
      return {
        content: textContent,
        title: textContent.slice(0, 60),
        contentType: item.type,
      }
    }

    // 图片：优先用本地 data URL，否则从服务器拉完整内容
    if (item.type === 'image') {
      let imgData = item.content || item.preview || ''
      if (!imgData || imgData.startsWith('[Image')) {
        try {
          const full = await api('GET', `/api/clipboard/${item.id}`)
          imgData = full.data?.contentEncrypted || full.data?.contentPreview || ''
        } catch (e: any) {
          console.warn('[Clipboard] failed to fetch image for share:', e?.message || e)
        }
      }
      if (!imgData || imgData.startsWith('[Image')) return null
      return {
        content: imgData,
        title: item.metadata?.originalName || item.metadata?.name || 'Image',
        contentType: 'image',
      }
    }

    // 文件：读取真实文件、上传到后端，生成可下载的分享链接
    if (item.type === 'file') {
      const filePath = display.extractFilePath(item.content)
      if (!filePath) {
        console.warn('[Clipboard] share file: no file path found in item.content')
        return null
      }
      let base64: string
      try {
        base64 = await tauri.readFileContentBase64(filePath)
      } catch (e: any) {
        console.warn('[Clipboard] failed to read file for share:', e?.message || e)
        return null
      }
      const fileName = display.formatContent(item) || filePath.split(/[/\\]/).pop() || 'file'
      const blob = display.base64ToBlob(base64)
      const file = new File([blob], fileName)
      if (file.size > 50 * 1024 * 1024) {
        toast.show(t('shared_link_file_too_large'), 'warning')
        return null
      }
      const uploaded = await uploadSharedFile(file)
      if (!uploaded.ok) {
        console.warn('[Clipboard] failed to upload file for share:', uploaded.error)
        toast.show(uploaded.error, 'error')
        return null
      }
      return {
        content: '',
        title: fileName,
        contentType: 'file',
        fileKey: uploaded.fileKey,
        fileName: uploaded.fileName,
        fileSize: uploaded.fileSize,
      }
    }

    return null
  }

  return { buildSharePayload }
}
