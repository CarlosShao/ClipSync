import { ref, onMounted, onUnmounted, type Ref } from 'vue'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'

export interface ClipboardKeyboardOptions {
  /** 列表级确认框（ConfirmDialog）—— 打开时冻结列表快捷键 */
  confirmOpen: Ref<boolean>
  toggleQuickPaste: () => void
  copySelected: (item: ClipItem) => void
  deleteSelected: (item: ClipItem) => void
}

const STORAGE_KEY = 'clipsync-custom-shortcuts'

// === 全局键盘层级栈（B3）===
// 仲裁顺序由低到高：列表 < 快速粘贴 < AI 面板 < ModalManager 弹窗 < 预览弹窗 < PIN 弹窗。
// Esc 由"当前最高且已打开"的那一层消费，避免按一次 Esc 关掉底层而顶层还在。
// 除列表外任意一层打开时，列表快捷键（↑↓/Enter/Delete）整体冻结。
export const KEYBOARD_LAYER_PRIORITY = ['list', 'quickPaste', 'ai', 'modal', 'preview', 'pin'] as const
export type KeyboardLayer = (typeof KEYBOARD_LAYER_PRIORITY)[number]

const layerOpen: Record<KeyboardLayer, boolean> = {
  list: true,
  quickPaste: false,
  ai: false,
  modal: false,
  preview: false,
  pin: false,
}

/**
 * 快速粘贴面板开关的唯一真相源。
 * HomeView 持有真实状态并写入这里；ClipboardView 只读它来判断"弹层是否打开"。
 * 之前两个组件各自持有一份 ref，Ctrl+K 触发两条 toggle 链（HomeView 一次 +
 * ClipboardView emit 再一次），同一次按键被 toggle 两次 → 互相抵消。
 */
export const quickPasteOpen = ref(false)

export function setKeyboardLayer(layer: KeyboardLayer, open: boolean) {
  layerOpen[layer] = open
}

/** 当前最高优先级的已打开层级（始终至少是 list） */
export function topKeyboardLayer(): KeyboardLayer {
  for (let i = KEYBOARD_LAYER_PRIORITY.length - 1; i >= 0; i--) {
    const layer = KEYBOARD_LAYER_PRIORITY[i]
    if (layerOpen[layer]) return layer
  }
  return 'list'
}

/** 列表之外是否还有弹层打开 —— 打开时必须冻结列表快捷键 */
export function isOverlayOpen(): boolean {
  return topKeyboardLayer() !== 'list'
}

/** 卸载/登出时清理，避免残留 true 永久冻结列表快捷键 */
export function resetKeyboardLayers() {
  layerOpen.quickPaste = false
  layerOpen.ai = false
  layerOpen.modal = false
  layerOpen.preview = false
  layerOpen.pin = false
  quickPasteOpen.value = false
}

export function setQuickPasteOpen(v: boolean) {
  quickPasteOpen.value = v
  setKeyboardLayer('quickPaste', v)
}

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
 * - Ctrl/Cmd+F 聚焦搜索框
 * - ↑↓ 选择行，Enter 复制，Delete 删除
 * - Esc 与 Ctrl/Cmd+K 不再在此注册：Esc 由 HomeView 按层级栈统一仲裁，
 *   Ctrl+K 由 HomeView 单通道处理（避免双通道互相抵消）。
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
    // 搜索框聚焦：列表导航之前处理，输入中也能用（与 Esc/Ctrl+K 不同，它属于页面级功能）
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
    // 输入中 或 有任意弹层打开 → 冻结列表快捷键（层级见 KEYBOARD_LAYER_PRIORITY）
    if (typing || isOverlayOpen()) return

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
    }
  }

  onMounted(() => document.addEventListener('keydown', handleGlobalKeydown))
  onUnmounted(() => document.removeEventListener('keydown', handleGlobalKeydown))

  return { focusedIndex, toggleQuickPaste: options.toggleQuickPaste, handleGlobalKeydown }
}
