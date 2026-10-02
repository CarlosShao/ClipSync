<script setup lang="ts">
// === 模型库面板（设置 → AI → 供应商编辑 → 模型）===
// 用户实测第一版（上下两排标签 + 单排「配置」按钮）后的重构：
//   1. 单排胶囊 + 选中态：刷新出来的全部模型在一行（可换行），已启用 = accent 高亮 + ✓，未启用 = 灰置；
//      点击胶囊 = 切换 enabled（乐观更新 + 失败回滚）。取消启用 = 同一件事（enabled=false），
//      **不是删除**：配置与自定义值一律留库，再点一下即可恢复。
//   2. 「不适用对话」分组折叠：applicability !== 'chat'（音频合成/识别、图像编辑、嵌入…）默认折叠、
//      默认不启用，展开后可手动启用。
//   3. 行操作图标化（右侧四个图标 + tooltip）：[自检][配置][启用/停用][清除自定义值]。
//   4. 逻辑停用/恢复语义见 1；任何文案都不暗示"数据被删"。
//   5. 刷新后一次性智能建议条（非阻断）：新模型里适合对话的默认勾选，不适合的折叠；三个动作可选。
//   6. 能力自检：调 POST /probe 真实打一次上游 → ✅可用（耗时）/ ⚠️不支持该推理参数（一键改协议）/
//      ❌不可用（原样展示上游错误码与文案）。**绝不自动触发**。
//   7. 别名（≤80，空 = 用原名）+ 拖拽排序（写 sortOrder，决定聊天模型选择器顺序）。
//   8. 配置弹窗逐字段显示「来自预设 / 你改过」+ 单项恢复图标；整模型「恢复预设」保留。
//   9. 搜索 + 只看已启用 / 只看对话模型筛选。
//  10. 面板只读 props.models 作为"服务端未给 enabled 时"的兜底，并把启用集合 emit 回父组件，
//      因此打开/关闭/配置都不会弄丢父组件的模型多选，供应商保存的 models 也保持一致。
//
// 契约：src/desktop/src/api/modelSettings.ts（v3）。服务端 v3 未就绪时的降级：
//   · GET 不带 enabled/alias/sortOrder/applicability → 启用态回落到父组件已选集合、用途按模型名本地推断，
//     并在面板顶部如实提示"该服务端的契约较旧，这些字段可能不会被保存"。
//   · POST /probe 404 → 行内如实显示接口错误，不伪造"可用"。
//
// 动效：本组件不引入任何过渡/关键帧（0 动画天然满足 reduce-motion）；弹窗动画来自既有
// ModalDialog（≤150ms，globals.css 的 reduce-motion 会压掉）。
import { computed, ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import Input from '@/components/ui/input/Input.vue'
import Switch from '@/components/ui/switch/Switch.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'
import Button from '@/components/ui/button/Button.vue'
import {
  Activity,
  Check,
  ChevronRight,
  ChevronUp,
  Eraser,
  GripVertical,
  Pencil,
  Power,
  RotateCcw,
  Settings2,
  X,
} from 'lucide-vue-next'
import {
  ALIAS_MAX_LEN,
  APPLICABILITY_LABELS,
  APPLICABILITY_LABEL_KEYS,
  BATCH_MAX_ITEMS,
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  MAX_OUTPUT_MAX,
  MAX_OUTPUT_MIN,
  REASONING_PROTOCOLS,
  REASONING_PROTOCOL_LABELS,
  REASONING_PROTOCOL_LABEL_KEYS,
  RESTORABLE_FIELDS,
  RESTORE_PRESET_PATCH,
  defaultModelSetting,
  getModelSettings,
  isChatApplicable,
  isValidTokenCount,
  modelDisplayName,
  normalizeModelSettingItem,
  normalizeReasoningProtocol,
  probeModelSetting,
  probeStateOf,
  putModelSetting,
  putModelSettingsBatch,
  resolveModelSettings,
  restoreFieldPatch,
  type ModelApplicability,
  type ModelSettingField,
  type ModelSettingItem,
  type ModelSettingPatch,
  type ProbeResult,
  type ReasoningProtocol,
} from '@/api/modelSettings'

const props = defineProps<{
  /** 已保存的供应商 id（uuid）；草稿态没有 id（此时走 draft-mode） */
  providerId?: string
  /** 父组件当前的已选模型（服务端未下发 enabled 时的兜底 + 手工添加的模型） */
  models?: string[]
  /** 父组件每次刷新模型列表成功后 +1：面板据此重新拉取并给出一次性智能建议 */
  refreshSeq?: number
  /**
   * 草稿态（供应商还没保存）：用 POST /resolve 只读解析预设值 + 本地 patch 记改动，
   * **绝不**触碰 GET/PUT /api/ai/model-settings（没有 providerId，打了只会 404/无意义）。
   * 勾选即出卡片；点保存时由父组件用 PUT /batch 一次性落库。
   */
  draftMode?: boolean
  /** 草稿态勾选的模型（顺序即卡片顺序） */
  draftModels?: string[]
  /** 草稿态本地改动（per model，只含用户真改过的字段）；保存时父组件用它做 batch */
  draftPatches?: Record<string, ModelSettingPatch>
}>()

const emit = defineEmits<{
  'update:enabledModels': [string[]]
  'update:draftPatches': [Record<string, ModelSettingPatch>]
  /** 草稿行「移除」：父组件把该模型从已选集合里去掉（草稿 patch 保留，勾回来即恢复） */
  removeDraftModel: [string]
}>()

const { t, tf } = useI18n()
const toast = useSonner()

const items = ref<ModelSettingItem[]>([])
const loading = ref(false)
/** 非空 = 接口不可用/读取失败（如实展示，不伪造预设值） */
const loadError = ref('')

/**
 * 失败文案：**服务端的可读 message 优先**，再退回 error / HTTP 状态。
 * 服务端 model-settings / probe 这条线用的是 `{ error: 'PROVIDER_NOT_FOUND', message: '供应商不存在' }`
 * 形状 —— 直接渲染 res.error 会把裸码（PROVIDER_NOT_FOUND / NO_API_KEY / INVALID_MODEL）甩给用户。
 */
function apiErrorText(res: { error?: string; status: number; data?: unknown }, fallback: string): string {
  const msg = String((res.data as { message?: string } | undefined)?.message || '').trim()
  return msg || res.error || fallback
}
/** 服务端未下发 v3 字段（enabled/alias/sortOrder）→ 顶部如实提示 */
const v3Missing = ref(false)

/** 本地乐观覆盖：model → enabled（服务端未确认前先用它渲染；失败回滚） */
const enabledOverrides = ref<Record<string, boolean>>({})
/** 在途请求（按模型）：驱动按钮 loading/禁用，避免重复提交 */
const applying = ref<Record<string, boolean>>({})
/** 能力自检结果（按模型） */
const probeResults = ref<Record<string, ProbeResult>>({})
const probing = ref<Record<string, boolean>>({})
/** 已按自检建议改过协议的模型（只收起"一键改协议"按钮，⚠️ 状态保留到重新自检） */
const protocolApplied = ref<Record<string, boolean>>({})
/** 本会话内我们写过哪些"预设类"字段（逐字段来源的本地判据） */
const touchedFields = ref<Record<string, string[]>>({})

// 搜索与筛选
const search = ref('')
const onlyEnabled = ref(false)
const onlyChat = ref(false)
// 不适用对话分组：默认折叠（搜索时自动展开，避免命中结果被藏起来）
const nonChatOpen = ref(false)

// 刷新后的智能建议（一次性）
const suggestion = ref<{ all: string[]; chat: string[]; nonChat: string[] } | null>(null)
const SUGGEST_KEY = 'clipsync-model-suggest-dismissed'
function isSuggestionDismissed(): boolean {
  try {
    return sessionStorage.getItem(`${SUGGEST_KEY}:${props.providerId}`) === '1'
  } catch {
    return false
  }
}
function persistSuggestionDismissed() {
  try {
    sessionStorage.setItem(`${SUGGEST_KEY}:${props.providerId}`, '1')
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

// 配置弹窗
const editingModel = ref<string | null>(null)
const draft = ref<Draft>(emptyDraft())
const baseline = ref<Draft>(emptyDraft())
const modalError = ref('')
const saving = ref(false)

// 别名行内编辑 / 拖拽排序
const aliasEditing = ref<string | null>(null)
const aliasDraft = ref('')
const dragFrom = ref<string | null>(null)

/* ===================== 草稿态（供应商还没保存）：勾选即出卡片 =====================
 * 数据来自 POST /api/ai/model-settings/resolve（只读、不落库）：勾选一个模型 → 只把**新增**的
 * 模型名批量发过去 → 立刻在下方渲染该模型的配置卡片；改动只记在本地 patch（父组件保存时用
 * PUT /api/ai/model-settings/batch 一次性落库）。本模式下**绝不**调用 GET/PUT /api/ai/model-settings。
 */
const isDraft = computed(() => props.draftMode === true)
/** 草稿态勾选的模型（顺序即卡片顺序） */
const draftModelList = computed(() => (props.draftMode ? (props.draftModels ?? []) : []))

const draftItems = ref<ModelSettingItem[]>([])
/** per-model 表单状态：卡片首次出现时用「预设值 + 已有草稿 patch」初始化（取消勾选再勾回来不丢改动） */
const draftForms = ref<Record<string, Draft>>({})
const draftAlias = ref<Record<string, string>>({})
const draftLoading = ref(false)
const draftError = ref('')
/** 已解析过的模型名（增量判据：只发新增的，不每次点击都全量重拉） */
const draftResolved = ref<string[]>([])

const draftItemMap = computed(() => {
  const map = new Map<string, ModelSettingItem>()
  for (const it of draftItems.value) map.set(it.model, it)
  return map
})

/** 卡片条目：resolve 结果，缺了就用本地占位（卡片照常渲染，绝不空白） */
const draftCards = computed<ModelSettingItem[]>(() =>
  draftModelList.value.map((m) => draftItemMap.value.get(m) ?? defaultModelSetting(m)),
)

function upsertDraftItem(item: ModelSettingItem) {
  const idx = draftItems.value.findIndex((i) => i.model === item.model)
  const next = [...draftItems.value]
  if (idx < 0) next.push(item)
  else next[idx] = item
  draftItems.value = next
}

/** 把已有草稿 patch 叠加到表单上（"取消勾选再勾回来保留改动"就靠它） */
function applyPatchToForm(form: Draft, patch: ModelSettingPatch) {
  if ('contextWindow' in patch) form.contextWindow = patch.contextWindow == null ? '' : String(patch.contextWindow)
  if ('maxOutput' in patch) form.maxOutput = patch.maxOutput == null ? '' : String(patch.maxOutput)
  if (typeof patch.supportsText === 'boolean') form.supportsText = patch.supportsText
  if (typeof patch.supportsImage === 'boolean') form.supportsImage = patch.supportsImage
  if (typeof patch.supportsVideo === 'boolean') form.supportsVideo = patch.supportsVideo
  if (typeof patch.supportsAudio === 'boolean') form.supportsAudio = patch.supportsAudio
  if (typeof patch.reasoningEnabled === 'boolean') form.reasoningEnabled = patch.reasoningEnabled
  if (patch.reasoningProtocol) form.reasoningProtocol = normalizeReasoningProtocol(patch.reasoningProtocol)
}

function ensureDraftForm(model: string) {
  if (draftForms.value[model]) return
  const item = draftItemMap.value.get(model) ?? defaultModelSetting(model)
  const form = draftFromItem(item)
  const patch = props.draftPatches?.[model]
  if (patch) applyPatchToForm(form, patch)
  draftForms.value = { ...draftForms.value, [model]: form }
  if (draftAlias.value[model] === undefined) {
    draftAlias.value = { ...draftAlias.value, [model]: `${patch?.alias ?? item.alias ?? ''}` }
  }
}

/** 某张卡的当前表单（没有就按条目现算一份，保证渲染不空） */
function draftForm(model: string): Draft {
  return draftForms.value[model] ?? draftFromItem(draftItemMap.value.get(model) ?? defaultModelSetting(model))
}

/** 增量解析：只把**新增**的模型名一次性发过去 */
async function loadDraftItems() {
  const pending = draftModelList.value.filter((m) => !draftResolved.value.includes(m))
  if (pending.length === 0) return
  draftLoading.value = true
  draftError.value = ''
  try {
    const res = await resolveModelSettings(pending)
    if (res.ok && res.data) {
      for (const raw of res.data.items || []) upsertDraftItem(normalizeModelSettingItem(raw))
      draftResolved.value = [...draftResolved.value, ...pending]
      for (const m of pending) {
        // 服务端没回的模型（未知模型）也标记已解析 + 本地占位，避免每次点击重复请求
        if (!draftItemMap.value.has(m)) upsertDraftItem(defaultModelSetting(m))
        ensureDraftForm(m)
      }
    } else {
      draftError.value = apiErrorText(res, t('ai_draft_resolve_fail', '无法读取该模型的预设配置'))
    }
  } catch (e) {
    draftError.value = String((e as Error)?.message || e)
  } finally {
    draftLoading.value = false
  }
}

function retryDraftResolve() {
  draftResolved.value = []
  void loadDraftItems()
}

function isCtxValid(form: Draft): boolean {
  const v = form.contextWindow.trim()
  return v === '' || isValidTokenCount(v, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX)
}

function isOutValid(form: Draft): boolean {
  const v = form.maxOutput.trim()
  return v === '' || isValidTokenCount(v, MAX_OUTPUT_MIN, MAX_OUTPUT_MAX)
}

/** 卡片上的就地校验（非法字段不进 patch，避免整批 400；提示里说明"不会被写入"） */
function draftCardErrors(model: string): string[] {
  const form = draftForm(model)
  const errs: string[] = []
  if (!isCtxValid(form)) {
    errs.push(
      tf('ai_model_cfg_err_context', '上下文窗口需为 {min} ~ {max} 之间的整数', {
        min: CONTEXT_WINDOW_MIN,
        max: CONTEXT_WINDOW_MAX,
      }),
    )
  }
  if (!isOutValid(form)) {
    errs.push(
      tf('ai_model_cfg_err_output', '最大输出需为 {min} ~ {max} 之间的整数', {
        min: MAX_OUTPUT_MIN,
        max: MAX_OUTPUT_MAX,
      }),
    )
  }
  if ((draftAlias.value[model] ?? '').trim().length > ALIAS_MAX_LEN) {
    errs.push(tf('ai_model_alias_too_long', '别名最长 {max} 个字符', { max: ALIAS_MAX_LEN }))
  }
  return errs
}

/**
 * 该模型相对**预设值**改过的字段：只含真改过的（未改的不出现 ⇒ 不会把预设物化成"已自定义"）。
 * 非法数字字段被跳过（由 draftCardErrors 就地提示，绝不静默提交非法值）。
 */
function draftPatchOf(model: string): ModelSettingPatch {
  const item = draftItemMap.value.get(model) ?? defaultModelSetting(model)
  const form = draftForm(model)
  const patch: ModelSettingPatch = {}
  if (isCtxValid(form)) {
    const ctx = form.contextWindow.trim()
    const base = item.contextWindow == null ? '' : String(item.contextWindow)
    if (ctx !== base) patch.contextWindow = ctx === '' ? null : Number(ctx)
  }
  if (isOutValid(form)) {
    const out = form.maxOutput.trim()
    const base = item.maxOutput == null ? '' : String(item.maxOutput)
    if (out !== base) patch.maxOutput = out === '' ? null : Number(out)
  }
  for (const f of ['supportsText', 'supportsImage', 'supportsVideo', 'supportsAudio', 'reasoningEnabled'] as const) {
    if (form[f] !== item[f]) patch[f] = form[f]
  }
  if (form.reasoningProtocol !== item.reasoningProtocol) patch.reasoningProtocol = form.reasoningProtocol
  const alias = (draftAlias.value[model] ?? '').trim()
  if (alias !== (item.alias ?? '') && alias.length <= ALIAS_MAX_LEN) patch.alias = alias
  return patch
}

/** 字段是否有草稿改动（驱动"来源"徽标与单项恢复按钮的可用性） */
function draftFieldChanged(model: string, field: ModelSettingField): boolean {
  return field in draftPatchOf(model)
}

function draftFieldSource(model: string, field: ModelSettingField): FieldSource {
  return draftFieldChanged(model, field) ? 'pending' : 'preset'
}

/** 把当前勾选模型的 patch 汇总给父组件（未勾选模型的旧 patch 保留 ⇒ 重勾能恢复改动） */
function syncDraftPatches() {
  const next = { ...(props.draftPatches || {}) }
  for (const m of draftModelList.value) {
    const p = draftPatchOf(m)
    if (Object.keys(p).length > 0) next[m] = p
    else delete next[m]
  }
  emit('update:draftPatches', next)
}

function setDraftField(model: string, field: keyof Draft, value: string | boolean) {
  ensureDraftForm(model)
  draftForms.value = { ...draftForms.value, [model]: { ...draftForm(model), [field]: value } as Draft }
  syncDraftPatches()
}

function setDraftAlias(model: string, value: string) {
  ensureDraftForm(model)
  draftAlias.value = { ...draftAlias.value, [model]: value }
  syncDraftPatches()
}

/** 单项恢复（草稿）：把该字段退回预设值 */
function resetDraftField(model: string, field: ModelSettingField) {
  const item = draftItemMap.value.get(model) ?? defaultModelSetting(model)
  const fresh = draftFromItem(item)
  if (field in fresh) {
    setDraftField(model, field as keyof Draft, (fresh as unknown as Record<string, string | boolean>)[field])
  }
}

/** 整卡恢复（草稿）：清空这个模型的全部草稿改动 */
function resetDraftCard(model: string) {
  const item = draftItemMap.value.get(model) ?? defaultModelSetting(model)
  draftForms.value = { ...draftForms.value, [model]: draftFromItem(item) }
  draftAlias.value = { ...draftAlias.value, [model]: item.alias ?? '' }
  syncDraftPatches()
}

/* ---------- 草稿行的折叠/展开（纯 UI 状态，不写库） ---------- */

/** 每行的展开状态：默认**全部收起**（多个模型时只显示一行行概要，不摊开一堆表单） */
const draftExpanded = ref<Record<string, boolean>>({})

function draftIsExpanded(model: string): boolean {
  return draftExpanded.value[model] === true
}

function toggleDraftExpanded(model: string) {
  draftExpanded.value = { ...draftExpanded.value, [model]: !draftIsExpanded(model) }
}

/** 该模型是否有本地草稿改动（徽标 / 摘要 / 按钮可用性都用它） */
function draftHasPatch(model: string): boolean {
  return Object.keys(draftPatchOf(model)).length > 0
}

/**
 * 把草稿 patch 叠加到 resolve 条目上 —— 概要行的**摘要与徽标必须如实反映你改过的值**
 * （例如把上下文改成 128000 后收起，摘要就显示 128000，而不是仍显示预设的 200000）。
 */
function effectiveDraftItem(model: string): ModelSettingItem {
  const base = draftItemMap.value.get(model) ?? defaultModelSetting(model)
  const patch = draftPatchOf(model)
  if (Object.keys(patch).length === 0) return base
  const out: ModelSettingItem = { ...base, isOverridden: true }
  if ('contextWindow' in patch) out.contextWindow = patch.contextWindow ?? null
  if ('maxOutput' in patch) out.maxOutput = patch.maxOutput ?? null
  if (typeof patch.supportsText === 'boolean') out.supportsText = patch.supportsText
  if (typeof patch.supportsImage === 'boolean') out.supportsImage = patch.supportsImage
  if (typeof patch.supportsVideo === 'boolean') out.supportsVideo = patch.supportsVideo
  if (typeof patch.supportsAudio === 'boolean') out.supportsAudio = patch.supportsAudio
  if (typeof patch.reasoningEnabled === 'boolean') out.reasoningEnabled = patch.reasoningEnabled
  if (patch.reasoningProtocol) out.reasoningProtocol = normalizeReasoningProtocol(patch.reasoningProtocol)
  if ('alias' in patch) out.alias = patch.alias && String(patch.alias).trim() !== '' ? String(patch.alias) : null
  return out
}

/** 草稿行徽标：本地改过 ⇒ 已自定义；否则按 resolve 条目（预设 / 无预设） */
function draftSourceLabel(model: string): string {
  return draftHasPatch(model) ? t('ai_model_cfg_badge_overridden', '已自定义') : sourceLabel(effectiveDraftItem(model))
}

function draftSourceClass(model: string): string {
  return draftHasPatch(model) ? 'aim-badge--custom' : sourceClass(effectiveDraftItem(model))
}

/** 草稿行「移除」：交给父组件从已选集合里去掉（草稿 patch 保留 ⇒ 勾回来即恢复） */
function removeDraftModel(model: string) {
  emit('removeDraftModel', model)
}

/* ===================== 列表 / 排序 / 启用态 ===================== */

const itemMap = computed(() => {
  const map = new Map<string, ModelSettingItem>()
  for (const it of items.value) map.set(it.model, it)
  return map
})

/** 服务端条目 ∪ 父组件已选（手工添加 / GET 尚未返回的模型）；有 sortOrder 的按它排序（稳定） */
const allItems = computed<ModelSettingItem[]>(() => {
  const list = [...items.value]
  const seen = new Set(list.map((i) => i.model))
  for (const m of props.models ?? []) {
    if (!seen.has(m)) {
      list.push(defaultModelSetting(m))
      seen.add(m)
    }
  }
  return list
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      const av = a.item.sortOrder
      const bv = b.item.sortOrder
      if (av == null && bv == null) return a.idx - b.idx
      if (av == null) return 1
      if (bv == null) return -1
      return av === bv ? a.idx - b.idx : av - bv
    })
    .map((x) => x.item)
})

function isEnabled(item: ModelSettingItem): boolean {
  const ov = enabledOverrides.value[item.model]
  if (ov !== undefined) return ov
  /**
   * **只信服务端**：契约 v3+ 每个条目都会下发 enabled（服务端已把默认值定为 false ——
   * 没有配置行且不在 selected_models 里就是"未启用"）。
   * 因此这里**不做任何本地推断**：
   *   · 不再回落到"父组件已选集合"（那是契约 v2 时代的兜底，会把"没有行"误当成已启用）；
   *   · 字段缺失（旧服务端）一律按 **false** 渲染。
   */
  return item.enabledFromServer ? item.enabled : false
}

const searchActive = computed(() => search.value.trim() !== '')
const filteredItems = computed(() => {
  const q = search.value.trim().toLowerCase()
  return allItems.value.filter((it) => {
    if (onlyEnabled.value && !isEnabled(it)) return false
    if (onlyChat.value && !isChatApplicable(it)) return false
    if (!q) return true
    return it.model.toLowerCase().includes(q) || (it.alias || '').toLowerCase().includes(q)
  })
})
const chatItems = computed(() => filteredItems.value.filter(isChatApplicable))
const nonChatItems = computed(() => filteredItems.value.filter((it) => !isChatApplicable(it)))
const nonChatAllCount = computed(() => allItems.value.filter((it) => !isChatApplicable(it)).length)
/** 非对话组：手动展开 or 正在搜索（搜索结果不能被折叠吞掉） */
const nonChatExpanded = computed(() => nonChatOpen.value || searchActive.value)
/** 非对话组里实际出现的用途（用于写清"为什么不适合对话"） */
const nonChatWhy = computed(() => {
  const kinds = new Set<ModelApplicability>()
  for (const it of allItems.value) if (!isChatApplicable(it)) kinds.add(it.applicability)
  return [...kinds].map((k) => t(APPLICABILITY_LABEL_KEYS[k], APPLICABILITY_LABELS[k])).join(' · ')
})

/** 已启用集合（按面板顺序）→ 同步回父组件，保证供应商保存的 models 与之一致 */
const enabledModels = computed(() => allItems.value.filter(isEnabled).map((i) => i.model))
/** 首次加载完成前不往外同步（否则 items 还是空的，会把父组件已选集合清空） */
const loadedOnce = ref(false)

function syncEnabledToParent(list: string[]) {
  /**
   * 服务端没下发 enabled（旧契约）时**不往回同步**：那种情况下 isEnabled 一律按 false 渲染，
   * 若照此回写会把父组件已保存的模型列表清空（数据损失）。宁可不同步，也不猜。
   */
  if (!items.value.some((i) => i.enabledFromServer)) return
  const prev = props.models ?? []
  if (list.length === prev.length && list.every((m, i) => m === prev[i])) return
  emit('update:enabledModels', list)
}

watch(enabledModels, (list) => {
  if (!loadedOnce.value) return
  syncEnabledToParent(list)
})

const enabledCount = computed(() => enabledModels.value.length)

/* ===================== 数据加载 ===================== */

/** 本轮之前已知的模型名：用于判定"刷新出来的新模型" */
let knownModels = new Set<string>()

async function load(opts: { announceNew?: boolean } = {}) {
  if (!props.providerId) return
  loading.value = true
  loadError.value = ''
  try {
    const res = await getModelSettings(props.providerId)
    if (res.ok && res.data) {
      const normalized = (res.data.items || []).map((i) => normalizeModelSettingItem(i))
      items.value = normalized
      v3Missing.value = normalized.length > 0 && !normalized.some((i) => i.enabledFromServer)
      if (opts.announceNew) {
        // 只读：刷新只更新"上游有哪些模型"，绝不改任何 enabled / selected_models / 模型配置
        announceNewModels(normalized)
      } else {
        for (const i of normalized) knownModels.add(i.model)
      }
      loadedOnce.value = true
      // 首次加载完成后把"真实启用集合"同步给父组件（服务端的 enabled 是权威来源）
      syncEnabledToParent(enabledModels.value)
    } else {
      loadError.value = apiErrorText(res, `HTTP ${res.status}`)
    }
  } catch (e) {
    loadError.value = String((e as Error)?.message || e)
  } finally {
    loading.value = false
  }
}

/**
 * 刷新后**只**给出一次性建议 —— 绝不写库。
 *
 * 历史教训（用户实测炸过）：v3 曾把方案里的「M 个适合对话（已勾选）」**照字面实现**成
 * "刷新后自动把新发现的对话模型置 enabled=true"。那会真的写库（ai_model_settings.enabled /
 * ai_settings.selected_models）：用户编辑已保存供应商、刷新出 169 个模型，瞬间全变选中态，
 * 只能一个个点回去、最后删掉整个供应商。
 * 现在的契约：**刷新 = 只读**。这里只做两件事 —— 记住"哪些是新的"、把建议条显示出来；
 * 任何 enabled 变更都必须由用户点按钮触发（见 requestBulk / applySuggestion*）。
 */
function announceNewModels(normalized: ModelSettingItem[]) {
  const fresh = normalized.filter((i) => !knownModels.has(i.model))
  for (const i of normalized) knownModels.add(i.model)
  if (fresh.length === 0) return
  const freshChat = fresh.filter(isChatApplicable)
  const freshNonChat = fresh.filter((i) => !isChatApplicable(i))
  if (!isSuggestionDismissed()) {
    suggestion.value = {
      all: fresh.map((i) => i.model),
      chat: freshChat.map((i) => i.model),
      nonChat: freshNonChat.map((i) => i.model),
    }
  }
}

function isEnabledByModel(model: string): boolean {
  const item = itemMap.value.get(model) ?? defaultModelSetting(model)
  return isEnabled(item)
}

/** 建议条：[只启用对话模型] —— 仅当用户点按钮时才写库（走批量批口） */
async function applySuggestionChatOnly() {
  const s = suggestion.value
  if (!s) return
  const targets = [
    ...s.chat.map((m) => ({ model: m, enabled: true })),
    ...s.nonChat.map((m) => ({ model: m, enabled: false })),
  ]
  await requestBulk('chatOnly', targets)
}

/** 建议条：[全部启用] —— 数量大时二次确认（见 BULK_CONFIRM_THRESHOLD） */
async function applySuggestionAll() {
  const s = suggestion.value
  if (!s) return
  await requestBulk(
    'enableAll',
    s.all.map((m) => ({ model: m, enabled: true })),
  )
}

/** 建议条：[我自己选] / 关闭 = **什么都不改**（零请求），只收起建议条；本会话不再提示 */
function dismissSuggestion() {
  suggestion.value = null
  persistSuggestionDismissed()
}

/* ===================== 批量启用/停用（把"误启用"一键救回来）=====================
 * 全部走 PUT /api/ai/model-settings/batch（一次 ≤200 条、事务；超限分片），
 * 带 loading + 结果反馈；失败**绝不假成功**，并重新拉取一次让界面与服务端一致。
 */

type BulkKind = 'disableAll' | 'chatOnly' | 'enableAll'
interface BulkTarget {
  model: string
  enabled: boolean
}
/** 一次要"启用"超过这么多模型时，先二次确认（保护用户，别再来一次 169 个全选） */
const BULK_CONFIRM_THRESHOLD = 30

const bulkBusy = ref(false)
const bulkResult = ref<{ kind: 'success' | 'error'; text: string } | null>(null)
const bulkConfirm = ref<{ kind: BulkKind; items: BulkTarget[]; enabling: number; disabling: number } | null>(null)

/** 当前 provider 下按策略算出"需要变更"的目标（已经是目标状态的模型跳过，不做无谓写入） */
function bulkTargets(kind: BulkKind): BulkTarget[] {
  const out: BulkTarget[] = []
  for (const it of allItems.value) {
    const now = isEnabled(it)
    let want: boolean
    if (kind === 'disableAll') want = false
    else if (kind === 'enableAll') want = true
    else want = isChatApplicable(it)
    if (want === now) continue
    out.push({ model: it.model, enabled: want })
  }
  return out
}

function bulkConfirmText(kind: BulkKind, enabling: number, disabling: number): string {
  if (kind === 'disableAll') {
    return tf('ai_bulk_confirm_disable', '将为 {n} 个模型停用：配置与自定义值都不会丢，只是停用，可随时再启用。', {
      n: disabling,
    })
  }
  if (kind === 'chatOnly') {
    return tf('ai_bulk_confirm_chat', '将启用 {on} 个对话模型、停用 {off} 个非对话模型。', {
      on: enabling,
      off: disabling,
    })
  }
  return tf('ai_bulk_confirm_enable', '将为 {n} 个模型启用配置。', { n: enabling })
}

/** 入口：算目标 → 需要确认就先挂确认条 → 否则直接执行 */
async function requestBulk(kind: BulkKind, targets?: BulkTarget[]) {
  if (bulkBusy.value) return
  const items = (targets ?? bulkTargets(kind)).filter((t) => isEnabledByModel(t.model) !== t.enabled)
  if (items.length === 0) {
    bulkResult.value = { kind: 'success', text: t('ai_bulk_noop', '没有需要变更的模型') }
    toast.show(bulkResult.value.text, 'success')
    return
  }
  const enabling = items.filter((t) => t.enabled).length
  const disabling = items.length - enabling
  // 破坏性批量（全部停用）一律确认；任何"要启用 >30 个"的批量也都确认
  if (kind === 'disableAll' || enabling > BULK_CONFIRM_THRESHOLD) {
    bulkConfirm.value = { kind, items, enabling, disabling }
    return
  }
  await executeBulk(kind, items, enabling, disabling)
}

function cancelBulk() {
  bulkConfirm.value = null
}

async function confirmBulk() {
  const c = bulkConfirm.value
  if (!c) return
  bulkConfirm.value = null
  await executeBulk(c.kind, c.items, c.enabling, c.disabling)
}

/** 真正执行：分片 batch + loading + 结果反馈；成功/失败都重新拉取一次以与服务端对齐 */
async function executeBulk(kind: BulkKind, items: BulkTarget[], enabling: number, disabling: number) {
  bulkBusy.value = true
  bulkResult.value = null
  let written = 0
  try {
    for (let i = 0; i < items.length; i += BATCH_MAX_ITEMS) {
      const chunk = items.slice(i, i + BATCH_MAX_ITEMS)
      const res = await putModelSettingsBatch(
        props.providerId || '',
        chunk.map((t) => ({ model: t.model, patch: { enabled: t.enabled } })),
      )
      if (!res.ok) {
        // 如实报错（含已写入的条数），并重新拉取 —— 绝不留下"看着成功其实没写"
        const reason = apiErrorText(res, t('ai_bulk_fail_default', '批量操作失败'))
        bulkResult.value = {
          kind: 'error',
          text: tf('ai_bulk_fail', '批量操作失败（已写入 {n} 条）：{reason}', { n: written, reason }),
        }
        toast.show(bulkResult.value.text, 'error')
        await load()
        return
      }
      written += chunk.length
    }
    bulkResult.value = {
      kind: 'success',
      text: tf('ai_bulk_ok', '已更新 {n} 个模型（{what}）', {
        n: written,
        what: bulkKindText(kind, enabling, disabling),
      }),
    }
    toast.show(bulkResult.value.text, 'success')
    await load()
  } catch (e) {
    const reason = (e as Error)?.message || String(e)
    bulkResult.value = {
      kind: 'error',
      text: tf('ai_bulk_fail', '批量操作失败（已写入 {n} 条）：{reason}', { n: written, reason }),
    }
    toast.show(bulkResult.value.text, 'error')
    await load()
  } finally {
    bulkBusy.value = false
  }
}

function bulkKindText(kind: BulkKind, enabling: number, disabling: number): string {
  if (kind === 'disableAll') return tf('ai_bulk_what_disable', '停用 {n} 个', { n: disabling })
  if (kind === 'chatOnly') {
    return tf('ai_bulk_what_chat', '对话模型启用 {on} 个 / 其余停用 {off} 个', { on: enabling, off: disabling })
  }
  return tf('ai_bulk_what_enable', '启用 {n} 个', { n: enabling })
}

/** 工具栏三个批量按钮 */
async function bulkDisableAll() {
  await requestBulk('disableAll')
}
async function bulkChatOnly() {
  await requestBulk('chatOnly')
}
async function bulkEnableAll() {
  await requestBulk('enableAll')
}

/* ===================== 写操作 ===================== */

function upsertItem(item: ModelSettingItem) {
  // 原位替换（不能用 push：否则每次改配置/别名都会把该模型顶到列表末尾，顺序无故跳动）
  const idx = items.value.findIndex((i) => i.model === item.model)
  if (idx < 0) {
    items.value = [...items.value, item]
    return
  }
  const next = [...items.value]
  next[idx] = item
  items.value = next
}

function clearEnabledOverride(model: string) {
  if (!(model in enabledOverrides.value)) return
  const next = { ...enabledOverrides.value }
  delete next[model]
  enabledOverrides.value = next
}

function rollbackEnabled(model: string, prev: boolean | undefined) {
  const next = { ...enabledOverrides.value }
  if (prev === undefined) delete next[model]
  else next[model] = prev
  enabledOverrides.value = next
}

function setApplying(model: string, on: boolean) {
  const next = { ...applying.value }
  if (on) next[model] = true
  else delete next[model]
  applying.value = next
}

/**
 * 记录"本会话内写过哪些预设类字段"（逐字段来源的本地判据）。
 * 写 null / inherit 表示**清除覆盖**（恢复预设），此时要把该字段从记录里去掉，
 * 否则单项恢复后仍会显示"你改过"——状态与现实不符。
 */
function applyTouched(model: string, patch: ModelSettingPatch) {
  const cur = new Set(touchedFields.value[model] || [])
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'enabled' || k === 'alias' || k === 'sortOrder') continue
    if (v === null || (k === 'reasoningProtocol' && v === 'inherit')) cur.delete(k)
    else cur.add(k)
  }
  const next = { ...touchedFields.value }
  if (cur.size === 0) delete next[model]
  else next[model] = [...cur]
  touchedFields.value = next
}

