<script setup lang="ts">
/**
 * 人机验证挂件（provider 可切换：Cloudflare Turnstile / 自建滑块）+ **弹窗模式**
 *
 * 交互（owner 明确要求的基础业务逻辑）：
 *   用户点「发送验证码」→ 若服务端要求人机验证且尚未通过 ⇒ **弹出验证弹窗**
 *   → 用户完成验证（拖滑块 / 过 Turnstile）→ 弹窗关闭并**自动真正发送短信**。
 *   ⇒ 父组件把 `open` 传下来控制弹窗；`payload` 上来即表示"验证已完成，可以发码了"。
 *
 * 两种用法：
 *   - `:open="captchaOpen"`（弹窗模式，推荐）：只在 open=true 时渲染遮罩弹窗
 *   - 不传 open（行内模式）：挂载后若服务端要求验证就直接渲染在行内（兼容旧用法）
 *
 * ⚠️ 响应结构：桌面端 `api()` 返回的是**整包**（`{ok, data: <整个响应体>}`）。
 *    `/api/auth/captcha-config` 是扁平结构（provider/enabled/siteKey）⇒ 读 `res.data.*`；
 *    `/api/auth/captcha-challenge` 是包裹结构（`{code, data:{...}}`）⇒ 必须读 `res.data.data.*`。
 *    （曾因为读错这一层导致挂件静默不渲染 ✗）
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from '@/api/client'

const props = defineProps<{
  /** 弹窗是否可见；不传 = 行内模式 */
  open?: boolean
}>()

const emit = defineEmits<{
  /** 验证完成：把字段原样塞进发码请求体（turnstile ⇒ {turnstileToken}；self ⇒ {captchaToken,captchaX,captchaTrack}） */
  payload: [payload: Record<string, unknown>]
  /** 服务端是否要求人机验证 */
  enabled: [enabled: boolean]
  /** 用户关闭弹窗（未完成验证） */
  close: []
}>()

const host = ref<HTMLElement | null>(null)
let widgetId = ''
let disposed = false
let provider = 'off'
let cfgLoaded = false

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

interface TurnstileApi {
  render: (el: HTMLElement, options: Record<string, unknown>) => string
  remove?: (id: string) => void
}
function turnstileApi(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile
}

/** 只注入一次脚本（显式渲染模式）；拉不到就 resolve 当未启用，绝不能把发码卡死 */
function loadScriptOnce(): Promise<void> {
  if (document.querySelector('script[data-clipsync-turnstile]')) return Promise.resolve()
  return new Promise((resolve) => {
    const s = document.createElement('script')
    s.src = SCRIPT_SRC
    s.async = true
    s.defer = true
    s.setAttribute('data-clipsync-turnstile', '1')
    s.onload = () => resolve()
    s.onerror = () => resolve()
    document.head.appendChild(s)
  })
}

// ───────────────────────── 自建滑块 ─────────────────────────
const bg = ref('')
const piece = ref('')
const pieceSize = ref(44)
const pieceY = ref(0)
const offsetX = ref(0)
const dragging = ref(false)
const done = ref(false)
const loadingChallenge = ref(false)
const challengeError = ref('')

let challengeToken = ''
let startX = 0
let startOffset = 0
let trackPoints = 0
let trackStartAt = 0
let maxOffset = 260

async function loadChallenge() {
  loadingChallenge.value = true
  challengeError.value = ''
  try {
    const res = await api<{ code?: number; data?: Record<string, unknown>; background?: string }>(
      'GET',
      '/api/auth/captcha-challenge'
    )
    // ⚠️ 包裹结构：题目在 res.data.data 里（兼容万一被展平的情况）
    const d = ((res.data as { data?: Record<string, unknown> })?.data ?? res.data ?? {}) as Record<
      string,
      unknown
    >
    const background = typeof d?.background === 'string' ? (d.background as string) : ''
    const token = typeof d?.token === 'string' ? (d.token as string) : ''
    if (disposed || !res.ok || !background || !token) {
      challengeError.value = res.error || '获取验证题失败，请重试'
      return
    }
    bg.value = background
    piece.value = typeof d?.piece === 'string' ? (d.piece as string) : ''
    pieceY.value = Number(d?.y) || 0
    pieceSize.value = Number(d?.pieceSize) || 44
    challengeToken = token
    offsetX.value = 0
    done.value = false
    maxOffset = Math.max(120, (host.value?.clientWidth || 300) - pieceSize.value)
  } catch (e) {
    challengeError.value = String(e)
  } finally {
    loadingChallenge.value = false
  }
}

function onPointerDown(e: PointerEvent) {
  if (done.value || !bg.value) return
  dragging.value = true
  startX = e.clientX
  startOffset = offsetX.value
  trackPoints = 1
  trackStartAt = Date.now()
  try {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 捕获失败也能靠 move 事件拖动 */
  }
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const dx = e.clientX - startX
  offsetX.value = Math.min(Math.max(startOffset + dx, 0), maxOffset)
  trackPoints += 1
}
function onPointerUp() {
  if (!dragging.value) return
  dragging.value = false
  done.value = true
  // 松手即交卷：父组件收到 payload 后会关闭弹窗并真正发码（服务端做最终判定）
  emit('payload', {
    captchaToken: challengeToken,
    captchaX: Math.round(offsetX.value),
    captchaTrack: { points: trackPoints, durationMs: Date.now() - trackStartAt },
  })
}
function redo() {
  emit('payload', {})
  void loadChallenge()
}

