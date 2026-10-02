// === 模型级设置 API（设置 → AI → 供应商编辑 → 模型配置）===
// 需求：模型不再只能"多选"，还要能逐个配置「上下文窗口 / 最大输出 / 多模态能力（文本·识图·
// 视频·音频）/ 推理开关 + 推理协议」，并展示来源（预设 / 已自定义）与「恢复预设」。
//
// 契约 v2（已冻结，字段名以此为准）：
//   GET  /api/ai/model-settings?providerId=<uuid>
//        → 200 { items: [ { model, contextWindow, maxOutput, supportsText, supportsImage,
//                           supportsVideo, supportsAudio, reasoningEnabled, reasoningProtocol,
//                           isPreset, isOverridden } ] }
//   PUT  /api/ai/model-settings
//        body { providerId, model, patch: { contextWindow?, maxOutput?, supportsText?,
//               supportsImage?, supportsVideo?, supportsAudio?, reasoningEnabled?,
//               reasoningProtocol? } }
//        → 200 { ok: true, item: {…同上} }
// reasoningProtocol 取值：inherit | none | openai_reasoning_effort | anthropic_thinking |
//                        output_config_effort | qwen_enable_thinking
// 注意：契约 v2 已**移除 reasoningLevels**（思考强度映射）——思考强度统一为 5 档
// low | medium | high | xhigh | max 原样透传上游，不再逐模型配映射；发 reasoningLevels 会被服务端忽略。
//
// 该端点需登录 + 真 CSRF，一律走项目统一的 api()（Bearer + X-CSRF-Token + 幂等键 + 401 刷新），
// 本文件不裸 fetch。

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

// ===== 数值边界（与服务端硬校验同源，避免"本地能填、服务端 400"）=====
// 服务端 routes/aiModelSettings.js 的契约边界：contextWindow 1024..2000000 / maxOutput 1..200000。
// 这里取同一组常量做前置校验（服务端仍会独立校验并可能返回 400）。
export const CONTEXT_WINDOW_MIN = 1024
export const CONTEXT_WINDOW_MAX = 2_000_000
export const MAX_OUTPUT_MIN = 1
export const MAX_OUTPUT_MAX = 200_000

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
  /** 该模型是否在内置预设表中（服务端给） */
  isPreset: boolean
  /** 该模型是否存在用户覆盖（服务端给） */
  isOverridden: boolean
}

export interface ModelSettingPatch {
  contextWindow?: number | null
  maxOutput?: number | null
  supportsText?: boolean | null
  supportsImage?: boolean | null
  supportsVideo?: boolean | null
  supportsAudio?: boolean | null
  reasoningEnabled?: boolean | null
  reasoningProtocol?: ReasoningProtocol | null
}

/**
 * 「恢复预设」提交的 patch：把可覆盖项一律置 null，请服务端回退到内置预设值。
 * reasoningProtocol 例外 —— 它的枚举里 `inherit` 本身就表示"沿用系统既有行为"，
 * 因此恢复预设提交 'inherit' 而不是 null。
 *
 * 服务端语义（routes/aiModelSettings.js + utils/aiModelSettings.js）：patch 里显式 null =
 * 清除该项覆盖 —— 数值列写 NULL（读时回退预设），多模态/推理开关物化为该模型的预设值，
 * 推理协议 null → 'inherit'（沿用系统默认），与本常量直接提交 'inherit' 结果一致。
 * 界面文案据此如实描述；若对接的服务端版本较旧、没有该端点，已存值保持不变（GET 会 404，
 * 面板会提示"无法读取预设配置"，不会假装恢复成功）。
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
    isPreset: false,
    isOverridden: false,
  }
}

/** 服务端返回的条目 → 前端模型（补齐缺失字段，未知协议归一化） */
export function normalizeModelSettingItem(raw: Partial<ModelSettingItem> & { model: string }): ModelSettingItem {
  const base = defaultModelSetting(raw.model)
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
    isPreset: !!raw.isPreset,
    isOverridden: !!raw.isOverridden,
  }
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
