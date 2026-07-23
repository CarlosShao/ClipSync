import { ref, reactive, onMounted, onUnmounted, type Ref } from 'vue'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useFavoritePopover } from '@/composables/useFavoritePopover'
import { useClipboardActions } from '@/composables/useClipboardActions'

/**
 * 剪贴板右击上下文菜单 + 「更多」下拉状态管理。
 */
export function useContextMenu(actions: ReturnType<typeof useClipboardActions>, focusedIndex: Ref<number>) {
  const clip = useClipboard()
  const fav = useFavoritePopover()

  const ctxItem = ref<ClipItem | null>(null)
  const ctxX = ref(0)
  const ctxY = ref(0)
  const ctxInitialMode = ref<'main' | 'expiry'>('main')
  const moreOpenId = ref<string | null>(null)

  function openCtxMenu(item: ClipItem, e: MouseEvent) {
    if (!actions.requireUnlocked(item)) return
    const idx = clip.filteredItems.value.findIndex((i) => i.id === item.id)
    if (idx >= 0) focusedIndex.value = idx
    ctxInitialMode.value = 'main'
    ctxItem.value = item
    ctxX.value = e.clientX
    ctxY.value = e.clientY
  }

  function closeCtxMenu() {
    ctxItem.value = null
  }

  function toggleMore(item: ClipItem) {
    moreOpenId.value = moreOpenId.value === item.id ? null : item.id
  }

  function closeMore() {
    moreOpenId.value = null
  }

  function openExpiryFromDropdown(item: ClipItem, e: MouseEvent) {
    moreOpenId.value = null
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    ctxInitialMode.value = 'expiry'
    ctxItem.value = item
    ctxX.value = rect.right
    ctxY.value = rect.bottom
  }

  function handleDocClick(e: MouseEvent) {
    fav.handleDocClickForCollections(e)
    if (moreOpenId.value) {
      const target = e.target as HTMLElement
      if (!target.closest('.more-wrap')) moreOpenId.value = null
    }
  }

  onMounted(() => document.addEventListener('click', handleDocClick))
  onUnmounted(() => document.removeEventListener('click', handleDocClick))

  return reactive({
    ctxItem,
    ctxX,
    ctxY,
    ctxInitialMode,
    openCtxMenu,
    closeCtxMenu,
    moreOpenId,
    toggleMore,
    closeMore,
    openExpiryFromDropdown,
    handleDocClick,
  })
}
