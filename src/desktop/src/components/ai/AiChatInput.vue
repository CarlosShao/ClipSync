<script setup lang="ts">
import { ref, computed } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'
import type { AiProvider } from '@/api/ai'
import { Send, Square, Brain, ChevronDown, Settings2 } from 'lucide-vue-next'

const props = defineProps<{
  disabled: boolean
  isStreaming: boolean
  providers: AiProvider[]
  selectedProviderId: string
  selectedModel: string
  thinkingEnabled: boolean
  thinkingStrength: 'low' | 'medium' | 'high'
  mode: 'ask' | 'agent'
}>()
const emit = defineEmits<{
  send: [text: string]
  stop: []
  'select-provider': [id: string]
  'select-model': [model: string]
  'toggle-thinking': []
  'set-thinking-strength': [strength: 'low' | 'medium' | 'high']
  'set-mode': [mode: 'ask' | 'agent']
  'open-settings': []
}>()
const { t } = useI18n()

const text = ref('')
const activePopup = ref<string | null>(null)

// 各下拉气泡及其触发按钮的 ref（用于点击外部关闭）
const thinkingBtnEl = ref<HTMLElement | null>(null)
const thinkingPopupEl = ref<HTMLElement | null>(null)
const modeBtnEl = ref<HTMLElement | null>(null)
const modePopupEl = ref<HTMLElement | null>(null)
const modelBtnEl = ref<HTMLElement | null>(null)
const modelPopupEl = ref<HTMLElement | null>(null)

onClickOutside(thinkingPopupEl, () => { if (activePopup.value === 'thinking') activePopup.value = null }, { ignore: [thinkingBtnEl] })
onClickOutside(modePopupEl, () => { if (activePopup.value === 'mode') activePopup.value = null }, { ignore: [modeBtnEl] })
onClickOutside(modelPopupEl, () => { if (activePopup.value === 'model') activePopup.value = null }, { ignore: [modelBtnEl] })

const selectedProvider = computed(() => props.providers.find((x) => x.id === props.selectedProviderId))

const providerLabel = computed(() => {
  const p = selectedProvider.value
  if (!p) return t('ai_select_provider')
  // 用户要求展示模型名而非配置名称
  return props.selectedModel || p.model || p.name
})

// 当前选中供应商下可用模型列表（多选标签来源）
const selectedProviderModels = computed<string[]>(() => {
  const p = selectedProvider.value
  if (p && Array.isArray(p.models) && p.models.length > 0) return p.models
  // 无上游列表时，至少把当前 model 作为唯一标签
  return p?.model ? [p.model] : []
})

const inputPlaceholder = computed(() => {
  if (props.providers.length === 0 || !props.selectedProviderId) {
    return t('ai_input_disabled') || '请先添加供应商'
  }
  if (props.isStreaming) {
    return t('ai_input_streaming') || 'AI 回答中...'
  }
  return t('ai_input_ph') || '输入消息，Enter 发送，Shift+Enter 换行'
})

const modeLabel = computed(() => {
  return props.mode === 'ask' ? t('ai_mode_ask') : t('ai_mode_agent')
})

// 发送按钮旁圆环提示文案（Agent 模式下模型自行决定是否派发子代理）
const orchestrationTip = computed(() => {
  return props.mode === 'agent'
    ? t('ai_orchestration_agent_tip') || 'Agent 模式：模型将自动决定是否派发子代理'
    : t('ai_orchestration_ask_tip') || 'Ask 模式：直接回答'
})

function submit() {
  const value = text.value.trim()
  if (!value || props.disabled) return
  emit('send', value)
  text.value = ''
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}

function togglePopup(name: string) {
  activePopup.value = activePopup.value === name ? null : name
}

function closePopups() {
  activePopup.value = null
}

function selectProvider(id: string) {
  emit('select-provider', id)
  closePopups()
}

function setMode(m: 'ask' | 'agent') {
  emit('set-mode', m)
  closePopups()
}

function setStrength(s: 'low' | 'medium' | 'high') {
  emit('set-thinking-strength', s)
  if (!props.thinkingEnabled) emit('toggle-thinking')
  closePopups()
}

function toggleThinking() {
  emit('toggle-thinking')
  closePopups()
}
</script>

