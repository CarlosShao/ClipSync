<script setup lang="ts">
import { ref } from 'vue'
import AiChatComposer from './AiChatComposer.vue'
import type { AiProvider, ContextUsage, ChatImage } from '@/api/ai'

/**
 * AiChatInput — 转发薄壳（UI-C 过渡兼容层）
 *
 * 实现已全部迁移至 AiChatComposer.vue；本文件仅为兼容既有引用（AISidebar 及
 * 并行代理新 Shell）保留同名入口，透传全部 props / emits 与 setDraft 暴露。
 * 契约与 AiChatComposer 完全一致；待 UI-F 收尾包统一替换引用后删除本文件。
 */
defineProps<{
  disabled: boolean
  isStreaming: boolean
  providers: AiProvider[]
  selectedProviderId: string
  selectedModel: string
  thinkingEnabled: boolean
  thinkingStrength: 'low' | 'medium' | 'high'
  mode: 'ask' | 'agent'
  contextUsage: ContextUsage | null
  providerSupportsCache?: boolean
}>()

const emit = defineEmits<{
  send: [text: string, images?: ChatImage[]]
  'quick-action': [action: 'summarize' | 'translate' | 'format' | 'explain', text: string, images?: ChatImage[]]
  stop: []
  'select-provider': [id: string]
  'select-model': [model: string]
  'toggle-thinking': []
  'set-thinking-strength': [strength: 'low' | 'medium' | 'high']
  'set-mode': [mode: 'ask' | 'agent']
  'open-settings': []
}>()

const composerRef = ref<InstanceType<typeof AiChatComposer> | null>(null)

// 历史消息「重新编辑」：透传给 Composer（填回输入框并聚焦）
function setDraft(content: string) {
  composerRef.value?.setDraft(content)
}

defineExpose({ setDraft })
</script>

<template>
  <AiChatComposer
    ref="composerRef"
    :disabled="disabled"
    :is-streaming="isStreaming"
    :providers="providers"
    :selected-provider-id="selectedProviderId"
    :selected-model="selectedModel"
    :thinking-enabled="thinkingEnabled"
    :thinking-strength="thinkingStrength"
    :mode="mode"
    :context-usage="contextUsage"
    :provider-supports-cache="providerSupportsCache"
    @send="(text, images) => emit('send', text, images)"
    @quick-action="(action, text, images) => emit('quick-action', action, text, images)"
    @stop="emit('stop')"
    @select-provider="(id) => emit('select-provider', id)"
    @select-model="(model) => emit('select-model', model)"
    @toggle-thinking="emit('toggle-thinking')"
    @set-thinking-strength="(strength) => emit('set-thinking-strength', strength)"
    @set-mode="(m) => emit('set-mode', m)"
    @open-settings="emit('open-settings')"
  />
</template>
