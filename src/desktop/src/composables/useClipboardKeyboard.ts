import { ref, onMounted, onUnmounted } from 'vue'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'

export interface ClipboardKeyboardOptions {
  showQuickPaste: ReturnType<typeof ref<boolean>>
  confirmOpen: ReturnType<typeof ref<boolean>>
  toggleQuickPaste: () => void
  copySelected: (item: ClipItem) => void
  deleteSelected: (item: ClipItem) => void
}

const STORAGE_KEY = 'clipsync-custom-shortcuts'

function savedAppKeys(id: string): string[] | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const ks = saved[id]
    return Array.isArray(ks) && ks.length ? ks : undefined
  } catch {
    return undefined
  }
}

function matchShortcut(saved: string[] | undefined, e: KeyboardEvent): boolean {
  if (!saved || !saved.length) return false
  const mainKey = saved[saved.length - 1]
  const needCtrl = saved.includes('Ctrl')
  const needAlt = saved.includes('Alt')
  const needShift = saved.includes('Shift')
  const pressedMain = e.key.length === 1 ? e.key.toUpperCase() : e.key
  return (
    pressedMain.toLowerCase() === mainKey.toLowerCase() &&
    needCtrl === (e.ctrlKey || e.metaKey) &&
    needAlt === e.altKey &&
    needShift === e.shiftKey
  )
}

/**
 * 剪贴板页键盘导航与快捷键：
 * - ESC 关闭 quick paste / confirm dialog
 * - Ctrl/Cmd+K 切换 quick paste
 * - Ctrl/Cmd+F 聚焦搜索框
 * - ↑↓ 选择行，Enter 复制，Delete 删除
 */
export function useClipboardKeyboard(options: ClipboardKeyboardOptions) {
  const clip = useClipboard()
  const focusedIndex = ref(0)

  function focusSearchBox() {
    const el = document.querySelector('.search-field input') as HTMLInputElement | null
    el?.focus()
    el?.select()
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (options.showQuickPaste.value) {
        options.showQuickPaste.value = false
        return
      }
      if (options.confirmOpen.value) {
        options.confirmOpen.value = false
        return
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault()
      options.toggleQuickPaste()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      const def = savedAppKeys('search') || ['Ctrl', 'F']
      if (matchShortcut(def, e)) {
        e.preventDefault()
        focusSearchBox()
      }
      return
    }

    const target = e.target as HTMLElement | null
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    if (typing || options.showQuickPaste.value || options.confirmOpen.value) return

    const list = clip.filteredItems.value
    if (!list.length) return
    if (focusedIndex.value >= list.length) focusedIndex.value = list.length - 1

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusedIndex.value = (focusedIndex.value + 1) % list.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusedIndex.value = (focusedIndex.value - 1 + list.length) % list.length
      return
    }
    if (matchShortcut(savedAppKeys('copyClip') || ['Enter'], e)) {
      e.preventDefault()
      const item = list[focusedIndex.value]
      if (item) options.copySelected(item)
      return
    }
    if (matchShortcut(savedAppKeys('deleteClip') || ['Delete'], e)) {
      e.preventDefault()
      const item = list[focusedIndex.value]
      if (item) options.deleteSelected(item)
      return
    }
  }

  onMounted(() => document.addEventListener('keydown', handleGlobalKeydown))
  onUnmounted(() => document.removeEventListener('keydown', handleGlobalKeydown))

  return { focusedIndex, toggleQuickPaste: options.toggleQuickPaste, handleGlobalKeydown }
}