<template>
  <div class="ai-input-card" @click="closePopups">
    <!-- 文本输入区 -->
    <textarea
      v-model="text"
      class="ai-textarea"
      :placeholder="inputPlaceholder"
      :disabled="disabled"
      rows="2"
      @keydown="onKeydown"
      @click.stop
    />

    <!-- 底部工具栏 -->
    <div class="ai-card-bottom">
      <div class="ai-card-actions">
        <!-- 思考模式 -->
        <button ref="thinkingBtnEl" class="ai-tag-btn" :class="{ active: thinkingEnabled }" @click.stop="togglePopup('thinking')">
          <Brain :size="12" />
          <span>{{ thinkingEnabled ? t('ai_strength_' + thinkingStrength) : t('ai_thinking') }}</span>
        </button>
        <div v-if="activePopup === 'thinking'" ref="thinkingPopupEl" class="ai-popup" @click.stop>
          <button :class="{ active: thinkingEnabled && thinkingStrength === 'low' }" @click="setStrength('low')">{{ t('ai_strength_low') }}</button>
          <button :class="{ active: thinkingEnabled && thinkingStrength === 'medium' }" @click="setStrength('medium')">{{ t('ai_strength_medium') }}</button>
          <button :class="{ active: thinkingEnabled && thinkingStrength === 'high' }" @click="setStrength('high')">{{ t('ai_strength_high') }}</button>
          <button class="ai-popup-divider" @click="toggleThinking">{{ thinkingEnabled ? t('ai_thinking_off') : t('ai_thinking_on') }}</button>
        </div>

        <!-- Ask/Agent（一个按钮，点击选择） -->
        <button ref="modeBtnEl" class="ai-tag-btn" @click.stop="togglePopup('mode')">
          {{ modeLabel }}
          <ChevronDown :size="10" />
        </button>
        <div v-if="activePopup === 'mode'" ref="modePopupEl" class="ai-popup" @click.stop>
          <button :class="{ active: mode === 'ask' }" @click="setMode('ask')">{{ t('ai_mode_ask') }}</button>
          <button :class="{ active: mode === 'agent' }" @click="setMode('agent')">{{ t('ai_mode_agent') }}</button>
        </div>

        <!-- 模型选择（当前供应商的多模型以标签形式展示） -->
        <button ref="modelBtnEl" class="ai-tag-btn" @click.stop="togglePopup('model')">
          <span>{{ providerLabel }}</span>
          <ChevronDown :size="10" />
        </button>
        <div v-if="activePopup === 'model'" ref="modelPopupEl" class="ai-popup ai-popup--right ai-popup--models" @click.stop>
          <div class="ai-popup-title">{{ t('ai_select_model') }}</div>
          <button
            v-for="m in selectedProviderModels"
            :key="m"
            :class="{ active: (selectedModel || selectedProvider?.model) === m }"
            @click="emit('select-model', m); closePopups()"
          >{{ m }}</button>
          <div class="ai-popup-title ai-popup-title--sub">{{ t('ai_switch_provider') }}</div>
          <button
            v-for="p in providers"
            :key="p.id"
            :class="{ active: selectedProviderId === p.id }"
            @click="selectProvider(p.id)"
          >{{ p.name }}</button>
          <button class="ai-popup-divider" @click="emit('open-settings'); closePopups()">{{ t('ai_manage') }}</button>
        </div>
      </div>

      <div class="ai-send-area">
        <div class="ai-orchestration-ring" :class="{ agent: mode === 'agent' }" :title="orchestrationTip" />
        <Button v-if="!isStreaming" size="icon" class="ai-send-btn" :disabled="disabled || !text.trim()" @click="submit">
          <Send :size="16" />
        </Button>
        <Button v-else size="icon" variant="outline" class="ai-send-btn" @click="emit('stop')">
          <Square :size="16" />
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-input-card {
  border-top: 1px solid var(--border-default);
  padding: 12px 14px 14px;
  background: var(--bg-surface);
  flex-shrink: 0;
}

.ai-input-card {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-input, var(--bg-hover));
  padding: 0;
  overflow: visible;
  transition: border-color 0.15s;
}

.ai-input-card:focus-within {
  border-color: var(--accent);
}

.ai-textarea {
  width: 100%;
  min-height: 80px;
  resize: none;
  border: none;
  background: transparent;
  color: var(--text-primary);
  padding: 12px 14px;
  font-size: 14px;
  line-height: 1.6;
  outline: none;
}

.ai-textarea::placeholder {
  color: var(--text-tertiary);
}

.ai-card-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-top: 1px solid var(--border-subtle);
}

.ai-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  position: relative;
}

.ai-tag-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.ai-tag-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.ai-tag-btn.active {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
}

.ai-send-area {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ai-orchestration-ring {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--border-default);
  background: transparent;
  transition: all 0.2s ease;
  cursor: help;
  flex-shrink: 0;
}

.ai-orchestration-ring.agent {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent);
}

.ai-send-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 50%;
}

.ai-popup {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 6px;
  min-width: 140px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-dropdown);
  overflow: hidden;
  z-index: 50;
}

.ai-popup--right {
  left: auto;
  right: 0;
}

.ai-popup--models {
  min-width: 200px;
  max-height: 280px;
  overflow-y: auto;
}

.ai-popup-title {
  padding: 8px 12px 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
}

.ai-popup-title--sub {
  border-top: 1px solid var(--border-subtle);
  margin-top: 4px;
  padding-top: 8px;
}

.ai-popup button {
  display: block;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition: background 0.12s;
}

.ai-popup button:hover {
  background: var(--bg-hover);
}

.ai-popup button.active {
  color: var(--accent);
  font-weight: 500;
}

.ai-popup-divider {
  border-top: 1px solid var(--border-subtle) !important;
  color: var(--text-secondary) !important;
}
</style>