// ───────────────────────── 初始化 ─────────────────────────
/** 渲染当前 provider 的验证形态（幂等；弹窗打开时才需要 DOM） */
async function renderProvider() {
  if (disposed) return
  if (provider === 'self') {
    if (!bg.value) await loadChallenge()
    return
  }
  if (!cfgLoaded || provider !== 'turnstile') return
  await loadScriptOnce()
  await Promise.resolve()
  const el = host.value
  const w = turnstileApi()
  if (disposed || !el || !w || widgetId) return
  const siteKey = (globalThis as { __clipsyncTurnstileKey?: string }).__clipsyncTurnstileKey
  if (!siteKey) return
  widgetId = w.render(el, {
    sitekey: siteKey,
    callback: (token: string) => emit('payload', { turnstileToken: token }),
    'expired-callback': () => emit('payload', {}),
    'error-callback': () => emit('payload', {}),
  })
}

onMounted(async () => {
  try {
    const res = await api<{ provider?: string; enabled?: boolean; siteKey?: string }>(
      'GET',
      '/api/auth/captcha-config'
    )
    if (disposed || !res.ok || !res.data?.enabled) return
    cfgLoaded = true
    provider = res.data.provider || (res.data.siteKey ? 'turnstile' : 'off')
    if (provider === 'turnstile' && res.data.siteKey) {
      ;(globalThis as { __clipsyncTurnstileKey?: string }).__clipsyncTurnstileKey = res.data.siteKey
    }
    emit('enabled', true)
    // 行内模式（未传 open）立即渲染；弹窗模式等 open=true
    if (props.open === undefined) await renderProvider()
  } catch {
    /* 任何异常都按未启用处理：服务端未启用时门控也放行 */
  }
})

watch(
  () => props.open,
  async (v) => {
    if (v) await renderProvider()
  }
)

onBeforeUnmount(() => {
  disposed = true
  const id = widgetId
  widgetId = ''
  if (id) {
    try {
      turnstileApi()?.remove?.(id)
    } catch {
      /* 卸载失败无所谓 */
    }
  }
})
</script>

<template>
  <!-- 弹窗模式：open=false 时什么都不渲染（组件仍挂载，用于上报 enabled） -->
  <Teleport v-if="open !== undefined && open" to="body">
    <div class="captcha-overlay" @click.self="emit('close')">
      <div class="captcha-card">
        <div class="captcha-head">
          <span class="captcha-title">请完成人机验证</span>
          <button type="button" class="captcha-close" @click="emit('close')">✕</button>
        </div>
        <p class="captcha-tip">验证通过后会自动发送短信验证码</p>

        <div ref="host" />

        <div v-if="provider === 'self'" class="slider-wrap">
          <p v-if="loadingChallenge" class="slider-hint">正在加载验证题…</p>
          <p v-else-if="challengeError" class="slider-err">
            {{ challengeError }}
            <button type="button" class="slider-reset" @click="loadChallenge">重试</button>
          </p>
          <template v-else-if="bg">
            <div class="slider-bg">
              <img :src="bg" alt="拖动滑块完成验证" draggable="false" />
              <img
                v-if="piece"
                class="slider-piece"
                :class="{ dragging, done }"
                :src="piece"
                :style="{ left: offsetX + 'px', top: pieceY + 'px', width: pieceSize + 'px', height: pieceSize + 'px' }"
                draggable="false"
                @pointerdown="onPointerDown"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @pointercancel="onPointerUp"
              />
            </div>
            <div class="slider-bar">
              <span v-if="!done">按住滑块，拖到图上缺口处</span>
              <span v-else>
                已交卷，正在发送短信
                <button type="button" class="slider-reset" @click="redo">重来</button>
              </span>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 行内模式（未传 open） -->
  <div v-else-if="open === undefined" class="captcha-host">
    <div ref="host" />
    <div v-if="bg" class="slider-wrap">
      <div class="slider-bg">
        <img :src="bg" alt="拖动滑块完成验证" draggable="false" />
        <img
          v-if="piece"
          class="slider-piece"
          :class="{ dragging, done }"
          :src="piece"
          :style="{ left: offsetX + 'px', top: pieceY + 'px', width: pieceSize + 'px', height: pieceSize + 'px' }"
          draggable="false"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.captcha-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}
.captcha-card {
  width: 360px;
  max-width: calc(100vw - 32px);
  background: var(--bg-surface, #fff);
  color: var(--text-primary, #111);
  border-radius: 12px;
  padding: 18px 20px 20px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
}
.captcha-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.captcha-title {
  font-size: 15px;
  font-weight: 600;
}
.captcha-close {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-tertiary, #999);
}
.captcha-tip {
  margin: 6px 0 12px;
  font-size: 12px;
  color: var(--text-secondary, #666);
}
/* 行内模式容器 */
.captcha-host {
  margin-top: 10px;
}
/* 滑块 */
.slider-wrap {
  margin-top: 4px;
}
.slider-bg {
  position: relative;
  width: 300px;
  max-width: 100%;
  user-select: none;
  touch-action: none;
}
.slider-bg img {
  display: block;
  width: 100%;
  border-radius: 6px;
}
.slider-piece {
  position: absolute;
  cursor: grab;
  border-radius: 6px;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85);
  transition: left 60ms linear;
}
.slider-piece.dragging {
  cursor: grabbing;
  transition: none;
}
.slider-piece.done {
  box-shadow: 0 0 0 2px var(--success, #16a34a);
}
.slider-bar {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary, #666);
  display: flex;
  align-items: center;
  gap: 8px;
}
.slider-hint,
.slider-err {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-secondary, #666);
}
.slider-err {
  color: var(--danger, #d33);
}
.slider-reset {
  background: none;
  border: none;
  color: var(--accent, #4f46e5);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
</style>
