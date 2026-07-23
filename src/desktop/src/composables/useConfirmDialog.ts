import { ref } from 'vue'

// ===== Confirm Dialog =====
export interface ConfirmOptions {
  title: string
  message: string
  confirmText: string
  confirmVariant?: 'default' | 'destructive'
  secondaryText?: string
  secondaryVariant?: 'default' | 'outline' | 'destructive'
  onConfirm: () => void
  onSecondary?: () => void
}

/**
 * 确认对话框状态机（标题/消息/主按钮/次按钮 + 回调）。
 * ClipboardView 的批量删除/单条删除共用。
 */
export function useConfirmDialog() {
  const confirmOpen = ref(false)
  const confirmTitle = ref('')
  const confirmMessage = ref('')
  const confirmConfirmText = ref('')
  const confirmCallback = ref<(() => void) | null>(null)
  const confirmVariant = ref<'default' | 'destructive'>('destructive')
  const confirmSecondaryText = ref('')
  const confirmSecondaryVariant = ref<'default' | 'outline' | 'destructive'>('outline')
  const confirmSecondaryCallback = ref<(() => void) | null>(null)

  function showConfirm(opts: ConfirmOptions) {
    confirmTitle.value = opts.title
    confirmMessage.value = opts.message
    confirmConfirmText.value = opts.confirmText
    confirmCallback.value = opts.onConfirm
    confirmVariant.value = opts.confirmVariant ?? 'destructive'
    confirmSecondaryText.value = opts.secondaryText ?? ''
    confirmSecondaryVariant.value = opts.secondaryVariant ?? 'outline'
    confirmSecondaryCallback.value = opts.onSecondary ?? null
    confirmOpen.value = true
  }

  function onConfirmDialog() {
    const cb = confirmCallback.value
    confirmOpen.value = false
    confirmCallback.value = null
    confirmSecondaryCallback.value = null
    if (cb) cb()
  }

  function onCancelDialog() {
    confirmOpen.value = false
    confirmCallback.value = null
    confirmSecondaryCallback.value = null
  }

  function onSecondaryDialog() {
    const cb = confirmSecondaryCallback.value
    confirmOpen.value = false
    confirmSecondaryCallback.value = null
    confirmCallback.value = null
    if (cb) cb()
  }

  return {
    confirmOpen,
    confirmTitle,
    confirmMessage,
    confirmConfirmText,
    confirmVariant,
    confirmSecondaryText,
    confirmSecondaryVariant,
    showConfirm,
    onConfirmDialog,
    onCancelDialog,
    onSecondaryDialog,
  }
}
