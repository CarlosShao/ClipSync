<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue'
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
import { aiFailureFrom, describeAiFailure, hasAiFailureMapping, SERVER_MESSAGE_FIRST_CODES } from '@/utils/aiErrors'
import AIModelSettingsPanel from './AIModelSettingsPanel.vue'
import {
  BATCH_MAX_ITEMS,
  putModelSetting,
  putModelSettingsBatch,
  type ModelSettingBatchItem,
  type ModelSettingPatch,
} from '@/api/modelSettings'
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
// 模型库面板（单排胶囊启用/停用 + 每行自检/配置/停用/清除自定义值 + 折叠分组）由下面模板渲染；
// 刷新模型列表成功 → modelRefreshSeq +1，面板据此自己重新拉取并按新模型给出一次性智能建议
// （父组件不再需要持有面板实例：全部通过 props/emit 单向数据流交互）。
const modelRefreshSeq = ref(0)
// 手工添加的模型名（上游 /models 没列出、或想先填一个）：Enter/「添加」加入启用集合
const formManualModel = ref('')
// 草稿态（未保存）刷新出来的**候选**模型：上游返回、未落库，默认不选中；点一下加入/移出待保存集合。
// 本轮缺陷：草稿态没有 providerId ⇒ 模型库面板无从渲染，刷出来的 159 个模型必须在这里立刻可见。
const draftCandidates = ref<string[]>([])
// 上一次刷新返回的模型总数：芯片区计数必须等于刷新真正返回的数量（不再出现「报了 N 个但页面空」）
const lastRefreshCount = ref<number | null>(null)
// 草稿态的模型配置改动（per model，只含用户真改过的字段）：由模型库面板（草稿模式）回传；
// 供应商创建成功后用 PUT /api/ai/model-settings/batch 一次性落库。
const draftModelPatches = ref<Record<string, ModelSettingPatch>>({})
// 批量写入失败：供应商其实已经创建成功，但配置没写进去 —— 如实告知 + 就地重试（绝不谎报成功）
const draftBatchFailure = ref<{
  providerId: string
  items: ModelSettingBatchItem[]
  reason: string
  provider: AiProvider | null
} | null>(null)
const draftBatchApplying = ref(false)
const draftBatchReason = ref('')

const editingId = ref<string | null>(null)
const formProvider = ref('')
const formName = ref('')
const formApiKey = ref('')
const formBaseUrl = ref('')
/**
 * ⚠️ 两个完全不同的概念，别再混用（本轮缺陷的根因就是把它们当成了同一个字段）：
 *   1) **候选清单**（formCandidates）= ai_providers.models：上游刷新出「有哪些模型」（如 169 个）。
 *      它**只**表示候选，**不代表用户选中了哪些**；刷新只更新它。
 *   2) **选中 / 已启用**（savedEnabledModels；草稿态用 formSelectedModels）= 服务端
 *      GET /api/ai/model-settings 的 enabled（唯一事实来源；后端语义：配置行 → selected_models
 *      → 默认 false）。保存时由 v4 PUT /batch 写 enabled 落库，**不再**把选中集合写进 models。
 */
const formCandidates = ref<string[]>([])
/** 主模型（ai_providers.model）：编辑时保持原值，新建时取第一个选中的模型 */
const formPrimaryModel = ref('')
/** 已保存态「已启用」的镜像（来自模型库面板 = 服务端 enabled）：**仅用于计数展示**，不参与保存 */
const savedEnabledModels = ref<string[]>([])
/** 草稿态（新增供应商）的选中集合：只服务草稿流程（勾选即出概要行 + 保存时 batch 写 enabled） */
const formSelectedModels = ref<string[]>([])
const formIsDefault = ref(false)
// 上下文窗口用字符串承载（兼容 type=number 的 Input v-model），提交时再转 number
const formContextWindow = ref<string>('')
// 自定义供应商的多协议格式（OpenAI 兼容 / Anthropic 兼容 / OpenAI Responses）
const formApiFormat = ref<AiApiFormat>('openai')
const saving = ref(false)
const refreshingModels = ref(false)
// 已保存态「手工添加模型」在途（该操作会真的写 enabled=true）
const addingModel = ref(false)
// 刷新模型列表的**持久**结果（就近显示在按钮下方）：用户实测反馈"toast 弹了已刷新，但一个模型都
// 没刷出来" —— toast 一闪而过不足以让人发现失败。三态互不混淆：success / empty（上游合法返回 0 个，
// 按 warning 处理，绝不显示"已刷新"）/ error（失败原因可就地看到 + 重试）。
type ModelsRefreshKind = 'idle' | 'success' | 'empty' | 'error'
const modelsRefresh = ref<{ kind: ModelsRefreshKind; text: string }>({ kind: 'idle', text: '' })
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