/**
 * 服务端未回传 item 时的本地合并（旧契约降级路径）。逐字段处理以保住类型：
 * · 数值 patch 为 null = 清除覆盖（列可空）→ 本地也置 null（界面显示"预设"）；
 * · 布尔/协议 patch 为 null = 回退预设值，但预设值本地不可知 → 保留当前值（不编造）。
 * · enabled/alias/sortOrder 不属于"能力参数覆盖"，不影响 isOverridden。
 */
function mergePatchLocally(model: string, patch: ModelSettingPatch) {
  const current = itemMap.value.get(model) ?? defaultModelSetting(model)
  const merged: ModelSettingItem = { ...current }
  if ('contextWindow' in patch) merged.contextWindow = patch.contextWindow ?? null
  if ('maxOutput' in patch) merged.maxOutput = patch.maxOutput ?? null
  if (typeof patch.supportsText === 'boolean') merged.supportsText = patch.supportsText
  if (typeof patch.supportsImage === 'boolean') merged.supportsImage = patch.supportsImage
  if (typeof patch.supportsVideo === 'boolean') merged.supportsVideo = patch.supportsVideo
  if (typeof patch.supportsAudio === 'boolean') merged.supportsAudio = patch.supportsAudio
  if (typeof patch.reasoningEnabled === 'boolean') merged.reasoningEnabled = patch.reasoningEnabled
  if ('reasoningProtocol' in patch) merged.reasoningProtocol = normalizeReasoningProtocol(patch.reasoningProtocol)
  if ('enabled' in patch) merged.enabled = patch.enabled === true
  if ('alias' in patch) merged.alias = typeof patch.alias === 'string' && patch.alias.trim() !== '' ? patch.alias : null
  if ('sortOrder' in patch) merged.sortOrder = typeof patch.sortOrder === 'number' ? patch.sortOrder : null
  if (Object.keys(patch).some((k) => k !== 'enabled' && k !== 'alias' && k !== 'sortOrder')) merged.isOverridden = true
  upsertItem(merged)
}

