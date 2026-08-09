<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import type { AiProvider } from '@/api/ai'
import { streamRefactorPrompt } from '@/api/ai'
import {
  Send,
  Square,
  Brain,
  ChevronDown,
  Settings2,
  ListChecks,
  Languages,
  AlignLeft,
  HelpCircle,
  Sparkles,
} from 'lucide-vue-next'
import type { ContextUsage, ChatImage } from '@/api/ai'
import { sha256DataUrl } from '@/utils/hash'

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
  // 当前选中的供应商在协议层是否支持 prompt cache（由 useAiChat 给出）。
  // 用于区分"供应商不支持"（显示「未启用/N/A」）与"支持但还没命中"（显示 0%）。
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
const { t } = useI18n()

const text = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const activePopup = ref<string | null>(null)
// 快捷指令：总结/翻译/格式化/解释。点击后把对应 instruction 通过独立的
// quick-action 事件外抛：上层的 useAiChat.send() 会自动在 user 消息前注入一条
// 隐藏的 system 消息（systemMeta.kind='quick_action_xxx'），模型能感知意图但
// 输入框中**不会**看到 prompt 文本——更接近用户对"一键命令"的预期。
const QUICK_ACTIONS = [
  { key: 'summarize', icon: 'ListChecks', labelKey: 'ai_quick_summarize', promptKey: 'ai_quick_summarize_prompt' },
  { key: 'translate', icon: 'Languages', labelKey: 'ai_quick_translate', promptKey: 'ai_quick_translate_prompt' },
  { key: 'format', icon: 'AlignLeft', labelKey: 'ai_quick_format', promptKey: 'ai_quick_format_prompt' },
  { key: 'explain', icon: 'HelpCircle', labelKey: 'ai_quick_explain', promptKey: 'ai_quick_explain_prompt' },
] as const
type QuickActionKey = (typeof QUICK_ACTIONS)[number]['key']
// 动态解析 lucide 图标组件
const QUICK_ICONS: Record<QuickActionKey, any> = {
  summarize: ListChecks,
  translate: Languages,
  format: AlignLeft,
  explain: HelpCircle,
}
const quickCanUse = computed(
  () => !props.disabled && !props.isStreaming && props.providers.length > 0 && !!props.selectedProviderId,
)
function runQuickAction(action: (typeof QUICK_ACTIONS)[number]) {
  if (!quickCanUse.value) return
  // 关键：不再把 prompt 写入 text.value。直接把"原始输入"作为 user 消息发送，
  // 由上层 useAiChat 包装一层 system 指令。输入框保持用户原文本（或空白）。
  const original = text.value
  const hasImages = pastedImages.value.length > 0
  // 即使输入框为空，也允许使用快捷指令（让 AI 直接对"空白文本"做总结/翻译，
  // 通常这种场景下用户其实是想让 AI 进入某种"工具模式"）。这里依然走原 send 路径。
  emit('quick-action', action.key, original, hasImages ? [...pastedImages.value] : undefined)
  // 快捷指令触发后清空输入框与截图，与普通发送一致
  text.value = ''
  pastedImages.value = []
}

