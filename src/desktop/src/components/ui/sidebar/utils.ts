import { inject, computed, type ComputedRef } from 'vue'

export const SIDEBAR_KEY = Symbol('sidebar')

export interface SidebarContext {
  state: ComputedRef<'expanded' | 'collapsed'>
  isCollapsed: ComputedRef<boolean>
  isMobile: ComputedRef<boolean>
  toggleSidebar: () => void
  setOpen: (open: boolean) => void
}

// Safe fallback so SidebarMenuButton works standalone (without a Provider),
// e.g. when we keep our own prop-driven collapse logic in AppSidebar.
const fallback: SidebarContext = {
  state: computed(() => 'expanded'),
  isCollapsed: computed(() => false),
  isMobile: computed(() => false),
  toggleSidebar: () => {},
  setOpen: () => {},
}

export function useSidebar(): SidebarContext {
  return inject(SIDEBAR_KEY, fallback)
}