/** 通用 patch：PUT → 用服务端返回的 item 刷新（或本地合并）→ 可选 toast */
async function patchModel(model: string, patch: ModelSettingPatch, okMsg?: string): Promise<boolean> {
  setApplying(model, true)
  try {
    const res = await putModelSetting(props.providerId || '', model, patch)
    if (res.ok) {
      const raw = res.data?.item
      if (raw) {
        const norm = normalizeModelSettingItem(raw)
        upsertItem(norm)
        if (norm.enabledFromServer) clearEnabledOverride(model)
      } else {
        mergePatchLocally(model, patch)
      }
      applyTouched(model, patch)
      if (okMsg) toast.show(okMsg, 'success')
      return true
    }
    toast.show(apiErrorText(res, t('ai_model_patch_fail', '保存失败')), 'error')
    return false
  } catch (e) {
    toast.show(String((e as Error)?.message || e), 'error')
    return false
  } finally {
    setApplying(model, false)
  }
}

/** 胶囊点击 / 行内停用启用：乐观更新 + 失败回滚（取消启用 = enabled:false，不是删除） */
async function setEnabled(model: string, next: boolean): Promise<boolean> {
  const prev = enabledOverrides.value[model]
  enabledOverrides.value = { ...enabledOverrides.value, [model]: next }
  setApplying(model, true)
  try {
    const res = await putModelSetting(props.providerId || '', model, { enabled: next })
    if (res.ok) {
      const raw = res.data?.item
      if (raw) {
        const norm = normalizeModelSettingItem(raw)
        upsertItem(norm)
        // 服务端回传了权威 enabled 才撤掉本地乐观值；契约较旧时不撤，避免界面跳回
        if (norm.enabledFromServer) clearEnabledOverride(model)
      }
      return true
    }
    rollbackEnabled(model, prev)
    toast.show(apiErrorText(res, t('ai_model_toggle_fail', '启用状态保存失败，已还原')), 'error')
    return false
  } catch (e) {
    rollbackEnabled(model, prev)
    toast.show(String((e as Error)?.message || e), 'error')
    return false
  } finally {
    setApplying(model, false)
  }
}