// 提示词优化：行为对齐 WorkBuddy —— 点 Sparkles 图标，AI 润色当前输入内容，结果覆盖回输入框。
// 不进入对话历史、不发起对话、不污染 messages；当前 AI 回复中时可中止。
const optimizeCanUse = computed(
  () => !props.disabled && !props.isStreaming && props.providers.length > 0 && !!props.selectedProviderId,
)
// 优化进度状态：idle → loading → done/error；用于按钮的旋转动画/小红点
const optimizeState = ref<'idle' | 'loading' | 'error'>('idle')
const optimizeErrorText = ref<string>('')
// 用户取消（AbortController）
const optimizeAbort = ref<AbortController | null>(null)
async function runOptimizePrompt() {
  if (!optimizeCanUse.value || optimizeState.value === 'loading') return
  const original = text.value
  const providerId = props.selectedProviderId
  const ctrl = new AbortController()
  optimizeAbort.value = ctrl
  optimizeState.value = 'loading'
  optimizeErrorText.value = ''
  try {
    let accumulated = ''
    await streamRefactorPrompt({
      providerId,
      content: original,
      signal: ctrl.signal,
      onDelta: (chunk) => {
        accumulated += chunk
        // 用 ref 同步避免关闭旧 chunk 导致渲染抖动
        text.value = accumulated
      },
      onError: (msg, detail) => {
        optimizeState.value = 'error'
        optimizeErrorText.value = detail ? `${msg}（${detail}）` : msg
      },
      onDone: () => {
        optimizeState.value = 'idle'
      },
    })
    optimizeState.value = 'idle'
  } catch (e: any) {
    if (e?.name !== 'AbortError') {
      optimizeState.value = 'error'
      optimizeErrorText.value = String(e?.message || e)
    } else {
      optimizeState.value = 'idle'
    }
  } finally {
    optimizeAbort.value = null
  }
}
function cancelOptimizePrompt() {
  optimizeAbort.value?.abort()
  optimizeState.value = 'idle'
}
// 粘贴进输入框的截图（仅图片，不处理任意文件上传）
const pastedImages = ref<ChatImage[]>([])

// 各下拉气泡及其触发按钮的 ref（用于点击外部关闭）
const thinkingBtnEl = ref<HTMLElement | null>(null)
const thinkingPopupEl = ref<HTMLElement | null>(null)
const modeBtnEl = ref<HTMLElement | null>(null)
const modePopupEl = ref<HTMLElement | null>(null)
const modelBtnEl = ref<HTMLElement | null>(null)
const modelPopupEl = ref<HTMLElement | null>(null)

onClickOutside(
  thinkingPopupEl,
  () => {
    if (activePopup.value === 'thinking') activePopup.value = null
  },
  { ignore: [thinkingBtnEl] },
)
onClickOutside(
  modePopupEl,
  () => {
    if (activePopup.value === 'mode') activePopup.value = null
  },
  { ignore: [modeBtnEl] },
)
onClickOutside(
  modelPopupEl,
  () => {
    if (activePopup.value === 'model') activePopup.value = null
  },
  { ignore: [modelBtnEl] },
)

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

// 发送按钮旁圆环：单环设计 = 上下文 token 用量百分比。
// viewBox=40×40，外环半径 14（留出足够环带和文字空间）。
const RING_R = 14
const RING_C = 2 * Math.PI * RING_R
const RING_SIZE = 40
const RING_CENTER = RING_SIZE / 2

const usagePercent = computed(() => props.contextUsage?.percent ?? 0)
const ringDashOffset = computed(() => RING_C * (1 - usagePercent.value / 100))
const ringColorClass = computed(() => {
  const p = usagePercent.value
  if (p >= 90) return 'level-danger'
  if (p >= 70) return 'level-warn'
  return 'level-ok'
})
const ringLabel = computed(() => (props.contextUsage ? `${usagePercent.value}` : '–'))

