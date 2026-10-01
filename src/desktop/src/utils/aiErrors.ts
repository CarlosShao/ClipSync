/**
 * AI 调用失败 → 可行动的中文/英文文案。
 *
 * 背景（用户实测反馈）：这些「AI 小功能」（页内总结、AI 建议、整理收藏、审核设置、相似度…）
 * 之前失败只显示一句「AI 调用失败」—— 没有原因、没有是哪个供应商、也没有下一步该去哪改。
 * 服务端现在会在失败响应里带上 `code`（分类）与 `provider`（名字/模型/是否默认），
 * 这里把它翻译成用户能照着做的话。
 *
 * 兼容：老服务端不带 `code` 时，退化为「AI 调用失败 + detail 摘要 + 去设置指引」，
 * 也就是只比以前多一句指引，不会更差。
 */
import type { ApiResponse } from '@/api/client'

export interface AiFailureProvider {
  id?: string | null
  name?: string | null
  model?: string | null
  isDefault?: boolean
}

export interface AiFailurePayload {
  code?: string
  error?: string
  detail?: string
  provider?: AiFailureProvider | null
}

type Tf = (key: string, fallback: string, params?: Record<string, string | number>) => string

/** 需要用户去设置里动手的失败（决定文案末尾要不要跟「去设置」指引） */
const ACTIONABLE = new Set([
  'ai_no_provider',
  'ai_no_key',
  'ai_upstream_auth',
  'ai_upstream_model',
  'ai_upstream_endpoint',
  'ai_failed',
])

const REASON: Record<string, { key: string; zh: string; en: string }> = {
  ai_no_provider: {
    key: 'ai_fail_no_provider',
    zh: '还没有可用的 AI 供应商。',
    en: 'No AI provider is available.',
  },
  ai_no_api_key: {
    key: 'ai_fail_no_key',
    zh: '供应商「{name}」还没有填写 API Key。',
    en: 'Provider "{name}" has no API key configured.',
  },
  ai_upstream_auth: {
    key: 'ai_fail_auth',
    zh: '供应商「{name}」的 API Key 无效或已过期。',
    en: 'Provider "{name}" has an invalid or expired API key.',
  },
  ai_upstream_rate_limit: {
    key: 'ai_fail_rate_limit',
    zh: '供应商「{name}」限流或额度不足，稍后重试。',
    en: 'Provider "{name}" is rate-limited or out of quota. Try again later.',
  },
  ai_upstream_model: {
    key: 'ai_fail_model',
    zh: '供应商「{name}」不支持当前模型。',
    en: 'Provider "{name}" does not support the current model.',
  },
  ai_upstream_endpoint: {
    key: 'ai_fail_endpoint',
    zh: '供应商「{name}」的接口地址可能不对（404）。',
    en: 'Provider "{name}" endpoint URL looks wrong (404).',
  },
  ai_upstream_timeout: {
    key: 'ai_fail_timeout',
    zh: '供应商「{name}」响应超时，稍后重试。',
    en: 'Provider "{name}" timed out. Try again later.',
  },
  ai_upstream_unavailable: {
    key: 'ai_fail_unavailable',
    zh: '供应商「{name}」暂时不可用，稍后重试。',
    en: 'Provider "{name}" is temporarily unavailable. Try again later.',
  },
}

/**
 * 把服务端失败响应翻译成一句可行动的话。
 * @param data api() 返回的响应体（可能含 code / provider / detail）
 */
export function describeAiFailure(data: AiFailurePayload | null | undefined, tf: Tf): string {
  const code = String(data?.code || '')
  const name = data?.provider?.name || tf('ai_fail_default_provider', '默认供应商')
  const reason = REASON[code]

  let text: string
  if (reason) {
    text = tf(reason.key, reason.zh, { name })
  } else {
    // 老服务端 / 未知分类：保留 detail 摘要（排查用），但不再是唯一信息
    const detail = String(data?.detail || data?.error || '').trim()
    const head = tf('ai_fail_generic', 'AI 调用失败')
    text = detail ? `${head}：${detail.slice(0, 160)}` : head
  }

  if (ACTIONABLE.has(code) || !code) {
    text += tf('ai_fail_action', ' 请到 设置 → AI 供应商 检查密钥与模型，或把其他供应商设为默认。')
  }
  return text
}

/** 便捷判断：这次失败是不是「需要用户去设置里动手」 */
export function isAiConfigFailure(data: AiFailurePayload | null | undefined): boolean {
  return ACTIONABLE.has(String(data?.code || ''))
}

/** 从 api() 的返回里取出失败载荷（HTTP 非 2xx 时 body 在 res.data） */
export function aiFailureFrom(res: ApiResponse<unknown> | null | undefined): AiFailurePayload | null {
  if (!res) return null
  const d = (res.data || null) as AiFailurePayload | null
  if (d && typeof d === 'object') return d
  return res.error ? { error: String(res.error) } : null
}