async function toggleEnabled(item: ModelSettingItem) {
  if (applying.value[item.model]) return
  await setEnabled(item.model, !isEnabled(item))
}

/** 行内 [🧹 清除自定义值]：恢复能力参数预设（**不删除模型、不改启用状态**） */
async function clearOverrides(model: string) {
  if (applying.value[model]) return
  await patchModel(model, { ...RESTORE_PRESET_PATCH }, t('ai_model_cleared', '已清除该模型的自定义值（回到预设）'))
}

/* ===================== 别名 ===================== */

function startAliasEdit(item: ModelSettingItem) {
  aliasEditing.value = item.model
  aliasDraft.value = item.alias || ''
}

function cancelAliasEdit() {
  aliasEditing.value = null
  aliasDraft.value = ''
}

async function saveAlias(model: string) {
  const v = aliasDraft.value.trim()
  if (v.length > ALIAS_MAX_LEN) {
    toast.show(tf('ai_model_alias_too_long', '别名最长 {max} 个字符', { max: ALIAS_MAX_LEN }), 'error')
    return
  }
  const current = itemMap.value.get(model)?.alias ?? null
  const next = v === '' ? null : v
  if ((current || null) === next) {
    cancelAliasEdit()
    return
  }
  const ok = await patchModel(model, { alias: v }, t('ai_model_alias_saved', '显示别名已保存'))
  if (ok) cancelAliasEdit()
}

/* ===================== 拖拽排序 ===================== */

function onDragStart(model: string) {
  dragFrom.value = model
}

function onDragEnd() {
  dragFrom.value = null
}

/** 拖到目标行：重排后写 sortOrder（只对顺序真的变了的模型发请求） */
async function onDrop(target: string) {
  const from = dragFrom.value
  dragFrom.value = null
  if (!from || from === target) return
  const order = allItems.value.map((i) => i.model)
  const fromIdx = order.indexOf(from)
  const toIdx = order.indexOf(target)
  if (fromIdx < 0 || toIdx < 0) return
  const next = [...order]
  next.splice(fromIdx, 1)
  next.splice(toIdx, 0, from)
  const changed: Array<{ model: string; sortOrder: number }> = []
  next.forEach((m, i) => {
    if (order[i] !== m) changed.push({ model: m, sortOrder: i })
  })
  if (changed.length === 0) return
  for (const c of changed) {
    await patchModel(c.model, { sortOrder: c.sortOrder })
  }
  toast.show(t('ai_model_order_saved', '顺序已保存（决定聊天里模型选择器的顺序）'), 'success')
}

/* ===================== 能力自检 ===================== */

/** 自检：真实调用上游（只在用户点击时触发，绝不自动跑） */
async function runProbe(model: string) {
  if (probing.value[model]) return
  if (protocolApplied.value[model]) {
    const cleared = { ...protocolApplied.value }
    delete cleared[model]
    protocolApplied.value = cleared
  }
  probing.value = { ...probing.value, [model]: true }
  try {
    const res = await probeModelSetting(props.providerId || '', model)
    if (res.ok && res.data) {
      probeResults.value = { ...probeResults.value, [model]: res.data }
    } else {
      probeResults.value = {
        ...probeResults.value,
        [model]: { ok: false, error: apiErrorText(res, `HTTP ${res.status}`) },
      }
    }
  } catch (e) {
    probeResults.value = {
      ...probeResults.value,
      [model]: { ok: false, error: String((e as Error)?.message || e) },
    }
  } finally {
    const next = { ...probing.value }
    delete next[model]
    probing.value = next
  }
}

function probeState(model: string) {
  const r = probeResults.value[model]
  return r ? probeStateOf(r) : null
}

/** 自检结果一行文案：失败时原样带出上游状态码/错误码/文案，绝不吞 */
function probeLine(model: string): string {
  const r = probeResults.value[model]
  if (!r) return ''
  const state = probeStateOf(r)
  if (state === 'fail') {
    const parts = [t('ai_model_probe_fail', '不可用')]
    if (r.upstreamStatus != null) parts.push(`HTTP ${r.upstreamStatus}`)
    if (r.upstreamErrorCode) parts.push(String(r.upstreamErrorCode))
    if (r.upstreamMessage) parts.push(String(r.upstreamMessage))
    if (r.error) parts.push(String(r.error))
    return parts.join(' · ')
  }
  const bits: string[] = []
  bits.push(
    state === 'warn' ? t('ai_model_probe_warn', '上游可用，但不支持当前推理参数') : t('ai_model_probe_ok', '可用'),
  )
  if (r.latencyMs != null) bits.push(`${r.latencyMs} ms`)
  if (r.protocolTried) bits.push(String(r.protocolTried))
  if (r.usedReasoningParam) bits.push(t('ai_model_probe_reasoning_sent', '已下发推理参数'))
  if (r.supportsReasoningParam === 'unknown') bits.push(t('ai_model_probe_unknown', '是否支持推理参数未知'))
  return bits.join(' · ')
}

/** ⚠️ 一键修正：把推理协议改成自检建议的协议（改完不假装已经可用，提示重新自检） */
async function applySuggestedProtocol(model: string) {
  const r = probeResults.value[model]
  const p = normalizeReasoningProtocol(r?.suggestedProtocol)
  const ok = await patchModel(
    model,
    { reasoningProtocol: p },
    tf('ai_model_probe_protocol_applied', '已改为自检建议的协议：{protocol}', { protocol: protocolLabel(p) }),
  )
  // 只收起"一键改协议"按钮 + 提示重新自检，**不把 ⚠️ 悄悄改成 ✅**（协议是否真的被上游接受，只有再自检一次才知道）
  if (ok) protocolApplied.value = { ...protocolApplied.value, [model]: true }
}

/** 一键回填：把自检观测到的上下文窗口写进配置 */
async function applyObservedContext(model: string) {
  const r = probeResults.value[model]
  const ctx = r?.observedContextWindow
  if (!ctx) return
  await patchModel(
    model,
    { contextWindow: Math.floor(Number(ctx)) },
    tf('ai_model_probe_context_applied', '已回填上下文窗口：{ctx}', { ctx: String(Math.floor(Number(ctx))) }),
  )
}

/* ===================== 配置弹窗（逐字段来源 + 单项恢复）===================== */

interface Draft {
  contextWindow: string
  maxOutput: string
  supportsText: boolean
  supportsImage: boolean
  supportsVideo: boolean
  supportsAudio: boolean
  reasoningEnabled: boolean
  reasoningProtocol: ReasoningProtocol
}

function emptyDraft(): Draft {
  return {
    contextWindow: '',
    maxOutput: '',
    supportsText: true,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    reasoningEnabled: false,
    reasoningProtocol: 'inherit',
  }
}

function draftFromItem(item: ModelSettingItem): Draft {
  return {
    contextWindow: item.contextWindow == null ? '' : String(item.contextWindow),
    maxOutput: item.maxOutput == null ? '' : String(item.maxOutput),
    supportsText: item.supportsText,
    supportsImage: item.supportsImage,
    supportsVideo: item.supportsVideo,
    supportsAudio: item.supportsAudio,
    reasoningEnabled: item.reasoningEnabled,
    reasoningProtocol: item.reasoningProtocol,
  }
}

const editingItem = computed<ModelSettingItem | null>(
  () =>
    itemMap.value.get(editingModel.value || '') ??
    (editingModel.value ? defaultModelSetting(editingModel.value) : null),
)
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(baseline.value))
const busy = computed(() => saving.value)

/** 数字输入归一：`<input type="number">` 经 Vue v-model 会给出 number，空值仍为 '' */
function asText(v: string | number | null | undefined): string {
  return v == null ? '' : String(v)
}

function openEditor(model: string) {
  const item = itemMap.value.get(model) ?? defaultModelSetting(model)
  const d = draftFromItem(item)
  draft.value = d
  baseline.value = { ...d }
  modalError.value = ''
  editingModel.value = model
}

function closeEditor() {
  editingModel.value = null
  modalError.value = ''
}

function protocolLabel(p: ReasoningProtocol): string {
  return t(REASONING_PROTOCOL_LABEL_KEYS[p], REASONING_PROTOCOL_LABELS[p])
}

/** 弹窗字段读写（8 个可恢复字段；enabled/alias/sortOrder 不属于"预设覆盖"） */
function draftField(d: Draft, f: ModelSettingField): string | boolean | null {
  switch (f) {
    case 'contextWindow':
      return d.contextWindow.trim()
    case 'maxOutput':
      return d.maxOutput.trim()
    case 'supportsText':
      return d.supportsText
    case 'supportsImage':
      return d.supportsImage
    case 'supportsVideo':
      return d.supportsVideo
    case 'supportsAudio':
      return d.supportsAudio
    case 'reasoningEnabled':
      return d.reasoningEnabled
    case 'reasoningProtocol':
      return d.reasoningProtocol
    default:
      return null
  }
}

type FieldSource = 'preset' | 'user' | 'pending'

/**
 * 逐字段来源：
 *   pending —— 弹窗里刚改过还没保存
 *   user    —— 本会话内我们提交过该字段
 *   preset  —— 其余（模型未被覆盖 ⇒ 一定是预设；已覆盖但没记录到 ⇒ 按预设展示）
 * 诚实说明：契约不返回逐字段覆盖标记，因此这里只能"本地改动记录 + 模型级预设标记"推断，
 * 弹窗底部有对应说明文案，不假装是服务端权威数据。
 */
function fieldSource(model: string, f: ModelSettingField): FieldSource {
  if (draftField(draft.value, f) !== draftField(baseline.value, f)) return 'pending'
  if ((touchedFields.value[model] || []).includes(f)) return 'user'
  return 'preset'
}

function fieldSourceLabel(src: FieldSource): string {
  if (src === 'pending') return t('ai_model_src_pending', '你刚改过')
  if (src === 'user') return t('ai_model_src_user', '你改过')
  return t('ai_model_src_preset', '来自预设')
}

function isFieldDirty(f: ModelSettingField): boolean {
  return draftField(draft.value, f) !== draftField(baseline.value, f)
}