// 缓存命中率 = 命中缓存的 prompt token / 总 prompt token
const cacheHitPercent = computed(() => {
  const c = props.contextUsage
  if (!c || !c.promptTokens) return 0
  const cached = c.cacheReadTokens || 0
  return Math.min(100, Math.round((cached / c.promptTokens) * 100))
})
// 缓存是否生效：必须以"协议层是否支持 prompt cache"为前提（由 useAiChat 的
// providerSupportsCache 提供），而不是仅看 usage 是否有 cache 字段——否则
// 像 mimo / MiniMax / Hunyuan / LongCat 这种协议层不返回 cache 字段的供应商，
// 永远会显示「未启用」误导用户"自己没启用什么"。
// 判定：
//   - providerSupportsCache === false  → 协议层不支持 → 显示「未启用」(短提示符)
//   - providerSupportsCache === true   + 尚未产生 cache token → 显示 0%
//   - providerSupportsCache === true   + 有 cacheReadTokens/cacheWriteTokens → 显示真实命中率
const cacheAvailable = computed(() => {
  if (props.providerSupportsCache === false) return false
  // 协议层支持 → 视为已启用（即使 0 也属正常"未命中"）
  return true
})
// 兼容旧名（保留外层 `cacheSupported` 引用）：当协议层支持即视为"启用"，与 cache 字段是否非 0 无关。
const cacheSupported = cacheAvailable
// 缓存面板右上的"缓存命中率"显示文案：
//   - 协议层不支持（providerSupportsCache === false）→ 显示"未启用"并配 explanation 提示当前供应商不返回 cache 字段
//   - 协议层支持（默认情况）→ 0% 或实际命中率
const cacheHitRateDisplay = computed(() => {
  if (!cacheAvailable.value) return t('ai_cache_not_enabled') || '未启用'
  return `${cacheHitPercent.value}%`
})
// 缓存面板 hover 提示：解释"未启用"的真实原因
const cacheStatusTip = computed(() => {
  if (!cacheAvailable.value) {
    return t('ai_cache_not_supported') || '当前供应商（如 MiMo、DeepSeek、MiniMax 等）的 API 协议不支持 prompt 缓存功能，因此无法统计缓存命中率。这是供应商协议限制，非配置问题。'
  }
  if (cacheHitPercent.value > 0) {
    return t('ai_cache_hit', {
      percent: cacheHitPercent.value,
      cached: props.contextUsage?.cacheReadTokens || 0,
      prompt: props.contextUsage?.promptTokens || 0,
    })
  }
  return t('ai_cache_zero_yet') || '当前供应商支持 prompt 缓存，但本次请求尚未命中（0%）'
})

const usageTip = computed(() => {
  if (!props.contextUsage) return t('ai_context_usage_none') || '上下文用量：暂无数据'
  const usageText = `${t('ai_context_usage', { percent: usagePercent.value, used: props.contextUsage.totalTokens, total: props.contextUsage.contextWindow })}`
  if (cacheSupported.value) {
    return `${usageText}\n缓存命中率：${cacheHitPercent.value}%`
  }
  return `${usageText}\n缓存：当前供应商协议不支持 prompt 缓存`
})

