import { ref, computed } from 'vue'

/**
 * AI Shell 布局状态（UI-B 三栏 Shell：Nav + Canvas + Detail）。
 *
 * 与 useAiChat.ts（协议层）完全分离：这里只承载布局形态（断点/折叠/开关）与
 * 确认卡 UI 状态占位，不碰任何 SSE 协议字段。
 * 状态为模块级单例：AiPanel / AiNavRail / AiInspector / AiChatPanel 共享同一份。
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

/** 确认卡自动超时时长（契约：120s 未决 → 自动转超时态） */
export const CONFIRM_TIMEOUT_MS = 120_000

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

// 确认卡 UI 状态（UI-E 补全：状态机 + 120s 超时定时器 + SSE meta 事件接入）
const confirmRequest = ref<AiConfirmRequest | null>(null)
const confirmPhase = ref<AiConfirmPhase>('idle')
/** 确认卡超时截止时间戳（ms，null = 无进行中的倒计时）；卡片据此渲染剩余秒数 */
const confirmExpiresAt = ref<number | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

function clearConfirmTimer() {
  if (confirmTimer !== null) {
    clearTimeout(confirmTimer)
    confirmTimer = null
  }
  confirmExpiresAt.value = null
}

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

  // ---- 确认卡状态机（UI-E 补全，保持 UI-B 既有导出名向后兼容）----
  // 状态迁移：idle --openConfirm--> pending --settleConfirm--> approved/denied/timeout
  //   - pending 持续 CONFIRM_TIMEOUT_MS(120s) 未决 → 定时器自动 settle 为 timeout
  //   - 首个终态获胜：进入终态后忽略迟到的 settle（如超时后批准请求才返回），
  //     避免 UI 在终态间闪烁；resetConfirm 才会回到 idle
  function openConfirm(req: AiConfirmRequest) {
    confirmRequest.value = req
    confirmPhase.value = 'pending'
    clearConfirmTimer()
    confirmExpiresAt.value = Date.now() + CONFIRM_TIMEOUT_MS
    confirmTimer = setTimeout(() => {
      if (confirmPhase.value === 'pending') settleConfirm('timeout')
    }, CONFIRM_TIMEOUT_MS)
  }
  function settleConfirm(phase: 'approved' | 'denied' | 'timeout') {
    if (confirmPhase.value !== 'pending') return
    confirmPhase.value = phase
    clearConfirmTimer()
  }
  function resetConfirm() {
    clearConfirmTimer()
    confirmRequest.value = null
    confirmPhase.value = 'idle'
  }
  /** 关闭已结算（approved/denied/timeout）的确认卡；pending 态不可关闭 */
  function dismissConfirm() {
    if (confirmPhase.value === 'pending') return
    resetConfirm()
  }
  /**
   * SSE meta 事件接入点（UI-E）。AiChatPanel / 协议层把含确认事件的 meta 原样
   * 交给此函数即可，识别与归一化在这里完成（useAiChat.ts 协议层无需改动）：
   *   - meta.type === 'confirm_tool_action' → openConfirm（字段 requestId/tool/argsSummary/impact）
   *   - meta.type === 'confirm_resolved'    → settleConfirm（meta.allow ? approved : denied）
   *     // TODO(backend Package C)：resolved 事件字段名以最终契约为准
   * 后端未就绪时的 mock 测试方式见 AiConfirmCard.vue 顶部注释。
   */
  function feedConfirmMeta(meta: unknown) {
    if (!meta || typeof meta !== 'object') return
    const m = meta as Record<string, unknown>
    if (m.type === 'confirm_tool_action') {
      const requestId = String(m.requestId ?? m.request_id ?? '')
      const tool = String(m.tool ?? '')
      if (!requestId || !tool) return
      openConfirm({
        requestId,
        tool,
        argsSummary: m.argsSummary != null ? String(m.argsSummary) : undefined,
        impact: m.impact != null ? String(m.impact) : undefined,
      })
    } else if (m.type === 'confirm_resolved') {
      settleConfirm(m.allow ? 'approved' : 'denied')
    }
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
    // 确认卡状态机（UI-B 既有导出名不变；confirmExpiresAt/dismissConfirm/feedConfirmMeta 为 UI-E 新增）
    confirmRequest,
    confirmPhase,
    confirmExpiresAt,
    openConfirm,
    settleConfirm,
    resetConfirm,
    dismissConfirm,
    feedConfirmMeta,
  }
}