function canRestoreField(model: string, f: ModelSettingField): boolean {
  const item = itemMap.value.get(model)
  return isFieldDirty(f) || !!item?.isOverridden || touchedFields.value[model]?.includes(f) === true
}

/** 单项恢复：只提交一个字段的"清除覆盖"值，并把该字段的草稿对齐到服务端最新值 */
async function restoreField(field: ModelSettingField) {
  const model = editingModel.value
  // 只接受"能力参数"字段（enabled/alias/sortOrder 不属于预设覆盖，没有单项恢复语义）
  if (!model || busy.value || !RESTORABLE_FIELDS.includes(field)) return
  const ok = await patchModel(model, restoreFieldPatch(field))
  if (!ok) return
  const item = itemMap.value.get(model) ?? defaultModelSetting(model)
  const fresh = draftFromItem(item)
  if (field in fresh) {
    const key = field as keyof Draft
    draft.value = { ...draft.value, [key]: fresh[key] }
    baseline.value = { ...baseline.value, [key]: fresh[key] }
  }
  toast.show(t('ai_model_field_restored', '该字段已恢复为预设值'), 'success')
}

/** 只提交真正改动过的字段：未改的字段不进 patch，服务端保持原值（避免误清用户已有配置） */
function buildPatch(): ModelSettingPatch {
  const d = draft.value
  const b = baseline.value
  const patch: ModelSettingPatch = {}
  if (d.contextWindow.trim() !== b.contextWindow.trim()) {
    patch.contextWindow = d.contextWindow.trim() === '' ? null : Number(d.contextWindow.trim())
  }
  if (d.maxOutput.trim() !== b.maxOutput.trim()) {
    patch.maxOutput = d.maxOutput.trim() === '' ? null : Number(d.maxOutput.trim())
  }
  if (d.supportsText !== b.supportsText) patch.supportsText = d.supportsText
  if (d.supportsImage !== b.supportsImage) patch.supportsImage = d.supportsImage
  if (d.supportsVideo !== b.supportsVideo) patch.supportsVideo = d.supportsVideo
  if (d.supportsAudio !== b.supportsAudio) patch.supportsAudio = d.supportsAudio
  if (d.reasoningEnabled !== b.reasoningEnabled) patch.reasoningEnabled = d.reasoningEnabled
  if (d.reasoningProtocol !== b.reasoningProtocol) patch.reasoningProtocol = d.reasoningProtocol
  return patch
}

/** 非法输入不提交：本地先拦（与服务端上限同源），错误就地提示 */
function validateDraft(): string {
  const d = draft.value
  const ctx = d.contextWindow.trim()
  if (ctx !== '' && !isValidTokenCount(ctx, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX)) {
    return tf('ai_model_cfg_err_context', '上下文窗口需为 {min} ~ {max} 之间的整数', {
      min: CONTEXT_WINDOW_MIN,
      max: CONTEXT_WINDOW_MAX,
    })
  }
  const out = d.maxOutput.trim()
  if (out !== '' && !isValidTokenCount(out, MAX_OUTPUT_MIN, MAX_OUTPUT_MAX)) {
    return tf('ai_model_cfg_err_output', '最大输出需为 {min} ~ {max} 之间的整数', {
      min: MAX_OUTPUT_MIN,
      max: MAX_OUTPUT_MAX,
    })
  }
  if (ctx !== '' && out !== '' && Number(out) > Number(ctx)) {
    return t('ai_model_cfg_err_output_gt_context', '最大输出不能大于上下文窗口')
  }
  return ''
}

async function saveDraft() {
  const model = editingModel.value
  if (!model || busy.value) return
  modalError.value = validateDraft()
  if (modalError.value) return
  const patch = buildPatch()
  if (Object.keys(patch).length === 0) {
    closeEditor()
    return
  }
  saving.value = true
  try {
    const ok = await patchModel(model, patch)
    if (ok) {
      toast.show(t('ai_model_cfg_saved', '模型配置已保存'), 'success')
      closeEditor()
    } else {
      modalError.value = t('ai_model_cfg_save_fail', '保存模型配置失败')
    }
  } finally {
    saving.value = false
  }
}

/** 整模型「恢复预设」：清除全部能力参数覆盖（不含启用态/别名/排序） */
async function restorePreset() {
  const model = editingModel.value
  if (!model || busy.value) return
  saving.value = true
  try {
    const ok = await patchModel(model, { ...RESTORE_PRESET_PATCH })
    if (ok) {
      toast.show(t('ai_model_cfg_restored', '已恢复预设'), 'success')
      closeEditor()
    }
  } finally {
    saving.value = false
  }
}

/* ===================== 展示辅助 ===================== */

/** 来源标记：已自定义 > 预设 > 无预设（未收录于内置预设表，也没有覆盖） */
function sourceLabel(item: ModelSettingItem): string {
  if (item.isOverridden) return t('ai_model_cfg_badge_overridden', '已自定义')
  if (item.isPreset) return t('ai_model_cfg_badge_preset', '预设')
  return t('ai_model_cfg_badge_none', '无预设')
}

function sourceClass(item: ModelSettingItem): string {
  return item.isOverridden ? 'aim-badge--custom' : item.isPreset ? 'aim-badge--preset' : 'aim-badge--none'
}

/** 行内摘要：上下文 · 输出 · 已支持的多模态 · 推理协议 */
function summary(item: ModelSettingItem): string {
  const unset = t('ai_model_cfg_unset', '预设')
  const ctx = item.contextWindow == null ? unset : String(item.contextWindow)
  const out = item.maxOutput == null ? unset : String(item.maxOutput)
  const mods =
    [
      item.supportsText ? t('ai_model_cfg_text', '文本') : '',
      item.supportsImage ? t('ai_model_cfg_image', '识图') : '',
      item.supportsVideo ? t('ai_model_cfg_video', '视频') : '',
      item.supportsAudio ? t('ai_model_cfg_audio', '音频') : '',
    ]
      .filter(Boolean)
      .join('/') || '—'
  return tf('ai_model_cfg_summary', '{ctx} 上下文 · {out} 输出 · {mods} · {protocol}', {
    ctx,
    out,
    mods,
    protocol: protocolLabel(item.reasoningProtocol),
  })
}

function chipTitle(item: ModelSettingItem): string {
  const name = modelDisplayName(item)
  return isEnabled(item)
    ? tf('ai_model_chip_on_h', '{name}：已启用，点击停用（不会删除配置）', { name })
    : tf('ai_model_chip_off_h', '{name}：未启用，点击启用', { name })
}

const modalTitle = computed(() =>
  tf('ai_model_cfg_modal_title', '配置模型：{model}', {
    model: editingModel.value ? modelDisplayName(editingItem.value ?? defaultModelSetting(editingModel.value)) : '',
  }),
)

/* ===================== 生命周期 ===================== */

defineExpose({ reload: load })

watch(
  () => props.providerId,
  () => {
    // 草稿态没有 providerId：一次都不打 model-settings（走 resolve 的草稿路径）
    if (isDraft.value) return
    knownModels = new Set<string>()
    suggestion.value = null
    nonChatOpen.value = false
    search.value = ''
    onlyEnabled.value = false
    onlyChat.value = false
    probeResults.value = {}
    protocolApplied.value = {}
    enabledOverrides.value = {}
    closeEditor()
    void load()
  },
  { immediate: true },
)

watch(
  () => props.refreshSeq,
  (n, o) => {
    if (isDraft.value) return
    if ((n ?? 0) > (o ?? 0)) void load({ announceNew: true })
  },
)

// 草稿态：勾选集合变化 → **只解析新增的**模型名（批量一次），卡片立刻出现
watch(
  () => [isDraft.value, draftModelList.value.join('\u0000')].join('|'),
  () => {
    if (isDraft.value) void loadDraftItems()
  },
  { immediate: true },
)
</script>

