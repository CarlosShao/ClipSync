import { toast } from 'vue-sonner'

export interface SonnerToast {
  show(message: string, type?: 'success' | 'error' | 'warning' | 'info', duration?: number): void
  /** 持续 loading 提示（不会自动消失），返回 id 用于操作完成后 dismiss 或切换为 success/error */
  loading(message: string): string | number
  /** 关闭指定 id 的 toast（通常用于关闭 loading） */
  dismiss(id?: string | number): void
}

export function useSonner(): SonnerToast {
  const typeMap: Record<string, (message: string, options?: Record<string, unknown>) => void> = {
    success: (msg, opts) => toast.success(msg, opts),
    error: (msg, opts) => toast.error(msg, opts),
    warning: (msg, opts) => toast.warning(msg, opts),
    info: (msg, opts) => toast.info(msg, opts),
  }

  function show(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info', duration = 3000) {
    const fn = typeMap[type] || toast.info
    fn(message, { duration })
  }

  function loading(message: string): string | number {
    return toast.loading(message, { duration: Infinity })
  }

  function dismiss(id?: string | number): void {
    if (id) toast.dismiss(id)
    else toast.dismiss()
  }

  return { show, loading, dismiss }
}
