import { ref, computed } from 'vue'

/**
 * AI Shell 布局状态（UI-B 三栏 Shell：Nav + Canvas + Detail）。
 *
 * 与 useAiChat.ts（协议层）完全分离：这里只承载布局形态（断点/折叠/开关），
 * 不碰任何 SSE 协议字段。
 * 状态为模块级单例：AiPanel / AiNavRail / AiInspector / AiChatPanel 共享同一份。
 *
 * 断点四档（E5：由面板容器宽度驱动，不再用视口宽度的媒体查询——
 * 修复「宽窗口 + 拖窄的 320px 面板仍按 xl 渲染三栏」的问题）：
 *   xl ≥1440        三栏全展开（Inspector 行内）
 *   lg 1100–1439    Inspector 折叠为浮层（可呼出）
 *   md 820–1099     NavRail 自动降级为 48px icon-rail（可呼出浮层完整形态）
 *   sm <820         NavRail 脱离布局（浮层呼出），Canvas 占满
 *
 * 容器注册：AiPanel 挂载时调用 registerShellContainer(el) 交给本模块，
 * ResizeObserver 观测该元素宽度并驱动断点；卸载时传 null 解除。
 * 未注册期间回退 window.innerWidth，保证测试/无 Shell 场景仍有合理初值。
 */

export type AiShellBreakpoint = 'xl' | 'lg' | 'md' | 'sm'
export type AiNavRailMode = 'expanded' | 'icon' | 'overlay'
export type AiInspectorMode = 'inline' | 'overlay'

const NAV_COLLAPSED_KEY = 'ai-nav-rail-collapsed'
const INSPECTOR_OPEN_KEY = 'ai-inspector-open'

// ---- 模块级单例状态 ----
const breakpoint = ref<AiShellBreakpoint>('lg')
const navRailCollapsed = ref(localStorage.getItem(NAV_COLLAPSED_KEY) === '1')
/** NavRail 浮层呼出（icon/overlay 档位下呼出完整形态；不持久化） */
const navOverlayOpen = ref(false)
const inspectorOpen = ref(localStorage.getItem(INSPECTOR_OPEN_KEY) === '1')

function currentBreakpoint(w: number): AiShellBreakpoint {
  if (w >= 1440) return 'xl'
  if (w >= 1100) return 'lg'
  if (w >= 820) return 'md'
  return 'sm'
}

// ---- E5：Shell 容器宽度观测（ResizeObserver）----
let shellEl: HTMLElement | null = null
let shellResizeObserver: ResizeObserver | null = null

function applyBreakpoint(width?: number) {
  const w =
    width ??
    (shellEl ? shellEl.getBoundingClientRect().width : typeof window !== 'undefined' ? window.innerWidth : 0)
  const bp = currentBreakpoint(w)
  if (bp === breakpoint.value) return
  breakpoint.value = bp
  // 进入 sm 档时关闭残留的 Nav 浮层
  if (bp === 'sm') navOverlayOpen.value = false
}

/**
 * 注册/注销 Shell 根容器（E5）。AiPanel onMounted 时传入根元素；
 * onBeforeUnmount 传 null。ResizeObserver 在 observe 后会立即回调一次，
 * 因此挂载后断点马上按真实容器宽度校正。
 */
export function registerShellContainer(el: HTMLElement | null) {
  if (shellResizeObserver) {
    shellResizeObserver.disconnect()
    shellResizeObserver = null
  }
  shellEl = el
  if (!el || typeof ResizeObserver === 'undefined') {
    applyBreakpoint()
    return
  }
  applyBreakpoint(el.getBoundingClientRect().width)
  shellResizeObserver = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width ?? el.getBoundingClientRect().width
    applyBreakpoint(w)
  })
  shellResizeObserver.observe(el)
}

/** SSR/卸载安全兜底（当前 SPA 无 SSR，但保持防御式） */
if (typeof window !== 'undefined') {
  applyBreakpoint()
}

export function useAiChatUi() {
  /** NavRail 形态：sm 浮层；md 自动 icon-rail；其余按用户折叠偏好 */
  const navRailMode = computed<AiNavRailMode>(() => {
    if (breakpoint.value === 'sm' || navOverlayOpen.value) return 'overlay'
    if (breakpoint.value === 'md' || navRailCollapsed.value) return 'icon'
    return 'expanded'
  })

  function toggleNavRail() {
    navRailCollapsed.value = !navRailCollapsed.value
    localStorage.setItem(NAV_COLLAPSED_KEY, navRailCollapsed.value ? '1' : '0')
  }

  function setNavOverlayOpen(v: boolean) {
    navOverlayOpen.value = v
  }

  /** Inspector 形态：xl 行内占位；其余档位浮层（open 即呼出） */
  const inspectorMode = computed<AiInspectorMode>(() => (breakpoint.value === 'xl' ? 'inline' : 'overlay'))

  function toggleInspector() {
    inspectorOpen.value = !inspectorOpen.value
    localStorage.setItem(INSPECTOR_OPEN_KEY, inspectorOpen.value ? '1' : '0')
  }

  function openInspector() {
    if (!inspectorOpen.value) toggleInspector()
  }

  function closeInspector() {
    if (inspectorOpen.value) toggleInspector()
  }

  return {
    // 断点
    breakpoint,
    // NavRail
    navRailMode,
    navRailCollapsed,
    navOverlayOpen,
    toggleNavRail,
    setNavOverlayOpen,
    // Inspector
    inspectorMode,
    inspectorOpen,
    toggleInspector,
    openInspector,
    closeInspector,
  }
}