<template>
  <div class="aim-cfg">
    <!-- ===== 草稿态（供应商还没保存）：勾选即出配置卡片（POST /resolve 只读解析，不落库） ===== -->
    <template v-if="isDraft">
      <div class="aim-cfg-head">
        <div class="aim-cfg-title">
          {{ tf('ai_draft_cards_title', '模型配置（草稿：已勾选 {n} 个）', { n: draftModelList.length }) }}
        </div>
        <div class="aim-cfg-hint">
          {{
            t(
              'ai_draft_cards_hint',
              '改动先记在草稿里，点「保存」时一次性写入（只提交你改过的字段）；未改动的字段保持预设。',
            )
          }}
        </div>
      </div>

      <div v-if="draftLoading" class="aim-cfg-note">{{ t('ai_model_cfg_loading', '正在读取预设配置…') }}</div>
      <div v-else-if="draftError" class="aim-cfg-note aim-cfg-note--warn">
        <span>{{ draftError }}</span>
        <button type="button" class="aim-cfg-link" @click="retryDraftResolve">
          {{ t('ai_model_cfg_retry', '重试') }}
        </button>
      </div>
      <div v-if="draftModelList.length === 0" class="aim-cfg-note">
        {{ t('ai_draft_cards_empty', '勾选上面的候选模型，这里会立刻出现它的配置卡片。') }}
      </div>

      <!-- 草稿态一行 = **折叠概要行**（与已保存态的模型库行同构）：模型名 + 来源徽标 + 要点摘要
           + 右侧图标操作（配置 / 清空自定义值 / 移除）。点「配置」才展开完整表单。
           多个模型各自一行、默认**全部收起**（不再把 159 个表单全摊开）。
           展开后是与已保存态弹窗**同一套字段**（上下文/输出/四路模态/推理协议/别名 + 逐字段来源）；
           改这里时请同步上面的弹窗字段，反之亦然。 -->
      <div
        v-for="item in draftCards"
        :key="item.model"
        class="aim-draft-card"
        :data-draft-card="item.model"
        :data-model="item.model"
      >
        <div class="aim-draft-row" data-draft-row>
          <div class="aim-row-main">
            <div class="aim-row-name">
              <span class="aim-row-model">{{ modelDisplayName(effectiveDraftItem(item.model)) }}</span>
              <span class="aim-badge" :class="draftSourceClass(item.model)">{{ draftSourceLabel(item.model) }}</span>
            </div>
            <!-- 摘要复用已保存态同一套文案生成：未设置的项写成"预设 / 沿用系统默认"，不留空 -->
            <div class="aim-cfg-sum" data-draft-sum>{{ summary(effectiveDraftItem(item.model)) }}</div>
            <!-- 预设值在途：行先出现（不让人干等），这里说明"正在读"，避免被空摘要误导 -->
            <div v-if="draftLoading && !draftResolved.includes(item.model)" class="aim-form-note">
              {{ t('ai_draft_card_loading', '正在读取该模型的预设值…') }}
            </div>
          </div>
          <div class="aim-row-actions">
            <button
              type="button"
              class="aim-icon"
              data-action="draft-config"
              :title="
                draftIsExpanded(item.model) ? t('ai_draft_collapse_h', '收起配置') : t('ai_model_cfg_edit', '配置')
              "
              @click="toggleDraftExpanded(item.model)"
            >
              <ChevronUp v-if="draftIsExpanded(item.model)" :size="14" />
              <Settings2 v-else :size="14" />
            </button>
            <button
              type="button"
              class="aim-icon"
              data-action="draft-clear"
              :disabled="!draftHasPatch(item.model)"
              :title="t('ai_draft_card_reset_h', '清空这个模型的草稿改动（回到预设）')"
              @click="resetDraftCard(item.model)"
            >
              <Eraser :size="14" />
            </button>
            <button
              type="button"
              class="aim-icon"
              data-action="draft-remove"
              :title="t('ai_draft_remove_h', '从已选里移除（草稿里改过的值仍保留，勾回来即可恢复）')"
              @click="removeDraftModel(item.model)"
            >
              <Power :size="14" />
            </button>
          </div>
        </div>

        <div v-if="draftIsExpanded(item.model)" class="aim-draft-form aim-form">
          <div class="aim-field">
            <div class="aim-field-head">
              <label class="aim-label">{{ t('ai_model_cfg_context', '上下文窗口 (tokens)') }}</label>
              <span class="aim-src" :class="`aim-src--${draftFieldSource(item.model, 'contextWindow')}`">
                {{ fieldSourceLabel(draftFieldSource(item.model, 'contextWindow')) }}
              </span>
              <button
                type="button"
                class="aim-field-restore"
                data-action="draft-restore-contextWindow"
                :disabled="!draftFieldChanged(item.model, 'contextWindow')"
                :title="t('ai_model_field_restore_h', '只恢复该字段为预设值')"
                @click="resetDraftField(item.model, 'contextWindow')"
              >
                <RotateCcw :size="11" />
              </button>
            </div>
            <Input
              :model-value="draftForm(item.model).contextWindow"
              type="number"
              class="aim-input"
              :placeholder="t('ai_model_cfg_leave_empty', '留空 = 用预设')"
              @update:model-value="(v: string | number) => setDraftField(item.model, 'contextWindow', asText(v))"
            />
          </div>

          <div class="aim-field">
            <div class="aim-field-head">
              <label class="aim-label">{{ t('ai_model_cfg_max_output', '最大输出 (tokens)') }}</label>
              <span class="aim-src" :class="`aim-src--${draftFieldSource(item.model, 'maxOutput')}`">
                {{ fieldSourceLabel(draftFieldSource(item.model, 'maxOutput')) }}
              </span>
              <button
                type="button"
                class="aim-field-restore"
                data-action="draft-restore-maxOutput"
                :disabled="!draftFieldChanged(item.model, 'maxOutput')"
                :title="t('ai_model_field_restore_h', '只恢复该字段为预设值')"
                @click="resetDraftField(item.model, 'maxOutput')"
              >
                <RotateCcw :size="11" />
              </button>
            </div>
            <Input
              :model-value="draftForm(item.model).maxOutput"
              type="number"
              class="aim-input"
              :placeholder="t('ai_model_cfg_leave_empty', '留空 = 用预设')"
              @update:model-value="(v: string | number) => setDraftField(item.model, 'maxOutput', asText(v))"
            />
          </div>

          <div class="aim-field">
            <label class="aim-label">{{ t('ai_model_cfg_multimodal', '多模态能力') }}</label>
            <div class="aim-switch-list">
              <div
                v-for="f in ['supportsText', 'supportsImage', 'supportsVideo', 'supportsAudio'] as const"
                :key="f"
                class="aim-switch-row"
              >
                <span class="aim-switch-name">
                  {{
                    f === 'supportsText'
                      ? t('ai_model_cfg_text', '文本')
                      : f === 'supportsImage'
                        ? t('ai_model_cfg_image', '识图')
                        : f === 'supportsVideo'
                          ? t('ai_model_cfg_video', '视频')
                          : t('ai_model_cfg_audio', '音频')
                  }}
                </span>
                <span class="aim-src" :class="`aim-src--${draftFieldSource(item.model, f)}`">
                  {{ fieldSourceLabel(draftFieldSource(item.model, f)) }}
                </span>
                <button
                  type="button"
                  class="aim-field-restore"
                  :data-action="`draft-restore-${f}`"
                  :disabled="!draftFieldChanged(item.model, f)"
                  :title="t('ai_model_field_restore_h', '只恢复该字段为预设值')"
                  @click="resetDraftField(item.model, f)"
                >
                  <RotateCcw :size="11" />
                </button>
                <Switch
                  :model-value="draftForm(item.model)[f]"
                  @update:model-value="(v: boolean) => setDraftField(item.model, f, v)"
                />
              </div>
            </div>
          </div>

          <div class="aim-field">
            <label class="aim-label">{{ t('ai_model_cfg_reasoning', '推理（思考强度下发）') }}</label>
            <div class="aim-switch-row">
              <span class="aim-switch-name">{{ t('ai_model_cfg_reasoning_on', '启用推理') }}</span>
              <span class="aim-src" :class="`aim-src--${draftFieldSource(item.model, 'reasoningEnabled')}`">
                {{ fieldSourceLabel(draftFieldSource(item.model, 'reasoningEnabled')) }}
              </span>
              <button
                type="button"
                class="aim-field-restore"
                data-action="draft-restore-reasoningEnabled"
                :disabled="!draftFieldChanged(item.model, 'reasoningEnabled')"
                :title="t('ai_model_field_restore_h', '只恢复该字段为预设值')"
                @click="resetDraftField(item.model, 'reasoningEnabled')"
              >
                <RotateCcw :size="11" />
              </button>
              <Switch
                :model-value="draftForm(item.model).reasoningEnabled"
                @update:model-value="(v: boolean) => setDraftField(item.model, 'reasoningEnabled', v)"
              />
            </div>
            <div class="aim-sub-label">
              {{ t('ai_model_cfg_reasoning_protocol', '推理协议') }}
              <span class="aim-src" :class="`aim-src--${draftFieldSource(item.model, 'reasoningProtocol')}`">
                {{ fieldSourceLabel(draftFieldSource(item.model, 'reasoningProtocol')) }}
              </span>
              <button
                type="button"
                class="aim-field-restore"
                data-action="draft-restore-reasoningProtocol"
                :disabled="!draftFieldChanged(item.model, 'reasoningProtocol')"
                :title="t('ai_model_field_restore_h', '只恢复该字段为预设值')"
                @click="resetDraftField(item.model, 'reasoningProtocol')"
              >
                <RotateCcw :size="11" />
              </button>
            </div>
            <CustomSelect
              :model-value="draftForm(item.model).reasoningProtocol"
              @update:model-value="
                (v: string) => setDraftField(item.model, 'reasoningProtocol', v as ReasoningProtocol)
              "
            >
              {{ protocolLabel(draftForm(item.model).reasoningProtocol) }}
              <template #options>
                <CustomSelectOption
                  v-for="p in REASONING_PROTOCOLS"
                  :key="p"
                  :value="p"
                  :selected="draftForm(item.model).reasoningProtocol === p"
                  @select="(v: string) => setDraftField(item.model, 'reasoningProtocol', v as ReasoningProtocol)"
                >
                  {{ protocolLabel(p) }}
                </CustomSelectOption>
              </template>
            </CustomSelect>
          </div>

          <div class="aim-field">
            <div class="aim-field-head">
              <label class="aim-label">{{ t('ai_model_alias_edit', '显示别名') }}</label>
              <button
                type="button"
                class="aim-field-restore"
                data-action="draft-restore-alias"
                :disabled="!draftFieldChanged(item.model, 'alias')"
                :title="t('ai_draft_alias_restore_h', '清空别名（回到模型原名）')"
                @click="setDraftAlias(item.model, '')"
              >
                <RotateCcw :size="11" />
              </button>
            </div>
            <Input
              :model-value="draftAlias[item.model] ?? ''"
              class="aim-input"
              :maxlength="ALIAS_MAX_LEN"
              :placeholder="t('ai_model_alias_ph', '留空 = 用模型原名')"
              @update:model-value="(v: string | number) => setDraftAlias(item.model, asText(v))"
            />
          </div>

          <div v-if="draftCardErrors(item.model).length" class="aim-form-error">
            {{ draftCardErrors(item.model).join('；')
            }}{{ t('ai_draft_invalid_suffix', '（本次不会被写入，请先修正）') }}
          </div>
        </div>
      </div>
    </template>

    <!-- ===== 已保存态（有 providerId）：单排胶囊 / 折叠分组 / 建议条 / 自检 / 配置弹窗 ===== -->
    <template v-else>
      <div class="aim-cfg-head">
        <div class="aim-cfg-title">
          {{ tf('ai_model_lib_title', '模型库（{n} 个，已启用 {on}）', { n: allItems.length, on: enabledCount }) }}
        </div>
        <div class="aim-cfg-hint">
          {{
            t(
              'ai_model_lib_hint',
              '点胶囊启用 / 停用（停用只是不参与对话，配置与自定义值都留在库里，再点一下即可恢复）；顺序决定聊天里模型选择器的顺序。',
            )
          }}
        </div>
      </div>

      <!-- 搜索 / 筛选 + 批量启用/停用（把"误启用"一键救回来） -->
      <div class="aim-toolbar">
        <Input v-model="search" class="aim-search" :placeholder="t('ai_model_search_ph', '搜索模型名 / 别名')" />
        <button
          type="button"
          class="aim-filter"
          :class="{ on: onlyEnabled }"
          data-action="filter-enabled"
          @click="onlyEnabled = !onlyEnabled"
        >
          {{ t('ai_model_filter_enabled', '只看已启用') }}
        </button>
        <button
          type="button"
          class="aim-filter"
          :class="{ on: onlyChat }"
          data-action="filter-chat"
          @click="onlyChat = !onlyChat"
        >
          {{ t('ai_model_filter_chat', '只看对话模型') }}
        </button>
      </div>

      <!-- 批量操作：只在这里（用户主动点）才会写库；刷新永远不会写 -->
      <div class="aim-bulk">
        <button
          type="button"
          class="aim-filter"
          data-action="bulk-disable-all"
          :disabled="bulkBusy || enabledCount === 0"
          :title="t('ai_bulk_disable_h', '把当前供应商下所有已启用模型停用（配置不会丢）')"
          @click="bulkDisableAll"
        >
          {{ t('ai_bulk_disable_all', '全部停用') }}
        </button>
        <button
          type="button"
          class="aim-filter"
          data-action="bulk-chat-only"
          :disabled="bulkBusy"
          :title="t('ai_bulk_chat_h', '只启用适合对话的模型，其余全部停用')"
          @click="bulkChatOnly"
        >
          {{ t('ai_model_suggest_chat_only', '只启用对话模型') }}
        </button>
        <button
          type="button"
          class="aim-filter"
          data-action="bulk-enable-all"
          :disabled="bulkBusy"
          :title="t('ai_bulk_enable_h', '启用当前供应商下全部模型（数量大时会先二次确认）')"
          @click="bulkEnableAll"
        >
          {{ t('ai_model_suggest_all', '全部启用') }}
        </button>
        <span v-if="bulkBusy" class="aim-bulk-running">{{ t('ai_bulk_running', '正在写入…') }}</span>
      </div>

      <!-- 二次确认（破坏性批量 / 一次启用过多）：写明影响数量；确认前一个请求都不发 -->
      <div v-if="bulkConfirm" class="aim-bulk-confirm">
        <span class="aim-bulk-confirm-text">
          {{ bulkConfirmText(bulkConfirm.kind, bulkConfirm.enabling, bulkConfirm.disabling) }}
        </span>
        <button type="button" class="aim-mini" data-action="bulk-confirm" :disabled="bulkBusy" @click="confirmBulk">
          {{ t('ai_bulk_confirm_ok', '确认执行') }}
        </button>
        <button type="button" class="aim-mini" data-action="bulk-cancel" :disabled="bulkBusy" @click="cancelBulk">
          {{ t('cancel_btn', '取消') }}
        </button>
      </div>

      <!-- 批量结果（成功 N 条 / 失败原因），不谎报成功 -->
      <div
        v-if="bulkResult"
        class="aim-bulk-result"
        :class="`aim-bulk-result--${bulkResult.kind}`"
        data-action="bulk-result"
      >
        {{ bulkResult.text }}
      </div>

      <div v-if="loading" class="aim-cfg-note">{{ t('ai_model_cfg_loading', '正在读取预设配置…') }}</div>
      <div v-else-if="loadError" class="aim-cfg-note aim-cfg-note--warn">
        <span>{{
          t('ai_model_cfg_load_fail', '无法读取模型预设配置（接口未就绪或网络异常），下面显示的是本地占位值。')
        }}</span>
        <button type="button" class="aim-cfg-link" @click="load()">{{ t('ai_model_cfg_retry', '重试') }}</button>
      </div>
      <div v-if="v3Missing && !loading" class="aim-cfg-note aim-cfg-note--warn">
        {{
          t(
            'ai_model_v3_missing',
            '当前服务端未返回 enabled / alias / sortOrder 字段（契约 v3 未就绪）：启用态暂时按你已保存的模型列表推断，启用/别名/排序的改动可能不会被保存。',
          )
        }}
      </div>

      <!-- 刷新后的一次性**纯建议**（非阻断）：刷新只读，这里一个请求都不会发；
           只有点下面的按钮才会写库 -->
      <div v-if="suggestion" class="aim-suggest">
        <div class="aim-suggest-text">
          {{
            tf(
              'ai_model_suggest_text',
              '发现 {n} 个新模型：{m} 个适合对话（尚未启用）· {k} 个为音频/图像/嵌入（已折叠）',
              {
                n: suggestion.all.length,
                m: suggestion.chat.length,
                k: suggestion.nonChat.length,
              },
            )
          }}
        </div>
        <div class="aim-suggest-actions">
          <button
            type="button"
            class="aim-mini"
            data-action="suggest-chat"
            :disabled="bulkBusy"
            @click="applySuggestionChatOnly"
          >
            {{ t('ai_model_suggest_chat_only', '只启用对话模型') }}
          </button>
          <button
            type="button"
            class="aim-mini"
            data-action="suggest-all"
            :disabled="bulkBusy"
            @click="applySuggestionAll"
          >
            {{ t('ai_model_suggest_all', '全部启用') }}
          </button>
          <button
            type="button"
            class="aim-mini"
            data-action="suggest-manual"
            :disabled="bulkBusy"
            @click="dismissSuggestion"
          >
            {{ t('ai_model_suggest_manual', '我自己选') }}
          </button>
          <button
            type="button"
            class="aim-icon aim-suggest-x"
            data-action="suggest-close"
            :title="t('ai_model_suggest_dismiss_h', '收起建议（本会话不再提示，什么都不会改）')"
            @click="dismissSuggestion"
          >
            <X :size="13" />
          </button>
        </div>
      </div>

      <div v-if="allItems.length === 0" class="aim-cfg-note">
        {{ t('ai_model_cfg_empty', '先刷新模型列表或手工添加模型，再逐个配置参数。') }}
      </div>

      <template v-else>
        <!-- 对话模型：单排胶囊（可换行） -->
        <div class="aim-group">
          <div class="aim-group-head">
            <span>{{ t('ai_model_group_chat', '对话模型') }}</span>
            <span class="aim-count">{{ chatItems.length }}</span>
          </div>
          <div class="aim-chips">
            <button
              v-for="it in chatItems"
              :key="it.model"
              type="button"
              class="aim-chip"
              :class="{ 'aim-chip--on': isEnabled(it) }"
              :data-model="it.model"
              :title="chipTitle(it)"
              @click="toggleEnabled(it)"
            >
              <Check v-if="isEnabled(it)" :size="11" class="aim-chip-check" />
              <span class="aim-chip-name">{{ modelDisplayName(it) }}</span>
            </button>
            <span v-if="chatItems.length === 0" class="aim-empty">{{
              t('ai_model_none_match', '没有匹配的模型')
            }}</span>
          </div>

          <!-- 对话模型行：图标化操作 -->
          <div class="aim-rows">
            <div
              v-for="it in chatItems"
              :key="`row-${it.model}`"
              class="aim-row"
              :data-model="it.model"
              @dragover.prevent
              @drop="onDrop(it.model)"
            >
              <span
                class="aim-drag"
                draggable="true"
                :title="t('ai_model_drag_h', '拖拽排序：决定聊天里模型选择器的顺序')"
                @dragstart="onDragStart(it.model)"
                @dragend="onDragEnd"
              >
                <GripVertical :size="13" />
              </span>
              <div class="aim-row-main">
                <div class="aim-row-name">
                  <span class="aim-row-model">{{ modelDisplayName(it) }}</span>
                  <span v-if="it.alias" class="aim-row-orig">{{ it.model }}</span>
                  <span class="aim-badge" :class="sourceClass(it)">{{ sourceLabel(it) }}</span>
                  <span v-if="!isEnabled(it)" class="aim-badge aim-badge--off">
                    {{ t('ai_model_badge_off', '未启用') }}
                  </span>
                </div>
                <div class="aim-cfg-sum">{{ summary(it) }}</div>

                <div class="aim-alias-line">
                  <template v-if="aliasEditing !== it.model">
                    <button type="button" class="aim-mini" data-action="alias" @click="startAliasEdit(it)">
                      <Pencil :size="10" />
                      {{ t('ai_model_alias_edit', '显示别名') }}
                    </button>
                  </template>
                  <template v-else>
                    <input
                      v-model="aliasDraft"
                      class="aim-alias-input"
                      :maxlength="ALIAS_MAX_LEN"
                      :placeholder="t('ai_model_alias_ph', '留空 = 用模型原名')"
                      @keydown.enter.prevent="saveAlias(it.model)"
                    />
                    <button type="button" class="aim-mini" data-action="alias-save" @click="saveAlias(it.model)">
                      {{ t('common_save', '保存') }}
                    </button>
                    <button type="button" class="aim-mini" data-action="alias-cancel" @click="cancelAliasEdit">
                      {{ t('cancel_btn', '取消') }}
                    </button>
                  </template>
                </div>

                <div v-if="probeResults[it.model]" class="aim-probe" :class="`aim-probe--${probeState(it.model)}`">
                  <span class="aim-probe-line" :data-probe="probeState(it.model)">{{ probeLine(it.model) }}</span>
                  <button
                    v-if="
                      probeState(it.model) === 'warn' &&
                      probeResults[it.model]?.suggestedProtocol &&
                      !protocolApplied[it.model]
                    "
                    type="button"
                    class="aim-mini"
                    data-action="apply-protocol"
                    @click="applySuggestedProtocol(it.model)"
                  >
                    {{
                      tf('ai_model_probe_apply_protocol', '一键改为 {protocol}', {
                        protocol: protocolLabel(
                          normalizeReasoningProtocol(probeResults[it.model]?.suggestedProtocol as string),
                        ),
                      })
                    }}
                  </button>
                  <span
                    v-else-if="probeState(it.model) === 'warn' && protocolApplied[it.model]"
                    class="aim-probe-recheck"
                  >
                    {{ t('ai_model_probe_recheck', '已改为建议协议，建议再自检一次确认') }}
                  </span>
                  <button
                    v-if="probeResults[it.model]?.observedContextWindow"
                    type="button"
                    class="aim-mini"
                    data-action="apply-context"
                    @click="applyObservedContext(it.model)"
                  >
                    {{ t('ai_model_probe_apply_context', '一键回填上下文') }}
                  </button>
                </div>
              </div>

              <div class="aim-row-actions">
                <button
                  type="button"
                  class="aim-icon"
                  data-action="probe"
                  :title="t('ai_model_probe_h', '自检：真实调用一次上游（会产生一次极小请求）')"
                  :disabled="!!probing[it.model]"
                  @click="runProbe(it.model)"
                >
                  <Activity :size="14" :class="{ 'aim-spin': !!probing[it.model] }" />
                </button>
                <button
                  type="button"
                  class="aim-icon"
                  data-action="config"
                  :title="t('ai_model_cfg_edit', '配置')"
                  @click="openEditor(it.model)"
                >
                  <Settings2 :size="14" />
                </button>
                <button
                  type="button"
                  class="aim-icon"
                  data-action="toggle"
                  :title="isEnabled(it) ? t('ai_model_disable', '停用（不会删除配置）') : t('ai_model_enable', '启用')"
                  @click="toggleEnabled(it)"
                >
                  <Power :size="14" />
                </button>
                <button
                  type="button"
                  class="aim-icon"
                  data-action="clear"
                  :disabled="!it.isOverridden"
                  :title="t('ai_model_clear_h', '清除自定义值，回到预设（不删除模型、不改启用状态）')"
                  @click="clearOverrides(it.model)"
                >
                  <Eraser :size="14" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 不适用对话：默认折叠 + 默认不启用（"只看对话模型"筛选下整块隐藏） -->
        <div v-if="nonChatAllCount > 0 && !onlyChat" class="aim-group">
          <button
            type="button"
            class="aim-group-head aim-group-head--toggle"
            data-action="toggle-nonchat"
            @click="nonChatOpen = !nonChatOpen"
          >
            <ChevronRight :size="12" class="aim-chev" :class="{ open: nonChatExpanded }" />
            <span>{{ t('ai_model_group_nonchat', '不适用对话') }}</span>
            <span class="aim-count">{{ nonChatAllCount }}</span>
            <span class="aim-group-why">
              {{ tf('ai_model_group_nonchat_why', '{kinds}，不用于对话（默认不启用）', { kinds: nonChatWhy }) }}
            </span>
          </button>
          <template v-if="nonChatExpanded">
            <div class="aim-chips">
              <button
                v-for="it in nonChatItems"
                :key="it.model"
                type="button"
                class="aim-chip"
                :class="{ 'aim-chip--on': isEnabled(it) }"
                :data-model="it.model"
                :title="chipTitle(it)"
                @click="toggleEnabled(it)"
              >
                <Check v-if="isEnabled(it)" :size="11" class="aim-chip-check" />
                <span class="aim-chip-name">{{ modelDisplayName(it) }}</span>
              </button>
              <span v-if="nonChatItems.length === 0" class="aim-empty">{{
                t('ai_model_none_match', '没有匹配的模型')
              }}</span>
            </div>
            <div class="aim-rows">
              <div
                v-for="it in nonChatItems"
                :key="`row-${it.model}`"
                class="aim-row"
                :data-model="it.model"
                @dragover.prevent
                @drop="onDrop(it.model)"
              >
                <span
                  class="aim-drag"
                  draggable="true"
                  :title="t('ai_model_drag_h', '拖拽排序：决定聊天里模型选择器的顺序')"
                  @dragstart="onDragStart(it.model)"
                  @dragend="onDragEnd"
                >
                  <GripVertical :size="13" />
                </span>
                <div class="aim-row-main">
                  <div class="aim-row-name">
                    <span class="aim-row-model">{{ modelDisplayName(it) }}</span>
                    <span class="aim-badge aim-badge--none">{{
                      t(APPLICABILITY_LABEL_KEYS[it.applicability], APPLICABILITY_LABELS[it.applicability])
                    }}</span>
                    <span v-if="!isEnabled(it)" class="aim-badge aim-badge--off">
                      {{ t('ai_model_badge_off', '未启用') }}
                    </span>
                  </div>
                  <div class="aim-cfg-sum">{{ summary(it) }}</div>
                  <div v-if="probeResults[it.model]" class="aim-probe" :class="`aim-probe--${probeState(it.model)}`">
                    <span class="aim-probe-line" :data-probe="probeState(it.model)">{{ probeLine(it.model) }}</span>
                  </div>
                </div>
                <div class="aim-row-actions">
                  <button
                    type="button"
                    class="aim-icon"
                    data-action="probe"
                    :title="t('ai_model_probe_h', '自检：真实调用一次上游（会产生一次极小请求）')"
                    :disabled="!!probing[it.model]"
                    @click="runProbe(it.model)"
                  >
                    <Activity :size="14" />
                  </button>
                  <button
                    type="button"
                    class="aim-icon"
                    data-action="config"
                    :title="t('ai_model_cfg_edit', '配置')"
                    @click="openEditor(it.model)"
                  >
                    <Settings2 :size="14" />
                  </button>
                  <button
                    type="button"
                    class="aim-icon"
                    data-action="toggle"
                    :title="
                      isEnabled(it) ? t('ai_model_disable', '停用（不会删除配置）') : t('ai_model_enable', '启用')
                    "
                    @click="toggleEnabled(it)"
                  >
                    <Power :size="14" />
                  </button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </template>

      <!-- 配置弹窗：逐字段来源 + 单项恢复 -->
      <ModalDialog :open="editingModel !== null" :title="modalTitle" max-width="580px" @close="closeEditor">
        <div v-if="editingItem" class="aim-form">
          <div class="aim-form-bar">
            <span class="aim-badge" :class="sourceClass(editingItem)">{{ sourceLabel(editingItem) }}</span>
            <Button size="sm" variant="ghost" class="aim-cfg-restore shrink-0" :disabled="busy" @click="restorePreset">
              <RotateCcw :size="12" />
              {{ t('ai_model_cfg_restore', '恢复预设') }}
            </Button>
          </div>
          <div class="aim-form-note">
            {{
              t(
                'ai_model_cfg_restore_hint',
                '「恢复预设」清除该模型的能力参数覆盖（上下文/输出/模态/推理），回到内置预设；不改启用状态、别名与排序。',
              )
            }}
          </div>
          <div class="aim-form-note">
            {{
              t(
                'ai_model_field_source_hint',
                '每个字段的「来自预设 / 你改过」由本地改动记录 + 模型级预设标记推断（接口暂不返回逐字段标记）；点字段右侧的小箭头可只恢复该字段。',
              )
            }}
          </div>

          <div class="aim-field">
            <div class="aim-field-head">
              <label class="aim-label">{{ t('ai_model_cfg_context', '上下文窗口 (tokens)') }}</label>
              <span class="aim-src" :class="`aim-src--${fieldSource(editingItem.model, 'contextWindow')}`">
                {{ fieldSourceLabel(fieldSource(editingItem.model, 'contextWindow')) }}
              </span>
              <button
                type="button"
                class="aim-field-restore"
                data-action="restore-contextWindow"
                :disabled="!canRestoreField(editingItem.model, 'contextWindow')"
                :title="t('ai_model_field_restore_h', '只恢复该字段为预设值')"
                @click="restoreField('contextWindow')"
              >
                <RotateCcw :size="11" />
              </button>
            </div>
            <Input
              :model-value="draft.contextWindow"
              type="number"
              class="aim-input"
              :placeholder="t('ai_model_cfg_leave_empty', '留空 = 用预设')"
              @update:model-value="(v: string | number) => (draft.contextWindow = asText(v))"
            />
          </div>

          <div class="aim-field">
            <div class="aim-field-head">
              <label class="aim-label">{{ t('ai_model_cfg_max_output', '最大输出 (tokens)') }}</label>
              <span class="aim-src" :class="`aim-src--${fieldSource(editingItem.model, 'maxOutput')}`">
                {{ fieldSourceLabel(fieldSource(editingItem.model, 'maxOutput')) }}
              </span>
              <button
                type="button"
                class="aim-field-restore"
                data-action="restore-maxOutput"
                :disabled="!canRestoreField(editingItem.model, 'maxOutput')"
                :title="t('ai_model_field_restore_h', '只恢复该字段为预设值')"
                @click="restoreField('maxOutput')"
              >
                <RotateCcw :size="11" />
              </button>
            </div>
            <Input
              :model-value="draft.maxOutput"
              type="number"
              class="aim-input"
              :placeholder="t('ai_model_cfg_leave_empty', '留空 = 用预设')"
              @update:model-value="(v: string | number) => (draft.maxOutput = asText(v))"
            />
          </div>

          <div class="aim-field">
            <label class="aim-label">{{ t('ai_model_cfg_multimodal', '多模态能力') }}</label>
            <div class="aim-switch-list">
              <div
                v-for="f in ['supportsText', 'supportsImage', 'supportsVideo', 'supportsAudio'] as const"
                :key="f"
                class="aim-switch-row"
              >
                <span class="aim-switch-name">
                  {{
                    f === 'supportsText'
                      ? t('ai_model_cfg_text', '文本')
                      : f === 'supportsImage'
                        ? t('ai_model_cfg_image', '识图')
                        : f === 'supportsVideo'
                          ? t('ai_model_cfg_video', '视频')
                          : t('ai_model_cfg_audio', '音频')
                  }}
                </span>
                <span class="aim-src" :class="`aim-src--${fieldSource(editingItem.model, f)}`">
                  {{ fieldSourceLabel(fieldSource(editingItem.model, f)) }}
                </span>
                <button
                  type="button"
                  class="aim-field-restore"
                  :data-action="`restore-${f}`"
                  :disabled="!canRestoreField(editingItem.model, f)"
                  :title="t('ai_model_field_restore_h', '只恢复该字段为预设值')"
                  @click="restoreField(f)"
                >
                  <RotateCcw :size="11" />
                </button>
                <Switch :model-value="draft[f]" @update:model-value="(v: boolean) => (draft[f] = v)" />
              </div>
            </div>
          </div>

          <div class="aim-field">
            <label class="aim-label">{{ t('ai_model_cfg_reasoning', '推理（思考强度下发）') }}</label>
            <div class="aim-switch-row">
              <span class="aim-switch-name">{{ t('ai_model_cfg_reasoning_on', '启用推理') }}</span>
              <span class="aim-src" :class="`aim-src--${fieldSource(editingItem.model, 'reasoningEnabled')}`">
                {{ fieldSourceLabel(fieldSource(editingItem.model, 'reasoningEnabled')) }}
              </span>
              <button
                type="button"
                class="aim-field-restore"
                data-action="restore-reasoningEnabled"
                :disabled="!canRestoreField(editingItem.model, 'reasoningEnabled')"
                :title="t('ai_model_field_restore_h', '只恢复该字段为预设值')"
                @click="restoreField('reasoningEnabled')"
              >
                <RotateCcw :size="11" />
              </button>
              <Switch
                :model-value="draft.reasoningEnabled"
                @update:model-value="(v: boolean) => (draft.reasoningEnabled = v)"
              />
            </div>
            <div class="aim-sub-label">
              {{ t('ai_model_cfg_reasoning_protocol', '推理协议') }}
              <span class="aim-src" :class="`aim-src--${fieldSource(editingItem.model, 'reasoningProtocol')}`">
                {{ fieldSourceLabel(fieldSource(editingItem.model, 'reasoningProtocol')) }}
              </span>
              <button
                type="button"
                class="aim-field-restore"
                data-action="restore-reasoningProtocol"
                :disabled="!canRestoreField(editingItem.model, 'reasoningProtocol')"
                :title="t('ai_model_field_restore_h', '只恢复该字段为预设值')"
                @click="restoreField('reasoningProtocol')"
              >
                <RotateCcw :size="11" />
              </button>
            </div>
            <CustomSelect
              :model-value="draft.reasoningProtocol"
              @update:model-value="(v: string) => (draft.reasoningProtocol = v as ReasoningProtocol)"
            >
              {{ protocolLabel(draft.reasoningProtocol) }}
              <template #options>
                <CustomSelectOption
                  v-for="p in REASONING_PROTOCOLS"
                  :key="p"
                  :value="p"
                  :selected="draft.reasoningProtocol === p"
                  @select="(v: string) => (draft.reasoningProtocol = v as ReasoningProtocol)"
                >
                  {{ protocolLabel(p) }}
                </CustomSelectOption>
              </template>
            </CustomSelect>
            <div class="aim-form-note">
              {{
                t(
                  'ai_model_cfg_reasoning_protocol_hint',
                  '决定"思考强度"如何下发到该模型；沿用系统默认 = 保持既有行为不变。不确定时点行内「自检」，会按实际结果建议协议。',
                )
              }}
            </div>
          </div>

          <div v-if="modalError" class="aim-form-error">{{ modalError }}</div>
        </div>

        <template #footer>
          <Button variant="outline" class="aim-modal-btn" :disabled="busy" @click="closeEditor">
            {{ t('cancel_btn', '取消') }}
          </Button>
          <Button class="aim-modal-btn" :disabled="busy || !dirty" @click="saveDraft">
            {{ busy ? t('ai_model_cfg_saving', '保存中…') : t('ai_model_cfg_save', '保存配置') }}
          </Button>
        </template>
      </ModalDialog>
    </template>
  </div>
