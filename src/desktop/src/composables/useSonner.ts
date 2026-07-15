import { toast } from 'vue-sonner'

export interface SonnerToast {
  show(message: string, type?: 'success' | 'error' | 'warning' | 'info', duration?: number): void
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

  return { show }
}
