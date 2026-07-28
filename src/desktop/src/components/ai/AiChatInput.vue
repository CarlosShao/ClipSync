<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'
import type { AiProvider } from '@/api/ai'
import { Send, Square, Brain, ChevronDown, Settings2 } from 'lucide-vue-next'

const props = defineProps<{
  disabled: boolean
  isStreaming: boolean
  providers: AiProvider[]
  selectedProviderId: string
  thinkingEnabled: boolean
  thinkingStrength: 'low' | 'medium' | 'high'
  mode: 'ask' | 'agent'
}>()
const emit = defineEmits<{
  send: [text: string]
  stop: []
  'select-provider': [id: string]
  'toggle-thinking': []
  'set-thinking-strength': [strength: 'low' | 'medium' | 'high']
  'set-mode': [mode: 'ask' | 'agent']
  'open-settings': []
}>()
const { t } = useI18n()

const text = ref('')
const activePopup = ref<string | null>(null)

const providerLabel = computed(() => {
  const p = props.providers.find((x) => x.id === props.selectedProviderId)
  return p?.name || t('ai_select_provider')
})

const modeLabel = computed(() => {
  return props.mode === 'ask' ? t('ai_mode_ask') : t('ai_mode_agent')
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
      :placeholder="disabled ? t('ai_input_disabled') : t('ai_input_ph')"
      :disabled="disabled"
      rows="2"
      @keydown="onKeydown"
      @click.stop
    />

    <!-- 底部工具栏 -->
    <div class="ai-card-bottom">
      <div class="ai-card-actions">
        <!-- 思考模式 -->
        <button class="ai-tag-btn" :class="{ active: thinkingEnabled }" @click.stop="togglePopup('thinking')">
          <Brain :size="12" />
          <span>{{ thinkingEnabled ? t('ai_strength_' + thinkingStrength) : t('ai_thinking') }}</span>
        </button>
        <div v-if="activePopup === 'thinking'" class="ai-popup" @click.stop>
          <button :class="{ active: thinkingEnabled && thinkingStrength === 'low' }" @click="setStrength('low')">{{ t('ai_strength_low') }}</button>
          <button :class="{ active: thinkingEnabled && thinkingStrength === 'medium' }" @click="setStrength('medium')">{{ t('ai_strength_medium') }}</button>
          <button :class="{ active: thinkingEnabled && thinkingStrength === 'high' }" @click="setStrength('high')">{{ t('ai_strength_high') }}</button>
          <button class="ai-popup-divider" @click="toggleThinking">{{ thinkingEnabled ? t('ai_thinking_off') : t('ai_thinking_on') }}</button>
        </div>

        <!-- Ask/Agent（一个按钮，点击选择） -->
        <button class="ai-tag-btn" @click.stop="togglePopup('mode')">
          {{ modeLabel }}
          <ChevronDown :size="10" />
        </button>
        <div v-if="activePopup === 'mode'" class="ai-popup" @click.stop>
          <button :class="{ active: mode === 'ask' }" @click="setMode('ask')">{{ t('ai_mode_ask') }}</button>
          <button :class="{ active: mode === 'agent' }" @click="setMode('agent')">{{ t('ai_mode_agent') }}</button>
        </div>

        <!-- 模型选择 -->
        <button class="ai-tag-btn" @click.stop="togglePopup('model')">
          <span>{{ providerLabel }}</span>
          <ChevronDown :size="10" />
        </button>
        <div v-if="activePopup === 'model'" class="ai-popup ai-popup--right" @click.stop>
          <button v-for="p in providers" :key="p.id" :class="{ active: selectedProviderId === p.id }" @click="selectProvider(p.id)">{{ p.name }}</button>
          <button class="ai-popup-divider" @click="emit('open-settings'); closePopups()">{{ t('ai_manage') }}</button>
        </div>
      </div>

      <Button v-if="!isStreaming" size="icon" class="ai-send-btn" :disabled="disabled || !text.trim()" @click="submit">
        <Send :size="16" />
      </Button>
      <Button v-else size="icon" variant="outline" class="ai-send-btn" @click="emit('stop')">
        <Square :size="16" />
      </Button>
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
