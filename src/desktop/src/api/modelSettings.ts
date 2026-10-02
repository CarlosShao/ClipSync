// === 模型库 API（设置 → AI → 供应商编辑 → 模型库）===
// 需求（契约 v3）：模型不再只是"名字"——每个模型可单独配置上下文窗口 / 最大输出 /
// 多模态能力（文本·识图·视频·音频）/ 推理协议，并且能启用停用、起显示别名、排序、
// 按 applicability 分组（音频/图像/嵌入不用于对话）、以及**按需**真实调用上游做能力自检。
//
// 契约 v3（字段名以此为准；服务端并行实现中，本文件按契约写，缺字段时按下面注释优雅降级）：
//   GET  /api/ai/model-settings?providerId=<uuid>
//        → 200 { items: [ { model, contextWindow, maxOutput,
//                           supportsText, supportsImage, supportsVideo, supportsAudio,
//                           reasoningEnabled, reasoningProtocol,
//                           enabled, alias, sortOrder,
//                           applicability: 'chat'|'audio'|'image'|'embedding'|'other',
//                           isPreset, isOverridden } ] }
//   PUT  /api/ai/model-settings
//        body { providerId, model, patch: { contextWindow?, maxOutput?, supportsText?,
//               supportsImage?, supportsVideo?, supportsAudio?, reasoningEnabled?,
//               reasoningProtocol?, enabled?, alias?, sortOrder? } }
//        → 200 { ok: true, item: {…同上} }
//        · alias 空串 = 清除别名（回落到模型原名）；sortOrder null = 清除自定义顺序
//   POST /api/ai/model-settings/probe   body { providerId, model }
//        → 200 { ok, latencyMs, protocolTried, usedReasoningParam,
//                supportsReasoningParam: true|false|'unknown', suggestedProtocol?,
//                observedContextWindow?, upstreamStatus?, upstreamErrorCode?, upstreamMessage? }
//        **真实调用上游**（会产生一次极小请求），只在用户点「自检」时触发，绝不自动跑。
//
// 契约 v2 已移除 reasoningLevels（思考强度固定 5 档原样透传，见 src/utils/aiThinking.ts），
// 本文件同样不发送、不解析该字段。
//
// 端点需登录 + 真 CSRF，一律走项目统一的 api()（Bearer + X-CSRF-Token + 幂等键 + 401 刷新）。

import { api } from './client'

// ===== 推理协议 =====

/**
 * 推理协议白名单（与服务端枚举一一对应）。
 * 决定「思考强度」如何下发到该模型：
 *   - inherit                  沿用系统既有行为（不额外下发参数）
 *   - none                     明确不下发思考相关参数
 *   - openai_reasoning_effort  OpenAI Chat Completions 的 reasoning_effort
 *   - anthropic_thinking       Anthropic Messages 的 thinking.budget_tokens
 *   - output_config_effort     OpenAI 兼容网关的 output_config.effort
 *   - qwen_enable_thinking     通义千问 enable_thinking
 */
export const REASONING_PROTOCOLS = [
  'inherit',
  'none',
  'openai_reasoning_effort',
  'anthropic_thinking',
  'output_config_effort',
  'qwen_enable_thinking',
] as const

export type ReasoningProtocol = (typeof REASONING_PROTOCOLS)[number]

/**
 * 协议 → i18n key。界面优先读词典（中英都补），key 缺失时回退到下面的中文标签，
 * 避免出现裸 key（ai_model_reasoning_protocol_xxx）。
 */
export const REASONING_PROTOCOL_LABEL_KEYS: Record<ReasoningProtocol, string> = {
  inherit: 'ai_model_reasoning_protocol_inherit',
  none: 'ai_model_reasoning_protocol_none',
  openai_reasoning_effort: 'ai_model_reasoning_protocol_openai_reasoning_effort',
  anthropic_thinking: 'ai_model_reasoning_protocol_anthropic_thinking',
  output_config_effort: 'ai_model_reasoning_protocol_output_config_effort',
  qwen_enable_thinking: 'ai_model_reasoning_protocol_qwen_enable_thinking',
}

/** 协议 → 中文标签（词典缺 key 时的兜底文案，也是本常量对外导出的"中文标签"） */
export const REASONING_PROTOCOL_LABELS: Record<ReasoningProtocol, string> = {
  inherit: '沿用系统默认',
  none: '不下发思考参数',
  openai_reasoning_effort: 'OpenAI reasoning_effort',
  anthropic_thinking: 'Anthropic thinking',
  output_config_effort: 'OpenAI 兼容 output_config.effort',
  qwen_enable_thinking: '通义千问 enable_thinking',
}

