<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Switch from '@/components/ui/switch/Switch.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'
import { RefreshCw, PlayCircle, Pencil, Trash2, Check, X, ChevronDown, Plus, Star } from 'lucide-vue-next'
import { useMenuAccess } from '@/composables/useMenuAccess'
import {
  getProviders,
  getPresets,
  createProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  getProviderModels,
  fetchProviderModels,
  getSettings,
  saveSettings,
  testSearchConfig,
} from '@/api/ai'
import type { AiProvider, AiProviderPreset, AiApiFormat, AiSettings } from '@/api/ai'
import type { ApiResponse } from '@/api/client'
import { aiFailureFrom, describeAiFailure, hasAiFailureMapping } from '@/utils/aiErrors'
import AIModelSettingsPanel from './AIModelSettingsPanel.vue'
import {
  DEFAULT_THINKING_STRENGTH,
  THINKING_STRENGTH_LABELS,
  THINKING_STRENGTHS,
  normalizeThinkingStrength,
  type ThinkingStrength,
} from '@/utils/aiThinking'

const { t, tf, tMsg } = useI18n()
const toast = useSonner()
// MA-05：feature.ai_categories（服务端 plan.features.ai_classify 能力键）桌面端消费点。
// capabilities 快照未加载时 can() fail-open 放行，越权由服务端 requireFeature 403 权威兜底。
const { can } = useMenuAccess()
// 如实展示能力状态：桌面端暂无独立分类 UI，ai_classify 由服务端 AI 工具链（AI 建议等）消费
const aiCategoriesEnabled = computed(() => can('feature.ai_categories'))

const providers = ref<AiProvider[]>([])
const presets = ref<AiProviderPreset[]>([])
const loading = ref(false)
// 模型级配置面板（每个模型单独配置上下文窗口/最大输出/多模态/推理协议）。
// 刷新模型列表后由 refreshModels() 调 reload() 自动拉取预设值，用户无需手动点。
const modelPanelRef = ref<InstanceType<typeof AIModelSettingsPanel> | null>(null)

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
// 思考强度固定 5 档（low|medium|high|xhigh|max），档位文案与兜底统一在 utils/aiThinking.ts，界面不翻译成中文

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
const prefThinkingStrength = ref<ThinkingStrength>(DEFAULT_THINKING_STRENGTH)
const prefMemory = ref(false)
// 复制后自动 AI 摘要（C1）：本地偏好，默认关闭；默认配置下复制内容不触发任何 LLM 调用
const AUTO_SUMMARY_KEY = 'ai-auto-summary-on-copy'
const autoSummaryOnCopy = ref(localStorage.getItem(AUTO_SUMMARY_KEY) === '1')

function setAutoSummaryOnCopy(v: boolean) {
  autoSummaryOnCopy.value = v
  localStorage.setItem(AUTO_SUMMARY_KEY, v ? '1' : '0')
  // 通知常驻的 AiSummaryFloat 即时生效
  window.dispatchEvent(new CustomEvent('clipsync:ai-auto-summary-changed'))
}

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
      prefThinkingStrength.value = normalizeThinkingStrength(res.data.thinkingStrength)
      prefMemory.value = !!res.data.memoryEnabled
      searchProvider.value = res.data.searchProvider || ''
      searchBaseUrl.value = res.data.searchBaseUrl || ''
      searchHasKey.value = !!res.data.searchHasKey
    }
  } catch (e) {
    console.warn('[AI] load settings failed', e)
  }
}

// ===== 联网搜索源（web_search 工具路由；key 加密存、不回显）=====
const SEARCH_PROVIDER_OPTIONS = [
  { value: 'anysearch', label: 'AnySearch' },
  { value: 'bocha', label: '博查 Bocha' },
  { value: 'brave', label: 'Brave Search' },
  { value: 'tavily', label: 'Tavily' },
  { value: 'searxng', label: '自建 SearXNG' },
]
const searchProvider = ref('')
const searchBaseUrl = ref('')
const searchApiKeyInput = ref('')
const searchHasKey = ref(false)
const searchTesting = ref(false)

function searchProviderLabel(v: string) {
  return SEARCH_PROVIDER_OPTIONS.find((o) => o.value === v)?.label || v
}

function onSearchProviderChange(v: string) {
  searchProvider.value = v
  // 切源即保存（空=未配置，走管理台全局兜底）；key 输入框独立保存
  savePrefs({ searchProvider: v })
}

function onSearchBaseUrlBlur() {
  savePrefs({ searchBaseUrl: searchBaseUrl.value.trim() })
}

