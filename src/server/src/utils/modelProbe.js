/**
 * 模型能力自检探测（契约 v3，POST /api/ai/model-settings/probe 的核心实现）。
 *
 * 目的：用户按模型配了「推理协议」以后，能不能真的用是这个协议、这个上游到底吃不吃这个参数，
 *   只能**真实打一次上游**才知道。所以这里发一次极小的探针请求（max_tokens=1 + 极短 user 消息
 *   + ≤20s 超时），并把判定结果如实回给前端。
 *
 * 判定矩阵（与 routes/aiModelSettings.js 的响应字段一一对应）：
 *   ① 当前协议是显式协议（非 inherit/none）且该协议参数真的进了请求体：
 *      · 成功                       → ok=true, usedReasoningParam=true,  supportsReasoningParam=true
 *      · **参数相关** 4xx/5xx       → 去掉推理参数再试一次：
 *            - 成功                   → ok=true, usedReasoningParam=false, supportsReasoningParam=false,
 *                                       suggestedProtocol='inherit'（或按错误文案推断更合适的协议）
 *            - 仍失败                 → ok=false, supportsReasoningParam=false，
 *                                       原样保留**上游**错误码/文案（不许吞 ✗）
 *      · 其它错误（401/404/429…）    → ok=false, supportsReasoningParam='unknown'，**不重试**，
 *                                       错误码/文案原样保留
 *   ② 协议是 inherit        → 既有行为本就不下发任何推理参数（我们不知道字段名）：
 *                             只发一次普通请求，supportsReasoningParam='unknown'
 *   ③ 协议是 none           → 配置已声明该模型不支持：只发一次普通请求，
 *                             supportsReasoningParam=false（结论来自配置，不来自猜测）
 *   ④ 显式协议但参数没进请求体（协议族不匹配，如 openai 族配了 anthropic_thinking）：
 *                             usedReasoningParam=false，supportsReasoningParam='unknown'（测不到）
 *
 * 安全与约束：
 *   · 绝不自动调用（只有用户点「自检」才走这个端点）；调用方挂 apiLimiter + 独立限流桶
 *     （modelProbeLimiter，10 次/分/用户）。
 *   · 复用既有上游构造（utils/aiProviders.js buildUpstreamChat）与 safeUpstreamFetch
 *     （内含 assertSafeUpstreamUrl 的 SSRF 校验 + DNS rebinding 兜底），**不新写 HTTP 栈**。
 *   · 日志只记 provider/model/protocol/status/latency，**绝不记 api key、绝不记请求头**。
 *   · 与正常聊天链路完全隔离：本文件不 import runChatLoop / aiStream，也不改任何全局状态
 *     （唯一的模块级状态是测试用的 fetch 注入缝，见 setProbeFetchImpl）。
 */
import { buildUpstreamChat, safeUpstreamFetch } from './aiProviders.js'
import { loadEffectiveModelSettings } from './aiModelSettings.js'
import { buildReasoningRequest, THINKING_STRENGTHS } from './modelPresets.js'
import { pool } from '../db/pool.js'
import { logger } from './logger.js'

/** 探针超时（契约：≤20s） */
export const PROBE_TIMEOUT_MS = 20000
/** 探针出参上限：1 个 token 足够判活，避免消耗用户额度 */
export const PROBE_MAX_TOKENS = 1
/** 极短 user 消息 */
export const PROBE_USER_MESSAGE = 'ping'

/** 推理参数在各协议下可能落进请求体的字段名（用于判定「参数是否真的发出去了」） */
export const REASONING_BODY_FIELDS = ['reasoning_effort', 'reasoning', 'thinking', 'output_config', 'enable_thinking']

// ==================== 测试注入缝 ====================
// 契约要求「probe 用可注入 fetch/HTTP mock，不发真实外网」。
// 默认实现 = safeUpstreamFetch（生产唯一路径）；只有测试会替换它。
let fetchImpl = safeUpstreamFetch

/** 仅测试使用：替换探针的出网实现；传 null/非法值恢复默认 safeUpstreamFetch */
export function setProbeFetchImpl(fn) {
  fetchImpl = typeof fn === 'function' ? fn : safeUpstreamFetch
}