/** 兜底：服务端返回未知/空协议时按 inherit 处理，不把脏值塞进下拉。 */
export function normalizeReasoningProtocol(value?: string | null): ReasoningProtocol {
  return REASONING_PROTOCOLS.includes(value as ReasoningProtocol) ? (value as ReasoningProtocol) : 'inherit'
}

// ===== 模型用途（applicability）=====

export const MODEL_APPLICABILITIES = ['chat', 'audio', 'image', 'embedding', 'other'] as const
export type ModelApplicability = (typeof MODEL_APPLICABILITIES)[number]

/** 用途 → i18n key（服务端下发 applicability 时直接用它渲染分组标题） */
export const APPLICABILITY_LABEL_KEYS: Record<ModelApplicability, string> = {
  chat: 'ai_model_app_chat',
  audio: 'ai_model_app_audio',
  image: 'ai_model_app_image',
  embedding: 'ai_model_app_embedding',
  other: 'ai_model_app_other',
}

/** 用途 → 中文兜底标签 */
export const APPLICABILITY_LABELS: Record<ModelApplicability, string> = {
  chat: '对话',
  audio: '音频合成/识别',
  image: '图像生成/编辑',
  embedding: '嵌入',
  other: '其他非对话',
}

/**
 * 本地用途推断：服务端 v3 之前的版本不返回 `applicability`，此时按模型名兜底，
 * 让「不适用对话」分组与"默认不启用"的智能默认值仍然成立（而非整块功能失效）。
 * 命中即为**非对话**：tts/asr/whisper/realtime 等 → audio；embed 系 → embedding；
 * 画图系 → image；视频生成 → other（契约里没有 video 用途）；其余 → chat。
 */
export function deriveApplicability(model: string): ModelApplicability {
  const m = (model || '').toLowerCase()
  if (/embed/.test(m)) return 'embedding'
  if (/(^|[^a-z])(tts|asr|stt|whisper|speech|audio|realtime|voice|sovits|cosyvoice|sensevoice)([^a-z]|$)/.test(m)) {
    return 'audio'
  }
  if (
    /(dall-e|dalle|gpt-image|image-(gen|generation|edit|preview|1)|stable-diffusion|midjourney|seedream|kolors|sdxl|flux|imagen)/.test(
      m,
    )
  ) {
    return 'image'
  }
  if (/(sora|veo-|runway|pika|kling|wan2|wanx|-video|video-gen|hunyuan-video)/.test(m)) return 'other'
  return 'chat'
}

/** 服务端值优先（白名单外的脏值回落到本地推断） */
export function normalizeApplicability(value: string | null | undefined, model: string): ModelApplicability {
  return MODEL_APPLICABILITIES.includes(value as ModelApplicability)
    ? (value as ModelApplicability)
    : deriveApplicability(model)
}

/** 是否"用于对话"：只有 chat 会被放进单排胶囊的默认区，其余进「不适用对话」折叠组 */
export function isChatApplicable(item: Pick<ModelSettingItem, 'applicability'>): boolean {
  return item.applicability === 'chat'
}

// ===== 数值边界（与服务端硬校验同源，避免"本地能填、服务端 400"）=====
// 服务端 routes/aiModelSettings.js 的契约边界：contextWindow 1024..2000000 / maxOutput 1..200000。
export const CONTEXT_WINDOW_MIN = 1024
export const CONTEXT_WINDOW_MAX = 2_000_000
export const MAX_OUTPUT_MIN = 1
export const MAX_OUTPUT_MAX = 200_000
/** 显示别名长度上限（服务端契约：≤80，空串 = 清除别名） */
export const ALIAS_MAX_LEN = 80

/** 是否是可以下发的 token 数：纯数字、在 [min, max] 闭区间内。空串由调用方判为"用预设"。 */
export function isValidTokenCount(raw: string, min: number, max: number): boolean {
  const s = (raw ?? '').trim()
  if (!/^\d+$/.test(s)) return false
  const n = Number(s)
  return Number.isSafeInteger(n) && n >= min && n <= max
}

// ===== 类型 =====