/**
 * 防线 ①（主路径）：**自动纠偏** —— 用户一旦填了 Base URL 或 API Key、而「供应商」还空着，
 * 就说明他要配的是自己的网关（本地 one-api / vLLM / Ollama 或任何 OpenAI 兼容服务），
 * 自动把 provider 置为 Custom（下拉里如实显示 Custom）。
 *
 * 用户实测（本轮缺陷）：新增供应商草稿态下「供应商」下拉是空的，点「刷新模型列表」时 payload 里
 * provider='' ⇒ 服务端预设白名单直接 400「Invalid provider」，**根本没发出上游请求** ——
 * 所以换 127.0.0.1:3800 还是 host.docker.internal:3800 表现完全一样，看着像网络问题，其实是这个空值。
 *
 * 只在 provider **为空**时纠偏 ⇒ 用户显式选过的预设永远不会被覆盖。
 */
watch(
  [formProvider, formBaseUrl, formApiKey],
  () => {
    if (formProvider.value) return
    if (formBaseUrl.value.trim() || formApiKey.value.trim()) formProvider.value = 'custom'
  },
  { immediate: true },
)

function resetForm() {
  editingId.value = null
  formOpen.value = false
  formProvider.value = ''
  formName.value = ''
  formApiKey.value = ''
  formBaseUrl.value = ''
  formSelectedModels.value = []
  formCandidates.value = []
  formPrimaryModel.value = ''
  savedEnabledModels.value = []
  formManualModel.value = ''
  modelRefreshSeq.value = 0
  // 草稿态刷新结果一并清空：取消后再开「添加供应商」是干净表单，不会带着上一次的候选/计数
  draftCandidates.value = []
  lastRefreshCount.value = null
  modelsRefresh.value = { kind: 'idle', text: '' }
  // 草稿里的模型配置改动与批量写入失败态同样清空（取消表单 = 放弃这次草稿）
  draftModelPatches.value = {}
  draftBatchFailure.value = null
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
  // 候选清单（上游有哪些模型）——**绝不再**把它当成「选中集合」：老代码 formSelectedModels = p.models
  // 正是本轮错乱的根因（刷新把 models 覆盖成 169 个之后，再进编辑就变成「全选」）
  formCandidates.value = Array.isArray(p.models) ? [...p.models] : []
  formPrimaryModel.value = p.model || ''
  savedEnabledModels.value = []
  // 已保存流程的「选中」一律以服务端 enabled 为准，草稿选中集合在这里不使用
  formSelectedModels.value = []
  formCandidates.value = []
  formPrimaryModel.value = ''
  savedEnabledModels.value = []
  formManualModel.value = ''
  modelRefreshSeq.value = 0
  // 草稿候选/计数退场：改由模型库面板按 providerId 接管
  draftCandidates.value = []
  lastRefreshCount.value = null
  formIsDefault.value = p.is_default
  formContextWindow.value = p.context_window != null ? String(p.context_window) : ''
  // 回显自定义供应商的协议格式（历史数据无 api_format 时默认 openai）
  formApiFormat.value = (p.api_format as AiApiFormat) || 'openai'
  formError.value = ''
}

/**
 * 手工添加模型名：
 * · 草稿态 → 加进草稿选中集合（保存时由 PUT /batch 写 enabled）；
 * · 已保存态 → 直接 PUT enabled=true（选中由服务端 enabled 落库，**不再**往 models 里塞）。
 */
async function addManualModel() {
  const m = formManualModel.value.trim()
  if (!m) return
  if (!editingId.value) {
    if (!formSelectedModels.value.includes(m)) formSelectedModels.value = [...formSelectedModels.value, m]
    formManualModel.value = ''
    return
  }
  if (savedEnabledModels.value.includes(m)) {
    formManualModel.value = ''
    return
  }
  addingModel.value = true
  try {
    const res = await putModelSetting(editingId.value, m, { enabled: true })
    if (res.ok) {
      formManualModel.value = ''
      toast.show(tf('ai_model_add_enabled', '已启用 {name}', { name: m }), 'success')
      // 重新拉取：该模型会以 enabled=true 出现在候选与列表里
      modelRefreshSeq.value += 1
    } else {
      toast.show(providerErrorText(res, t('ai_model_add_failed', '添加模型失败')), 'error')
    }
  } catch (e) {
    toast.show((e as Error)?.message || String(e), 'error')
  } finally {
    addingModel.value = false
  }
}

