<script setup lang="ts">
// 页内 AI 结果卡（clearline 卡面语言）：A 线各入口复用；
// 写操作类通过 actions 插槽注入「采纳」等按钮，只读类用默认操作条。
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { Copy, X, RefreshCw, Sparkles, MessageSquare } from 'lucide-vue-next'
import AiStreamText from './AiStreamText.vue'

const props = defineProps<{
  title: string
  status: 'idle' | 'loading' | 'done' | 'error'
  text: string
  /** 打字机展示值（useInlineAi.displayText）；提供时走流式渲染，未提供回退 text */
  displayText?: string
  /** 打字机播出中（useInlineAi.streaming） */
  streaming?: boolean
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
// 流式展示值：打字机在播用 displayText；播完（done）用完整 text；body 插槽覆盖时此值仅影响拷贝兜底
const streamedText = computed(() => props.displayText || props.text)

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

    <!-- 等待后端返回：转圈；打字机播出中：渲染流式 Markdown + 光标 -->
    <div v-if="status === 'loading' && !(streaming || streamedText)" class="iac-loading">
      <span class="iac-spinner" />
      <span>{{ loadingLabel }}</span>
    </div>
    <div v-else-if="status === 'loading'" class="iac-body markdown-body">
      <AiStreamText :text="streamedText" :done="false" />
      <span class="iac-caret" aria-hidden="true" />
    </div>

    <div v-else-if="status === 'error'" class="iac-error">
      <span>{{ tf(error || 'inline_ai_failed', 'AI 调用失败') }}</span>
      <button type="button" class="pl-btn pl-btn--sm" @click="emit('retry')">
        <RefreshCw :size="12" /><span>{{ tf('inline_ai_retry', '重试') }}</span>
      </button>
    </div>

    <template v-else-if="status === 'done'">
      <div class="iac-body markdown-body">
        <!-- body 插槽：结构化结果（如审查清单）可替换默认文本渲染；
             默认走 Markdown 预览（与 AI 侧栏同管线），不再裸显源码 -->
        <slot name="body"><AiStreamText :text="text" :done="true" /></slot>
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
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}
/* 打字机光标：与 AI 侧栏同语言（中性灰呼吸） */
.iac-caret {
  display: inline-block;
  width: 2px;
  height: 1.2em;
  margin-left: 1px;
  vertical-align: text-bottom;
  background: var(--text-secondary);
  border-radius: 1px;
  animation: iac-caret-pulse 1.2s ease-in-out infinite;
}
@keyframes iac-caret-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scaleY(1);
  }
  50% {
    opacity: 0.4;
    transform: scaleY(0.85);
  }
}
@media (prefers-reduced-motion: reduce) {
  .iac-caret {
    animation: none;
  }
}
/* Markdown 预览排版（与 AI 侧栏 .ai-msg-content 同 token） */
.iac-body.markdown-body :deep(h1),
.iac-body.markdown-body :deep(h2),
.iac-body.markdown-body :deep(h3),
.iac-body.markdown-body :deep(h4) {
  margin: 12px 0 6px;
  font-weight: 600;
}
.iac-body.markdown-body :deep(h1) {
  font-size: 17px;
}
.iac-body.markdown-body :deep(h2) {
  font-size: 15px;
}
.iac-body.markdown-body :deep(h3) {
  font-size: 13.5px;
}
.iac-body.markdown-body :deep(p) {
  margin: 6px 0;
}
.iac-body.markdown-body :deep(ul),
.iac-body.markdown-body :deep(ol) {
  padding-left: 20px;
  margin: 6px 0;
}
.iac-body.markdown-body :deep(li) {
  margin: 3px 0;
}
.iac-body.markdown-body :deep(code) {
  background: var(--bg-overlay-l1, var(--bg-hover));
  padding: 2px 5px;
  border-radius: 4px;
  font-family: var(--font-family-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--accent);
}
.iac-body.markdown-body :deep(pre) {
  background: var(--bg-base-secondary, var(--bg-hover));
  border: 1px solid var(--border-neutral-l1, var(--border-default));
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  margin: 10px 0;
}
.iac-body.markdown-body :deep(pre code) {
  background: none;
  padding: 0;
  color: var(--text-default, var(--text-primary));
}
.iac-body.markdown-body :deep(strong) {
  font-weight: 600;
}
.iac-body.markdown-body :deep(a) {
  color: var(--accent);
}
.iac-body.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--accent);
  background: var(--bg-overlay-l1, var(--bg-hover));
  padding: 8px 14px;
  border-radius: 6px;
  margin: 8px 0;
  color: var(--text-secondary);
}
.iac-body.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12px;
}
.iac-body.markdown-body :deep(th),
.iac-body.markdown-body :deep(td) {
  padding: 8px 12px;
  border: 1px solid var(--border-neutral-l1, var(--border-default));
  text-align: left;
}
.iac-body.markdown-body :deep(th) {
  background: var(--bg-base-secondary, var(--bg-hover));
  font-weight: 600;
}
.iac-body.markdown-body :deep(tr:nth-child(2n)) {
  background: var(--bg-base-secondary, var(--bg-hover));
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
