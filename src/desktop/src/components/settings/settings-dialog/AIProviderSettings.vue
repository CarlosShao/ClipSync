<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Switch from '@/components/ui/switch/Switch.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'
import { RefreshCw, PlayCircle, Pencil, Trash2, Check, X, ChevronDown, Plus } from 'lucide-vue-next'
import {
  getProviders,
  getPresets,
  createProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  getProviderModels,
  getSettings,
  saveSettings,
} from '@/api/ai'
import type { AiProvider, AiProviderPreset, AiApiFormat, AiSettings } from '@/api/ai'

const { t } = useI18n()
const toast = useSonner()

const providers = ref<AiProvider[]>([])
const presets = ref<AiProviderPreset[]>([])
const loading = ref(false)

const editingId = ref<string | null>(null)
const formProvider = ref('')
const formName = ref('')
const formApiKey = ref('')
const formBaseUrl = ref('')
// 多选：该配置已启用的模型（tags 形式）
const formSelectedModels = ref<string[]>([])
// 上游刷新得到的完整模型列表（用于点选）
const formModels = ref<string[]>([])
const formIsDefault = ref(false)
// 上下文窗口用字符串承载（兼容 type=number 的 Input v-model），提交时再转 number
const formContextWindow = ref<string>('')
// 自定义供应商的多协议格式（OpenAI 兼容 / Anthropic 兼容 / OpenAI Responses）
const formApiFormat = ref<AiApiFormat>('openai')
const saving = ref(false)
const refreshingModels = ref(false)
const formError = ref('')
const confirmingDeleteId = ref<string | null>(null)
const testingId = ref<string | null>(null)
// 表单是否展开：默认折叠（不占位置），点「添加供应商」按钮展开；点编辑自动展开。
const formOpen = ref(false)
// 表单容器引用：展开后滚动到可见区域（供应商多时表单在列表下方，避免“点了没反应”）
const formRef = ref<HTMLElement | null>(null)
// 思考强度选项兜底文案（locale 未热更新/缺 key 时仍可读）
const strengthFallback: Record<'low' | 'medium' | 'high', string> = { low: '轻量', medium: '均衡', high: '深度' }

