<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { X, Sparkles } from 'lucide-vue-next'
import { getProviders, summarizeClipboard } from '@/api/ai'
import { useI18n } from '@/composables/useI18n'

interface ClipboardChangedPayload {
  content?: string
  contentType?: string
  timestamp?: string
}

/** 复制后自动 AI 摘要开关：默认关闭（默认不产生任何 LLM 调用）。
 *  与 AIProviderSettings 共享同一个 localStorage key。 */
const AUTO_SUMMARY_KEY = 'ai-auto-summary-on-copy'
/** 同内容节流窗口（10 分钟） */
const THROTTLE_MS = 10 * 60 * 1000
/** 单请求硬超时：与 client.ts 内置超时对齐，传入自定义 signal 后由本组件兜底 */
const REQUEST_TIMEOUT_MS = 30_000
/** 浮窗最长驻留时间 */
const DISMISS_MS = 12_000

const { tf } = useI18n()

const visible = ref(false)
const preview = ref('')
const summary = ref('')
const loading = ref(false)
const providerId = ref('')

/** 开关状态：localStorage 为准（'1' 开启，其余一律视为关闭） */
const autoEnabled = ref(localStorage.getItem(AUTO_SUMMARY_KEY) === '1')

let unlisten: UnlistenFn | null = null
let dismissTimer: ReturnType<typeof setTimeout> | null = null
/** 在途请求的中止控制器：发起新请求前先 abort 旧的 */
let inFlight: AbortController | null = null
/** 单请求硬超时兜底（自定义 signal 覆盖了 client 内置超时） */
let requestTimer: ReturnType<typeof setTimeout> | null = null
/** 节流表：内容 → 上次成功发起请求的时间戳 */
const lastRequestedAt = new Map<string, number>()
/** 单调递增的请求序号：迟到响应不覆盖新请求结果 */
let requestSeq = 0

function close() {
  visible.value = false
  if (dismissTimer) {
    clearTimeout(dismissTimer)
    dismissTimer = null
  }
}

function abortInFlight() {
  if (inFlight) {
    inFlight.abort()
    inFlight = null
  }
  if (requestTimer) {
    clearTimeout(requestTimer)
    requestTimer = null
  }
}

function syncAutoEnabled() {
  autoEnabled.value = localStorage.getItem(AUTO_SUMMARY_KEY) === '1'
  // 关闭开关时立刻收起浮窗并中止在途请求，避免"关了还在调"
  if (!autoEnabled.value) {
    abortInFlight()
    close()
  }
}

async function ensureProvider() {
  if (providerId.value) return
  const res = await getProviders()
  if (res.ok && res.data?.items?.length) {
    const p = res.data.items.find((x) => x.is_default) || res.data.items[0]
    providerId.value = p.id
  }
}

async function summarize(content: string) {
  await ensureProvider()
  if (!providerId.value) {
    // 无可用 provider 时静默跳过，不报错、不打扰
    close()
    return
  }
  // 新请求前先中止在途请求
  abortInFlight()
  const seq = ++requestSeq
  const ctrl = new AbortController()
  inFlight = ctrl
  requestTimer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)

  loading.value = true
  try {
    const res = await summarizeClipboard({ providerId: providerId.value, content }, { signal: ctrl.signal })
    // 迟到响应（已被更新的请求取代 / 组件已卸载）直接丢弃
    if (seq !== requestSeq) return
    if (res.ok && res.data?.summary) {
      summary.value = res.data.summary
    } else {
      // 摘要失败 → 静默关闭浮窗，不显示错误打扰用户
      close()
    }
  } catch {
    // 网络/服务端异常/主动中止 → 静默关闭浮窗
    if (seq === requestSeq) close()
  } finally {
    if (seq === requestSeq) {
      loading.value = false
      inFlight = null
      if (requestTimer) {
        clearTimeout(requestTimer)
        requestTimer = null
      }
    }
  }
}

async function onClipboardChanged(event: { payload: ClipboardChangedPayload }) {
  // 开关关闭：完全不介入，不发起任何 LLM 调用
  if (!autoEnabled.value) return
  const payload = event.payload
  if (!payload || payload.contentType === 'file' || payload.contentType === 'image') return
  const text = payload.content || ''
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 4000) return

  // 同内容 10 分钟节流：窗口内不重复调用
  const now = Date.now()
  const last = lastRequestedAt.get(trimmed)
  if (last && now - last < THROTTLE_MS) return
  lastRequestedAt.set(trimmed, now)
  // 简易容量控制：避免长期运行无限增长
  if (lastRequestedAt.size > 50) {
    for (const [k, ts] of lastRequestedAt) {
      if (now - ts >= THROTTLE_MS) lastRequestedAt.delete(k)
    }
  }

  preview.value = trimmed.slice(0, 120)
  summary.value = ''
  visible.value = true
  if (dismissTimer) clearTimeout(dismissTimer)
  dismissTimer = setTimeout(close, DISMISS_MS)
  await summarize(trimmed)
}

onMounted(async () => {
  unlisten = await listen('clipboard-changed', onClipboardChanged)
  // 设置页改动开关后即时生效（跨组件同步）
  window.addEventListener('clipsync:ai-auto-summary-changed', syncAutoEnabled)
  window.addEventListener('storage', syncAutoEnabled)
})

onUnmounted(() => {
  if (unlisten) unlisten()
  if (dismissTimer) clearTimeout(dismissTimer)
  abortInFlight()
  requestSeq++
  window.removeEventListener('clipsync:ai-auto-summary-changed', syncAutoEnabled)
  window.removeEventListener('storage', syncAutoEnabled)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="summary-float">
      <div v-if="visible" class="ai-summary-float pointer-events-auto">
        <div class="flex items-start justify-between gap-2 shrink-0">
          <div class="flex items-center gap-1.5 text-xs font-medium text-strong">
            <Sparkles class="w-3.5 h-3.5" />
            <span>{{ tf('ai_summary_float_title', 'AI 摘要') }}</span>
          </div>
          <button
            class="p-1 rounded-md hover:bg-muted text-muted-foreground transition-colors"
            :title="tf('close_btn', '关闭')"
            @click="close"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
        <div class="float-preview mt-2 text-xs text-muted-foreground">
          {{ preview }}
        </div>
        <div class="float-summary mt-2 text-sm leading-relaxed text-foreground">
          <span v-if="loading" class="text-muted-foreground">{{
            tf('ai_summary_float_loading', '正在生成摘要...')
          }}</span>
          <span v-else>{{ summary }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ai-summary-float {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 320px;
  max-width: calc(100vw - 48px);
  max-height: 260px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: hsl(var(--background) / 0.98);
  border: 1px solid hsl(var(--border));
  border-radius: 12px;
  padding: 14px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
  /* C8⑤：收敛到 --z-* 变量，且必须位于 toast 层之下（--z-toast=9200；原裸值 9999 会盖住 toast） */
  z-index: var(--z-drawer, 9000);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}

.float-preview {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  overflow: hidden;
  word-break: break-word;
}

.float-summary {
  flex: 1 1 auto;
  min-height: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
  word-break: break-word;
}

.summary-float-enter-active,
.summary-float-leave-active {
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.summary-float-enter-from,
.summary-float-leave-to {
  opacity: 0;
  transform: translateY(16px) scale(0.96);
}
</style>