function saveSearchApiKey() {
  const v = searchApiKeyInput.value.trim()
  if (!v) return
  savePrefs({ searchApiKey: v })
  searchApiKeyInput.value = ''
  searchHasKey.value = true
}

function clearSearchApiKey() {
  savePrefs({ searchApiKey: null })
  searchApiKeyInput.value = ''
  searchHasKey.value = false
}

async function testSearch() {
  if (!searchProvider.value || searchTesting.value) return
  searchTesting.value = true
  try {
    // 输入框有值用输入框的（未保存也可用）；否则用已存 key（后端 '__keep__' 语义）
    const res = await testSearchConfig({
      provider: searchProvider.value,
      apiKey: searchApiKeyInput.value.trim() || '__keep__',
      baseUrl: searchBaseUrl.value.trim() || undefined,
    })
    if (res.ok && res.data?.ok) {
      toast.show(
        t('ai_search_test_ok', `搜索可用（${res.data.firstTitle || '已返回结果'}）`),
        'success',
      )
    } else {
      toast.show(providerErrorText(res, t('ai_search_test_fail', '搜索测试失败')), 'error')
    }
  } catch (e: any) {
    toast.show(tMsg(e?.message) || String(e), 'error')
  } finally {
    searchTesting.value = false
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
      toast.show(tMsg(res.error) || t('ai_save_failed'), 'error')
    }
  } catch (e: any) {
    toast.show(tMsg(e?.message) || String(e), 'error')
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
      toast.show(tMsg(res.error) || t('ai_prompt_save_fail', '保存失败'), 'error')
    }
  } catch (e: any) {
    toast.show(tMsg(e?.message) || String(e), 'error')
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

// 一键设为默认。
// 之前只能打开「编辑」表单里的开关才能改默认 —— 而默认供应商同时决定所有 AI 快捷功能
// （页内总结 / AI 建议 / 整理收藏 / 相似度…）走哪个模型，入口藏这么深就是用户说的
// 「前台没有任何可以配置的入口」。这里给卡片补一个直接按钮。
const settingDefaultId = ref<string | null>(null)
async function setDefault(p: AiProvider) {
  if (p.is_default || settingDefaultId.value) return
  settingDefaultId.value = p.id
  try {
    const res = await updateProvider(p.id, { isDefault: true })
    if (res.ok) {
      toast.show(t('ai_set_default_done'), 'success')
      await load()
    } else {
      toast.show(res.error || t('ai_save_failed', '保存失败'), 'error')
    }
  } catch (e) {
    toast.show(String((e as Error)?.message || e), 'error')
  } finally {
    settingDefaultId.value = null
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

/**
 * 供应商表单 / 刷新模型 / 搜索源测试的失败文案。
 *
 * 服务端对 base_url 的拒绝会带稳定机器码（ai_base_url_*，见 src/server/src/utils/aiProviders.js
 * 的 UPSTREAM_URL_CODES）：命中 utils/aiErrors 的映射表就出人话（哪一类地址被拒 + 怎么解决），
 * 不再把「Base URL resolves to a blocked internal address」这类黑话直接甩给用户；
 * 未命中任何映射时**沿用原 error 文案**（不改变既有行为）。
 */
function providerErrorText(res: ApiResponse<unknown>, fallback: string): string {
  const payload = aiFailureFrom(res)
  if (payload && hasAiFailureMapping(payload)) return describeAiFailure(payload, tf)
  return tMsg(res.error) || fallback
}

// 刷新该供应商可用模型列表（上游 /models）。
// 有 key 就能拉列表，**不需要先保存**：
//   - 表单里填了 key（新增供应商，或刚改了 key / 地址）→ 直接用表单里的值走预览接口（不落库）；
//   - 编辑已保存的供应商、且没重输 key → 按 id 用库里已存的加密 key。
// 预览接口对 baseUrl 走与保存路径同一套 SSRF 校验（默认放行环回/私网/ULA 本地网关，
// 仍禁云元数据/链路本地、组播/广播/保留段、非 http(s)、带用户信息等；DNS 全解析逐个校验），
// 所以直连预览不会降低安全性。
// 按钮可否点：新增时必须先有 key；编辑态即使没重输 key 也能刷新（用库里的 key）。
const canRefreshModels = computed(() => !!editingId.value || formApiKey.value.trim().length > 0)

async function refreshModels() {
  if (refreshingModels.value) return
  const typedKey = formApiKey.value.trim()
  if (!typedKey && !editingId.value) {
    formError.value = t('ai_api_key_required')
    return
  }
  refreshingModels.value = true
  formError.value = ''
  try {
    const res = typedKey
      ? await fetchProviderModels({
          provider: formProvider.value,
          apiKey: typedKey,
          baseUrl: formBaseUrl.value.trim() || undefined,
          apiFormat: isCustom.value ? formApiFormat.value : undefined,
        })
      : await getProviderModels(editingId.value as string)
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
      // 刷新成功后自动拉取模型级配置（GET /api/ai/model-settings），把预设值与来源标记展示出来
      void modelPanelRef.value?.reload()
      toast.show(t('ai_models_refreshed'), 'success')
    } else {
      toast.show(providerErrorText(res, t('ai_models_refresh_fail')), 'error')
    }
  } catch (e: any) {
    toast.show(tMsg(e?.message) || String(e), 'error')
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
      formError.value = providerErrorText(res, t('ai_save_failed'))
    }
  } catch (e: any) {
    formError.value = tMsg(e?.message) || String(e)
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
    toast.show(tMsg(res.error) || t('ai_delete_failed'), 'error')
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
      toast.show(detail + (tMsg(res.error) || t('ai_test_fail')), 'error')
    }
  } catch (e: any) {
    toast.show(tMsg(e?.message) || String(e), 'error')
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
          {{ formOpen ? tf('collapse', '收起') : t('ai_add_provider') }}
        </Button>
      </div>

      <!-- 供应商列表 -->
      <div class="ai-prov-list">
        <div v-for="p in providers" :key="p.id" class="ai-prov-card">
          <div class="ai-prov-main">
            <div class="ai-prov-name">
              <span class="ai-prov-name-text">{{ p.name }}</span>
              <span
                v-if="p.is_default"
                class="ai-badge ai-badge--default"
                :title="t('ai_badge_default_h')"
                >{{ t('ai_default') }}</span
              >
              <span v-if="p.has_key" class="ai-badge ai-badge--key">{{ t('ai_key_set') }}</span>
              <span v-else class="ai-badge ai-badge--nokey">{{ t('ai_no_key') }}</span>
            </div>
            <div class="ai-prov-meta">
              {{ presetLabel(p.provider) }} ·
              <template v-if="Array.isArray(p.models) && p.models.length > 1">
                {{ tf('ai_provider_models_count', `${p.models[0]} 等 ${p.models.length} 个模型`, { first: p.models[0], n: p.models.length }) }}
              </template>
              <template v-else>{{ p.model }}</template>
            </div>
          </div>
          <div class="ai-card-actions">
            <button
              v-if="!p.is_default"
              type="button"
              class="ai-card-btn"
              :class="{ testing: settingDefaultId === p.id }"
              :title="t('ai_set_default')"
              :disabled="settingDefaultId === p.id"
              @click="setDefault(p)"
            >
              <Star :size="16" />
            </button>
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
          <!-- AN-03：桌面端供应商选项非硬编码，由服务端 GET /api/ai/presets 动态下发
               （load() 里 getPresets()），管理台 AI 平台预设扩充后此处自动同步 -->
          <div class="ai-format-hint">{{ t('ai_provider_admin_hint') }}</div>
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
              :disabled="refreshingModels || !canRefreshModels"
              @click="refreshModels"
            >
              <RefreshCw v-if="!refreshingModels" :size="12" />
              {{ refreshingModels ? t('ai_refreshing') : t('ai_refresh_models') }}
            </Button>
          </div>

          <!-- 模型级配置：每个已选模型一行，点「配置」展开上下文/最大输出/多模态/推理协议 + 恢复预设 -->
          <AIModelSettingsPanel
            v-if="editingId"
            ref="modelPanelRef"
            :provider-id="editingId"
            :models="formSelectedModels"
          />
          <div v-else class="ai-format-hint">
            {{ t('ai_model_cfg_need_save', '先保存该供应商，保存后即可逐个配置模型的参数与预设。') }}
          </div>
        </div>

        <div class="ai-field">
          <label class="ai-label">{{ t('ai_context_window_label', '上下文窗口 (tokens)') }}</label>
          <Input
            v-model="formContextWindow"
            type="number"
            :placeholder="tf('ai_context_window_ph', `自动按模型：${formSelectedModels[0] || '?'}`, { model: formSelectedModels[0] || '?' })"
          />
          <div class="sg-hint">
            {{ t('ai_context_window_hint', '留空则按内置模型表自动识别（切换模型时总量随之变化）。自定义/未知模型请填真实上下文窗口，如 128000 / 200000 / 1000000。') }}
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
              @update:model-value="(v: string) => { prefThinkingStrength = v as ThinkingStrength; savePrefs({ thinkingStrength: prefThinkingStrength }) }"
            >
              {{ t(`ai_thinking_strength_${prefThinkingStrength}`, THINKING_STRENGTH_LABELS[prefThinkingStrength]) }}
              <template #options>
                <CustomSelectOption
                  v-for="s in THINKING_STRENGTHS"
                  :key="s"
                  :value="s"
                  :selected="prefThinkingStrength === s"
                  @select="(v: string) => { prefThinkingStrength = v as ThinkingStrength; savePrefs({ thinkingStrength: prefThinkingStrength }) }"
                >
                  {{ t(`ai_thinking_strength_${s}`, THINKING_STRENGTH_LABELS[s]) }}
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

        <!-- 复制后自动 AI 摘要（C1）：默认关闭，开启后每次复制文本都会调用一次 LLM -->
        <div class="ai-pref-row">
          <div class="ai-pref-text">
            <div class="ai-pref-name">{{ t('ai_auto_summary_title', '复制后自动 AI 摘要') }}</div>
            <div class="ai-pref-hint">
              {{ t('ai_auto_summary_hint', '开启后每次复制文本会自动调用大模型生成摘要并弹出浮窗；相同内容 10 分钟内只调用一次。关闭时不产生任何模型调用。') }}
            </div>
          </div>
          <Switch :model-value="autoSummaryOnCopy" @update:model-value="setAutoSummaryOnCopy" />
        </div>
      </div>
    </section>

    <!-- ===== 联网搜索源（web_search 工具路由） ===== -->
    <section class="ai-section">
      <div class="ai-section-head">
        <div class="ai-section-head-text">
          <div class="ai-section-title">{{ t('ai_search_title', '联网搜索') }}</div>
          <div class="ai-section-hint">
            {{ t('ai_search_hint', 'Agent 需要最新知识时调用的搜索源。未配置则走管理台全局，仍未配则用 AnySearch 匿名额度。') }}
          </div>
        </div>
      </div>
      <div class="ai-prefs-card">
        <div class="ai-pref-row">
          <div class="ai-pref-text">
            <div class="ai-pref-name">{{ t('ai_search_provider', '搜索源') }}</div>
            <div class="ai-pref-hint">{{ t('ai_search_provider_h', '清空=未配置，走管理台全局兜底。') }}</div>
          </div>
          <div class="ai-pref-control">
            <CustomSelect :model-value="searchProvider" @update:model-value="onSearchProviderChange">
              {{ searchProvider ? searchProviderLabel(searchProvider) : t('ai_search_unset', '未配置') }}
              <template #options>
                <CustomSelectOption value="" :selected="searchProvider === ''" @select="onSearchProviderChange">
                  {{ t('ai_search_unset', '未配置') }}
                </CustomSelectOption>
                <CustomSelectOption
                  v-for="o in SEARCH_PROVIDER_OPTIONS"
                  :key="o.value"
                  :value="o.value"
                  :selected="searchProvider === o.value"
                  @select="onSearchProviderChange"
                >
                  {{ o.label }}
                </CustomSelectOption>
              </template>
            </CustomSelect>
          </div>
        </div>

        <div v-if="searchProvider && searchProvider !== 'searxng'" class="ai-pref-row">
          <div class="ai-pref-text">
            <div class="ai-pref-name">
              {{ t('ai_search_key', 'API Key') }}
              <span v-if="searchHasKey" class="ai-badge ai-badge--key">{{ t('ai_key_set', '已配置') }}</span>
              <span v-else class="ai-badge ai-badge--nokey">{{ t('ai_no_key', '未配置') }}</span>
            </div>
            <div class="ai-pref-hint">{{ t('ai_search_key_h', '加密存储，永不回显；留空=不修改。') }}</div>
          </div>
          <div class="ai-pref-control ai-pref-control--wide">
            <div class="ai-search-key-line">
              <Input
                v-model="searchApiKeyInput"
                type="password"
                autocomplete="off"
                class="ai-search-key-input"
                :placeholder="searchHasKey ? t('ai_api_key_keep', '留空表示不修改') : t('ai_api_key_ph', '输入 Key')"
                @keyup.enter="saveSearchApiKey"
              />
              <Button
                size="sm"
                variant="outline"
                class="shrink-0 whitespace-nowrap"
                :disabled="!searchApiKeyInput.trim()"
                @click="saveSearchApiKey"
              >
                {{ t('ai_save', '保存') }}
              </Button>
              <Button
                v-if="searchHasKey"
                size="sm"
                variant="ghost"
                class="shrink-0 whitespace-nowrap"
                @click="clearSearchApiKey"
              >
                {{ t('ai_search_key_clear', '清除') }}
              </Button>
            </div>
          </div>
        </div>

        <div v-if="searchProvider === 'searxng'" class="ai-pref-row">
          <div class="ai-pref-text">
            <div class="ai-pref-name">{{ t('ai_search_base_url', '自建地址') }}</div>
            <div class="ai-pref-hint">{{ t('ai_search_base_url_h', '自建 SearXNG 地址，如 https://search.example.com 或本机 http://127.0.0.1:8080（本机/内网已放行；云元数据等地址仍会被拒绝）。') }}</div>
          </div>
          <div class="ai-pref-control ai-pref-control--wide">
            <Input
              v-model="searchBaseUrl"
              placeholder="https://search.example.com"
              @blur="onSearchBaseUrlBlur"
              @keyup.enter="onSearchBaseUrlBlur"
            />
          </div>
        </div>

        <div v-if="searchProvider" class="ai-pref-row">
          <div class="ai-pref-text">
            <div class="ai-pref-name">{{ t('ai_search_test', '连通性测试') }}</div>
          </div>
          <Button size="sm" variant="outline" :disabled="searchTesting" @click="testSearch">
            <RefreshCw v-if="!searchTesting" :size="12" />
            {{ searchTesting ? t('ai_testing', '测试中…') : t('ai_test', '测试') }}
          </Button>
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

    <!-- ===== AI 智能分类（MA-05：feature.ai_categories 消费，仅展示层引导）=====
         ai_classify 能力键由服务端 AI 工具链消费，桌面端无本地开关可接，
         这里如实展示当前套餐的能力可用状态；不满足时置灰 + 升级引导。 -->
    <section class="ai-section">
      <div class="ai-section-head">
        <div class="ai-section-head-text">
          <div class="ai-section-title">{{ t('ai_categories_title', 'AI 智能分类') }}</div>
          <div class="ai-section-hint">
            {{ t('ai_categories_hint', '当前套餐的智能分类能力状态（由服务端套餐能力控制）。') }}
          </div>
        </div>
      </div>
      <div class="ai-prefs-card">
        <div class="ai-pref-row" :class="{ 'ai-pref-row--locked': !aiCategoriesEnabled }">
          <div class="ai-pref-text">
            <div class="ai-pref-name">{{ t('ai_categories_name', '智能分类') }}</div>
            <div class="ai-pref-hint">
              {{
                aiCategoriesEnabled
                  ? t('ai_categories_ok_hint', '当前套餐已包含该能力，AI 建议等服务端能力可使用智能分类。')
                  : t('ai_categories_locked_hint', 'Pro 及以上套餐可用，升级后 AI 建议等服务端能力将支持智能分类。')
              }}
            </div>
          </div>
          <span class="ai-badge" :class="aiCategoriesEnabled ? 'ai-badge--key' : 'ai-badge--nokey'">
            {{ aiCategoriesEnabled ? t('ai_categories_ok_badge', '可用') : t('ai_categories_locked_badge', '未开通') }}
          </span>
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
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 35%, transparent);
}
.ai-card-btn--confirm:hover {
  background: color-mix(in srgb, var(--success) 12%, transparent);
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 35%, transparent);
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
  background: var(--success-bg);
  color: var(--success);
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
  background: var(--danger);
  color: var(--danger-foreground);
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
  color: var(--danger);
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
  /* 下拉弹层必须能溢出卡片：hidden 会把 CustomSelect 的菜单在卡片边缘截断
     （圆角改由首/末行收角保证，见下方 .ai-pref-row:first/last-child 规则） */
  overflow: visible;
}
/* 卡片无 overflow:hidden 后，首末行的背景收圆角，避免方形背景穿帮 */
.ai-prefs-card > .ai-pref-row:first-child {
  border-top-left-radius: var(--radius-md);
  border-top-right-radius: var(--radius-md);
}
.ai-prefs-card > .ai-pref-row:last-child {
  border-bottom-left-radius: var(--radius-md);
  border-bottom-right-radius: var(--radius-md);
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
/* MA-05：能力未开通时整行置灰（纯展示层，行内无交互控件） */
.ai-pref-row--locked .ai-pref-name,
.ai-pref-row--locked .ai-pref-hint {
  color: var(--text-tertiary);
}
.ai-pref-row--locked {
  opacity: 0.75;
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
/* 联网搜索 key 行：输入框 + 保存/清除同一行；地址行沿用纵向 */
.ai-pref-control--wide {
  width: 264px;
}
.ai-search-key-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ai-search-key-input {
  flex: 1;
  min-width: 0;
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
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent);
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
  color: var(--warning);
}
.ai-prompt-saved {
  font-size: 12px;
  color: var(--success);
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
  color: var(--accent-bg);
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