function scrollFormIntoView() {
  nextTick(() => formRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
}

function toggleForm() {
  formOpen.value = !formOpen.value
  if (formOpen.value) scrollFormIntoView()
}

// ===== 服务端 AI 偏好（ai_settings：系统提示词 + 对话偏好）=====
const customPrompt = ref('')
const promptSnapshot = ref('')
const promptSaved = ref(false)
const promptSaving = ref(false)
// 对话偏好：与 AI 面板共享同一行 ai_settings，变更即时生效
const prefMode = ref<'ask' | 'agent'>('ask')
const prefThinking = ref(false)
const prefThinkingStrength = ref<'low' | 'medium' | 'high'>('medium')
const prefMemory = ref(false)

// 系统提示词脏状态：只有真正修改过才允许保存
const promptDirty = computed(() => customPrompt.value !== promptSnapshot.value)

async function loadAllSettings() {
  try {
    const res = await getSettings()
    if (res.ok && res.data) {
      customPrompt.value = res.data.customSystemPrompt || ''
      promptSnapshot.value = customPrompt.value
      prefMode.value = res.data.defaultMode || 'ask'
      prefThinking.value = !!res.data.thinkingEnabled
      prefThinkingStrength.value = res.data.thinkingStrength || 'medium'
      prefMemory.value = !!res.data.memoryEnabled
    }
  } catch (e) {
    console.warn('[AI] load settings failed', e)
  }
}

// 偏好即时保存：服务端 sanitize 对未传字段沿用已存值，可安全部分提交。
// 成功后广播 clipsync:ai-settings-changed，让已打开的 AI 面板同步。
async function savePrefs(patch: Partial<AiSettings>) {
  try {
    const res = await saveSettings(patch)
    if (res.ok) {
      window.dispatchEvent(new CustomEvent('clipsync:ai-settings-changed'))
    } else {
      toast.show(res.error || t('ai_save_failed'), 'error')
    }
  } catch (e: any) {
    toast.show(String(e?.message || e), 'error')
  }
}

async function saveCustomPrompt() {
  promptSaving.value = true
  promptSaved.value = false
  try {
    const res = await saveSettings({ customSystemPrompt: customPrompt.value })
    if (res.ok) {
      promptSnapshot.value = customPrompt.value
      promptSaved.value = true
      toast.show(t('ai_prompt_saved', '系统提示词已保存'), 'success')
      // 让 AI 侧边栏读到最新设置
      window.dispatchEvent(new CustomEvent('clipsync:ai-settings-changed'))
      setTimeout(() => (promptSaved.value = false), 2400)
    } else {
      toast.show(res.error || t('ai_prompt_save_fail', '保存失败'), 'error')
    }
  } catch (e: any) {
    toast.show(String(e?.message || e), 'error')
  } finally {
    promptSaving.value = false
  }
}

const formProviderLabel = computed(() => {
  const p = presets.value.find((x) => x.provider === formProvider.value)
  return p?.label || formProvider.value
})

// 是否自定义供应商：Custom 支持多协议（OpenAI 兼容 / Anthropic 兼容 / OpenAI Responses）
const isCustom = computed(() => formProvider.value === 'custom')

function presetLabel(provider: string) {
  const p = presets.value.find((x) => x.provider === provider)
  return p?.label || provider
}

async function load() {
  loading.value = true
  try {
    const [p, pr] = await Promise.all([getProviders(), getPresets()])
    if (p.ok) providers.value = p.data?.items || []
    if (pr.ok) presets.value = pr.data?.items || []
  } catch (e) {
    console.warn('[AI] load providers failed', e)
  } finally {
    loading.value = false
  }
}

function onProviderChange(v: string) {
  formProvider.value = v
  const preset = presets.value.find((x) => x.provider === v)
  if (preset) {
    if (!formBaseUrl.value) formBaseUrl.value = preset.defaultBaseUrl
    if (formSelectedModels.value.length === 0) {
      formSelectedModels.value = [preset.defaultModel]
    }
  }
}

function resetForm() {
  editingId.value = null
  formOpen.value = false
  formProvider.value = ''
  formName.value = ''
  formApiKey.value = ''
  formBaseUrl.value = ''
  formSelectedModels.value = []
  formModels.value = []
  formIsDefault.value = false
  formContextWindow.value = ''
  formApiFormat.value = 'openai'
  formError.value = ''
}

function startEdit(p: AiProvider) {
  editingId.value = p.id
  formOpen.value = true
  scrollFormIntoView()
  formProvider.value = p.provider
  formName.value = p.name
  formApiKey.value = '' // 不回显密钥；留空表示不修改
  formBaseUrl.value = p.base_url || ''
  formSelectedModels.value = Array.isArray(p.models) && p.models.length > 0 ? [...p.models] : [p.model]
  formModels.value = Array.isArray(p.models) ? [...p.models] : []
  formIsDefault.value = p.is_default
  formContextWindow.value = p.context_window != null ? String(p.context_window) : ''
  // 回显自定义供应商的协议格式（历史数据无 api_format 时默认 openai）
  formApiFormat.value = (p.api_format as AiApiFormat) || 'openai'
  formError.value = ''
}

function toggleModel(m: string) {
  const idx = formSelectedModels.value.indexOf(m)
  if (idx >= 0) {
    formSelectedModels.value = formSelectedModels.value.filter((x) => x !== m)
  } else {
    formSelectedModels.value = [...formSelectedModels.value, m]
  }
}

// 刷新该供应商可用模型列表（上游 /models）。
// 已保存供应商走后端解密 key；未保存供应商先落地（密钥加密入库）再用已存密钥拉取，避免明文 key 出现在请求体。
async function refreshModels() {
  if (refreshingModels.value) return
  const hasKey = formApiKey.value.trim().length > 0
  if (!hasKey) {
    formError.value = t('ai_api_key_required')
    return
  }
  refreshingModels.value = true
  formError.value = ''
  try {
    let res
    if (editingId.value) {
      res = await getProviderModels(editingId.value)
    } else {
      // 未保存：先落地（密钥加密入库），再用已存密钥拉取，避免明文 key 出现在 fetch-models 请求体
      const createRes = await createProvider({
        provider: formProvider.value,
        name: formName.value.trim(),
        apiKey: formApiKey.value,
        baseUrl: formBaseUrl.value.trim() || undefined,
        model: formSelectedModels.value[0] || '',
        models: formSelectedModels.value,
        isDefault: formIsDefault.value,
        contextWindow: formContextWindow.value ? Number(formContextWindow.value) : null,
        apiFormat: isCustom.value ? formApiFormat.value : undefined,
      })
      if (!createRes.ok || !createRes.data?.id) {
        toast.show(createRes.error || t('ai_save_failed'), 'error')
        return
      }
      editingId.value = createRes.data.id
      res = await getProviderModels(editingId.value)
    }
    if (res.ok && res.data) {
      const list = res.data.models || []
      formModels.value = list
      // 把当前已选但不在新列表里的模型合并进去，避免用户先手工输入后被刷新清空
      const selected = new Set([...formSelectedModels.value, ...list.filter((m) => formSelectedModels.value.includes(m))])
      // 若当前未选任何模型，默认勾选第一个
      if (selected.size === 0 && list.length > 0) {
        selected.add(list[0])
      }
      formSelectedModels.value = Array.from(selected)
      toast.show(t('ai_models_refreshed'), 'success')
    } else {
      toast.show(res.error || t('ai_models_refresh_fail'), 'error')
    }
  } catch (e: any) {
    toast.show(String(e?.message || e), 'error')
  } finally {
    refreshingModels.value = false
  }
}

async function save() {
  formError.value = ''
  if (!formProvider.value) {
    formError.value = t('ai_provider_required')
    return
  }
  if (!formName.value.trim()) {
    formError.value = t('ai_name_required')
    return
  }
  if (formSelectedModels.value.length === 0) {
    formError.value = t('ai_model_required')
    return
  }
  saving.value = true
  try {
    const payload = {
      provider: formProvider.value,
      name: formName.value.trim(),
      apiKey: formApiKey.value || undefined,
      baseUrl: formBaseUrl.value.trim() || undefined,
      model: formSelectedModels.value[0],
      models: formSelectedModels.value,
      isDefault: formIsDefault.value,
      contextWindow: formContextWindow.value ? Number(formContextWindow.value) : null,
      apiFormat: isCustom.value ? formApiFormat.value : undefined,
    }
    const res = editingId.value
      ? await updateProvider(editingId.value, payload)
      : await createProvider(payload)
    if (res.ok) {
      toast.show(t('ai_saved'), 'success')
      // 通知 AI 侧边栏等其他消费方刷新 provider 列表
      //（AI 侧边栏默认只在 open=true 切换时 loadProviders，常驻打开时不刷新）
      window.dispatchEvent(new CustomEvent('clipsync:ai-providers-changed'))
      await load()
      resetForm()
    } else {
      formError.value = res.error || t('ai_save_failed')
    }
  } catch (e: any) {
    formError.value = String(e?.message || e)
  } finally {
    saving.value = false
  }
}

async function remove(id: string) {
  const res = await deleteProvider(id)
  if (res.ok) {
    toast.show(t('ai_deleted'), 'success')
    if (confirmingDeleteId.value === id) confirmingDeleteId.value = null
    window.dispatchEvent(new CustomEvent('clipsync:ai-providers-changed'))
    await load()
  } else {
    toast.show(res.error || t('ai_delete_failed'), 'error')
  }
}

async function test(id: string) {
  testingId.value = id
  try {
    const res = await testProvider(id)
    if (res.ok && res.data?.ok) {
      toast.show(t('ai_test_ok'), 'success')
    } else {
      const detail = res.data?.detail ? `${res.data.detail} ` : ''
      toast.show(detail + (res.error || t('ai_test_fail')), 'error')
    }
  } catch (e: any) {
    toast.show(String(e?.message || e), 'error')
  } finally {
    testingId.value = null
  }
}

onMounted(() => {
  load()
  loadAllSettings()
})
</script>

<template>
  <div class="settings-group">
    <div class="sg-header">{{ t('sg_ai') }}</div>

    <!-- ===== 模型供应商 ===== -->
    <section class="ai-section">
      <div class="ai-section-head">
        <div class="ai-section-head-text">
          <div class="ai-section-title">{{ t('ai_section_providers', '模型供应商') }}</div>
          <div class="ai-section-hint">{{ t('ai_intro') }}</div>
        </div>
        <Button variant="outline" size="sm" class="shrink-0 whitespace-nowrap" @click="toggleForm">
          <Plus v-if="!formOpen" />
          <ChevronDown v-else class="ai-add-chev open" />
          {{ formOpen ? t('collapse', '收起') : t('ai_add_provider') }}
        </Button>
      </div>

      <!-- 供应商列表 -->
      <div class="ai-prov-list">
        <div v-for="p in providers" :key="p.id" class="ai-prov-card">
          <div class="ai-prov-main">
            <div class="ai-prov-name">
              <span class="ai-prov-name-text">{{ p.name }}</span>
              <span v-if="p.is_default" class="ai-badge ai-badge--default">{{ t('ai_default') }}</span>
              <span v-if="p.has_key" class="ai-badge ai-badge--key">{{ t('ai_key_set') }}</span>
              <span v-else class="ai-badge ai-badge--nokey">{{ t('ai_no_key') }}</span>
            </div>
            <div class="ai-prov-meta">
              {{ presetLabel(p.provider) }} ·
              <template v-if="Array.isArray(p.models) && p.models.length > 1">
                {{ p.models[0] }} 等 {{ p.models.length }} 个模型
              </template>
              <template v-else>{{ p.model }}</template>
            </div>
          </div>
          <div class="ai-card-actions">
            <button
              type="button"
              class="ai-card-btn"
              :class="{ testing: testingId === p.id }"
              :title="testingId === p.id ? t('ai_testing') : t('ai_test')"
              :disabled="testingId === p.id"
              @click="test(p.id)"
            >
              <PlayCircle :size="16" />
            </button>
            <button type="button" class="ai-card-btn" :title="t('ai_edit')" @click="startEdit(p)">
              <Pencil :size="16" />
            </button>
            <button
              v-if="confirmingDeleteId !== p.id"
              type="button"
              class="ai-card-btn ai-card-btn--danger"
              :title="t('ai_delete')"
              @click="confirmingDeleteId = p.id"
            >
              <Trash2 :size="16" />
            </button>
            <template v-else>
              <button type="button" class="ai-card-btn ai-card-btn--confirm" :title="t('ai_confirm_delete')" @click="remove(p.id)">
                <Check :size="16" />
              </button>
              <button type="button" class="ai-card-btn" :title="t('cancel_btn')" @click="confirmingDeleteId = null">
                <X :size="16" />
              </button>
            </template>
          </div>
        </div>
      </div>

      <div v-if="loading" class="ai-empty">{{ t('ai_loading', '加载中…') }}</div>
      <div v-else-if="providers.length === 0" class="ai-empty">{{ t('ai_no_providers') }}</div>

      <!-- 新增 / 编辑表单：默认折叠；点「添加供应商」展开并滚动到可见，编辑时自动展开 -->
      <div v-show="formOpen" ref="formRef" class="ai-form">
        <!-- 兼容格式说明：Custom 供应商支持三种 API 协议 -->
        <div class="ai-protocol-hint">
          <span class="ai-protocol-hint-icon">i</span>
          <span>{{ t('ai_format_guide') }}</span>
        </div>

        <div class="ai-field">
          <label class="ai-label">{{ t('ai_provider_label') }}</label>
          <CustomSelect :model-value="formProvider" @update:model-value="onProviderChange">
            {{ formProvider ? formProviderLabel : t('ai_select_provider') }}
            <template #options>
              <CustomSelectOption
                v-for="pr in presets"
                :key="pr.provider"
                :value="pr.provider"
                :selected="formProvider === pr.provider"
                @select="onProviderChange"
              >
                {{ pr.label }}
              </CustomSelectOption>
            </template>
          </CustomSelect>
        </div>

        <!-- 自定义供应商：多协议格式（OpenAI 兼容 / Anthropic 兼容 / OpenAI Responses） -->
        <div v-if="isCustom" class="ai-field">
          <label class="ai-label">{{ t('ai_custom_format_label') }}</label>
          <CustomSelect :model-value="formApiFormat" @update:model-value="(v: string) => (formApiFormat = v as AiApiFormat)">
            {{ t(`ai_custom_format_${formApiFormat}`) }}
            <template #options>
              <CustomSelectOption
                v-for="fmt in (['openai', 'anthropic', 'responses'] as AiApiFormat[])"
                :key="fmt"
                :value="fmt"
                :selected="formApiFormat === fmt"
                @select="(v: string) => (formApiFormat = v as AiApiFormat)"
              >
                {{ t(`ai_custom_format_${fmt}`) }}
              </CustomSelectOption>
            </template>
          </CustomSelect>
          <div class="ai-format-hint">{{ t(`ai_custom_format_hint_${formApiFormat}`) }}</div>
        </div>

        <div class="ai-field">
          <label class="ai-label">{{ t('ai_name') }}</label>
          <Input v-model="formName" :placeholder="t('ai_name_ph')" />
        </div>

        <div class="ai-field">
          <label class="ai-label">{{ t('ai_api_key') }}</label>
          <Input
            v-model="formApiKey"
            type="password"
            autocomplete="off"
            :placeholder="editingId ? t('ai_api_key_keep') : t('ai_api_key_ph')"
          />
        </div>

        <div class="ai-field">
          <label class="ai-label">{{ t('ai_base_url') }}</label>
          <Input v-model="formBaseUrl" :placeholder="t('ai_base_url_ph')" />
        </div>

        <div class="ai-field">
          <label class="ai-label">{{ t('ai_model') }}</label>
          <!-- 已选模型以 tag 形式展示，可直接删除；亦可从下方列表点选添加 -->
          <div v-if="formSelectedModels.length" class="ai-models">
            <div class="ai-models-tags">
              <button
                v-for="m in formSelectedModels"
                :key="m"
                type="button"
                class="ai-model-tag ai-model-tag--selected"
                @click="toggleModel(m)"
              >
                {{ m }}
                <span class="ai-model-remove">×</span>
              </button>
            </div>
          </div>
          <Input
            v-model="formSelectedModels[formSelectedModels.length - 1]"
            :placeholder="t('ai_model_ph')"
            @keydown.enter.prevent="
              ($event.target as HTMLInputElement)?.value &&
                toggleModel(($event.target as HTMLInputElement).value)
            "
          />
          <div v-if="formModels.length" class="ai-models">
            <div class="ai-models-hint">{{ t('ai_models_hint') }}</div>
            <div class="ai-models-tags">
              <button
                v-for="m in formModels"
                :key="m"
                type="button"
                class="ai-model-tag"
                :class="{ active: formSelectedModels.includes(m) }"
                @click="toggleModel(m)"
              >
                {{ m }}
              </button>
            </div>
          </div>
          <div class="ai-models-actions">
            <Button
              size="sm"
              variant="outline"
              class="min-w-[100px]"
              :disabled="refreshingModels || !formApiKey.trim()"
              @click="refreshModels"
            >
              <RefreshCw v-if="!refreshingModels" :size="12" />
              {{ refreshingModels ? t('ai_refreshing') : t('ai_refresh_models') }}
            </Button>
          </div>
        </div>

        <div class="ai-field">
          <label class="ai-label">上下文窗口 (tokens)</label>
          <Input
            v-model="formContextWindow"
            type="number"
            :placeholder="`自动按模型：${formSelectedModels[0] || '?'}`"
          />
          <div class="sg-hint">
            留空则按内置模型表自动识别（切换模型时总量随之变化）。自定义/未知模型请填真实上下文窗口，如 128000 / 200000 / 1000000。
          </div>
        </div>

        <div class="sg-row ai-default-row">
          <div class="sg-label">
            <div class="sg-name">{{ t('ai_default') }}</div>
            <div class="sg-hint">{{ t('ai_default_h') }}</div>
          </div>
          <Switch :model-value="formIsDefault" @update:model-value="(v: boolean) => (formIsDefault = v)" />
        </div>

        <div v-if="formError" class="ai-error">{{ formError }}</div>

        <div class="ai-form-actions">
          <Button class="min-w-[100px]" :disabled="saving" @click="save">{{ saving ? t('ai_saving') : t('ai_save') }}</Button>
          <Button variant="outline" class="min-w-[100px]" @click="resetForm()">{{ t('cancel_btn') }}</Button>
        </div>
      </div>
    </section>

    <!-- ===== 对话偏好 ===== -->
    <section class="ai-section">
      <div class="ai-section-head">
        <div class="ai-section-head-text">
          <div class="ai-section-title">{{ t('ai_section_prefs', '对话偏好') }}</div>
          <div class="ai-section-hint">{{ t('ai_prefs_hint', '与 AI 面板实时同步，变更立即生效。') }}</div>
        </div>
      </div>
      <div class="ai-prefs-card">
        <!-- 默认对话模式 -->
        <div class="ai-pref-row">
          <div class="ai-pref-text">
            <div class="ai-pref-name">{{ t('ai_prefs_mode', '默认对话模式') }}</div>
            <div class="ai-pref-hint">{{ t('ai_prefs_mode_h', '新对话的起始模式，可随时在对话面板切换。') }}</div>
          </div>
          <div class="ai-pref-control">
            <CustomSelect
              :model-value="prefMode"
              @update:model-value="(v: string) => { prefMode = v as 'ask' | 'agent'; savePrefs({ defaultMode: prefMode }) }"
            >
              {{ prefMode === 'agent' ? t('ai_mode_agent') : t('ai_mode_ask') }}
              <template #options>
                <CustomSelectOption
                  value="ask"
                  :selected="prefMode === 'ask'"
                  @select="(v: string) => { prefMode = v as 'ask' | 'agent'; savePrefs({ defaultMode: prefMode }) }"
                >
                  {{ t('ai_mode_ask') }}
                </CustomSelectOption>
                <CustomSelectOption
                  value="agent"
                  :selected="prefMode === 'agent'"
                  @select="(v: string) => { prefMode = v as 'ask' | 'agent'; savePrefs({ defaultMode: prefMode }) }"
                >
                  {{ t('ai_mode_agent') }}
                </CustomSelectOption>
              </template>
            </CustomSelect>
          </div>
        </div>

        <!-- 思考模式 -->
        <div class="ai-pref-row">
          <div class="ai-pref-text">
            <div class="ai-pref-name">{{ t('ai_thinking') }}</div>
            <div class="ai-pref-hint">{{ t('ai_prefs_thinking_h', '开启后模型会先思考再回答，复杂任务效果更好。') }}</div>
          </div>
          <Switch
            :model-value="prefThinking"
            @update:model-value="(v: boolean) => { prefThinking = v; savePrefs({ thinkingEnabled: v }) }"
          />
        </div>
        <div v-if="prefThinking" class="ai-pref-row ai-pref-row--sub">
          <div class="ai-pref-text">
            <div class="ai-pref-name">{{ t('ai_thinking_strength', '思考强度') }}</div>
          </div>
          <div class="ai-pref-control">
            <CustomSelect
              :model-value="prefThinkingStrength"
              @update:model-value="(v: string) => { prefThinkingStrength = v as 'low' | 'medium' | 'high'; savePrefs({ thinkingStrength: prefThinkingStrength }) }"
            >
              {{ t(`ai_thinking_strength_${prefThinkingStrength}`, strengthFallback[prefThinkingStrength]) }}
              <template #options>
                <CustomSelectOption
                  v-for="s in (['low', 'medium', 'high'] as const)"
                  :key="s"
                  :value="s"
                  :selected="prefThinkingStrength === s"
                  @select="(v: string) => { prefThinkingStrength = v as 'low' | 'medium' | 'high'; savePrefs({ thinkingStrength: prefThinkingStrength }) }"
                >
                  {{ t(`ai_thinking_strength_${s}`, strengthFallback[s]) }}
                </CustomSelectOption>
              </template>
            </CustomSelect>
          </div>
        </div>

        <!-- 长程记忆 -->
        <div class="ai-pref-row">
          <div class="ai-pref-text">
            <div class="ai-pref-name">{{ t('ai_memory_mode') }}</div>
            <div class="ai-pref-hint">{{ t('ai_memory_mode_hint') }}</div>
          </div>
          <Switch
            :model-value="prefMemory"
            @update:model-value="(v: boolean) => { prefMemory = v; savePrefs({ memoryEnabled: v }) }"
          />
        </div>
      </div>
    </section>

    <!-- ===== 全局系统提示词 ===== -->
    <section class="ai-section">
      <div class="ai-section-head">
        <div class="ai-section-head-text">
          <div class="ai-section-title">{{ t('ai_system_prompt', '全局系统提示词') }}</div>
          <div class="ai-section-hint">
            {{ t('ai_system_prompt_h', '可选。配置后注入到每次 AI 对话的角色/产品知识之后，用于定义全局行为偏好、语气或人设。留空则不注入。') }}
          </div>
        </div>
      </div>
      <div class="ai-prompt-card">
        <textarea
          v-model="customPrompt"
          class="ai-prompt-ta"
          rows="6"
          :placeholder="t('ai_system_prompt_ph', '例如：你叫 Clip，是用户的跨设备剪贴板助手；回答保持简洁友好，重要结论用中文输出。')"
        />
        <div class="ai-prompt-foot">
          <span class="ai-prompt-count">{{ customPrompt.length }} {{ t('ai_prompt_chars', '字符') }}</span>
          <span v-if="promptSaved" class="ai-prompt-saved">{{ t('ai_prompt_saved_tip', '已保存 ✓') }}</span>
          <span v-else-if="promptDirty" class="ai-prompt-dirty">{{ t('ai_prompt_unsaved', '有未保存的修改') }}</span>
          <Button
            size="sm"
            class="ai-prompt-save shrink-0 whitespace-nowrap"
            :disabled="promptSaving || !promptDirty"
            @click="saveCustomPrompt"
          >
            {{ promptSaving ? t('ai_saving') : t('ai_save') }}
          </Button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-group {
  margin-bottom: 24px;
}
.sg-header {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  margin-bottom: 8px;
}
/* sg-* 通用行：表单内「设为默认」行仍在使用 */
.sg-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  gap: 16px;
}
.sg-label {
  flex: 1;
  min-width: 0;
}
.sg-name {
  font-size: 14px;
  font-weight: 500;
}
.sg-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 1px;
}

