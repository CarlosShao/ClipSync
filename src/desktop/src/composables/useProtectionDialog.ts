import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useItemPassword } from '@/composables/useItemPassword'

/**
 * 统一保护级别对话框（ProtectionDialog）状态与事件流。
 * 打开/保护/解除保护/解锁成功后同步本地条目元数据。
 */
export function useProtectionDialog() {
  const { t } = useI18n()
  const toast = useSonner()
  const clip = useClipboard()
  const itemPw = useItemPassword()

  const protectionDialogOpen = ref(false)
  const protectionDialogItem = ref<ClipItem | null>(null)

  function openProtectionDialog(item: ClipItem) {
    protectionDialogItem.value = item
    protectionDialogOpen.value = true
  }

  function onProtectionProtected(level: string) {
    // 更新本地条目元数据，让 UI 立即反映保护状态
    if (protectionDialogItem.value) {
      const item = clip.items.value.find((i) => i.id === protectionDialogItem.value!.id)
      if (item) {
        if (!item.metadata) item.metadata = {}
        item.isProtected = true
        if (level === 'advanced') {
          item.metadata.protected = true
        } else if (level === 'pin') {
          item.metadata.sensitive = true
        }
      }
    }
    toast.show(t('protection_applied'), 'success')
  }

  function onProtectionUnprotected() {
    // 清除本地条目保护状态
    if (protectionDialogItem.value) {
      const item = clip.items.value.find((i) => i.id === protectionDialogItem.value!.id)
      if (item) {
        if (item.metadata) {
          item.metadata.protected = false
          item.metadata.sensitive = false
        }
        item.isProtected = false
        itemPw.lockItem(protectionDialogItem.value.id)
      }
    }
    toast.show(t('protection_removed'), 'success')
  }

  function onProtectionUnlocked(content: string) {
    if (!protectionDialogItem.value) return
    const item = clip.items.value.find((i) => i.id === protectionDialogItem.value!.id)
    if (!item) return

    // 高级加密：解锁状态写入 itemPw.unlockedIds
    if ((item as any).metadata?.protected === true) {
      itemPw.setUnlocked(item.id, content)
    }

    // PIN 保护：解锁状态由 privacy 模块管理，只更新明文内容
    if (item.metadata?.sensitive) {
      item.content = content
    }

    toast.show(t('protection_unlocked'), 'success')
  }

  return {
    protectionDialogOpen,
    protectionDialogItem,
    openProtectionDialog,
    onProtectionProtected,
    onProtectionUnprotected,
    onProtectionUnlocked,
  }
}