/** 仅测试使用：恢复默认出网实现 */
export function resetProbeFetchImpl() {
  fetchImpl = safeUpstreamFetch
}

/** 当前出网实现（调试/断言用） */
export function getProbeFetchImpl() {
  return fetchImpl
}

// ==================== 错误解析 ====================

function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 从上游响应体里原样提取错误码/文案（兼容 OpenAI / Anthropic / 各类网关三种形态）。
 * 拿不到结构化字段时，用截断后的原文兜底 —— **绝不把错误吞成空**。
 */
export function extractUpstreamError(status, text) {
  const raw = typeof text === 'string' ? text : ''
  const json = safeJsonParse(raw)
  let code = null
  let type = null
  let message = null
  if (json && typeof json === 'object') {
    const err = json.error
    if (err && typeof err === 'object') {
      if (typeof err.code === 'string') code = err.code
      if (typeof err.type === 'string') type = err.type
      if (!code && type) code = type
      if (typeof err.message === 'string') message = err.message
      else if (typeof err.msg === 'string') message = err.msg
    } else if (typeof err === 'string') {
      message = err
    }
    if (!code && typeof json.code === 'string') code = json.code
    if (!code && typeof json.type === 'string') code = json.type
    if (!message && typeof json.message === 'string') message = json.message
    if (!message && typeof json.detail === 'string') message = json.detail
  }
  if (!message && raw.trim()) message = raw.trim().slice(0, 500)
  return { status, code, type, message, raw: raw.slice(0, 1000) }
}

/**
 * 是否「参数相关」的失败：既要像拒绝（unsupported/unknown/unrecognized/不支持…），
 * 又要提到推理相关字段名。刻意收紧 —— 避免把 401/模型不存在这类错误误判成参数不支持，
 * 那样会白白多打一次上游。
 */
export function isParamRelatedError(text) {
  const s = typeof text === 'string' ? text : ''
  if (!s.trim()) return false
  const rejection = /unsupported|not supported|does not support|isn'?t supported|unknown|unrecognized|unexpected|invalid|extra fields|不支持|无法识别|未知|多余/i
  const reasoningField = /reasoning[_a-z]*|enable_thinking|thinking_budget|output_config|budget_tokens|\bthinking\b/i
  return rejection.test(s) && reasoningField.test(s)
}

/**
 * 按错误文案推断更合适的协议（排除已经试过的那个）。推断不出返回 null（调用方回 'inherit'）。
 */
export function inferProtocolFromError(text, triedProtocol) {
  const s = typeof text === 'string' ? text.toLowerCase() : ''
  if (!s) return null
  // 越具体的字段名越靠前（'thinking' 是 'enable_thinking'/'thinking_budget' 的子串）
  const candidates = [
    ['reasoning_effort', 'openai_reasoning_effort'],
    ['output_config', 'output_config_effort'],
    ['enable_thinking', 'qwen_enable_thinking'],
    ['thinking_budget', 'qwen_enable_thinking'],
    ['budget_tokens', 'anthropic_thinking'],
    ['thinking', 'anthropic_thinking'],
  ]
  for (const [token, protocol] of candidates) {
    if (s.includes(token) && protocol !== triedProtocol) return protocol
  }
  return null
}

/** 本次请求体里到底带了哪个推理字段（没带 → null） */
export function detectReasoningField(body) {
  if (!body || typeof body !== 'object') return null
  for (const f of REASONING_BODY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, f)) return f
  }
  return null
}

/** 成功响应里尽力观察上下文窗口（上游基本不回这个字段，观察不到就如实省略） */
export function observeContextWindow(json, headers) {
  const fromBody = [
    json?.context_window,
    json?.context_length,
    json?.max_context_length,
    json?.max_input_tokens,
    json?.model_context_window,
    json?.model?.context_window,
    json?.data?.context_window,
  ]
  for (const v of fromBody) {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 1024) return Math.floor(n)
  }
  const headerNames = ['x-context-window', 'x-model-context-window', 'x-max-context-length']
  for (const h of headerNames) {
    let raw = null
    try {
      raw = typeof headers?.get === 'function' ? headers.get(h) : headers?.[h]
    } catch {
      raw = null
    }
    const n = Number(raw)
    if (raw !== null && raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 1024) return Math.floor(n)
  }
  return undefined
}

