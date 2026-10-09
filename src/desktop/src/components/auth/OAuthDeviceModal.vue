<script setup lang="ts">
/**
 * 第三方登录 · 设备码弹窗（RFC 8628）
 *
 * 流程：打开弹窗 → 调 /api/auth/oauth/:provider/start 拿 8 位码 → 用户去授权页输入
 * → 本组件按服务端给的 interval 轮询 /poll → 授权成功把会话交给父组件（父组件复用既有登录落地逻辑）。
 *
 * 设计要点：
 *  - **device_code 不在这里**：服务端只回 opaque 的 pollToken（device_code 是轮询密钥，不下发）。
 *  - 轮询间隔听服务端（provider 会给 interval，GitHub 默认 5s）；组件卸载/关闭**必须清定时器**，
 *    否则关掉弹窗还在打接口。
 *  - pending / slow_down 是正常中间态（服务端用 200 + status 表达），不当错误弹。
 *  - 过期/被拒/网络错要给出**可执行**的下一步（重新发起）。
 */
import { ref, watch, onUnmounted } from 'vue'
import { X, Copy, ExternalLink } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import { api } from '@/api/client'
import { useSonner } from '@/composables/useSonner'
import {
  githubDeviceCode as tauriGithubDeviceCode,
  githubDeviceToken as tauriGithubDeviceToken,
} from '@/lib/tauri'

const props = defineProps<{
  open: boolean
  /** 'github' | 'microsoft' */
  provider: string
  /** 展示名（父组件按 /providers 给） */
  providerName?: string
  /** GitHub 的 client_id（公开值，父组件从 /providers 拿）——本机跑设备码流要用它 */
  clientId?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  /** 授权成功：父组件负责写登录态（token / refreshToken / user）与导航 */
  (e: 'authorized', payload: { token: string; refreshToken?: string; user?: unknown }): void
}>()

const toast = useSonner()

const loading = ref(false)
const userCode = ref('')
const verificationUri = ref('')
const pollToken = ref('')
const secondsLeft = ref(0)
const errorText = ref('')
/** GitHub 本机流程用：设备码（轮询密钥，只在本机内存里） */
let ghDeviceCode = ''

let pollTimer: ReturnType<typeof setInterval> | null = null
let countdownTimer: ReturnType<typeof setInterval> | null = null

function clearTimers() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

/** 把「发起结果」铺到 UI 并启动倒计时 + 轮询（服务端链路与本机链路共用这段尾巴） */
function armFlow(opts: {
  code: string
  uri: string
  expiresIn: number
  intervalSec: number
  tick: () => void
}) {
  userCode.value = opts.code
  verificationUri.value = opts.uri
  secondsLeft.value = opts.expiresIn
  countdownTimer = setInterval(() => {
    secondsLeft.value = Math.max(secondsLeft.value - 1, 0)
    if (secondsLeft.value === 0) fail('验证码已过期，请重新发起')
  }, 1000)
  pollTimer = setInterval(() => opts.tick(), Math.max(opts.intervalSec, 5) * 1000)
}

