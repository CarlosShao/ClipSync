<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAiChat } from '@/composables/useAiChat'
import Button from '@/components/ui/button/Button.vue'
import AiMessageList from './AiMessageList.vue'
import AiChatInput from './AiChatInput.vue'
import { X, Trash2, Bot, Plus, Settings2, MessageSquare, Workflow, ChevronLeft, ChevronRight } from 'lucide-vue-next'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; 'open-settings': [] }>()
const { t } = useI18n()

const { providers, selectedProviderId, messages, isStreaming, error, hasProviders, canSend, init, loadProviders, selectProvider, send, stop, clear } =
  useAiChat()

// 模式：ask 或 agent
const mode = ref<'ask' | 'agent'>('ask')

// 思考模式（从 localStorage 恢复）
const thinkingEnabled = ref(localStorage.getItem('ai-thinking-enabled') === 'true')
const thinkingStrength = ref<'low' | 'medium' | 'high'>(
  (localStorage.getItem('ai-thinking-strength') as 'low' | 'medium' | 'high') || 'medium'
)

// 监听变化并持久化
watch(thinkingEnabled, (v) => localStorage.setItem('ai-thinking-enabled', String(v)))
watch(thinkingStrength, (v) => localStorage.setItem('ai-thinking-strength', v))

// 对话历史面板
const showHistory = ref(false)

onMounted(init)

watch(
  () => props.open,
  (v) => {
    if (v) loadProviders()
  },
)

function onSend(text: string) {
  send(text, { mode: mode.value, thinking: thinkingEnabled.value, thinkingStrength: thinkingStrength.value })
}

function toggleThinking() {
  thinkingEnabled.value = !thinkingEnabled.value
}

function setThinkingStrength(s: 'low' | 'medium' | 'high') {
  thinkingStrength.value = s
}
</script>

<template>
  <aside class="ai-panel" :class="{ 'ai-panel--open': open }" :aria-hidden="!open">
    <!-- 顶部栏 -->
    <div class="ai-header">
      <div class="ai-header-left">
        <div class="ai-header-title">
          <Bot :size="18" />
          <span>AI</span>
        </div>
      </div>
      <div class="ai-header-right">
        <Button v-if="messages.length" variant="ghost" size="icon-sm" :title="t('ai_clear')" @click="clear">
          <Trash2 :size="15" />
        </Button>
        <Button variant="ghost" size="icon-sm" :title="t('close_btn')" @click="emit('close')">
          <X :size="16" />
        </Button>
      </div>
    </div>

    <!-- 无供应商提示 -->
    <div v-if="!hasProviders" class="ai-no-providers">
      <Bot :size="48" class="ai-no-providers-icon" />
      <h3>{{ t('ai_no_providers_title') || 'No AI Provider' }}</h3>
      <p>{{ t('ai_no_providers_hint') }}</p>
      <Button class="ai-setup-btn" @click="emit('open-settings')">
        <Plus :size="14" />
        {{ t('ai_go_settings') }}
      </Button>
    </div>

    <!-- 主聊天区 -->
    <template v-else>
      <!-- Agent 模式：工作流显示 -->
      <div v-if="mode === 'agent'" class="ai-workflow-bar">
        <div class="ai-workflow-info">
          <Workflow :size="14" />
          <span>{{ t('ai_workflow_active') || 'Workflow Mode Active' }}</span>
        </div>
      </div>

      <AiMessageList :messages="messages" :is-streaming="isStreaming" />
      
      <div v-if="error" class="ai-error-bar">{{ error }}</div>
      
      <AiChatInput
        :disabled="!canSend"
        :is-streaming="isStreaming"
        :providers="providers"
        :selected-provider-id="selectedProviderId"
        :thinking-enabled="thinkingEnabled"
        :thinking-strength="thinkingStrength"
        :mode="mode"
        @send="onSend"
        @stop="stop"
        @select-provider="selectProvider"
        @toggle-thinking="toggleThinking"
        @set-thinking-strength="setThinkingStrength"
        @set-mode="(m) => mode = m"
        @open-settings="emit('open-settings')"
      />
    </template>
  </aside>
</template>

<style scoped>
.ai-panel {
  width: 0;
  min-width: 0;
  background: var(--bg-surface);
  border-left: 1px solid var(--border-default);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.22s ease, min-width 0.22s ease;
  flex-shrink: 0;
}

.ai-panel--open {
  width: 420px;
  min-width: 420px;
}

.ai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.ai-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ai-header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.ai-header-right {
  display: flex;
  gap: 4px;
}

.ai-no-providers {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
}

.ai-no-providers-icon {
  opacity: 0.3;
  margin-bottom: 8px;
}

.ai-no-providers h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.ai-no-providers p {
  font-size: 13px;
  margin: 0;
  line-height: 1.5;
}

.ai-setup-btn {
  min-width: 140px;
}

.ai-workflow-bar {
  padding: 8px 14px;
  background: var(--accent-bg);
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.ai-workflow-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--accent);
  font-weight: 500;
}

.ai-error-bar {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--danger, #ef4444);
  background: var(--danger-bg, #fef2f2);
  border-top: 1px solid var(--border-default);
}
</style>
