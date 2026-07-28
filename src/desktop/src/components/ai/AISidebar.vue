<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAiChat } from '@/composables/useAiChat'
import Button from '@/components/ui/button/Button.vue'
import AiMessageList from './AiMessageList.vue'
import AiChatInput from './AiChatInput.vue'
import AiConversationList from './AiConversationList.vue'
import AiMemoryPanel from './AiMemoryPanel.vue'
import { X, Bot, Plus, Settings2, MessageSquare, Workflow, History, Brain } from 'lucide-vue-next'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; 'open-settings': [] }>()
const { t } = useI18n()

const {
  providers,
  selectedProviderId,
  messages,
  isStreaming,
  error,
  hasProviders,
  canSend,
  memoryEnabled,
  setMemoryEnabled,
  init,
  loadProviders,
  selectProvider,
  send,
  stop,
  clear,
  conversations,
  currentConversationId,
  currentConversation,
  loadConversations,
  newConversation,
  loadConversation,
  renameConversation,
  deleteConversation,
  // 注意：resume（继续生成）按钮已按用户要求移除，用户可自行输入“继续”。
} = useAiChat()

// 记忆面板展开状态
const showMemory = ref(false)

// 模式：ask 或 agent
const mode = ref<'ask' | 'agent'>('ask')

// 思考模式（从 localStorage 恢复）
const thinkingEnabled = ref(localStorage.getItem('ai-thinking-enabled') === 'true')
const thinkingStrength = ref<'low' | 'medium' | 'high'>(
  (localStorage.getItem('ai-thinking-strength') as 'low' | 'medium' | 'high') || 'medium'
)

watch(thinkingEnabled, (v) => localStorage.setItem('ai-thinking-enabled', String(v)))
watch(thinkingStrength, (v) => localStorage.setItem('ai-thinking-strength', v))

// 并行多代理开关（从 localStorage 恢复，默认关闭）
const parallelEnabled = ref(localStorage.getItem('ai-parallel') === 'true')
watch(parallelEnabled, (v) => localStorage.setItem('ai-parallel', String(v)))

// 历史面板展开状态（桌面端默认折叠，点击历史按钮展开）
const showHistory = ref(false)

onMounted(init)

watch(
  () => props.open,
  (v) => {
    if (v) {
      loadProviders()
      loadConversations()
    }
  }
)

// 切换对话时同步模式/思考开关
async function onSelectConversation(id: string) {
  await loadConversation(id)
  if (currentConversation.value) {
    mode.value = currentConversation.value.mode || 'ask'
    thinkingEnabled.value = currentConversation.value.thinking_enabled || false
  }
}

async function onNewConversation() {
  await newConversation({ mode: mode.value, thinkingEnabled: thinkingEnabled.value })
}

function onSend(text: string) {
  send(text, { mode: mode.value, thinking: thinkingEnabled.value, thinkingStrength: thinkingStrength.value, parallel: parallelEnabled.value })
}

function toggleThinking() {
  thinkingEnabled.value = !thinkingEnabled.value
}

function setThinkingStrength(s: 'low' | 'medium' | 'high') {
  thinkingStrength.value = s
}

async function onRename(id: string, title: string) {
  await renameConversation(id, title)
}

async function onDelete(id: string) {
  await deleteConversation(id)
}
</script>

<template>
  <aside class="ai-panel" :class="{ 'ai-panel--open': open }" :aria-hidden="!open">
    <AiConversationList
      v-if="showHistory && hasProviders"
      :conversations="conversations"
      :current-id="currentConversationId"
      :loading="false"
      @select="onSelectConversation"
      @new="onNewConversation"
      @rename="onRename"
      @delete="onDelete"
    />

    <div class="ai-main">
      <!-- 顶部栏 -->
      <div class="ai-header">
        <div class="ai-header-left">
          <Button v-if="hasProviders" variant="ghost" size="icon-sm" :title="t('ai_history') || '历史'" @click="showHistory = !showHistory">
            <History :size="16" />
          </Button>
          <Button v-if="hasProviders" variant="ghost" size="icon-sm" :title="t('ai_memory') || '记忆'" @click="showMemory = !showMemory">
            <Brain :size="16" />
          </Button>
          <div class="ai-header-title">
            <Bot :size="18" />
            <span>AI</span>
          </div>
        </div>
        <div class="ai-header-right">
          <Button v-if="hasProviders" variant="ghost" size="icon-sm" :title="t('ai_new_chat') || '新对话'" @click="onNewConversation">
            <Plus :size="15" />
          </Button>
          <Button v-if="messages.length" variant="ghost" size="icon-sm" :title="t('ai_clear')" @click="clear">
            <MessageSquare :size="15" />
          </Button>
          <Button variant="ghost" size="icon-sm" :title="t('close_btn')" @click="emit('close')">
            <X :size="16" />
          </Button>
        </div>
      </div>

      <!-- 记忆管理面板 -->
      <AiMemoryPanel
        v-if="showMemory"
        :open="showMemory"
        :memory-enabled="memoryEnabled"
        @close="showMemory = false"
        @update:memory-enabled="setMemoryEnabled"
      />

      <!-- 无供应商提示 / 主聊天区 -->
      <template v-else>
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
            :parallel-enabled="parallelEnabled"
            @send="onSend"
            @stop="stop"
            @select-provider="selectProvider"
            @toggle-thinking="toggleThinking"
            @set-thinking-strength="setThinkingStrength"
            @set-mode="(m) => mode = m"
            @toggle-parallel="parallelEnabled = !parallelEnabled"
            @open-settings="emit('open-settings')"
          />
        </template>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.ai-panel {
  width: 0;
  min-width: 0;
  background: var(--bg-surface);
  border-left: 1px solid var(--border-default);
  display: flex;
  flex-direction: row;
  overflow: hidden;
  transition: width 0.22s ease, min-width 0.22s ease;
  flex-shrink: 0;
}

.ai-panel--open {
  width: 420px;
  min-width: 420px;
}
.ai-panel--open:has(.ai-conv-panel) {
  width: 640px;
  min-width: 640px;
}

.ai-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
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
  gap: 8px;
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
