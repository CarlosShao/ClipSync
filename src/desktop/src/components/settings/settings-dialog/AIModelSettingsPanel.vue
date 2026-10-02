<script setup lang="ts">
// === 模型级配置面板（设置 → AI → 供应商编辑 → 模型 区块）===
// 现状问题：模型那块只有一个标签多选 + 一个「刷新模型列表」，上下文窗口只能给"整个供应商"填一个数，
// 多模态能力/推理协议无从配置。本面板把每个已选模型做成一行，可就地展开配置：
//   上下文窗口 / 最大输出 / 四路多模态能力（文本·识图·视频·音频）/
//   推理开关 + 推理协议（思考强度怎么下发）+ 三档强度映射（low·medium·high）
// 并展示来源标记（预设 / 已自定义）与「恢复预设」。
//
// 契约：src/desktop/src/api/modelSettings.ts（GET/PUT /api/ai/model-settings，已冻结字段名）。
// 刷新模型列表后由父组件调用 reload() 自动拉取，用户不需要手动点。
//
// 与父组件「多选」的关系：本面板只读 props.models 渲染，绝不写回 formSelectedModels，
// 因此打开/关闭/保存配置都不会弄丢用户当前的模型多选。
//
// 服务端接口未落地时的降级：GET 失败（如 404）时如实提示"无法读取预设配置"并给出重试，
// 不伪造预设值；此时保存供应商/模型列表等既有功能不受影响。
//
// 动效：本组件不引入任何过渡或关键帧（0 动画天然满足 reduce-motion，无需再挂 useReducedMotion）；
// 唯一弹窗动画来自项目既有 ModalDialog（≤150ms，且 globals.css 的 reduce-motion 会压掉）。
import { computed, ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Switch from '@/components/ui/switch/Switch.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'
import { RotateCcw, Settings2 } from 'lucide-vue-next'
import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  LEVEL_VALUE_MAX_LEN,
  MAX_OUTPUT_MAX,
  MAX_OUTPUT_MIN,
  REASONING_PROTOCOLS,
  REASONING_PROTOCOL_LABELS,
  REASONING_PROTOCOL_LABEL_KEYS,
  RESTORE_PRESET_PATCH,
  defaultModelSetting,
  getModelSettings,
  isValidLevelValue,
  isValidTokenCount,
  normalizeModelSettingItem,
  putModelSetting,
  type ModelSettingItem,
  type ModelSettingPatch,
  type ReasoningLevels,
  type ReasoningProtocol,
} from '@/api/modelSettings'

const props = defineProps<{
  /** 已保存的供应商 id（uuid）；新增未保存的供应商没有 id，父组件不渲染本面板 */
  providerId: string
  /** 该供应商已启用的模型（父组件的标签多选结果，本面板只读） */
  models: string[]
}>()

const { t, tf } = useI18n()
const toast = useSonner()

const items = ref<ModelSettingItem[]>([])
const loading = ref(false)
/** 非空 = 接口不可用/读取失败（如实展示，不用本地默认值冒充服务端预设） */
const loadError = ref('')

const editingModel = ref<string | null>(null)
const saving = ref(false)
/** 保存/恢复在途：同一把闸门，防重复提交 */
const submitting = ref(false)

const itemMap = computed(() => {
  const map = new Map<string, ModelSettingItem>()
  for (const it of items.value) map.set(it.model, it)
  return map
})

/** 面板行 = 父组件已选模型；服务端没给数据的模型用本地占位（标记为"无预设"） */
const rows = computed<ModelSettingItem[]>(() => props.models.map((m) => itemMap.value.get(m) ?? defaultModelSetting(m)))

const editingItem = computed<ModelSettingItem | null>(
  () => rows.value.find((r) => r.model === editingModel.value) ?? null,
)

function protocolLabel(p: ReasoningProtocol): string {
  return t(REASONING_PROTOCOL_LABEL_KEYS[p], REASONING_PROTOCOL_LABELS[p])
}

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

// ===== 表单草稿（字符串承载数字输入，空串 = 用预设）=====

interface Draft {
  contextWindow: string
  maxOutput: string
  supportsText: boolean
  supportsImage: boolean
  supportsVideo: boolean
  supportsAudio: boolean
  reasoningEnabled: boolean
  reasoningProtocol: ReasoningProtocol
  levelLow: string
  levelMedium: string
  levelHigh: string
}

const draft = ref<Draft>(emptyDraft())
const baseline = ref<Draft>(emptyDraft())
const modalError = ref('')

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
    levelLow: '',
    levelMedium: '',
    levelHigh: '',
  }
}