async function start() {
  clearTimers()
  errorText.value = ''
  userCode.value = ''
  verificationUri.value = ''
  pollToken.value = ''
  ghDeviceCode = ''
  loading.value = true
  try {
    if (props.provider === 'github') {
      // GitHub 走**本机**设备码流：服务端到 github.com 时通时不通（用户侧表现「发起失败」或
      // 授权后一直等），而 webview 的 JS 直连会被 GitHub 的 CORS 拦掉 ⇒ 两步都交给 Rust。
      // 身份验证不在这里：拿到 access token 后交服务端（它向 api.github.com 取资料定身份）。
      const data = await tauriGithubDeviceCode(props.clientId || '')
      const code = String(data.user_code || '')
      const deviceCode = String(data.device_code || '')
      if (!code || !deviceCode) {
        errorText.value = String(
          data.error_description || data.error || '发起登录失败，请稍后重试'
        )
        return
      }
      ghDeviceCode = deviceCode
      armFlow({
        code,
        uri: String(data.verification_uri || 'https://github.com/login/device'),
        expiresIn: Number(data.expires_in) || 900,
        intervalSec: Number(data.interval) || 5,
        tick: () => void pollGithubLocal(),
      })
      return
    }

    const res = await api('POST', `/api/auth/oauth/${props.provider}/start`, {})
    // ⚠️ api() 不解响应壳：start 回的是 { code, data:{ userCode… } }（与 /providers 的裸对象不同形），
    // 直接读 res.data.userCode 会永远 undefined，表现就是「一点就报发起失败」。
    const payload = (res.data?.data ?? res.data) as Record<string, unknown> | undefined
    if (!res.ok || !payload?.userCode) {
      errorText.value = res.error || (res.data?.message as string) || '发起登录失败，请稍后重试'
      return
    }
    pollToken.value = String(payload.pollToken || '')
    armFlow({
      code: String(payload.userCode),
      uri: String(payload.verificationUri || ''),
      expiresIn: Number(payload.expiresIn) || 900,
      intervalSec: Number(payload.interval) || 5,
      tick: () => void poll(),
    })
  } catch (e) {
    errorText.value = String(e)
  } finally {
    loading.value = false
  }
}

/** GitHub 本机轮询：Rust 去 github.com 换 token；到手后交服务端验证并签发本站会话 */
async function pollGithubLocal() {
  if (!ghDeviceCode) return
  try {
    const data = await tauriGithubDeviceToken(props.clientId || '', ghDeviceCode)
    const token = typeof data.access_token === 'string' ? data.access_token : ''
    if (token) {
      clearTimers()
      await exchangeGithubToken(token)
      return
    }
    const err = String(data.error || '')
    if (err === 'authorization_pending' || err === 'slow_down') return
    if (err === 'expired_token') return fail('验证码已过期，请重新发起')
    if (err === 'access_denied') return fail('你取消了授权')
    fail(`授权失败：${String(data.error_description || err || '未知错误')}`)
  } catch {
    /* 单次抖动不致命：等下一轮，过期由倒计时兜住 */
  }
}

/** 把 GitHub access token 交服务端换本站会话（服务端向 api.github.com 验证身份，不采信客户端自称） */
async function exchangeGithubToken(accessToken: string) {
  try {
    const res = await api('POST', '/api/auth/oauth/github/exchange', { accessToken })
    const payload = (res.data?.data ?? res.data) as Record<string, unknown> | undefined
    if (!res.ok || !payload?.token) {
      errorText.value =
        (res.data as { message?: string } | undefined)?.message ||
        res.error ||
        '登录失败，请稍后重试'
      return
    }
    emit('authorized', {
      token: String(payload.token),
      refreshToken: payload.refreshToken as string | undefined,
      user: payload.user,
    })
  } catch (e) {
    errorText.value = String(e)
  }
}

async function poll() {
  if (!pollToken.value) return
  try {
    const res = await api('POST', `/api/auth/oauth/${props.provider}/poll`, {
      pollToken: pollToken.value,
    })
    // 网络抖动（status 0）与限流（429）：等下一轮，过期由倒计时兜住
    if (!res.ok && (res.status === 0 || res.status === 429)) return
    if (!res.ok) {
      // 409/403 是终止态（过期 / 用户拒绝 / 账号停用）：服务端给了可执行的中文原因，停轮询并展示。
      // 旧实现一律 return ⇒ 用户点了「取消授权」还要空转到 15 分钟倒计时结束。
      fail((res.data as { message?: string } | undefined)?.message || res.error || '授权失败，请重新发起')
      return
    }
    // ⚠️ 同 start()：poll 也是 { code, data } 壳，直接读 res.data.status 会永远 undefined
    const payload = (res.data?.data ?? res.data) as Record<string, unknown> | undefined
    const status = payload?.status
    // pending / slow_down：正常等待，什么都不做
    if (status === 'pending' || status === 'slow_down') return
    if (status === 'authorized' && payload?.token) {
      clearTimers()
      emit('authorized', {
        token: String(payload.token),
        refreshToken: payload.refreshToken as string | undefined,
        user: payload.user,
      })
      return
    }
    // 未知态（协议漂移）：停轮询并给出可执行下一步，别静默空转
    fail('授权状态异常，请重新发起')
  } catch {
    /* 单次轮询异常不致命：等下一个周期，过期由倒计时兜住 */
  }
}