// 预估费用（基于 OpenAI 官方定价 $2.5/M input, $10/M output 作基准估算）
const estimatedCost = computed(() => {
  const c = props.contextUsage
  if (!c) return null
  const inputCost = (c.promptTokens / 1_000_000) * 2.5
  const outputCost = (c.completionTokens / 1_000_000) * 10
  const total = inputCost + outputCost
  if (total < 0.01) return '<$0.01'
  return '$' + total.toFixed(3)
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
    reader.onload = async () => {
      const dataUrl = reader.result as string
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
        const hash = await sha256DataUrl(dataUrl)
        pastedImages.value.push({ mime: file.type, data: dataUrl, hash: hash || undefined })
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
function selectModel(m: string) {
  emit('select-model', m)
  closePopups()
}
function openProviderSettings() {
  emit('open-settings')
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

// 把 token 数格式化为人类可读：192000 -> "192.0K"，57256 -> "57.3K"，2_500_000 -> "2.5M"
function formatTokens(n: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

// 上下文用量浮层开关
const usagePanelOpen = ref(false)
const usageTotalTokens = computed(() => props.contextUsage?.totalTokens ?? 0)
const usageContextWindow = computed(() => props.contextUsage?.contextWindow ?? 0)
const usagePromptTokens = computed(() => props.contextUsage?.promptTokens ?? 0)
const usageCompletionTokens = computed(() => props.contextUsage?.completionTokens ?? 0)
const usageCacheReadTokens = computed(() => props.contextUsage?.cacheReadTokens ?? 0)
const usageCacheWriteTokens = computed(() => props.contextUsage?.cacheWriteTokens ?? 0)
const usageThinkingTokens = computed(() => props.contextUsage?.thinkingTokens ?? 0)
const usageReplyTokens = computed(() => props.contextUsage?.replyTokens ?? 0)
const usageCacheMissTokens = computed(() =>
  Math.max(0, usagePromptTokens.value - usageCacheReadTokens.value - usageCacheWriteTokens.value),
)
// 历史消息「重新编辑」：把内容填回输入框并聚焦、光标移到末尾。
function setDraft(content: string) {
  text.value = content
  nextTick(() => {
    const el = textareaRef.value
    if (el) {
      el.focus()
      const len = el.value.length
      el.setSelectionRange(len, len)
    }
  })
}

defineExpose({ setDraft })
</script>

<template>
  <div class="ai-input-card" @click="closePopups">
    <!-- 快捷指令行：总结/翻译/格式化/解释（一键填入对应 prompt 并发送） -->
    <div class="ai-quick-actions">
      <button
        v-for="a in QUICK_ACTIONS"
        :key="a.key"
        class="ai-quick-btn"
        :disabled="!quickCanUse"
        @click="runQuickAction(a)"
      >
        <component :is="QUICK_ICONS[a.key]" :size="12" />
        <span>{{ t(a.labelKey) }}</span>
      </button>
    </div>

    <!-- 文本输入区 -->
    <textarea
      ref="textareaRef"
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
        <button class="ai-paste-remove" :title="t('ai_remove_image') || '移除'" @click="removePastedImage(idx)">
          ×
        </button>
      </div>
    </div>

    <!-- 底部工具栏 -->
    <div class="ai-card-bottom">
      <div class="ai-card-actions">
        <!-- 思考模式 -->
        <button
          ref="thinkingBtnEl"
          class="ai-tag-btn"
          :class="{ active: thinkingEnabled }"
          @click.stop="togglePopup('thinking')"
        >
          <Brain :size="12" />
          <span>{{ thinkingEnabled ? t('ai_strength_' + thinkingStrength) : t('ai_thinking') }}</span>
        </button>
        <div v-if="activePopup === 'thinking'" ref="thinkingPopupEl" class="ai-popup" @click.stop>
          <button :class="{ active: thinkingEnabled && thinkingStrength === 'low' }" @click="setStrength('low')">
            {{ t('ai_strength_low') }}
          </button>
          <button :class="{ active: thinkingEnabled && thinkingStrength === 'medium' }" @click="setStrength('medium')">
            {{ t('ai_strength_medium') }}
          </button>
          <button :class="{ active: thinkingEnabled && thinkingStrength === 'high' }" @click="setStrength('high')">
            {{ t('ai_strength_high') }}
          </button>
          <button class="ai-popup-divider" @click="toggleThinking">
            {{ thinkingEnabled ? t('ai_thinking_off') : t('ai_thinking_on') }}
          </button>
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
        <div
          v-if="activePopup === 'model'"
          ref="modelPopupEl"
          class="ai-popup ai-popup--right ai-popup--models"
          @click.stop
        >
          <div class="ai-popup-title">{{ t('ai_select_model') }}</div>
          <button
            v-for="m in selectedProviderModels"
            :key="m"
            :class="{ active: (selectedModel || selectedProvider?.model) === m }"
            @click="selectModel(m)"
          >
            {{ m }}
          </button>
          <div class="ai-popup-title ai-popup-title--sub">{{ t('ai_switch_provider') }}</div>
          <button
            v-for="p in providers"
            :key="p.id"
            :class="{ active: selectedProviderId === p.id }"
            @click="selectProvider(p.id)"
          >
            {{ p.name }}
          </button>
          <button
            class="ai-popup-divider"
            @click="openProviderSettings"
          >
            {{ t('ai_manage') }}
          </button>
        </div>
      </div>

      <div class="ai-send-area">
        <!-- 提示词优化：行为对齐 WorkBuddy —— AI 润色当前输入，结果覆盖回输入框（不进入对话历史） -->
        <button
          class="ai-optimize-btn"
          :class="{ disabled: !optimizeCanUse, loading: optimizeState === 'loading', errored: optimizeState === 'error' }"
          :title="t('ai_optimize_prompt_tooltip') || '提示词优化：让 AI 润色当前输入内容'"
          :aria-label="t('ai_optimize_prompt_tooltip') || '提示词优化'"
          :disabled="!optimizeCanUse || optimizeState === 'loading'"
          @click="runOptimizePrompt"
        >
          <Sparkles :size="15" />
          <!-- 加载中：旋转遮罩；错误：角上红点；点击遮罩可中止 -->
          <span
            v-if="optimizeState === 'loading' || optimizeState === 'error'"
            class="ai-optimize-status"
            :class="optimizeState"
            :title="optimizeState === 'loading' ? (t('ai_optimize_cancel') || '点击取消') : (optimizeErrorText || (t('ai_optimize_failed') || '优化失败：未知原因'))"
            @click.stop="optimizeState === 'loading' ? cancelOptimizePrompt() : (optimizeState = 'idle', optimizeErrorText = '')"
          >
            <span v-if="optimizeState === 'loading'" class="ai-optimize-spinner" aria-hidden="true"></span>
            <span v-else class="ai-optimize-errdot" aria-hidden="true">!</span>
          </span>
        </button>
        <!-- 上下文用量：圆环触发 + 点击展开 Cursor 风格面板（百分比 / 用量 / 缓存命中率） -->
        <Popover v-model:open="usagePanelOpen" :disabled="!contextUsage">
          <PopoverTrigger as-child>
            <button
              class="ai-usage-ring-btn"
              :class="ringColorClass"
              :title="usageTip"
              :aria-label="t('ai_context_usage_title') || '上下文用量'"
            >
              <svg class="ai-usage-ring" :class="ringColorClass" :width="RING_SIZE" :height="RING_SIZE" :viewBox="`0 0 ${RING_SIZE} ${RING_SIZE}`">
                <circle class="ring-track" :cx="RING_CENTER" :cy="RING_CENTER" :r="RING_R" />
                <circle
                  class="ring-progress"
                  :cx="RING_CENTER"
                  :cy="RING_CENTER"
                  :r="RING_R"
                  :stroke-dasharray="RING_C"
                  :stroke-dashoffset="ringDashOffset"
                />
                <!-- 百分比文字：居中显示，清晰可读 -->
                <text class="ring-label" :x="RING_CENTER" :y="RING_CENTER" dominant-baseline="central">{{ ringLabel }}<tspan class="ring-label-pct" font-size="0.6em">%</tspan></text>
              </svg>
            </button>
          </PopoverTrigger>
          <PopoverContent class="ai-usage-panel" side="top" align="end" :side-offset="8">
            <div v-if="!contextUsage" class="ai-usage-panel-empty">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                style="opacity: 0.3; margin-bottom: 4px"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              {{ t('ai_context_usage_none') || '暂无数据，发起一次对话后将显示上下文用量' }}
            </div>
            <div v-else class="ai-usage-panel-body">
              <!-- 总计 -->
              <div class="ai-usage-total-row">
                <span class="ai-usage-panel-title">{{ t('ai_token_usage_total') || '总计' }}</span>
                <span class="ai-usage-total-val">{{ formatTokens(usageTotalTokens) }}</span>
              </div>

              <!-- 输入明细 -->
              <div class="ai-usage-section">
                <div class="ai-usage-section-title">
                  <span class="dot input"></span>
                  <span>{{ t('ai_token_usage_input') || '输入' }}</span>
                  <span class="ai-usage-section-val">{{ formatTokens(usagePromptTokens) }}</span>
                </div>
                <div class="ai-usage-detail-row">
                  <span class="dot hit"></span>
                  <span>{{ t('ai_token_usage_cache_hit') || '缓存命中' }}</span>
                  <span>{{ formatTokens(usageCacheReadTokens) }}</span>
                </div>
                <div class="ai-usage-detail-row">
                  <span class="dot miss"></span>
                  <span>{{ t('ai_token_usage_cache_miss') || '缓存未命中' }}</span>
                  <span>{{ formatTokens(usageCacheMissTokens) }}</span>
                </div>
                <div class="ai-usage-detail-row">
                  <span class="dot write"></span>
                  <span>{{ t('ai_token_usage_cache_write') || '缓存写入' }}</span>
                  <span>{{ formatTokens(usageCacheWriteTokens) }}</span>
                </div>
              </div>

              <!-- 输出明细 -->
              <div class="ai-usage-section">
                <div class="ai-usage-section-title">
                  <span class="dot output"></span>
                  <span>{{ t('ai_token_usage_output') || '输出' }}</span>
                  <span class="ai-usage-section-val">{{ formatTokens(usageCompletionTokens) }}</span>
                </div>
                <div class="ai-usage-detail-row">
                  <span class="dot thinking"></span>
                  <span>{{ t('ai_token_usage_thinking') || '思考过程' }}</span>
                  <span>{{ formatTokens(usageThinkingTokens) }}</span>
                </div>
                <div class="ai-usage-detail-row">
                  <span class="dot reply"></span>
                  <span>{{ t('ai_token_usage_reply') || '回复内容' }}</span>
                  <span>{{ formatTokens(usageReplyTokens) }}</span>
                </div>
              </div>

              <!-- 缓存命中率 -->
              <div class="ai-usage-hitrate" :title="cacheStatusTip">
                <div class="ai-usage-hitrate-head">
                  <span class="ai-usage-hitrate-title">{{ t('ai_token_usage_hit_rate') || '缓存命中率' }}</span>
                  <span class="ai-usage-hitrate-val">{{ cacheHitRateDisplay }}</span>
                </div>
                <div class="ai-usage-hitrate-bar">
                  <div class="ai-usage-hitrate-fill" :style="{ width: cacheHitPercent + '%' }"></div>
                </div>
              </div>

              <!-- 预估费用 -->
              <div v-if="estimatedCost" class="ai-usage-cost-row">
                <span>{{ t('ai_estimated_cost') || '预估费用' }}</span>
                <span class="ai-usage-cost-val">{{ estimatedCost }}</span>
              </div>
            </div>
          </PopoverContent>
        </Popover>
        <Button
          v-if="!isStreaming"
          size="icon"
          class="ai-send-btn"
          :disabled="disabled || (!text.trim() && pastedImages.length === 0)"
          @click="submit"
        >
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
  background: var(--bg-surface);
  padding: 0;
  overflow: visible;
  transition: border-color 0.15s;
}

.ai-input-card:focus-within {
  border-color: var(--accent);
}

.ai-quick-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px 0;
  flex-wrap: wrap;
}
.ai-quick-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: 11.5px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.ai-quick-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--accent);
  border-color: var(--accent);
}
.ai-quick-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
  opacity: 0.4;
}

