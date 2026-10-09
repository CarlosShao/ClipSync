<script setup lang="ts">
/**
 * 088 人机验证挂件（Cloudflare Turnstile）。
 *
 * 为什么是组件、而不是往发码按钮旁边插一个 div：
 *  1) 挂件要占一整行（约 300×65px）。`form-row` 是 flex 且验证码输入框 flex:1，
 *     把挂件塞进去会把输入框挤成一条缝（用户实测的「排版离谱」就是这个）；
 *  2) 登录页 / 注册页是两个 v-if 分支，按 id 找单个按钮只挂得到其中一个，
 *     另一个分支的「发送验证码」在开关打开后会 400（缺 token）。
 * 所以每个发码行各自挂一个实例，各自往上抛 token。
 *
 * 未启用时（服务端开关关着 / 密钥不齐）什么都不渲染、不发 token，行为与接入前一致。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { api } from '@/api/client'

const emit = defineEmits<{
  /** 拿到 / 失效 token（失效时发空串） */
  token: [token: string]
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

onMounted(async () => {
  try {
    const res = await api<{ enabled?: boolean; siteKey?: string }>('GET', '/api/auth/captcha-config')
    if (disposed || !res.ok || !res.data?.enabled || !res.data?.siteKey) return
    emit('enabled', true)
    await loadScriptOnce()
    const el = host.value
    const w = turnstileApi()
    if (disposed || !el || !w || widgetId) return
    widgetId = w.render(el, {
      sitekey: res.data.siteKey,
      callback: (token: string) => emit('token', token),
      'expired-callback': () => emit('token', ''),
      'error-callback': () => emit('token', ''),
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
  <div ref="host" class="turnstile-host" />
</template>

<style scoped>
/* 独占一行，不参与上面的 flex 行，也不撑宽输入框 */
.turnstile-host {
  margin-top: 10px;
}
</style>
