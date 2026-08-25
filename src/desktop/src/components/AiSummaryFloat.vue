<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { X, Sparkles } from 'lucide-vue-next'
import { getProviders, summarizeClipboard } from '@/api/ai'
import { logger } from '@/utils/logger'

interface ClipboardChangedPayload {
  content?: string
  contentType?: string
  timestamp?: string
}

const visible = ref(false)
const preview = ref('')
const summary = ref('')
const loading = ref(false)
const error = ref('')
const providerId = ref('')

let unlisten: UnlistenFn | null = null
let dismissTimer: ReturnType<typeof setTimeout> | null = null

function close() {
  visible.value = false
  if (dismissTimer) {
    clearTimeout(dismissTimer)
    dismissTimer = null
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
    // 无可用 provider 时静默关闭浮窗
    close()
    return
  }
  loading.value = true
  error.value = ''
  try {
    const res = await summarizeClipboard({ providerId: providerId.value, content })
    if (res.ok && res.data?.summary) {
      summary.value = res.data.summary
    } else {
      // 摘要失败 → 静默关闭浮窗，不显示错误打扰用户
      close()
    }
  } catch (e: any) {
    console.warn('[AiSummaryFloat] summarize failed:', e?.message || e)
    // 网络/服务端异常 → 静默关闭浮窗
    close()
  } finally {
    loading.value = false
  }
}

async function onClipboardChanged(event: { payload: ClipboardChangedPayload }) {
  const payload = event.payload
  if (!payload || payload.contentType === 'file' || payload.contentType === 'image') return
  const text = payload.content || ''
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 4000) return
  preview.value = trimmed.slice(0, 120)
  summary.value = ''
  error.value = ''
  visible.value = true
  if (dismissTimer) clearTimeout(dismissTimer)
  dismissTimer = setTimeout(close, 12000)
  await summarize(trimmed)
}

onMounted(async () => {
  unlisten = await listen('clipboard-changed', onClipboardChanged)
})

onUnmounted(() => {
  if (unlisten) unlisten()
  if (dismissTimer) clearTimeout(dismissTimer)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="summary-float">
      <div
        v-if="visible"
        class="ai-summary-float pointer-events-auto"
      >
        <div class="flex items-start justify-between gap-2 shrink-0">
          <div class="flex items-center gap-1.5 text-xs font-medium text-primary">
            <Sparkles class="w-3.5 h-3.5" />
            <span>AI 摘要</span>
          </div>
          <button
            class="p-1 rounded-md hover:bg-muted text-muted-foreground transition-colors"
            @click="close"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
        <div class="float-preview mt-2 text-xs text-muted-foreground">
          {{ preview }}
        </div>
        <div class="float-summary mt-2 text-sm leading-relaxed text-foreground">
          <span v-if="loading" class="text-muted-foreground">正在生成摘要...</span>
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
  z-index: 9999;
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
