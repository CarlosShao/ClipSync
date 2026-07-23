import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useClipboard } from '@/composables/useClipboard'
import { useConfigStore } from '@/stores/configStore'

/**
 * 剪贴板文件上传：触发文件选择、按套餐限制大小、调用 useClipboard.uploadFileItem。
 */
export function useFileUpload() {
  const { t } = useI18n()
  const toast = useSonner()
  const clip = useClipboard()
  const configStore = useConfigStore()

  const fileInputRef = ref<HTMLInputElement>()

  function triggerFileUpload() {
    fileInputRef.value?.click()
  }

  function planMaxBytes(): number {
    const plan = configStore.user.plan || 'Free'
    if (plan === 'Pro' || plan === 'pro' || plan === '专业版') return 256 * 1024 * 1024
    if (plan === 'Enterprise' || plan === 'enterprise' || plan === '企业版') return 1024 * 1024 * 1024
    return 128 * 1024 * 1024
  }

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
        const sizeStr = file.size < 1024 * 1024
          ? `${(file.size / 1024).toFixed(0)}KB`
          : `${(file.size / 1024 / 1024).toFixed(1)}MB`
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