/**
 * 模型库面板回传的「已启用」集合（= 服务端 enabled）。**只用于计数展示**：
 * 它**不是** ai_providers.models（候选清单），保存时也不会被写进 models。
 */
function onEnabledModelsChange(list: string[]) {
  savedEnabledModels.value = [...list]
}

/** 草稿行「移除」：从已选集合里去掉该模型（草稿里改过的值仍留在 patch 里，勾回来即恢复） */
function onDraftRemoveModel(model: string) {
  formSelectedModels.value = formSelectedModels.value.filter((m) => m !== model)
}

/** 草稿态候选芯片 = 上游候选 ∪ 手工添加的模型（手工的也要可见、可点取消） */
const draftChipList = computed(() => {
  const out = [...draftCandidates.value]
  for (const m of formSelectedModels.value) if (!out.includes(m)) out.push(m)
  return out
})

/** 草稿态点击候选芯片：选中 / 取消（草稿语义 = 候选，默认一个都不选中） */
function toggleDraftModel(m: string) {
  const idx = formSelectedModels.value.indexOf(m)
  if (idx >= 0) formSelectedModels.value = formSelectedModels.value.filter((x) => x !== m)
  else formSelectedModels.value = [...formSelectedModels.value, m]
}

/** 草稿候选芯片的 tooltip（已选中/未选中，说清保存后的效果） */
function draftChipTitle(m: string): string {
  return formSelectedModels.value.includes(m)
    ? tf('ai_draft_chip_on_h', '{name}：已选中（保存后启用）', { name: m })
    : tf('ai_draft_chip_off_h', '{name}：未选中，点击选中', { name: m })
}

/** 「报了 N 个却渲染不出来」时的可见说明（绝不空白） */
const draftBrokenText = computed(() =>
  tf('ai_models_status_unreadable', '已获取 {n} 个模型，但当前无法展示：{reason}', {
    n: lastRefreshCount.value ?? 0,
    reason: t('ai_models_unreadable_reason', '响应里没有可识别的 models 列表'),
  }),
)

/**
 * 芯片区计数：「上游 N 个 · 已启用 M 个模型」；没刷新过就只显示已启用数。
 * 上游数用**刷新返回的数量**，与芯片渲染同一个 list —— 不会再出现两个互相矛盾的数。
 */
const modelsCountText = computed(() => {
  // 已保存态的「已启用」= 服务端 enabled（面板回传的镜像）；草稿态 = 草稿里勾选的模型
  const n = editingId.value ? savedEnabledModels.value.length : formSelectedModels.value.length
  const selected = tf('ai_models_selected_count', '已启用 {n} 个模型', { n })
  if (lastRefreshCount.value === null) return selected
  return tf('ai_models_upstream_count', '上游 {n} 个', { n: lastRefreshCount.value }) + ' · ' + selected
})

/**
 * 防御：刷新报了 N>0，但候选芯片一个都渲染不出来（数据形状不认识等）⇒ 必须给出可见说明，
 * **空白是最糟的结果**。正常路径不会命中（成功分支一定带非空 list）。
 */
const draftRenderBroken = computed(
  () => !editingId.value && (lastRefreshCount.value ?? 0) > 0 && draftChipList.value.length === 0,
)

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
  if (!payload) return tMsg(res.error) || fallback
  // 未保存预览时服务端不知道供应商名字：用表单里填的，让文案能说清"是哪个供应商"
  const enriched = { ...payload }
  if (!enriched.provider?.name && formName.value.trim()) {
    enriched.provider = { ...(enriched.provider || {}), name: formName.value.trim() }
  }
  // 容器 + 回环那条建议由服务端按**真实端口**生成（含可直接照做的替换地址），UI 原样展示，
  // 比本地通用模板更具体；服务端没带 message 时才回退到映射表文案。
  const serverMessage = String(enriched.message || '').trim()
  if (SERVER_MESSAGE_FIRST_CODES.has(String(enriched.code || '')) && serverMessage) return serverMessage
  if (hasAiFailureMapping(enriched)) return describeAiFailure(enriched, tf)
  // 未命中映射表：服务端的可读 message 优先于 error（后者可能是裸码/英文内部串，如
  // "PROVIDER_NOT_FOUND"、"Invalid provider"）—— 保证界面上不出现裸码。
  if (serverMessage) return serverMessage
  return tMsg(res.error) || fallback
}

