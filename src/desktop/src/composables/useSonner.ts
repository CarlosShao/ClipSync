import { toast } from 'vue-sonner'

export interface SonnerToast {
  show(message: string, type?: 'success' | 'error' | 'warning' | 'info', duration?: number): void
  /** 持续 loading 提示（不会自动消失），返回 id 用于操作完成后 dismiss 或切换为 success/error */
  loading(message: string): string | number
  /** 关闭指定 id 的 toast（通常用于关闭 loading） */
  dismiss(id?: string | number): void
  /**
   * 限流倒计时提示：显示「限流中，N 秒后重试」并每秒递减。
   * 倒计时结束后自动关闭（duration 0 表示交给内部定时器控制）。
   * @returns toast id（可用于手动 dismiss）
   */
  rateLimited(seconds: number): string | number
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

  function rateLimited(seconds: number): string | number {
    const initial = Math.max(1, Math.ceil(seconds))
    let remaining = initial
    // 持续显示，由内部定时器消失
    const id = toast.warning(`限流中，请 ${remaining} 秒后重试`, { duration: Infinity })
    const timer = setInterval(() => {
      remaining -= 1
      if (remaining <= 0) {
        clearInterval(timer)
        toast.dismiss(id)
        return
      }
      toast.warning(`限流中，请 ${remaining} 秒后重试`, { id, duration: Infinity })
    }, 1000)
    return id
  }

  return { show, loading, dismiss, rateLimited }
}
