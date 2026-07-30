<script setup lang="ts">
import { ref, computed } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'
import type { AiProvider } from '@/api/ai'
import { Send, Square, Brain, ChevronDown, Settings2 } from 'lucide-vue-next'
import type { ContextUsage, ChatImage } from '@/api/ai'

const props = defineProps<{
  disabled: boolean
  isStreaming: boolean
  providers: AiProvider[]
  selectedProviderId: string
  selectedModel: string
  thinkingEnabled: boolean
  thinkingStrength: 'low' | 'medium' | 'high'
  mode: 'ask' | 'agent'
  contextUsage: ContextUsage | null
}>()
const emit = defineEmits<{
  send: [text: string, images?: ChatImage[]]
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
// 粘贴进输入框的截图（仅图片，不处理任意文件上传）
const pastedImages = ref<ChatImage[]>([])

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

// 发送按钮旁圆环：外环=上下文 token 用量百分比；内环=缓存命中率。
const RING_R = 9 // 外环半径
const RING_C = 2 * Math.PI * RING_R
const RING_R_INNER = 5.5 // 内环半径（缓存命中率）
const RING_C_INNER = 2 * Math.PI * RING_R_INNER

const usagePercent = computed(() => props.contextUsage?.percent ?? 0)
const ringDashOffset = computed(() => RING_C * (1 - usagePercent.value / 100))
const ringColorClass = computed(() => {
  const p = usagePercent.value
  if (p >= 90) return 'level-danger'
  if (p >= 70) return 'level-warn'
  return 'level-ok'
})
const ringLabel = computed(() => (props.contextUsage ? `${usagePercent.value}%` : '–'))

// 缓存命中率 = 命中缓存的 prompt token / 总 prompt token
const cacheHitPercent = computed(() => {
  const c = props.contextUsage
  if (!c || !c.promptTokens) return 0
  const cached = c.cacheReadTokens || 0
  return Math.min(100, Math.round((cached / c.promptTokens) * 100))
})
const ringDashOffsetInner = computed(() => RING_C_INNER * (1 - cacheHitPercent.value / 100))

const usageTip = computed(() => {
  if (!props.contextUsage) return t('ai_context_usage_none') || '上下文用量：暂无数据'
  return (
    `${t('ai_context_usage', { percent: usagePercent.value, used: props.contextUsage.totalTokens, total: props.contextUsage.contextWindow })}（外环）\n` +
    `${t('ai_cache_hit', { percent: cacheHitPercent.value, cached: props.contextUsage.cacheReadTokens || 0, prompt: props.contextUsage.promptTokens })}（内环）`
  )
})

function submit() {
  const value = text.value.trim()
  // 文本或截图任一非空即可发送（允许只发截图）
  if ((!value && pastedImages.value.length === 0) || props.disabled) return
  emit('send', value, pastedImages.value.length ? [...pastedImages.value] : undefined)
  text.value = ''
  pastedImages.value = []
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}

// 粘贴截图：拦截剪贴板中的图片文件，转成 data URL 作为待发送附件预览
function onPaste(e: ClipboardEvent) {
  const dt = e.clipboardData
  if (!dt) return
  const items = Array.from(dt.items || [])
  const imageItems = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
  if (imageItems.length === 0) return // 纯文本粘贴：保持默认行为
  e.preventDefault()
  for (const it of imageItems) {
    const file = it.getAsFile()
    if (!file) continue
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
        pastedImages.value.push({ mime: file.type, data: dataUrl })
      }
    }
    reader.readAsDataURL(file)
  }
}

function removePastedImage(idx: number) {
  pastedImages.value.splice(idx, 1)
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
      @paste="onPaste"
      @click.stop
    />

    <!-- 粘贴截图预览（仅图片；不支持任意文件上传） -->
    <div v-if="pastedImages.length" class="ai-paste-previews">
      <div v-for="(img, idx) in pastedImages" :key="idx" class="ai-paste-thumb">
        <img :src="img.data" :alt="img.mime" />
        <button class="ai-paste-remove" :title="t('ai_remove_image') || '移除'" @click="removePastedImage(idx)">×</button>
      </div>
    </div>

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
        <!-- 双环统计：外环=上下文 token 用量，内环=缓存命中率；hover 看明细 -->
        <div class="ai-usage-ring-wrap" :title="usageTip">
          <svg
            class="ai-usage-ring"
            :class="ringColorClass"
            width="30"
            height="30"
            viewBox="0 0 30 30"
          >
            <circle class="ring-track" cx="15" cy="15" :r="RING_R" />
            <circle
              class="ring-progress"
              cx="15"
              cy="15"
              :r="RING_R"
              :stroke-dasharray="RING_C"
              :stroke-dashoffset="ringDashOffset"
            />
            <circle class="ring-track-inner" cx="15" cy="15" :r="RING_R_INNER" />
            <circle
              class="ring-progress-inner"
              cx="15"
              cy="15"
              :r="RING_R_INNER"
              :stroke-dasharray="RING_C_INNER"
              :stroke-dashoffset="ringDashOffsetInner"
            />
            <text class="ring-label" x="15" y="15">{{ ringLabel }}</text>
          </svg>
        </div>
        <Button v-if="!isStreaming" size="icon" class="ai-send-btn" :disabled="disabled || (!text.trim() && pastedImages.length === 0)" @click="submit">
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

.ai-usage-ring-wrap {
  cursor: help;
  flex-shrink: 0;
  line-height: 0;
}

.ai-usage-ring {
  display: block;
  overflow: visible;
}

.ring-track {
  fill: none;
  stroke: var(--border-default);
  stroke-width: 3;
}

.ring-progress {
  fill: none;
  stroke: var(--accent);
  stroke-width: 3;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: 50% 50%;
  transition: stroke-dashoffset 0.4s ease, stroke 0.3s ease;
}

.ring-progress.level-warn {
  stroke: #f59e0b;
}

.ring-progress.level-danger {
  stroke: #ef4444;
}

/* 内环：缓存命中率（固定青蓝色，与外环上下文用量区分） */
.ring-track-inner {
  fill: none;
  stroke: var(--border-default);
  stroke-width: 2.5;
}

.ring-progress-inner {
  fill: none;
  stroke: #22d3ee;
  stroke-width: 2.5;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: 50% 50%;
  transition: stroke-dashoffset 0.4s ease, stroke 0.3s ease;
}

.ring-label {
  font-size: 7px;
  font-weight: 600;
  fill: var(--text-secondary);
  text-anchor: middle;
  dominant-baseline: central;
  pointer-events: none;
}

/* 粘贴截图预览 */
.ai-paste-previews {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 14px 8px;
}

.ai-paste-thumb {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border-default);
  background: var(--bg-hover);
}

.ai-paste-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.ai-paste-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  line-height: 14px;
  text-align: center;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}

.ai-paste-remove:hover {
  background: rgba(0, 0, 0, 0.8);
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