// 刷新该供应商可用模型列表（上游 /models）。
// 有 key 就能拉列表，**不需要先保存**：
//   - 表单里填了 key（新增供应商，或刚改了 key / 地址）→ 直接用表单里的值走预览接口（不落库）；
//   - 编辑已保存的供应商、且没重输 key → 按 id 用库里已存的加密 key。
// 预览接口对 baseUrl 走与保存路径同一套 SSRF 校验（默认放行环回/私网/ULA 本地网关，
// 仍禁云元数据/链路本地、组播/广播/保留段、非 http(s)、带用户信息等；DNS 全解析逐个校验），
// 所以直连预览不会降低安全性。
// 按钮可否点：**provider 必填**（防线 ② —— 为空时不让点，配合自动纠偏从源头消掉这个坑）；
// 新增态还必须有 key；编辑态即使没重输 key 也能刷新（用库里的 key）。
const canRefreshModels = computed(
  () => !!formProvider.value && (!!editingId.value || formApiKey.value.trim().length > 0),
)

async function refreshModels() {
  if (refreshingModels.value) return
  // 防线 ②（兜底）：provider 为空时**一个请求都不发**。按钮本身已禁用（canRefreshModels），
  // 这里再拦一层并给出"该选什么"的人话，而不是等服务端回裸码 Invalid provider。
  if (!formProvider.value) {
    const need = t('ai_refresh_need_provider', '请先选择供应商；自定义网关请选 Custom')
    formError.value = need
    modelsRefresh.value = { kind: 'error', text: need }
    return
  }
  const typedKey = formApiKey.value.trim()
  if (!typedKey && !editingId.value) {
    formError.value = t('ai_api_key_required')
    return
  }
  refreshingModels.value = true
  formError.value = ''
  const stamp = () => new Date().toLocaleString()
  try {
    const res = typedKey
      ? await fetchProviderModels({
          provider: formProvider.value,
          apiKey: typedKey,
          baseUrl: formBaseUrl.value.trim() || undefined,
          apiFormat: isCustom.value ? formApiFormat.value : undefined,
        })
      : await getProviderModels(editingId.value as string)

    // ① 失败：**绝不显示"已刷新"**（本轮用户实测缺陷）。原因按 code 映射成人话（容器+回环那条
    //    由服务端 message 原样给出），就近持久显示 + 可重试；服务端失败时不会覆盖已存列表。
    if (!res.ok || !res.data) {
      const reason = providerErrorText(res, t('ai_models_refresh_fail'))
      // "已保留原列表 N 个"：优先用服务端回带的未改动列表（GET 路径会带）；草稿态预览失败时
      // 服务端没有"已存列表"，但表单里的启用集合同样一个都没被清，用它的数量如实说明。
      const serverKept = Array.isArray(res.data?.models) ? res.data!.models.length : 0
      const kept = serverKept > 0 ? serverKept : formSelectedModels.value.length
      modelsRefresh.value = {
        kind: 'error',
        text:
          kept > 0
            ? tf('ai_models_status_error_kept', '上次刷新 {time} 失败：{reason}（已保留原列表 {n} 个模型）', {
                time: stamp(),
                reason,
                n: kept,
              })
            : tf('ai_models_status_error', '上次刷新 {time} 失败：{reason}', { time: stamp(), reason }),
      }
      toast.show(reason, 'error')
      return
    }

    // ①b 响应形状不认识（200 但 models 不是数组）：既不假成功、也不留白 —— 用服务端报的数量
    //     如实说明「已获取 N 个但展示不了」并给出重试（本轮缺陷的姊妹形态：有数但看不见）。
    const payload = res.data as { models?: unknown; count?: number }
    const rawModels = payload.models
    if (!Array.isArray(rawModels)) {
      const reason = t('ai_models_unreadable_reason', '响应里没有可识别的 models 列表')
      modelsRefresh.value = {
        kind: 'error',
        text: tf('ai_models_status_unreadable', '已获取 {n} 个模型，但当前无法展示：{reason}', {
          n: typeof payload.count === 'number' ? payload.count : 0,
          reason,
        }),
      }
      toast.show(reason, 'error')
      return
    }
    const list = rawModels
      .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      .map((m) => m.trim())
    // ② 上游**合法**返回 0 个模型：不是成功 —— 按 warning 提示（用户实测就是因为这里弹了 success
    //    才一直发现不了问题），服务端已按契约把库里的列表更新为合法空列表。
    if (res.data.upstreamEmpty === true || list.length === 0) {
      lastRefreshCount.value = 0
      draftCandidates.value = []
      // 库里的 models 已按契约被更新为合法空列表 → 让模型库面板重新拉取，UI 不显示与库里不一致的旧列表
      if (editingId.value) modelRefreshSeq.value += 1
      modelsRefresh.value = {
        kind: 'empty',
        text: tf('ai_models_status_empty', '上次刷新 {time}：上游返回 0 个模型，请检查该网关是否提供 /v1/models', {
          time: stamp(),
        }),
      }
      toast.show(t('ai_models_refresh_empty'), 'warning')
      return
    }

    // ③ 成功且 N>0：added 由服务端按刷新前的已存列表算出（预览模式没给就只报总数）
    const added = typeof res.data.added === 'number' ? res.data.added : null
    // 计数用刷新真正返回的数量（与芯片渲染同一个 list）：失败/形状异常时不清它
    lastRefreshCount.value = list.length
    if (editingId.value) {
      // 已保存供应商：刷新**只更新候选清单**（服务端已把它写进 ai_providers.models）——
      // 绝不动 enabled / selected_models / 模型配置；面板随后重新拉一次 model-settings，
      // 于是高亮与下方列表保持刷新前的状态（候选芯片变成 169 个，其中原来那几个仍然高亮）。
      formCandidates.value = [...list]
      draftCandidates.value = []
      modelRefreshSeq.value += 1
    } else {
      // 草稿态（未保存）：没有 providerId，模型库面板无从渲染 ⇒ 立刻把候选芯片渲染出来，
      // 让用户「刷到了就能看见、点一下就选上」，不必先保存。
      draftCandidates.value = [...list]
    }
    modelsRefresh.value = {
      kind: 'success',
      text:
        added === null
          ? tf('ai_models_status_success', '上次刷新 {time}：共 {n} 个模型（新增 {added} 个）', {
              time: stamp(),
              n: list.length,
              added: list.length,
            })
          : tf('ai_models_status_success', '上次刷新 {time}：共 {n} 个模型（新增 {added} 个）', {
              time: stamp(),
              n: list.length,
              added,
            }),
    }
    toast.show(
      added === null
        ? tf('ai_models_refreshed_total', '已刷新，共 {n} 个模型', { n: list.length })
        : tf('ai_models_refreshed_n', '已刷新，新增 {added} 个模型（共 {n} 个）', { added, n: list.length }),
      'success',
    )
  } catch (e: any) {
    const reason = tMsg(e?.message) || String(e)
    modelsRefresh.value = {
      kind: 'error',
      text: tf('ai_models_status_error', '上次刷新 {time} 失败：{reason}', { time: stamp(), reason }),
    }
    toast.show(reason, 'error')
  } finally {
    refreshingModels.value = false
  }
}
/**
 * 草稿态保存时要落库的模型配置（PUT /batch）：
 *   · 「勾选」= 用户要启用它 ⇒ 每个勾选的模型都写 enabled:true（选中由**服务端 enabled** 承载，
 *     不再像老代码那样塞进 ai_providers.models）；
 *   · 另外只带上真正改过的字段（未改的字段不出现，避免把预设物化成「已自定义」）；
 *   · 未勾选的模型一个都不发（它们本来就不启用）。
 */
