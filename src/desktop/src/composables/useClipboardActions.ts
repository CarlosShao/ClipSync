import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { usePrivacy } from '@/composables/usePrivacy'
import { useItemPassword } from '@/composables/useItemPassword'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { logger } from '@/utils/logger'

export interface ClipboardActionOptions {
  emit: ClipboardActionEmits
  openProtectionDialog: (item: ClipItem) => void
}

export interface ClipboardActionEmits {
  (e: 'show-pin-dialog'): void
  (e: 'show-pin-setup'): void
  (e: 'preview-image', item: ClipItem): void
  (e: 'preview-text', item: ClipItem): void
  (e: 'preview-file', item: ClipItem): void
}

/**
 * 剪贴板条目的「复制 / 双击 / 预览」动作封装。
 * 集中处理 PIN/密码保护检查、敏感内容校验、类型路由。
 */
export function useClipboardActions(options: ClipboardActionOptions) {
  const { emit, openProtectionDialog } = options
  const { t } = useI18n()
  const toast = useSonner()
  const clip = useClipboard()
  const privacy = usePrivacy()
  const itemPw = useItemPassword()

  function requireUnlocked(item: ClipItem): boolean {
    if (itemPw.isItemProtected(item) && !itemPw.isUnlocked(item.id)) {
      openProtectionDialog(item)
      return false
    }
    return true
  }

  function promptForSensitive() {
    if (!privacy.pinSet.value) emit('show-pin-setup')
    else emit('show-pin-dialog')
  }

  async function copyWithPinCheck(item: ClipItem) {
    if (!requireUnlocked(item)) return false
    if (privacy.isItemSensitive(item) && !privacy.canCopySensitive()) {
      promptForSensitive()
      return false
    }
    const ok = await clip.copyItem(item)
    toast.show(ok ? t('copied') : t('copy_failed'), ok ? 'success' : 'error')
    privacy.scheduleClipboardClear()
    return ok
  }

  function onDblClick(item: ClipItem) {
    copyWithPinCheck(item)
  }

  async function onCopyItem(item: ClipItem) {
    return copyWithPinCheck(item)
  }

  function openLink(item: ClipItem) {
    const url = item.content.trim()
    if (!url) return
    import('@/lib/tauri').then((tauri) => {
      tauri.openUrl(url).catch(() => window.open(url, '_blank'))
    })
  }

  function onPreview(item: ClipItem) {
    if (!requireUnlocked(item)) return
    if (privacy.isItemSensitive(item) && !privacy.canCopySensitive()) {
      promptForSensitive()
      return
    }
    if (item.type === 'image') emit('preview-image', item)
    else if (item.type === 'link') openLink(item)
    else if (item.type === 'file') emit('preview-file', item)
    else emit('preview-text', item)
  }

  return {
    requireUnlocked,
    copyWithPinCheck,
    onDblClick,
    onCopyItem,
    onPreview,
    openLink,
  }
}