</template>

<style scoped>
.aim-cfg {
  margin-top: 12px;
}
.aim-cfg-head {
  margin-bottom: 8px;
}
.aim-cfg-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  padding-left: 2px;
}
.aim-cfg-hint {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-tertiary);
  margin-top: 2px;
  padding-left: 2px;
}
.aim-cfg-note {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-tertiary);
  padding: 8px 10px;
  border: 1px dashed var(--border-subtle);
  border-radius: var(--radius-md);
  margin-top: 6px;
}
.aim-cfg-note--warn {
  color: var(--text-secondary);
  border-color: var(--border-default);
  background: var(--bg-hover);
}
.aim-cfg-link {
  margin-left: 6px;
  border: none;
  background: none;
  padding: 0;
  color: var(--accent);
  font-size: 11.5px;
  cursor: pointer;
  text-decoration: underline;
}

/* ===== 草稿态配置卡片：一行概要 + 可选展开的完整表单（字段样式复用上面 .aim-form 那套）===== */
.aim-draft-card {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface, transparent);
  /* 入选/移除不做突兀跳动：140ms 的淡入 + 3px 位移（≤160ms） */
  animation: aim-draft-card-in 140ms ease-out;
}
@keyframes aim-draft-card-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
/* 减少动效：设置页开关（html.reduce-motion）∪ 系统偏好，任一命中都不动 */
html.reduce-motion .aim-draft-card,
html.reduce-motion .aim-draft-form {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  .aim-draft-card,
  .aim-draft-form {
    animation: none;
  }
}
/* 折叠概要行：与已保存态的 .aim-row 同构 */
.aim-draft-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
/* 展开的完整表单：同样 140ms 淡入 + 3px 位移（收起时直接卸载，不做假动画） */
.aim-draft-form {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
  animation: aim-draft-card-in 140ms ease-out;
}