function buildDraftBatchItems(): ModelSettingBatchItem[] {
  const out: ModelSettingBatchItem[] = []
  for (const m of formSelectedModels.value) {
    out.push({ model: m, patch: { ...(draftModelPatches.value[m] ?? {}), enabled: true } })
  }
  return out
}

/** PUT /api/ai/model-settings/batch（超 200 条按契约分片）；返回是否全部成功，失败原因记在 draftBatchReason */
async function flushDraftBatch(providerId: string, items: ModelSettingBatchItem[]): Promise<boolean> {
  draftBatchApplying.value = true
  draftBatchReason.value = ''
  try {
    for (let i = 0; i < items.length; i += BATCH_MAX_ITEMS) {
      const res = await putModelSettingsBatch(providerId, items.slice(i, i + BATCH_MAX_ITEMS))
      if (!res.ok) {
        draftBatchReason.value = providerErrorText(res, t('ai_draft_batch_fail_default', '模型配置写入失败'))
        return false
      }
    }
    return true
  } catch (e) {
    draftBatchReason.value = (e as Error)?.message || String(e)
    return false
  } finally {
    draftBatchApplying.value = false
  }
}

/** 重试批量写入（供应商早已创建成功，这里只重发模型配置） */
async function retryDraftBatch() {
  const f = draftBatchFailure.value
  if (!f || draftBatchApplying.value) return
  const ok = await flushDraftBatch(f.providerId, f.items)
  if (!ok) {
    draftBatchFailure.value = { ...f, reason: draftBatchReason.value }
    return
  }
  toast.show(t('ai_draft_batch_ok', '模型配置已写入'), 'success')
  finishDraftSave(f.provider)
}