function fail(text: string) {
  clearTimers()
  errorText.value = text
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(userCode.value)
    toast.show('验证码已复制', 'success')
  } catch {
    toast.show('复制失败，请手动选择', 'error')
  }
}

function openAuthPage() {
  if (!verificationUri.value) return
  // ⚠️ Tauri 的 webview 里 window.open 是**空操作**（旧注释以为它会走系统浏览器，实测点了没反应），
  // 必须走 Rust 的 open_url（lib/tauri.openUrl，内部有 http/https 白名单校验）。
  import('@/lib/tauri')
    .then(({ openUrl }) => openUrl(verificationUri.value))
    .catch((e) => {
      console.error('[OAuth] open auth page failed:', e)
      toast.show('打不开浏览器，请手动复制下方链接', 'error')
    })
}

watch(
  () => props.open,
  (v) => {
    if (v) void start()
    else clearTimers()
  }
)

onUnmounted(clearTimers)
</script>

<template>
  <div v-if="open" class="oauth-mask" @click.self="emit('close')">
    <div class="oauth-card">
      <button class="oauth-close" title="关闭" @click="emit('close')">
        <X :size="16" />
      </button>

      <h3 class="oauth-title">使用 {{ providerName || provider }} 登录</h3>

      <template v-if="errorText">
        <p class="oauth-error">{{ errorText }}</p>
        <Button class="oauth-btn" @click="start">重新发起</Button>
      </template>

      <template v-else-if="loading && !userCode">
        <p class="oauth-hint">正在获取验证码…</p>
      </template>

      <template v-else-if="userCode">
        <p class="oauth-hint">
          1）点下面按钮打开 {{ providerName || provider }} 授权页；<br />
          2）在页面里输入这个验证码：
        </p>
        <div class="oauth-code">
          <span class="oauth-code-text">{{ userCode }}</span>
          <button class="oauth-copy" title="复制" @click="copyCode"><Copy :size="14" /></button>
        </div>
        <p class="oauth-hint">
          3）完成后<strong>本窗口会自动登录</strong>，不用回到这里操作。
          <span v-if="secondsLeft > 0">（{{ Math.floor(secondsLeft / 60) }}:{{ String(secondsLeft % 60).padStart(2, '0') }} 内有效）</span>
        </p>
        <Button class="oauth-btn" @click="openAuthPage">
          <ExternalLink :size="14" style="margin-right: 6px" />
          打开 {{ providerName || provider }} 授权页
        </Button>
        <p class="oauth-uri">{{ verificationUri }}</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.oauth-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.oauth-card {
  position: relative;
  width: 420px;
  max-width: calc(100vw - 32px);
  background: var(--bg-elevated, #fff);
  color: var(--text-1, #111);
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}
.oauth-close {
  position: absolute;
  top: 12px;
  right: 12px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-3, #888);
}
.oauth-title {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
}
.oauth-hint {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-2, #555);
  margin: 0 0 10px;
}
.oauth-code {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0 14px;
}
.oauth-code-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 3px;
  user-select: all;
}
.oauth-copy {
  background: transparent;
  border: 1px solid var(--border, #ddd);
  border-radius: 6px;
  padding: 4px 6px;
  cursor: pointer;
}
.oauth-btn {
  width: 100%;
}
.oauth-uri {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-3, #999);
  word-break: break-all;
  user-select: all;
}
.oauth-error {
  font-size: 13px;
  color: var(--danger, #d33);
  margin: 0 0 12px;
  line-height: 1.7;
}
</style>