.ring-progress {
  fill: none;
  stroke: var(--accent);
  stroke-width: 3;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: 50% 50%;
  transition:
    stroke-dashoffset 0.4s ease,
    stroke 0.3s ease;
}

.ring-progress.level-warn {
  stroke: #f59e0b;
}

.ring-progress.level-danger {
  stroke: #ef4444;
}

.ring-label {
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    'Helvetica Neue',
    Arial,
    sans-serif;
  font-size: 11px;
  font-weight: 700;
  fill: var(--text-primary);
  text-anchor: middle;
  dominant-baseline: central;
  pointer-events: none;
  user-select: none;
}

.ring-label-pct {
  font-size: 7px;
  font-weight: 500;
  fill: var(--text-secondary);
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

/* 上下文用量浮层（Cursor 风格）：点击圆环触发 */
.ai-usage-ring-btn {
  background: transparent;
  border: none;
  padding: 2px;
  margin: 0;
  cursor: pointer;
  line-height: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  transition: transform 0.15s ease;
}
.ai-usage-ring-btn:hover {
  transform: scale(1.08);
}
/* 提示词优化按钮：紧贴圆环左侧，hover 出现主题色光晕，禁用态灰显 */
.ai-optimize-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid transparent;
  background: transparent;
  color: var(--ai-fg-muted, #6b7280);
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.ai-optimize-btn:hover:not(.disabled) {
  color: #8b5cf6;
  background: rgba(139, 92, 246, 0.1);
  border-color: rgba(139, 92, 246, 0.25);
  transform: scale(1.08);
}
.ai-optimize-btn.disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.ai-optimize-btn.loading {
  color: #8b5cf6;
  background: rgba(139, 92, 246, 0.08);
  border-color: rgba(139, 92, 246, 0.25);
  cursor: progress;
}
.ai-optimize-btn.errored {
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.06);
}
/* 角上状态指示：loading 旋转遮罩 / error 小红点；点击遮罩可中止 / 清除错误 */
.ai-optimize-status {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  z-index: 2;
}
.ai-optimize-status.loading {
  background: #8b5cf6;
  border: 1px solid #fff;
}
.ai-optimize-status.errored {
  background: #ef4444;
  border: 1px solid #fff;
}
.ai-optimize-spinner {
  width: 8px;
  height: 8px;
  border: 1.5px solid #fff;
  border-top-color: transparent;
  border-radius: 50%;
  animation: ai-optimize-spin 0.8s linear infinite;
}
.ai-optimize-errdot {
  font-size: 10px;
  font-weight: 800;
}
@keyframes ai-optimize-spin {
  to { transform: rotate(360deg); }
}
.ai-optimize-btn {
  position: relative;
}
</style>

<style>
/* 上下文用量浮层（Cursor 风格）：点击圆环触发。
   注意：PopoverContent 通过 Portal 渲染到 body，必须在全局样式中定义。 */
.ai-usage-panel {
  width: 280px;
  padding: 18px 22px 16px !important;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  z-index: 60;
}

.ai-usage-panel-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ai-usage-panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 12px 0 8px;
  text-align: center;
}
.ai-usage-panel-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-usage-total-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ai-usage-total-val {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.ai-usage-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-usage-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.ai-usage-section-val {
  margin-left: auto;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.ai-usage-detail-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  padding-left: 16px;
}
.ai-usage-detail-row span:last-child {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  flex-shrink: 0;
}
.dot.input {
  background: #60a5fa;
}
.dot.output {
  background: #a78bfa;
}
.dot.hit {
  background: #34d399;
}
.dot.miss {
  background: #f87171;
}
.dot.write {
  background: #facc15;
}
.dot.thinking {
  background: #fbbf24;
}
.dot.reply {
  background: #a78bfa;
}

.ai-usage-hitrate {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ai-usage-hitrate-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ai-usage-hitrate-title {
  font-size: 11px;
  color: var(--text-secondary);
}
.ai-usage-hitrate-val {
  font-size: 12px;
  font-weight: 700;
  color: #34d399;
  font-variant-numeric: tabular-nums;
}
.ai-usage-hitrate-bar {
  width: 100%;
  height: 5px;
  background: var(--bg-hover);
  border-radius: 999px;
  overflow: hidden;
}
.ai-usage-hitrate-fill {
  height: 100%;
  background: linear-gradient(90deg, #34d399 0%, #facc15 60%, #f87171 100%);
  border-radius: 999px;
  transition: width 0.4s ease;
}

/* 费用行 */
.ai-usage-cost-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-tertiary);
  padding-top: 4px;
  border-top: 1px solid var(--border-subtle);
}
.ai-usage-cost-val {
  font-weight: 600;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
</style>
