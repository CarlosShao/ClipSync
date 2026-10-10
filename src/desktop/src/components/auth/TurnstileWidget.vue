<script setup lang="ts">
/**
 * 人机验证挂件（provider 可切换：Cloudflare Turnstile / 自建滑块）
 *
 * 为什么是组件、而不是往发码按钮旁边插一个 div：
 *  1) 挂件要占一整行。`form-row` 是 flex 且验证码输入框 flex:1，
 *     把挂件塞进去会把输入框挤成一条缝（用户实测的「排版离谱」就是这个）；
 *  2) 登录页 / 注册页是两个 v-if 分支，按 id 找单个按钮只挂得到其中一个，
 *     另一个分支的「发送验证码」在开关打开后会 400（缺 token）。
 * 所以每个发码行各自挂一个实例，各自往上抛 payload。
 *
 * 两个 provider 的差别（服务端 /api/auth/captcha-config 的 provider 字段决定）：
 *  - turnstile：注入官方脚本 → turnstile.render → 抛 { turnstileToken }
 *  - self     ：GET /api/auth/captcha-challenge 取「背景图 + 滑块图 + 签名 token」
 *               → 用户拖动滑块 → 抛 { captchaToken, captchaX, captchaTrack }
 *               （缺口坐标**只在服务端签名 token 里**，前端拿到的是像素图 ⇒ 脚本要过就得做图像识别）
 *
 * 未启用时（provider=off / 凭据不齐 / 拉不到脚本）什么都不渲染、不发 payload，行为与接入前一致。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { api } from '@/api/client'

const emit = defineEmits<{
  /** 交给父组件原样塞进发码请求体（未通过时为空对象） */
  payload: [payload: Record<string, unknown>]
  /** 服务端是否要求人机验证（父组件据此在发码前提示，而不是发一个注定 400 的请求） */
  enabled: [enabled: boolean]
}>()

const host = ref<HTMLElement | null>(null)
let widgetId = ''
let disposed = false

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
const offsetX = ref(0) // 滑块当前左偏移
const dragging = ref(false)
const done = ref(false)

let challengeToken = ''
let startX = 0
let startOffset = 0
let trackPoints = 0
let trackStartAt = 0
let maxOffset = 0

async function loadChallenge() {
  try {
    const res = await api<{
      token?: string
      background?: string
      piece?: string
      y?: number
      pieceSize?: number
    }>('GET', '/api/auth/captcha-challenge')
    if (disposed || !res.ok || !res.data?.background || !res.data?.token) return
    bg.value = res.data.background
    piece.value = res.data.piece || ''
    pieceY.value = Number(res.data.y) || 0
    pieceSize.value = Number(res.data.pieceSize) || 44
    challengeToken = res.data.token
    offsetX.value = 0
    done.value = false
    // 背景宽度即最大可拖距离（背景图与容器同宽）
    maxOffset = Math.max(0, (host.value?.clientWidth || 300) - pieceSize.value)
  } catch {
    /* 出题失败按未启用处理：不拦发码（服务端未启用时门控也放行） */
  }
}

function onPointerDown(e: PointerEvent) {
  if (done.value || !bg.value) return
  dragging.value = true
  startX = e.clientX
  startOffset = offsetX.value
  trackPoints = 1
  trackStartAt = Date.now()
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
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
  // 立刻给"已拖动"的视觉反馈；真正的判定在服务端（缺口坐标只有它有）
  emit('payload', {
    captchaToken: challengeToken,
    captchaX: Math.round(offsetX.value),
    captchaTrack: { points: trackPoints, durationMs: Date.now() - trackStartAt },
  })
}

function reset() {
  emit('payload', {})
  void loadChallenge()
}

// ───────────────────────── 挂载 ─────────────────────────
onMounted(async () => {
  try {
    const res = await api<{ provider?: string; enabled?: boolean; siteKey?: string }>(
      'GET',
      '/api/auth/captcha-config'
    )
    if (disposed || !res.ok || !res.data?.enabled) return
    emit('enabled', true)

    const provider = res.data.provider || (res.data.siteKey ? 'turnstile' : 'off')

    if (provider === 'self') {
      await loadChallenge()
      return
    }

    if (!res.data.siteKey) return
    await loadScriptOnce()
    const el = host.value
    const w = turnstileApi()
    if (disposed || !el || !w || widgetId) return
    widgetId = w.render(el, {
      sitekey: res.data.siteKey,
      callback: (token: string) => emit('payload', { turnstileToken: token }),
      'expired-callback': () => emit('payload', {}),
      'error-callback': () => emit('payload', {}),
    })
  } catch {
    /* 任何异常都按未启用处理：服务端未启用时门控也放行 */
  }
})

onBeforeUnmount(() => {
  disposed = true
  const id = widgetId
  widgetId = ''
  if (id) {
    try {
      turnstileApi()?.remove?.(id)
    } catch {
      /* 卸载失败无所谓：父组件不再读它的 token */
    }
  }
})
</script>

<template>
  <div class="captcha-host">
    <!-- Turnstile 容器（provider=turnstile 时才由脚本填充） -->
    <div ref="host" />

    <!-- 自建滑块 -->
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
      <div class="slider-bar">
        <span v-if="!done" class="slider-hint">按住滑块拖到缺口处</span>
        <span v-else class="slider-ok">
          已拖动，正在提交验证
          <button type="button" class="slider-reset" @click="reset">重来</button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 独占一行，不参与上面的 flex 行，也不撑宽输入框 */
.captcha-host {
  margin-top: 10px;
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
.slider-reset {
  background: none;
  border: none;
  color: var(--accent, #4f46e5);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
</style>
