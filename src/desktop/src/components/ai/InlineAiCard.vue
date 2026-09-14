<script setup lang="ts">
// 页内 AI 结果卡（clearline 卡面语言）：A 线各入口复用；
// 写操作类通过 actions 插槽注入「采纳」等按钮，只读类用默认操作条。
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { Copy, X, RefreshCw, Sparkles, MessageSquare } from 'lucide-vue-next'

const props = defineProps<{
  title: string
  status: 'idle' | 'loading' | 'done' | 'error'
  text: string
  error?: string
  closable?: boolean
}>()

const emit = defineEmits<{
  close: []
  retry: []
}>()

const { t, tf } = useI18n()
const toast = useSonner()

const loadingLabel = computed(() => tf('inline_ai_loading', '分析中…'))

function copyText() {
  const payload = props.text || ''
  if (!payload) return
  void navigator.clipboard.writeText(payload)
  toast.show(tf('inline_ai_copied', '已复制'), 'success')
}

/** 兜底通道：携带结果进入侧栏 —— A7：带 context 的载荷在侧栏折叠为引用块 + 输入框草稿，不自动发送 */
function continueInChat() {
  window.dispatchEvent(new CustomEvent('clipsync:toggle-ai'))
  setTimeout(() => {
    const detail = props.text
      ? { content: '请继续：', context: props.text.slice(0, 2000) }
      : { content: '请继续：' }
    window.dispatchEvent(new CustomEvent('clipsync:ai-send-message', { detail }))
  }, 120)
}
</script>

<template>
  <div class="inline-ai-card">
    <div class="iac-head">
      <span class="iac-title"><Sparkles :size="13" />{{ title }}</span>
      <button v-if="closable !== false" type="button" class="pl-icon-btn" :title="tf('inline_ai_close', '关闭')" @click="emit('close')">
        <X :size="14" />
      </button>
    </div>

    <div v-if="status === 'loading'" class="iac-loading">
      <span class="iac-spinner" />
      <span>{{ loadingLabel }}</span>
    </div>

    <div v-else-if="status === 'error'" class="iac-error">
      <span>{{ error || tf('inline_ai_failed', 'AI 调用失败') }}</span>
      <button type="button" class="pl-btn pl-btn--sm" @click="emit('retry')">
        <RefreshCw :size="12" /><span>{{ tf('inline_ai_retry', '重试') }}</span>
      </button>
    </div>

    <template v-else-if="status === 'done'">
      <div class="iac-body">
        <!-- body 插槽：结构化结果（如审查清单）可替换默认文本渲染 -->
        <slot name="body">{{ text }}</slot>
      </div>
      <div class="iac-acts">
        <!-- 写操作类（采纳等）由 actions 插槽注入，置于最左 -->
        <slot name="actions" />
        <span class="iac-acts-spacer" />
        <button type="button" class="pl-btn pl-btn--sm" :title="tf('inline_ai_copy', '复制')" @click="copyText">
          <Copy :size="12" /><span>{{ tf('inline_ai_copy', '复制') }}</span>
        </button>
        <button type="button" class="pl-btn pl-btn--sm" :title="tf('inline_ai_continue', '在 AI 助手中继续')" @click="continueInChat">
          <MessageSquare :size="12" /><span>{{ tf('inline_ai_continue', '在 AI 助手中继续') }}</span>
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.inline-ai-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  overflow: hidden;
  animation: iac-in 160ms var(--ease);
}
@keyframes iac-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.iac-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border-subtle);
}
.iac-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.iac-title svg {
  color: var(--accent);
}
.iac-head .pl-icon-btn {
  margin-left: auto;
}
.iac-loading {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 16px 12px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.iac-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: iac-spin 0.8s linear infinite;
}
@keyframes iac-spin {
  to {
    transform: rotate(360deg);
  }
}
.iac-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px;
  font-size: 12.5px;
  color: var(--danger);
}
.iac-body {
  padding: 12px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}
.iac-acts {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-subtle);
}
.iac-acts-spacer {
  flex: 1;
}
</style>