export interface ModelSettingItem {
  model: string
  contextWindow: number | null
  maxOutput: number | null
  supportsText: boolean
  supportsImage: boolean
  supportsVideo: boolean
  supportsAudio: boolean
  reasoningEnabled: boolean
  reasoningProtocol: ReasoningProtocol
  /** 是否启用（服务端同步进 ai_settings.selected_models） */
  enabled: boolean
  /** 显示别名；null/'' = 用模型原名 */
  alias: string | null
  /** 自定义排序；null = 未定序（按服务端返回顺序） */
  sortOrder: number | null
  applicability: ModelApplicability
  /** 该模型是否在内置预设表中（服务端给） */
  isPreset: boolean
  /** 该模型是否存在用户覆盖（服务端给） */
  isOverridden: boolean
  /**
   * 客户端标记：`enabled` 是否真的由服务端下发（v3 之前的服务端没有该字段）。
   * 为 false 时界面按父组件传入的已选集合兜底，并提示"该服务端的契约较旧"。
   */
  enabledFromServer: boolean
  /** 客户端标记：`applicability` 是否由服务端下发（false = 本地按模型名推断） */
  applicabilityFromServer: boolean
}

/** patch 的字段名（用于逐字段恢复） */
export type ModelSettingField =
  | 'contextWindow'
  | 'maxOutput'
  | 'supportsText'
  | 'supportsImage'
  | 'supportsVideo'
  | 'supportsAudio'
  | 'reasoningEnabled'
  | 'reasoningProtocol'
  | 'enabled'
  | 'alias'
  | 'sortOrder'

export interface ModelSettingPatch {
  contextWindow?: number | null
  maxOutput?: number | null
  supportsText?: boolean | null
  supportsImage?: boolean | null
  supportsVideo?: boolean | null
  supportsAudio?: boolean | null
  reasoningEnabled?: boolean | null
  reasoningProtocol?: ReasoningProtocol | null
  enabled?: boolean
  /** 空串 = 清除别名 */
  alias?: string | null
  /** null = 清除自定义顺序 */
  sortOrder?: number | null
}

/**
 * 「恢复预设」提交的 patch：把可覆盖项一律置 null，请服务端回退到内置预设值。
 * reasoningProtocol 例外 —— 它的枚举里 `inherit` 本身就表示"沿用系统既有行为"，
 * 因此恢复预设提交 'inherit' 而不是 null。
 *
 * 服务端语义（v2 已核实，routes/aiModelSettings.js + utils/aiModelSettings.js）：patch 里显式 null =
 * 清除该项覆盖 —— 数值列写 NULL（读时回退预设），多模态/推理开关物化为该模型的预设值，
 * 推理协议 null → 'inherit'（沿用系统默认），与本常量直接提交 'inherit' 结果一致。
 * 注意：本 patch **不含 enabled/alias/sortOrder** —— 「恢复预设」只管能力参数，不改变启用状态、
 * 别名与排序（那是用户自己的选择，不属于"预设覆盖"）。
 */
export const RESTORE_PRESET_PATCH: ModelSettingPatch = {
  contextWindow: null,
  maxOutput: null,
  supportsText: null,
  supportsImage: null,
  supportsVideo: null,
  supportsAudio: null,
  reasoningEnabled: null,
  reasoningProtocol: 'inherit',
}

/** 可逐字段恢复的字段（enabled/alias/sortOrder 不属于"预设覆盖"，不提供单项恢复） */
export const RESTORABLE_FIELDS: ModelSettingField[] = [
  'contextWindow',
  'maxOutput',
  'supportsText',
  'supportsImage',
  'supportsVideo',
  'supportsAudio',
  'reasoningEnabled',
  'reasoningProtocol',
]

/**
 * 单项恢复：只提交一个字段的"清除覆盖"值。
 * 数值/布尔 → null（服务端回退预设）；协议 → inherit（服务端把 null 也映射成 inherit）。
 */
export function restoreFieldPatch(field: ModelSettingField): ModelSettingPatch {
  if (field === 'reasoningProtocol') return { reasoningProtocol: 'inherit' }
  if (field === 'contextWindow') return { contextWindow: null }
  if (field === 'maxOutput') return { maxOutput: null }
  if (field === 'supportsText') return { supportsText: null }
  if (field === 'supportsImage') return { supportsImage: null }
  if (field === 'supportsVideo') return { supportsVideo: null }
  if (field === 'supportsAudio') return { supportsAudio: null }
  if (field === 'reasoningEnabled') return { reasoningEnabled: null }
  if (field === 'alias') return { alias: '' }
  if (field === 'sortOrder') return { sortOrder: null }
  return {}
}