/* 工具条 */
.aim-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.aim-search {
  flex: 1;
  min-width: 0;
  height: 30px;
}
.aim-filter {
  flex-shrink: 0;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11.5px;
  cursor: pointer;
}
.aim-filter:hover {
  border-color: var(--border-focus);
  color: var(--text-primary);
}
.aim-filter.on {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
}
.aim-filter:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 批量启用/停用（只有点这里才会写库） */
.aim-bulk {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.aim-bulk-running {
  font-size: 11.5px;
  color: var(--text-tertiary);
}
.aim-bulk-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
}
.aim-bulk-confirm-text {
  flex: 1;
  min-width: 220px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-secondary);
}
.aim-bulk-result {
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: var(--radius-md);
  font-size: 11.5px;
  line-height: 1.55;
}
.aim-bulk-result--success {
  background: var(--success-bg);
  color: var(--success);
}
.aim-bulk-result--error {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}

/* 建议条 */
.aim-suggest {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.aim-suggest-text {
  flex: 1;
  min-width: 200px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-secondary);
}
.aim-suggest-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.aim-suggest-x {
  width: 22px;
  height: 22px;
}

/* 分组 */
.aim-group {
  margin-top: 10px;
}
.aim-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0 2px 6px;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  text-align: left;
}
.aim-group-head--toggle {
  cursor: pointer;
}
.aim-chev.open {
  transform: rotate(90deg);
}
.aim-count {
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
}
.aim-group-why {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-tertiary);
}
.aim-empty {
  font-size: 11.5px;
  color: var(--text-tertiary);
  padding: 4px 2px;
}

/* 单排胶囊 */
.aim-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.aim-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
}
.aim-chip:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.aim-chip--on {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 500;
}
.aim-chip-check {
  flex-shrink: 0;
}
.aim-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 行 */
.aim-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.aim-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface, transparent);
}
.aim-drag {
  display: inline-flex;
  align-items: center;
  padding-top: 2px;
  color: var(--text-tertiary);
  cursor: grab;
  flex-shrink: 0;
}
.aim-row-main {
  flex: 1;
  min-width: 0;
}
.aim-row-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.aim-row-model {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aim-row-orig {
  font-size: 11px;
  color: var(--text-tertiary);
}
.aim-cfg-sum {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aim-badge {
  display: inline-block;
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  flex-shrink: 0;
}
.aim-badge--preset {
  background: var(--accent-bg);
  color: var(--accent);
}
.aim-badge--custom {
  background: var(--success-bg);
  color: var(--success);
}
.aim-badge--none {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}
.aim-badge--off {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}
.aim-alias-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.aim-alias-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 11.5px;
  outline: none;
}
.aim-mini {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.aim-mini:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.aim-row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.aim-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.aim-icon:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--border-default);
  color: var(--text-primary);
}
.aim-icon:disabled {
  opacity: 0.4;
  cursor: default;
}
.aim-spin {
  animation: aim-probe-spin 0.9s linear infinite;
}
@keyframes aim-probe-spin {
  to {
    transform: rotate(360deg);
  }
}
/* reduce-motion（设置开关 html.reduce-motion ∪ 系统偏好）下不转 */
html.reduce-motion .aim-spin {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  .aim-spin {
    animation: none;
  }
}

/* 自检结果 */
.aim-probe {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 5px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  line-height: 1.5;
}
.aim-probe--ok {
  background: var(--success-bg);
  color: var(--success);
}
.aim-probe--warn {
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  color: var(--warning);
}
.aim-probe--fail {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}

/* 弹窗表单 */
.aim-form-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
}
.aim-form-note {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-tertiary);
  margin-top: 6px;
  padding-left: 2px;
}
.aim-field {
  margin-top: 14px;
}
.aim-field-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.aim-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  padding-left: 2px;
}
.aim-sub-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  margin: 10px 0 6px;
  padding-left: 2px;
}
.aim-src {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
}
.aim-src--preset {
  background: var(--accent-bg);
  color: var(--accent);
}
.aim-src--user {
  background: var(--success-bg);
  color: var(--success);
}
.aim-src--pending {
  background: color-mix(in srgb, var(--warning) 15%, transparent);
  color: var(--warning);
}
.aim-field-restore {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.aim-field-restore:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--border-default);
  color: var(--text-primary);
}
.aim-field-restore:disabled {
  opacity: 0.35;
  cursor: default;
}
.aim-input {
  width: 100%;
}
.aim-switch-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.aim-switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
}
.aim-switch-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text-primary);
}
.aim-cfg-restore {
  height: 28px;
  padding: 0 10px;
  gap: 5px;
}
.aim-form-error {
  margin-top: 12px;
  font-size: 12px;
  color: var(--danger);
}
.aim-modal-btn {
  min-width: 88px;
  height: 34px;
  padding: 0 14px;
}
.aim-form :deep(.custom-select) {
  width: 100%;
}
.aim-form :deep(input) {
  padding-left: 12px;
  padding-right: 12px;
}
</style>