/** 读取响应体文本（容错：没有 text() 的实现回退到 json()） */
async function readBodyText(res) {
  try {
    if (typeof res?.text === 'function') return await res.text()
    if (typeof res?.json === 'function') return JSON.stringify(await res.json())
  } catch (e) {
    logger.warn('[modelProbe] read upstream body failed:', e.message)
  }
  return ''
}

/** 取用户当前的思考强度（探针用哪一档去试，决定 effort 字面值 / budget 数字） */
async function readUserThinkingStrength(userId) {
  try {
    const { rows } = await pool.query('SELECT thinking_strength FROM ai_settings WHERE user_id = $1', [userId])
    const s = rows[0]?.thinking_strength
    return THINKING_STRENGTHS.includes(s) ? s : 'medium'
  } catch (e) {
    logger.warn('[modelProbe] read thinking_strength failed, fallback medium:', e.message)
    return 'medium'
  }
}

/**
 * 执行一次探针尝试。
 * @returns {Promise<object>} { status, ok, text, error, detectedField, bodyKeys }
 */
async function runAttempt({ providerRow, apiKey, model, reasoning, useReasoning }) {
  const options = { stream: false, maxTokens: PROBE_MAX_TOKENS }
  if (useReasoning && reasoning) options.reasoning = reasoning
  const upstream = buildUpstreamChat({
    provider: providerRow.provider,
    baseUrl: providerRow.base_url,
    model,
    apiKey,
    messages: [{ role: 'user', content: PROBE_USER_MESSAGE }],
    options,
    apiFormat: providerRow.api_format,
  })
  const detectedField = detectReasoningField(upstream.body)
  let res
  try {
    res = await fetchImpl(
      upstream.url,
      {
        method: 'POST',
        headers: upstream.headers,
        body: JSON.stringify(upstream.body),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
      { timeoutMs: PROBE_TIMEOUT_MS },
    )
  } catch (e) {
    // 传输层失败（DNS/拒连/超时）：没有上游状态码，如实标注 transport_error
    return {
      status: null,
      ok: false,
      text: '',
      error: { status: null, code: 'transport_error', type: null, message: String(e?.message || e).slice(0, 500), raw: '' },
      detectedField,
      transportError: true,
    }
  }
  const text = await readBodyText(res)
  const ok = res?.ok === true
  return {
    status: Number.isFinite(Number(res?.status)) ? Number(res.status) : null,
    ok,
    text,
    error: ok ? null : extractUpstreamError(res?.status, text),
    detectedField,
    headers: res?.headers,
    transportError: false,
  }
}

/**
 * 探针主流程。返回值即 API 响应体（HTTP 200；是否成功看 ok）。
 *
 * @param {object} p
 * @param {string} p.userId 当前用户（归属校验由路由保证）
 * @param {object} p.providerRow ai_providers 行（含 provider / base_url / api_format）
 * @param {string} p.model 模型名
 * @param {string} p.apiKey 已解密的明文密钥（由路由层解密传入，本文件不落日志）
 * @returns {Promise<object>} 见文件头的判定矩阵
 */
export async function probeModelCapability({ userId, providerRow, model, apiKey }) {
  const startedAt = Date.now()
  const settings = await loadEffectiveModelSettings({ userId, providerId: providerRow.id, model })
  const protocolTried = settings.reasoningProtocol || 'inherit'
  const strength = await readUserThinkingStrength(userId)
  // force=true：自检就是要验「该协议能不能用」，因此不受 reasoning_enabled 开关影响
  //（那个开关是「聊天时要不要下发」，和「上遊吃不吃这个字段」是两件事）
  const reasoning = buildReasoningRequest({ settings, strength, force: true })

  const attempts = []
  const finish = (payload) => {
    const out = {
      ...payload,
      latencyMs: Date.now() - startedAt,
      protocolTried,
      attempts,
    }
    logger.info('[modelProbe] probe finished', {
      provider: providerRow.provider,
      model,
      protocolTried,
      ok: out.ok === true,
      supportsReasoningParam: out.supportsReasoningParam,
      upstreamStatus: out.upstreamStatus ?? null,
      latencyMs: out.latencyMs,
      attemptCount: attempts.length,
    })
    return out
  }

  // ---- 第 1 次：按当前协议（显式协议才带推理参数）----
  const first = await runAttempt({ providerRow, apiKey, model, reasoning, useReasoning: !!reasoning })
  const usedReasoningParam = first.detectedField !== null
  attempts.push({
    attempt: 1,
    status: first.status,
    ok: first.ok,
    usedReasoningParam,
    reasoningField: first.detectedField,
    errorCode: first.error?.code ?? null,
    message: first.error?.message ?? null,
  })

  const base = {
    usedReasoningParam,
    upstreamStatus: first.status,
  }

  if (first.ok) {
    const json = safeJsonParse(first.text)
    const observed = observeContextWindow(json, first.headers)
    return finish({
      ...base,
      ok: true,
      // 带了参数且上游接受 ⇒ 明确支持；没带参数（inherit/none/协议族不匹配）⇒ 测不到
      supportsReasoningParam: reasoning && usedReasoningParam ? true : (protocolTried === 'none' ? false : 'unknown'),
      ...(observed !== undefined ? { observedContextWindow: observed } : {}),
    })
  }

  const errorText = [first.error?.code, first.error?.type, first.error?.message, first.error?.raw]
    .filter(Boolean)
    .join(' | ')

  // ---- 非「参数相关」失败：不重试，原样保留上游错误 ----
  if (!first.error || !isParamRelatedError(errorText)) {
    return finish({
      ...base,
      ok: false,
      supportsReasoningParam: 'unknown',
      upstreamErrorCode: first.error?.code ?? (first.transportError ? 'transport_error' : undefined),
      upstreamMessage: first.error?.message ?? undefined,
    })
  }

  // 参数相关失败但本来就没带参数（inherit/none/协议族不匹配）⇒ 无处可退，如实报告
  if (!usedReasoningParam) {
    return finish({
      ...base,
      ok: false,
      supportsReasoningParam: protocolTried === 'none' ? false : 'unknown',
      upstreamErrorCode: first.error?.code ?? undefined,
      upstreamMessage: first.error?.message ?? undefined,
    })
  }

  // ---- 第 2 次：**去掉推理参数**再试一次 ----
  const second = await runAttempt({ providerRow, apiKey, model, reasoning: null, useReasoning: false })
  attempts.push({
    attempt: 2,
    status: second.status,
    ok: second.ok,
    usedReasoningParam: second.detectedField !== null,
    reasoningField: second.detectedField,
    errorCode: second.error?.code ?? null,
    message: second.error?.message ?? null,
  })

  if (second.ok) {
    const suggested = inferProtocolFromError(errorText, protocolTried) || 'inherit'
    const json = safeJsonParse(second.text)
    const observed = observeContextWindow(json, second.headers)
    return finish({
      usedReasoningParam: false,
      upstreamStatus: second.status,
      ok: true,
      // 去掉参数就通 ⇒ 该参数不被上游接受
      supportsReasoningParam: false,
      suggestedProtocol: suggested,
      ...(observed !== undefined ? { observedContextWindow: observed } : {}),
    })
  }

  // ---- 两次都失败：ok=false，原样保留**第二次**（去掉参数后）的上游错误 ----
  return finish({
    usedReasoningParam: false,
    upstreamStatus: second.status,
    ok: false,
    // 第一次已被上游明确判为「参数不支持」，这是直接证据
    supportsReasoningParam: false,
    suggestedProtocol: inferProtocolFromError(errorText, protocolTried) || 'inherit',
    upstreamErrorCode: second.error?.code ?? (second.transportError ? 'transport_error' : undefined),
    upstreamMessage: second.error?.message ?? undefined,
  })
}

export default {
  PROBE_TIMEOUT_MS,
  PROBE_MAX_TOKENS,
  PROBE_USER_MESSAGE,
  probeModelCapability,
  extractUpstreamError,
  isParamRelatedError,
  inferProtocolFromError,
  detectReasoningField,
  observeContextWindow,
  setProbeFetchImpl,
  resetProbeFetchImpl,
  getProbeFetchImpl,
}
