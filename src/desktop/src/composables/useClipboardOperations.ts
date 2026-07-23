import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useSharePayload } from '@/composables/useSharePayload'
import { useClipItemDisplay } from '@/composables/useClipItemDisplay'
import { type ConfirmOptions } from '@/composables/useConfirmDialog'
import * as tauri from '@/lib/tauri'
import { createSharedLink } from '@/api/client'
import { logger } from '@/utils/logger'

export interface ClipboardOperationEmits {
  (e: 'show-pin-dialog'): void
  (e: 'show-pin-setup'): void
}

/**
 * 剪贴板批量/单条操作：删除、归档、恢复、分享、在文件夹中显示。
 */
export function useClipboardOperations(
  isArchive: { value: boolean },
  emit: ClipboardOperationEmits,
  showConfirm: (opts: ConfirmOptions) => void,
) {
  const { t } = useI18n()
  const toast = useSonner()
  const clip = useClipboard()
  const display = useClipItemDisplay()
  const { buildSharePayload } = useSharePayload()

  function handleBatchDelete() {
    if (clip.selectedCount.value === 0) {
      toast.show(t('batch_none'), 'warning')
      return
    }
    const count = clip.selectedCount.value
    const favCount = clip.items.value.filter((i) => i.selected && (i as any).isFavorite).length

    if (isArchive.value) {
      showConfirm({
        title: t('confirm_purge_title'),
        message: count === 1 ? t('confirm_purge_msg') : t('confirm_purge_batch_msg', { n: count }),
        confirmText: t('delete_permanent_btn'),
        confirmVariant: 'destructive',
        onConfirm: async () => {
          try {
            await clip.batchDelete()
            await clip.loadClipboardItems({ view: isArchive.value ? 'archive' : 'all' })
            toast.show(t('batch_deleted', { n: count }), 'success')
          } catch (err: any) {
            toast.show(err.message || t('del_fail'), 'error')
          }
        },
      })
      return
    }

    const msg =
      favCount > 0
        ? t('confirm_delete_permanent_fav_batch_msg', { n: favCount })
        : t('confirm_delete_permanent_batch_msg', { n: count })
    showConfirm({
      title: t('confirm_delete_title'),
      message: msg,
      confirmText: t('delete_permanent_btn'),
      confirmVariant: 'destructive',
      secondaryText: t('archive_instead_btn'),
      secondaryVariant: 'default',
      onConfirm: async () => {
        try {
          const favItems = clip.items.value.filter((i) => i.selected && (i as any).isFavorite)
          for (const fi of favItems) clip.toggleFavorite(fi)
          await clip.batchDelete()
          await clip.loadClipboardItems({ view: isArchive.value ? 'archive' : 'all' })
          toast.show(t('batch_deleted', { n: count }), 'success')
        } catch (err: any) {
          toast.show(err.message || t('del_fail'), 'error')
        }
      },
      onSecondary: async () => {
        try {
          const selected = clip.items.value.filter((i) => i.selected)
          for (const si of selected) await clip.archiveItem(si)
          toast.show(t('batch_archived', { n: selected.length }), 'success')
        } catch (err: any) {
          toast.show(err.message || t('archive_fail'), 'error')
        }
      },
    })
  }

  async function handleBatchUnarchive() {
    const selected = clip.items.value.filter((i) => i.selected)
    if (selected.length === 0) {
      toast.show(t('batch_none'), 'warning')
      return
    }
    try {
      for (const si of selected) await clip.unarchiveItem(si)
      toast.show(t('batch_restored', { n: selected.length }), 'success')
    } catch (err: any) {
      toast.show(err.message || t('archive_fail'), 'error')
    }
  }

  function handleSingleDelete(item: ClipItem) {
    const isFav = (item as any).isFavorite

    if (isArchive.value) {
      showConfirm({
        title: t('confirm_purge_title'),
        message: t('confirm_purge_msg'),
        confirmText: t('delete_permanent_btn'),
        confirmVariant: 'destructive',
        onConfirm: async () => {
          try {
            if (isFav) clip.toggleFavorite(item)
            await clip.deleteSingle(item)
            await clip.loadClipboardItems({ view: isArchive.value ? 'archive' : 'all' })
            toast.show(t('deleted'), 'success')
          } catch (err: any) {
            toast.show(err.message || t('del_fail'), 'error')
          }
        },
      })
      return
    }

    const msg = isFav ? t('confirm_delete_permanent_fav_msg') : t('confirm_delete_permanent_msg')
    showConfirm({
      title: t('confirm_delete_title'),
      message: msg,
      confirmText: t('delete_permanent_btn'),
      confirmVariant: 'destructive',
      secondaryText: t('archive_instead_btn'),
      secondaryVariant: 'default',
      onConfirm: async () => {
        try {
          if (isFav) clip.toggleFavorite(item)
          await clip.deleteSingle(item)
          await clip.loadClipboardItems({ view: isArchive.value ? 'archive' : 'all' })
          toast.show(t('deleted'), 'success')
        } catch (err: any) {
          toast.show(err.message || t('del_fail'), 'error')
        }
      },
      onSecondary: async () => {
        const ok = await clip.archiveItem(item)
        if (ok) toast.show(t('archived_toast'), 'success')
        else toast.show(t('archive_fail'), 'error')
      },
    })
  }

  async function handleUnarchive(item: ClipItem) {
    try {
      const ok = await clip.unarchiveItem(item)
      if (ok) toast.show(t('unarchived_toast'), 'success')
      else toast.show(t('archive_fail'), 'error')
    } catch (err: any) {
      toast.show(err.message || t('archive_fail'), 'error')
    }
  }

  async function onArchiveToggle(item: ClipItem) {
    if (isArchive.value) {
      const ok = await clip.unarchiveItem(item)
      toast.show(ok ? t('unarchived_toast') : t('archive_fail'), ok ? 'success' : 'error')
    } else {
      const ok = await clip.archiveItem(item)
      toast.show(ok ? t('archived_toast') : t('archive_fail'), ok ? 'success' : 'error')
    }
  }

  async function revealFileFolder(item: ClipItem) {
    try {
      const data = JSON.parse(item.content)
      if (data.paths && Array.isArray(data.paths) && data.paths[0]) {
        tauri.revealInFolder(data.paths[0]).catch(() => {
          const dir = data.paths[0].replace(/[/\\][^/\\]+$/, '')
          tauri.openUrl(dir).catch(() => toast.show(t('err_open_folder'), 'error'))
        })
        return
      }
      if (data.path && typeof data.path === 'string' && data.path.length > 0) {
        tauri.revealInFolder(data.path).catch(() => {
          const dir = data.path.replace(/[/\\][^/\\]+$/, '')
          tauri.openUrl(dir).catch(() => toast.show(t('err_open_folder'), 'error'))
        })
        return
      }
      if (Array.isArray(data) && data.length > 0) {
        tauri.revealInFolder(data[0]).catch(() => {
          const dir = data[0].replace(/[/\\][^/\\]+$/, '')
          tauri.openUrl(dir).catch(() => toast.show(t('err_open_folder'), 'error'))
        })
        return
      }
    } catch (e) {
      logger.debug('[Clipboard] open path failed:', e)
    }
    toast.show(t('err_no_path'), 'warning')
  }

  async function shareItem(item: ClipItem) {
    const privacy = (await import('@/composables/usePrivacy')).usePrivacy()
    if (privacy.isItemSensitive(item) && !privacy.canCopySensitive()) {
      if (!privacy.pinSet.value) emit('show-pin-setup')
      else emit('show-pin-dialog')
      return
    }

    const payload = await buildSharePayload(item)
    if (!payload) {
      toast.show(t('shared_link_create_err'), 'error')
      return
    }

    try {
      const created = await createSharedLink({
        content: payload.content,
        title: payload.title,
        contentType: payload.contentType,
        fileKey: payload.fileKey,
        fileName: payload.fileName,
        fileSize: payload.fileSize,
      })
      if (!created) {
        toast.show(t('shared_link_create_err'), 'error')
        return
      }
      const ok = await clip.copyText(created.url)
      toast.show(ok ? t('shared_link_copied') : t('shared_link_copy_err'), ok ? 'success' : 'error')
    } catch (e: any) {
      logger.debug('[Clipboard] share failed', e)
      toast.show(t('shared_link_create_err'), 'error')
    }
  }

  return {
    handleBatchDelete,
    handleBatchUnarchive,
    handleSingleDelete,
    handleUnarchive,
    onArchiveToggle,
    revealFileFolder,
    shareItem,
  }
}
