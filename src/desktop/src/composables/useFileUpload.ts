import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useClipboard } from '@/composables/useClipboard'
import { planMaxUploadBytes } from '@/composables/clipboardUpload'

/**
 * 剪贴板文件上传：触发文件选择、按套餐限制大小、调用 useClipboard.uploadFileItem。
 */
export function useFileUpload() {
  const { t } = useI18n()
  const toast = useSonner()
  const clip = useClipboard()

  const fileInputRef = ref<HTMLInputElement>()

  function triggerFileUpload() {
    fileInputRef.value?.click()
  }

  // 套餐大小上限统一走 clipboardUpload.planMaxUploadBytes（Free 128MB / Pro 256MB / Ent 1GB），
  // 与剪贴板自动捕获（D1）共用同一份阈值，避免两处漂移。
  const planMaxBytes = planMaxUploadBytes

  async function handleFileUpload(e: Event) {
    const input = e.target as HTMLInputElement
    if (!input.files?.length) return
    const files = Array.from(input.files)
    input.value = ''

    let errorCount = 0
    for (const file of files) {
      const maxBytes = planMaxBytes()
      if (file.size > maxBytes) {
        const maxMb = Math.round(maxBytes / 1024 / 1024)
        const sizeStr =
          file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(0)}KB` : `${(file.size / 1024 / 1024).toFixed(1)}MB`
        toast.show(`${file.name}: ${t('file_exceeds_plan', { size: sizeStr, limit: `${maxMb}MB`, plan: '' })}`, 'error')
        errorCount++
        continue
      }
      try {
        await clip.uploadFileItem(file)
      } catch (err: any) {
        errorCount++
        toast.show(`${file.name}: ${err.message || t('upload_fail')}`, 'error')
      }
    }

    if (files.length > 0 && errorCount < files.length) {
      toast.show(t('upload_success'), 'success')
    }
  }

  return {
    fileInputRef,
    triggerFileUpload,
    handleFileUpload,
  }
}
