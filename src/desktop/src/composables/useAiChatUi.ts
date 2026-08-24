import { ref, computed } from 'vue'

/**
 * AI Shell 布局状态（UI-B 三栏 Shell：Nav + Canvas + Detail）。
 *
 * 与 useAiChat.ts（协议层）完全分离：这里只承载布局形态（断点/折叠/开关）与
 * 确认卡 UI 状态占位，不碰任何 SSE 协议字段。
 * 状态为模块级单例：AiPanel / AiNavRail / AiInspector / AISidebar 共享同一份。
 *
 * 断点四档（视口媒体查询驱动，CSS 侧另有容器查询做内容自适应）：
 *   xl ≥1440        三栏全展开（Inspector 行内）
 *   lg 1100–1439    Inspector 折叠为浮层（可呼出）
 *   md 820–1099     NavRail 自动降级为 48px icon-rail（可呼出浮层完整形态）
 *   sm <820         NavRail 脱离布局（浮层呼出），Canvas 占满
 */

export type AiShellBreakpoint = 'xl' | 'lg' | 'md' | 'sm'
export type AiNavRailMode = 'expanded' | 'icon' | 'overlay'
export type AiInspectorMode = 'inline' | 'overlay'

/** 确认卡 UI 状态占位（UI-E 接线：字段对齐后端 Package C confirm_tool_action 契约） */
export interface AiConfirmRequest {
  requestId: string
  tool: string
  argsSummary?: string
  impact?: string
}
export type AiConfirmPhase = 'idle' | 'pending' | 'approved' | 'denied' | 'timeout'

const NAV_COLLAPSED_KEY = 'ai-nav-rail-collapsed'
const INSPECTOR_OPEN_KEY = 'ai-inspector-open'

// ---- 模块级单例状态 ----
const breakpoint = ref<AiShellBreakpoint>('lg')
const navRailCollapsed = ref(localStorage.getItem(NAV_COLLAPSED_KEY) === '1')
/** NavRail 浮层呼出（icon/overlay 档位下呼出完整形态；不持久化） */
const navOverlayOpen = ref(false)
const inspectorOpen = ref(localStorage.getItem(INSPECTOR_OPEN_KEY) !== '0')
/** 用户本会话内显式切换过 Inspector（切换过则尊重用户，断点变化不再自动调整） */
let inspectorTouched = false

// 确认卡 UI 占位（UI-B 只承载状态，不做渲染/回调逻辑）
const confirmRequest = ref<AiConfirmRequest | null>(null)
const confirmPhase = ref<AiConfirmPhase>('idle')

function currentBreakpoint(w: number): AiShellBreakpoint {
  if (w >= 1440) return 'xl'
  if (w >= 1100) return 'lg'
  if (w >= 820) return 'md'
  return 'sm'
}

function applyBreakpoint() {
  const bp = currentBreakpoint(window.innerWidth)
  if (bp === breakpoint.value) return
  breakpoint.value = bp
  // 断点变化时自动调整 Inspector 默认形态：仅 xl 行内展开，其余档位收起。
  // 用户显式切换过（inspectorTouched）则完全尊重用户选择。
  if (!inspectorTouched) {
    const want = bp === 'xl'
    if (inspectorOpen.value !== want) {
      inspectorOpen.value = want
      localStorage.setItem(INSPECTOR_OPEN_KEY, want ? '1' : '0')
    }
  }
  // 进入 sm 档时关闭残留的 Nav 浮层
  if (bp === 'sm') navOverlayOpen.value = false
}

let mediaBound = false
function bindBreakpointMedia() {
  if (mediaBound || typeof window === 'undefined') return
  mediaBound = true
  applyBreakpoint()
  const onChange = () => applyBreakpoint()
  ;['(min-width: 820px)', '(min-width: 1100px)', '(min-width: 1440px)'].forEach((q) => {
    window.matchMedia(q).addEventListener('change', onChange)
  })
}

export function useAiChatUi() {
  bindBreakpointMedia()

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
    inspectorTouched = true
    inspectorOpen.value = !inspectorOpen.value
    localStorage.setItem(INSPECTOR_OPEN_KEY, inspectorOpen.value ? '1' : '0')
  }

  function openInspector() {
    if (!inspectorOpen.value) toggleInspector()
  }

  function closeInspector() {
    if (inspectorOpen.value) toggleInspector()
  }

  // ---- 确认卡 UI 状态占位（UI-E 接线用，UI-B 不消费）----
  function openConfirm(req: AiConfirmRequest) {
    confirmRequest.value = req
    confirmPhase.value = 'pending'
  }
  function settleConfirm(phase: 'approved' | 'denied' | 'timeout') {
    confirmPhase.value = phase
  }
  function resetConfirm() {
    confirmRequest.value = null
    confirmPhase.value = 'idle'
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
    // 确认卡占位
    confirmRequest,
    confirmPhase,
    openConfirm,
    settleConfirm,
    resetConfirm,
  }
}