function draftFromItem(item: ModelSettingItem): Draft {
  const lv = item.reasoningLevels || {}
  return {
    contextWindow: item.contextWindow == null ? '' : String(item.contextWindow),
    maxOutput: item.maxOutput == null ? '' : String(item.maxOutput),
    supportsText: item.supportsText,
    supportsImage: item.supportsImage,
    supportsVideo: item.supportsVideo,
    supportsAudio: item.supportsAudio,
    reasoningEnabled: item.reasoningEnabled,
    reasoningProtocol: item.reasoningProtocol,
    levelLow: lv.low == null ? '' : String(lv.low),
    levelMedium: lv.medium == null ? '' : String(lv.medium),
    levelHigh: lv.high == null ? '' : String(lv.high),
  }
}

const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(baseline.value))
const busy = computed(() => saving.value || submitting.value)

/**
 * 数字输入归一：`<input type="number">` 经 Vue v-model 会给出 number（canCastToNumber），
 * 空值仍为 ''。草稿一律按字符串承载，避免比较/校验里出现 number.trim 之类的类型事故。
 */
function asText(v: string | number | null | undefined): string {
  return v == null ? '' : String(v)
}

function openEditor(model: string) {
  const item = rows.value.find((r) => r.model === model)
  if (!item) return
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

/** 三档映射：留空的档位不写进对象（= 同名/交给服务端）；全空则提交 null（清除覆盖） */
function levelsFromDraft(d: Draft): ReasoningLevels | null {
  const out: ReasoningLevels = {}
  const low = d.levelLow.trim()
  const medium = d.levelMedium.trim()
  const high = d.levelHigh.trim()
  if (low) out.low = low
  if (medium) out.medium = medium
  if (high) out.high = high
  return Object.keys(out).length > 0 ? out : null
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
  const levelsChanged =
    d.levelLow.trim() !== b.levelLow.trim() ||
    d.levelMedium.trim() !== b.levelMedium.trim() ||
    d.levelHigh.trim() !== b.levelHigh.trim()
  if (levelsChanged) patch.reasoningLevels = levelsFromDraft(d)
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
  // 三档映射取值：服务端只收非空短串（≤64）；留空 = 与档位同名，合法
  for (const [lv, label] of [
    [d.levelLow, t('ai_model_cfg_level_low', '低')],
    [d.levelMedium, t('ai_model_cfg_level_medium', '中')],
    [d.levelHigh, t('ai_model_cfg_level_high', '高')],
  ] as const) {
    if (lv.trim() !== '' && !isValidLevelValue(lv)) {
      return tf('ai_model_cfg_err_level', '{level} 档的取值需为 {max} 个字符以内的短串', {
        level: label,
        max: LEVEL_VALUE_MAX_LEN,
      })
    }
  }
  return ''
}

function upsertItem(item: ModelSettingItem) {
  const next = items.value.filter((i) => i.model !== item.model)
  next.push(item)
  items.value = next
}

/** 服务端未回传 item 时的本地乐观合并（仅用于让界面与现实一致，不改写来源标记口径） */
function mergePatchLocally(model: string, patch: ModelSettingPatch) {
  const current = itemMap.value.get(model) ?? defaultModelSetting(model)
  const merged: ModelSettingItem = { ...current, ...patch, model } as ModelSettingItem
  if ('reasoningProtocol' in patch && patch.reasoningProtocol) {
    merged.reasoningProtocol = patch.reasoningProtocol
  }
  merged.reasoningLevels = 'reasoningLevels' in patch ? (patch.reasoningLevels ?? null) : current.reasoningLevels
  merged.isOverridden = true
  upsertItem(merged)
}

async function saveDraft() {
  const model = editingModel.value
  if (!model || busy.value) return
  modalError.value = validateDraft()
  if (modalError.value) return
  const patch = buildPatch()
  // 没有任何改动：不打扰服务端，直接收起
  if (Object.keys(patch).length === 0) {
    closeEditor()
    return
  }
  saving.value = true
  submitting.value = true
  try {
    const res = await putModelSetting(props.providerId, model, patch)
    if (res.ok && res.data?.item) {
      upsertItem(normalizeModelSettingItem(res.data.item))
      toast.show(t('ai_model_cfg_saved', '模型配置已保存'), 'success')
      closeEditor()
    } else if (res.ok) {
      mergePatchLocally(model, patch)
      toast.show(t('ai_model_cfg_saved', '模型配置已保存'), 'success')
      closeEditor()
    } else {
      modalError.value = res.error || t('ai_model_cfg_save_fail', '保存模型配置失败')
    }
  } catch (e) {
    modalError.value = String((e as Error)?.message || e)
  } finally {
    saving.value = false
    submitting.value = false
  }
}

/**
 * 恢复预设：提交全字段 null（reasoningProtocol 用 inherit）请服务端清除该模型的覆盖。
 * 若服务端当前不支持清除语义，返回的 item 会保持原值——界面按返回结果显示，不假装已恢复。
 */
async function restorePreset() {
  const model = editingModel.value
  if (!model || busy.value) return
  submitting.value = true
  modalError.value = ''
  try {
    const res = await putModelSetting(props.providerId, model, { ...RESTORE_PRESET_PATCH })
    if (res.ok) {
      if (res.data?.item) upsertItem(normalizeModelSettingItem(res.data.item))
      else mergePatchLocally(model, { ...RESTORE_PRESET_PATCH })
      toast.show(t('ai_model_cfg_restored', '已提交恢复预设'), 'success')
      closeEditor()
    } else {
      modalError.value = res.error || t('ai_model_cfg_restore_fail', '恢复预设失败')
    }
  } catch (e) {
    modalError.value = String((e as Error)?.message || e)
  } finally {
    submitting.value = false
  }
}

/** 拉取该供应商的模型配置（父组件在刷新模型列表后会调用 reload） */
async function load() {
  if (!props.providerId) return
  loading.value = true
  loadError.value = ''
  try {
    const res = await getModelSettings(props.providerId)
    if (res.ok && res.data) {
      items.value = (res.data.items || []).map((i) => normalizeModelSettingItem(i))
    } else {
      loadError.value = res.error || `HTTP ${res.status}`
    }
  } catch (e) {
    loadError.value = String((e as Error)?.message || e)
  } finally {
    loading.value = false
  }
}

defineExpose({ reload: load })

watch(
  () => props.providerId,
  () => {
    closeEditor()
    void load()
  },
  { immediate: true },
)

const modalTitle = computed(() =>
  tf('ai_model_cfg_modal_title', '配置模型：{model}', { model: editingModel.value || '' }),
)
</script>

<template>
  <div class="aim-cfg">
    <div class="aim-cfg-head">
      <div class="aim-cfg-title">{{ t('ai_model_cfg_title', '模型配置') }}</div>
      <div class="aim-cfg-hint">
        {{
          t(
            'ai_model_cfg_hint',
            '逐个配置上下文窗口、最大输出、多模态能力与推理协议；留空的项使用预设默认值（预设值由服务端下发）。',
          )
        }}
      </div>
    </div>

    <div v-if="loading" class="aim-cfg-note">{{ t('ai_model_cfg_loading', '正在读取预设配置…') }}</div>
    <div v-else-if="loadError" class="aim-cfg-note aim-cfg-note--warn">
      <span>{{
        t('ai_model_cfg_load_fail', '无法读取模型预设配置（接口未就绪或网络异常），下面显示的是本地占位值。')
      }}</span>
      <button type="button" class="aim-cfg-link" @click="load()">
        {{ t('ai_model_cfg_retry', '重试') }}
      </button>
    </div>

    <div v-if="models.length === 0" class="aim-cfg-note">
      {{ t('ai_model_cfg_empty', '先选择至少一个模型，再逐个配置参数。') }}
    </div>
    <div v-else class="aim-cfg-list">
      <div v-for="item in rows" :key="item.model" class="aim-cfg-row">
        <div class="aim-cfg-row-main">
          <div class="aim-cfg-row-name">
            <span class="aim-cfg-model">{{ item.model }}</span>
            <span class="aim-badge" :class="sourceClass(item)">{{ sourceLabel(item) }}</span>
          </div>
          <div class="aim-cfg-sum">{{ summary(item) }}</div>
        </div>
        <Button size="sm" variant="outline" class="aim-cfg-edit shrink-0" @click="openEditor(item.model)">
          <Settings2 :size="12" />
          {{ t('ai_model_cfg_edit', '配置') }}
        </Button>
      </div>
    </div>

    <ModalDialog :open="editingModel !== null" :title="modalTitle" max-width="560px" @close="closeEditor">
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
              '恢复预设会把该模型的全部覆盖项提交为 null 清除：数值回退内置预设，多模态/推理开关与三档映射回退预设值，推理协议回到「沿用系统默认」（服务端把 null 映射为 inherit），随后按服务端返回的最新值显示。',
            )
          }}
        </div>

        <div class="aim-field">
          <label class="aim-label">{{ t('ai_model_cfg_context', '上下文窗口 (tokens)') }}</label>
          <Input
            :model-value="draft.contextWindow"
            type="number"
            class="aim-input"
            :placeholder="t('ai_model_cfg_leave_empty', '留空 = 用预设')"
            @update:model-value="(v: string | number) => (draft.contextWindow = asText(v))"
          />
        </div>

        <div class="aim-field">
          <label class="aim-label">{{ t('ai_model_cfg_max_output', '最大输出 (tokens)') }}</label>
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
            <div class="aim-switch-row">
              <span class="aim-switch-name">{{ t('ai_model_cfg_text', '文本') }}</span>
              <Switch
                :model-value="draft.supportsText"
                @update:model-value="(v: boolean) => (draft.supportsText = v)"
              />
            </div>
            <div class="aim-switch-row">
              <span class="aim-switch-name">{{ t('ai_model_cfg_image', '识图') }}</span>
              <Switch
                :model-value="draft.supportsImage"
                @update:model-value="(v: boolean) => (draft.supportsImage = v)"
              />
            </div>
            <div class="aim-switch-row">
              <span class="aim-switch-name">{{ t('ai_model_cfg_video', '视频') }}</span>
              <Switch
                :model-value="draft.supportsVideo"
                @update:model-value="(v: boolean) => (draft.supportsVideo = v)"
              />
            </div>
            <div class="aim-switch-row">
              <span class="aim-switch-name">{{ t('ai_model_cfg_audio', '音频') }}</span>
              <Switch
                :model-value="draft.supportsAudio"
                @update:model-value="(v: boolean) => (draft.supportsAudio = v)"
              />
            </div>
          </div>
        </div>

        <div class="aim-field">
          <label class="aim-label">{{ t('ai_model_cfg_reasoning', '推理（思考强度下发）') }}</label>
          <div class="aim-switch-row">
            <span class="aim-switch-name">{{ t('ai_model_cfg_reasoning_on', '启用推理') }}</span>
            <Switch
              :model-value="draft.reasoningEnabled"
              @update:model-value="(v: boolean) => (draft.reasoningEnabled = v)"
            />
          </div>
          <div class="aim-sub-label">{{ t('ai_model_cfg_reasoning_protocol', '推理协议') }}</div>
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
                '决定"思考强度"如何下发到该模型；沿用系统默认 = 保持既有行为不变。',
              )
            }}
          </div>
        </div>

        <div class="aim-field">
          <label class="aim-label">{{ t('ai_model_cfg_levels', '思考强度映射') }}</label>
          <div class="aim-levels">
            <div class="aim-level">
              <span class="aim-level-name">{{ t('ai_model_cfg_level_low', '低') }}</span>
              <Input v-model="draft.levelLow" class="aim-input" :placeholder="t('ai_model_cfg_level_ph', '同名')" />
            </div>
            <div class="aim-level">
              <span class="aim-level-name">{{ t('ai_model_cfg_level_medium', '中') }}</span>
              <Input v-model="draft.levelMedium" class="aim-input" :placeholder="t('ai_model_cfg_level_ph', '同名')" />
            </div>
            <div class="aim-level">
              <span class="aim-level-name">{{ t('ai_model_cfg_level_high', '高') }}</span>
              <Input v-model="draft.levelHigh" class="aim-input" :placeholder="t('ai_model_cfg_level_ph', '同名')" />
            </div>
          </div>
          <div class="aim-form-note">
            {{ t('ai_model_cfg_levels_hint', '留空表示与档位同名（low / medium / high），由服务端按协议映射。') }}
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
.aim-cfg-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.aim-cfg-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface, transparent);
}
.aim-cfg-row-main {
  flex: 1;
  min-width: 0;
}
.aim-cfg-row-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.aim-cfg-model {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
/* 弹窗内表单 */
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
.aim-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
  padding-left: 2px;
}
.aim-sub-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 10px 0 6px;
  padding-left: 2px;
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
  justify-content: space-between;
  gap: 12px;
  min-height: 30px;
}
.aim-switch-name {
  font-size: 12.5px;
  color: var(--text-primary);
}
.aim-levels {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.aim-level {
  display: flex;
  align-items: center;
  gap: 10px;
}
.aim-level-name {
  width: 24px;
  flex-shrink: 0;
  font-size: 12.5px;
  color: var(--text-secondary);
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
.aim-cfg-edit {
  height: 28px;
  padding: 0 10px;
  gap: 5px;
}
.aim-cfg-restore {
  height: 28px;
  padding: 0 10px;
  gap: 5px;
}
.aim-form :deep(.custom-select) {
  width: 100%;
}
.aim-form :deep(input) {
  padding-left: 12px;
  padding-right: 12px;
}
</style>