/** 某个模型在没有服务端数据时的本地占位（未刷新出预设、或模型是刚手工输入的） */
export function defaultModelSetting(model: string): ModelSettingItem {
  return {
    model,
    contextWindow: null,
    maxOutput: null,
    supportsText: true,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    reasoningEnabled: false,
    reasoningProtocol: 'inherit',
    enabled: false,
    alias: null,
    sortOrder: null,
    applicability: deriveApplicability(model),
    isPreset: false,
    isOverridden: false,
    enabledFromServer: false,
    applicabilityFromServer: false,
  }
}

/** 服务端返回的条目 → 前端模型（补齐缺失字段、未知协议归一化、用途/启用态标记来源） */
export function normalizeModelSettingItem(raw: Partial<ModelSettingItem> & { model: string }): ModelSettingItem {
  const base = defaultModelSetting(raw.model)
  const aliasRaw = raw.alias
  return {
    ...base,
    ...raw,
    model: raw.model,
    supportsText: raw.supportsText ?? base.supportsText,
    supportsImage: !!raw.supportsImage,
    supportsVideo: !!raw.supportsVideo,
    supportsAudio: !!raw.supportsAudio,
    reasoningEnabled: !!raw.reasoningEnabled,
    reasoningProtocol: normalizeReasoningProtocol(raw.reasoningProtocol),
    enabled: raw.enabled === true,
    alias: typeof aliasRaw === 'string' && aliasRaw.trim() !== '' ? aliasRaw : null,
    sortOrder: typeof raw.sortOrder === 'number' && Number.isFinite(raw.sortOrder) ? raw.sortOrder : null,
    applicability: normalizeApplicability(raw.applicability, raw.model),
    isPreset: !!raw.isPreset,
    isOverridden: !!raw.isOverridden,
    // 字段是否存在（而非值）才是"服务端是否支持 v3"的判据
    enabledFromServer: raw.enabled !== undefined && raw.enabled !== null,
    applicabilityFromServer: MODEL_APPLICABILITIES.includes(raw.applicability as ModelApplicability),
  }
}

/** 显示名：别名优先，否则模型原名 */
export function modelDisplayName(item: Pick<ModelSettingItem, 'model' | 'alias'>): string {
  return item.alias && item.alias.trim() !== '' ? item.alias : item.model
}

// ===== 能力自检 =====

export type ProbeReasoningSupport = true | false | 'unknown'

export interface ProbeResult {
  ok: boolean
  latencyMs?: number | null
  protocolTried?: string | null
  usedReasoningParam?: boolean | null
  supportsReasoningParam?: ProbeReasoningSupport | null
  suggestedProtocol?: string | null
  observedContextWindow?: number | null
  upstreamStatus?: number | null
  upstreamErrorCode?: string | null
  upstreamMessage?: string | null
  /** 传输层失败（接口未就绪/网络异常）时由前端补上，便于原样展示 */
  error?: string | null
}

export type ProbeState = 'ok' | 'warn' | 'fail'

/**
 * 三态判定：
 *   ok    —— 上游可用（supportsReasoningParam 为 true 或 'unknown'）
 *   warn  —— 上游可用，但**不支持该推理参数**（支持字段明确为 false）→ 可一键改成 suggestedProtocol
 *   fail  —— 上游不可用（原样展示上游错误码/文案）
 */
export function probeStateOf(res: ProbeResult): ProbeState {
  if (!res.ok) return 'fail'
  return res.supportsReasoningParam === false ? 'warn' : 'ok'
}

// ===== 请求 =====

/** GET /api/ai/model-settings — 读某供应商全部模型的（预设 + 覆盖）配置 */
export function getModelSettings(providerId: string) {
  return api<{ items: ModelSettingItem[] }>(
    'GET',
    `/api/ai/model-settings?providerId=${encodeURIComponent(providerId)}`,
  )
}

/** PUT /api/ai/model-settings — 只提交 patch 里的字段（未提交的字段服务端保持原值） */
export function putModelSetting(providerId: string, model: string, patch: ModelSettingPatch) {
  return api<{ ok: boolean; item: ModelSettingItem }>('PUT', '/api/ai/model-settings', {
    providerId,
    model,
    patch,
  })
}

/**
 * POST /api/ai/model-settings/probe — 真实调用上游做能力自检。
 * 只应在用户显式点击「自检」时调用（会产生一次极小上游请求）。
 */
export function probeModelSetting(providerId: string, model: string) {
  return api<ProbeResult>('POST', '/api/ai/model-settings/probe', { providerId, model })
}
