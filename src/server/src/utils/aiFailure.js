import { logger } from './logger.js'

/**
 * AI 调用失败的统一分类 + 响应构造。
 *
 * 动机（用户实测反馈）：这些端点此前失败只回英文内部串（`Inline AI failed` / `Summary failed`），
 * 前端拿不到失败原因、更拿不到「是哪个供应商出的问题」，最终页内卡片只能显示一句
 * 「AI 调用失败」—— 用户不知道是没配 key、key 过期、模型不存在还是被限流，
 * 也不知道该去哪里改。
 *
 * 这里做两件事：
 *   1. 把失败归类成稳定的 `code`（前端据此给可行动的中文文案）
 *   2. 把出问题的供应商（名字 / 是否默认 / 用的模型）一起带回前端
 *
 * 兼容性：`error` / `detail` 字段维持原样不动，只**新增** `code` 与 `provider`，
 * 老前端与手机端按老字段渲染不受影响。
 */

const AUTH_RE = /invalid[\s_-]*api[\s_-]*key|unauthorized|authentication|auth failed|api key/i
const RATE_RE = /rate[\s_-]*limit|too many requests|quota|insufficient|balance|欠费|限流/i
const MODEL_RE = /model[\s\S]{0,40}(not[\s_-]*(found|exist|support))|unknown model|no such model/i
const TIMEOUT_RE = /upstream_timeout|timed?\s*out|etimedout|aborted|abort error|deadline/i
const NETWORK_RE = /fetch failed|econnrefused|econnreset|enotfound|socket hang up|network|getaddrinfo/i

/** 从上游错误里抠出 HTTP 状态码：openUpstreamStream 抛的是 `Upstream error: 401 {...}` */
function statusOf(msg) {
  const m = msg.match(/error:\s*(\d{3})\b/) || msg.match(/\b(4\d{2}|5\d{2})\b/)
  return m ? Number(m[1]) : 0
}

/**
 * 归类一个上游/内部异常。
 * @returns {{ code: string, httpStatus: number }}
 *   code 取值：ai_upstream_auth | ai_upstream_rate_limit | ai_upstream_model |
 *             ai_upstream_timeout | ai_upstream_unavailable | ai_failed
 */
export function classifyAiFailure(err) {
  const msg = String(err?.message || err || '')
  const status = statusOf(msg)

  // 先判超时/网络：这两类的 message 里通常没有状态码，但语义最明确
  if (TIMEOUT_RE.test(msg)) return { code: 'ai_upstream_timeout', httpStatus: 504 }

  if (status === 401 || status === 403 || AUTH_RE.test(msg)) {
    return { code: 'ai_upstream_auth', httpStatus: 502 }
  }
  if (status === 429 || RATE_RE.test(msg)) {
    return { code: 'ai_upstream_rate_limit', httpStatus: 502 }
  }
  // 404 要区分「模型不存在」与「地址填错/接口不存在」：只有真的提到 model 才算模型问题
  if (MODEL_RE.test(msg) || (status === 404 && /model/i.test(msg))) {
    return { code: 'ai_upstream_model', httpStatus: 502 }
  }
  // 纯 404（没提 model）：绝大多数是 base_url 填错或该网关没有这个接口 —— 单列一类，
  // 否则会被下面的兜底吞成笼统的「AI 调用失败」，用户完全无从下手
  if (status === 404) return { code: 'ai_upstream_endpoint', httpStatus: 502 }
  if (status >= 500 || NETWORK_RE.test(msg)) {
    return { code: 'ai_upstream_unavailable', httpStatus: 502 }
  }
  return { code: 'ai_failed', httpStatus: 500 }
}

/** 供应商摘要（只带前端要展示的字段，绝不外泄 key） */
export function providerBrief(providerRow) {
  if (!providerRow) return null
  return {
    id: providerRow.id ?? null,
    name: providerRow.name ?? null,
    provider: providerRow.provider ?? null,
    model: providerRow.model ?? null,
    isDefault: providerRow.is_default === true,
  }
}

/**
 * 构造失败响应体。`fallbackError` 是沿用各端点原来的英文 error 串（保持兼容）。
 * @returns {{ httpStatus: number, body: object }}
 */
export function buildAiFailure(err, providerRow, fallbackError = 'AI failed') {
  const { code, httpStatus } = classifyAiFailure(err)
  const detail = String(err?.message || err || '').slice(0, 600)
  logger.warn(`[AI] failure code=${code} provider=${providerRow?.name || '(none)'} detail=${detail.slice(0, 200)}`)
  return {
    httpStatus,
    body: {
      error: fallbackError,
      code,
      detail,
      provider: providerBrief(providerRow),
    },
  }
}

/** 「没有可用供应商」与「供应商没填 key」两个前置检查的统一响应体 */
export function providerPrecheckFailure(reason, providerRow = null) {
  if (reason === 'no_provider') {
    return {
      httpStatus: 404,
      body: { error: 'Provider not found', code: 'ai_no_provider', provider: null },
    }
  }
  return {
    httpStatus: 400,
    body: {
      error: 'Provider has no API key',
      code: 'ai_no_api_key',
      provider: providerBrief(providerRow),
    },
  }
}