/** 放弃批量写入：如实说明，然后切到模型库让用户在里面逐个配置 */
function abandonDraftBatch() {
  const f = draftBatchFailure.value
  toast.show(t('ai_draft_batch_skipped', '已跳过模型配置写入，可在模型库里逐个配置'), 'warning')
  finishDraftSave(f?.provider ?? null)
}

/** 草稿流收尾：草稿退场 + 切「编辑刚保存的供应商」，让模型库（服务端数据）无缝接管 */
function finishDraftSave(fresh: AiProvider | null | undefined) {
  draftBatchFailure.value = null
  draftModelPatches.value = {}
  draftCandidates.value = []
  if (fresh) {
    startEdit(fresh)
    // 覆盖「保存后」路径：面板（编辑态）立刻重新拉取 model-settings
    modelRefreshSeq.value += 1
  } else {
    resetForm()
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
  // 新建必须有主模型（第一个选中的）；编辑不要求选中（选中由服务端 enabled 独立维护）
  const isCreate = !editingId.value
  if (isCreate && formSelectedModels.value.length === 0) {
    formError.value = t('ai_model_required')
    return
  }
  saving.value = true
  try {
    // ⚠️ model / models 的语义（别再混用，这是上一轮错乱的根因）：
    //   · model  = 主模型：新建取第一个选中的；编辑保持原主模型（不因候选清单变化而被改掉）。
    //   · models = **候选清单**（上游刷新出的全部模型）：新建用草稿刷新结果（没有就只放主模型），
    //              编辑保持原候选清单。**绝不**把选中集合写进 models —— 选中由服务端 enabled 承载
    //              （草稿里勾选的会在下面用 PUT /batch 落库）。
    const primary = isCreate
      ? formSelectedModels.value[0]
      : formPrimaryModel.value || formCandidates.value[0] || ''
    const candidates = isCreate
      ? draftCandidates.value.length > 0
        ? [...draftCandidates.value]
        : [primary]
      : [...formCandidates.value]
    const payload = {
      provider: formProvider.value,
      name: formName.value.trim(),
      apiKey: formApiKey.value || undefined,
      baseUrl: formBaseUrl.value.trim() || undefined,
      model: primary,
      models: candidates,
      isDefault: formIsDefault.value,
      contextWindow: formContextWindow.value ? Number(formContextWindow.value) : null,
      apiFormat: isCustom.value ? formApiFormat.value : undefined,
    }
    const res = isCreate ? await createProvider(payload) : await updateProvider(editingId.value as string, payload)
    if (res.ok) {
      toast.show(t('ai_saved'), 'success')
      // 通知 AI 侧边栏等其他消费方刷新 provider 列表
      //（AI 侧边栏默认只在 open=true 切换时 loadProviders，常驻打开时不刷新）
      window.dispatchEvent(new CustomEvent('clipsync:ai-providers-changed'))
      await load()
      // 保存成功**不再关表单**：切成「编辑该供应商」，让模型库无缝接管（草稿态的候选集合已写进 models）。
      // 之前这里 resetForm() 会把表单关掉，用户刚选好的模型立刻从眼前消失，还得重新找编辑入口。
      const saved = res.data
      const fresh = (saved && providers.value.find((p) => p.id === saved.id)) || saved
      const wasNew = !editingId.value
      const batchItems = wasNew ? buildDraftBatchItems() : []
      // 草稿 → 正式：先把草稿卡片里改过的模型配置一次性写进去（只提交改过的字段）
      if (wasNew && batchItems.length > 0 && fresh?.id) {
        const ok = await flushDraftBatch(fresh.id, batchItems)
        if (!ok) {
          // 供应商已创建（下面如实告知），但配置没写进去：就地在草稿里重试，**不**切编辑态、**不**丢草稿
          draftBatchFailure.value = {
            providerId: fresh.id,
            items: batchItems,
            reason: draftBatchReason.value,
            provider: fresh,
          }
          return
        }
      }
      finishDraftSave(fresh)
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
          <!-- 手工添加模型名（上游 /models 未列出 / 想先填一个）：加入启用集合 -->
          <div class="ai-model-add">
            <Input v-model="formManualModel" :placeholder="t('ai_model_ph')" @keydown.enter.prevent="addManualModel" />
            <Button
              size="sm"
              variant="outline"
              class="shrink-0 whitespace-nowrap"
              :disabled="!formManualModel.trim() || addingModel"
              @click="addManualModel"
            >
              {{ t('ai_model_add', '添加') }}
            </Button>
          </div>
          <div class="ai-models-hint">{{ t('ai_models_hint') }}</div>
          <div class="ai-models-actions">
            <Button
              size="sm"
              variant="outline"
              class="min-w-[100px]"
              :disabled="refreshingModels || !canRefreshModels"
              :title="!formProvider ? t('ai_refresh_need_provider', '请先选择供应商；自定义网关请选 Custom') : ''"
              @click="refreshModels"
            >
              <RefreshCw v-if="!refreshingModels" :size="12" />
              {{ refreshingModels ? t('ai_refreshing') : t('ai_refresh_models') }}
            </Button>
            <!-- 计数用**刷新返回的数量**：不会再出现「报了 159 个但页面空」 -->
            <span class="ai-models-count">{{ modelsCountText }}</span>
          </div>

          <!-- 防线 ②：provider 为空时把"为什么点不了 + 该选什么"直接写在按钮下面，
               而不是等用户点了才弹一句裸码「Invalid provider」（用户实测就是这么被带沟里的） -->
          <div v-if="!formProvider" class="ai-refresh-need-provider">
            {{ t('ai_refresh_need_provider', '请先选择供应商；自定义网关请选 Custom') }}
          </div>

          <!-- 刷新结果**持久**提示（就近显示，不依赖一闪而过的 toast）：用户实测反馈"toast 弹了已刷新，
               但一个模型都没刷出来"。三态：success / empty（上游合法返回 0 个）/ error（原因 + 重试） -->
          <div
            v-if="modelsRefresh.kind !== 'idle'"
            class="ai-refresh-status"
            :class="`ai-refresh-status--${modelsRefresh.kind}`"
          >
            <span class="ai-refresh-status-text">{{ modelsRefresh.text }}</span>
            <button
              v-if="modelsRefresh.kind === 'error'"
              type="button"
              class="ai-refresh-status-retry"
              :disabled="refreshingModels"
              @click="refreshModels"
            >
              {{ t('retry', '重试') }}
            </button>
          </div>

          <!-- 草稿态（未保存）刷新出来的**候选**模型：立刻可见、点一下就选中，不必先保存。
               本轮缺陷：这里以前一个芯片都没有，用户刷出 159 个却看不到任何模型。 -->
          <div v-if="!editingId && (draftChipList.length > 0 || draftRenderBroken)" class="ai-draft-models">
            <div class="ai-draft-models-head">{{ t('ai_draft_models_title', '候选模型（草稿态，默认不选中）') }}</div>
            <div v-if="draftChipList.length" class="ai-draft-chips">
              <button
                v-for="m in draftChipList"
                :key="m"
                type="button"
                class="ai-draft-chip"
                :class="{ on: formSelectedModels.includes(m) }"
                :data-model="m"
                :title="draftChipTitle(m)"
                @click="toggleDraftModel(m)"
              >
                {{ m }}
              </button>
            </div>
            <!-- 绝不空白：报了数量却渲染不出来时，给出可见说明 + 重试 -->
            <div v-else class="ai-draft-models-broken">
              {{ draftBrokenText }}
              <button type="button" class="ai-refresh-status-retry" :disabled="refreshingModels" @click="refreshModels">
                {{ t('retry', '重试') }}
              </button>
            </div>
            <div class="ai-draft-models-hint">
              {{ t('ai_draft_models_hint', '点一下选中 / 取消；保存后即可逐个配置这些模型的上下文、多模态与推理协议。') }}
            </div>
          </div>

          <!-- 模型库：单排胶囊（启用/停用）+ 行内图标操作（自检/配置/停用/清除自定义值）+ 折叠分组 -->
          <AIModelSettingsPanel
            v-if="editingId"
            :provider-id="editingId"
            :models="savedEnabledModels"
            :refresh-seq="modelRefreshSeq"
            @update:enabled-models="onEnabledModelsChange"
          />
          <!-- 草稿态：模型库面板以 draft-mode 渲染 —— 勾选候选模型即出配置卡片
               （POST /resolve 只读解析预设值，不落库；没有 providerId 就绝不打 model-settings），
               改动先记在草稿里，点保存时用 PUT /batch 一次性落库 -->
          <template v-else>
            <AIModelSettingsPanel
              draft-mode
              :draft-models="formSelectedModels"
              :draft-patches="draftModelPatches"
              @update:draft-patches="draftModelPatches = $event"
              @remove-draft-model="onDraftRemoveModel"
            />

            <!-- 批量写入失败：供应商已保存（如实告知）+ 可就地重试，绝不谎报「配置已存」 -->
            <div v-if="draftBatchFailure" class="ai-draft-batch-fail">
              <span class="ai-draft-batch-fail-text">
                {{
                  tf('ai_draft_batch_fail', '供应商已保存，但模型配置写入失败：{reason}', {
                    reason: draftBatchFailure.reason,
                  })
                }}
              </span>
              <Button
                size="sm"
                class="shrink-0 whitespace-nowrap"
                data-action="draft-batch-retry"
                :disabled="draftBatchApplying"
                @click="retryDraftBatch"
              >
                {{ draftBatchApplying ? t('ai_draft_batch_applying', '正在写入…') : t('retry', '重试') }}
              </Button>
              <Button
                size="sm"
                variant="outline"
                class="shrink-0 whitespace-nowrap"
                data-action="draft-batch-skip"
                :disabled="draftBatchApplying"
                @click="abandonDraftBatch"
              >
                {{ t('ai_draft_batch_use_library', '去模型库配置') }}
              </Button>
            </div>

            <div class="ai-draft-cfg">
              <span class="ai-draft-cfg-text">
                {{ t('ai_model_cfg_need_save', '勾选候选模型即可在下方卡片里直接配置；改动会在点「保存」时一次性写入（只提交你改过的字段）。') }}
              </span>
              <Button
                size="sm"
                class="ai-draft-cfg-save shrink-0 whitespace-nowrap"
                data-action="draft-save"
                :disabled="saving"
                @click="save"
              >
                {{ saving ? t('ai_saving') : t('ai_save') }}
              </Button>
            </div>
          </template>
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
/* 手工添加模型：输入框 + 添加按钮同一行 */
.ai-model-add {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 草稿态候选芯片：上游刷出来的模型立刻可见（默认不选中，点一下选中） */
.ai-draft-models {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface, transparent);
}
.ai-draft-models-head {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.ai-draft-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
}
.ai-draft-chip {
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
}
.ai-draft-chip:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.ai-draft-chip.on {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 500;
}
.ai-draft-models-hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-tertiary);
}
.ai-draft-models-broken {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--danger);
}
/* 草稿态配置降级：说明 + 就近保存按钮 */
.ai-draft-cfg {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-hover);
}
.ai-draft-cfg-text {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-secondary);
}
/* 草稿 → 正式：批量写模型配置失败时的就近提示（供应商已保存这件事如实写在文案里） */
.ai-draft-batch-fail {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}
.ai-draft-batch-fail-text {
  flex: 1;
  min-width: 220px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--danger);
}
.ai-draft-cfg-save {
  height: 32px;
  padding: 0 14px;
}
.ai-models-hint {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 6px;
}
.ai-models-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.ai-models-count {
  font-size: 11.5px;
  color: var(--text-tertiary);
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

/* 防线 ②：provider 为空时按钮下方的就近提示（"为什么点不了 + 该选什么"） */
.ai-refresh-need-provider {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--warning);
}
/* ===== 刷新模型列表：结果就地持久显示 =====
 * 用户实测："toast 说刷新成功，但一个模型都没刷出来"。toast 一闪而过，失败/空列表必须在按钮
 * 下方留得住；失败时给"重试"。三态配色：成功=次要文字、空列表=警告色、失败=危险色。 */
.ai-refresh-status {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
}
.ai-refresh-status-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.ai-refresh-status--success .ai-refresh-status-text {
  color: var(--text-secondary);
}
.ai-refresh-status--empty .ai-refresh-status-text {
  color: var(--warning);
}
.ai-refresh-status--error .ai-refresh-status-text {
  color: var(--danger);
}
.ai-refresh-status-retry {
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  background: transparent;
  color: var(--danger);
  font-size: 11.5px;
  cursor: pointer;
}
.ai-refresh-status-retry:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