/* ===== 分区骨架 ===== */
.ai-section {
  margin-top: 26px;
}
.ai-section:first-of-type {
  margin-top: 4px;
}
.ai-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 10px;
}
.ai-section-head-text {
  min-width: 0;
}
.ai-section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.4;
}
.ai-section-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
  line-height: 1.55;
}

/* ===== 供应商卡片 ===== */
.ai-prov-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ai-prov-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface, transparent);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}
.ai-prov-card:hover {
  border-color: var(--border-default);
  box-shadow: var(--shadow-card);
}
.ai-prov-main {
  flex: 1;
  min-width: 0;
}
.ai-prov-name {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
}
.ai-prov-meta {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-card-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
  align-items: center;
}
/* 图标操作按钮：测试/编辑/删除（替换文字按钮，更紧凑干净） */
.ai-card-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease,
    border-color 0.15s ease;
}
.ai-card-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--border-default);
}
.ai-card-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.ai-card-btn--danger:hover {
  background: color-mix(in srgb, var(--danger, #ef4444) 12%, transparent);
  color: var(--danger, #ef4444);
  border-color: color-mix(in srgb, var(--danger, #ef4444) 35%, transparent);
}
.ai-card-btn--confirm:hover {
  background: color-mix(in srgb, var(--success, #16a34a) 12%, transparent);
  color: var(--success, #16a34a);
  border-color: color-mix(in srgb, var(--success, #16a34a) 35%, transparent);
}
/* 测试中旋转微光 */
.ai-card-btn.testing :deep(svg) {
  animation: ai-card-testing 0.9s linear infinite;
}
@keyframes ai-card-testing {
  to { transform: rotate(360deg); }
}
.ai-badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
}
.ai-badge--default {
  background: var(--accent-bg);
  color: var(--accent);
}
.ai-badge--key {
  background: var(--success-bg, #dcfce7);
  color: var(--success, #16a34a);
}
.ai-badge--nokey {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}
.ai-empty {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 16px;
  border: 1px dashed var(--border-subtle);
  border-radius: var(--radius-md);
  text-align: center;
}
/* 添加/收起按钮的折叠指示箭头 */
.ai-add-chev {
  transition: transform 0.2s ease;
}
.ai-add-chev.open {
  transform: rotate(180deg);
}

/* ===== 新增/编辑表单 ===== */
.ai-form {
  margin-top: 10px;
  padding: 20px 22px;
  background: var(--bg-hover);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}
.ai-field {
  margin-bottom: 16px;
}
.ai-field .custom-select {
  width: 100%;
}
.ai-field :deep(input) {
  padding-left: 14px;
  padding-right: 14px;
}
.ai-field :deep(.custom-select-trigger) {
  padding-left: 14px;
  padding-right: 14px;
}
.ai-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
  padding-left: 2px;
}
.ai-default-row {
  padding: 10px 4px;
}
.ai-models {
  margin-top: 10px;
}
.ai-models-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ai-model-tag {
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: transparent;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.ai-model-tag:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.ai-model-tag.active {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 500;
}
.ai-model-tag--selected {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 500;
  padding-right: 8px;
}
.ai-model-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 4px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-bg);
  font-size: 10px;
  line-height: 1;
}
.ai-model-tag--selected:hover .ai-model-remove {
  background: var(--danger, #ef4444);
  color: #fff;
}
.ai-models-hint {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 6px;
}
.ai-models-actions {
  margin-top: 10px;
}
.ai-models-actions :deep(.ai-model-tag svg) {
  display: inline-block;
  vertical-align: middle;
}
.ai-error {
  color: var(--danger, #ef4444);
  font-size: 12px;
  margin: 4px 0 10px;
}
.ai-form-actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}

/* ===== 按钮兜底 =====
 * shadcn Button 的内边距/高度依赖 tailwind v4 间距工具类（px-4/h-9，经 --spacing 计算），
 * 该机制在部分运行环境下不生效，导致文字贴边、高度塌陷（历史上“保存”按钮被压成竖排即此因）。
 * 未分层的 scoped 规则优先级高于 @layer utilities，这里显式声明，保证任何环境下按钮都正确。 */
.ai-section-head > button,
.ai-models-actions > button,
.ai-prompt-save {
  gap: 6px;
  height: 32px;
  padding: 0 14px;
}
.ai-form-actions > button {
  height: 36px;
  padding: 0 18px;
  min-width: 100px;
}

/* ===== 对话偏好 ===== */
.ai-prefs-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface, transparent);
  overflow: hidden;
}
.ai-pref-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
}
.ai-pref-row + .ai-pref-row {
  border-top: 1px solid var(--border-subtle);
}
.ai-pref-row--sub .ai-pref-name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-secondary);
}
.ai-pref-text {
  flex: 1;
  min-width: 0;
}
.ai-pref-name {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-primary);
}
.ai-pref-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
  line-height: 1.5;
}
.ai-pref-control {
  width: 172px;
  flex-shrink: 0;
}
.ai-pref-control .custom-select {
  width: 100%;
}

/* ===== 全局系统提示词 ===== */
.ai-prompt-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  background: var(--bg-surface, transparent);
}
.ai-prompt-ta {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.6;
  font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--text-primary);
  background: var(--bg-input);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  outline: none;
  resize: vertical;
}
.ai-prompt-ta:focus {
  border-color: var(--accent, #4f8cff);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #4f8cff) 20%, transparent);
}
.ai-prompt-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}
.ai-prompt-count {
  font-size: 11.5px;
  color: var(--text-tertiary);
}
.ai-prompt-dirty {
  font-size: 12px;
  color: var(--warning, #f59e0b);
}
.ai-prompt-saved {
  font-size: 12px;
  color: var(--success, #16a34a);
}
.ai-prompt-save {
  margin-left: auto;
  min-width: 76px;
}

/* 协议格式限制说明：醒目蓝/灰底色，避免用户选错非 OpenAI 协议的供应商 */
.ai-protocol-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 14px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
}
.ai-protocol-hint-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-bg, #fff);
  font-size: 11px;
  font-weight: 700;
  font-style: italic;
  margin-top: 1px;
}

/* 兼容格式说明：位于格式下拉下方 */
.ai-format-hint {
  margin-top: 6px;
  padding-left: 2px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-secondary);
}
</style>
