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
  /** 服务端按真实参数生成的可读文案（如容器+回环提示，带真实端口）；见 SERVER_MESSAGE_FIRST_CODES */
  message?: string
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
  // ===== 供应商 Base URL 被服务端地址策略拒绝（utils/aiProviders.js 的 UPSTREAM_URL_CODES）=====
  // 用户反馈：本地模型网关（Base URL = http://127.0.0.1:3800/v1，one-api/vLLM/Ollama）被旧策略以
  // 「Base URL resolves to a blocked internal address」拒掉。现在默认放行环回/私网/ULA，
  // 这里把每种机器码翻译成"哪一类被拒 + 怎么解决"。
  ai_base_url_local_disabled: {
    key: 'ai_fail_base_url_local_disabled',
    zh: '该地址是本机/内网地址（回环或私网），但服务端设置了 AI_ALLOW_LOCAL_BASE_URL=false，当前禁止连接内网。要连本地模型网关，请把它改回 true（默认值）后重启服务。',
    en: 'This is a loopback/private address, but the server has AI_ALLOW_LOCAL_BASE_URL=false, so local addresses are blocked. Set it back to true (the default) and restart to use a local model gateway.',
  },
  ai_base_url_blocked_address: {
    key: 'ai_fail_base_url_blocked',
    zh: '该地址属于始终禁止的网段（链路本地/云元数据 169.254.x.x、fe80::/10、组播/广播/保留段），与 AI_ALLOW_LOCAL_BASE_URL 开关无关。要连本机或局域网网关，请改用它自己的回环/私网地址，例如 http://127.0.0.1:3800/v1。',
    en: 'This address is in an always-blocked range (link-local/cloud-metadata 169.254.x.x, fe80::/10, multicast/broadcast/reserved), regardless of AI_ALLOW_LOCAL_BASE_URL. Use your gateway loopback/private address instead, e.g. http://127.0.0.1:3800/v1.',
  },
  ai_base_url_unresolved: {
    key: 'ai_fail_base_url_unresolved',
    zh: 'Base URL 的主机名解析不出 IP（DNS 失败）：请检查域名拼写、DNS/网络，或直接填 IP 地址。',
    en: 'The Base URL host name cannot be resolved (DNS failure). Check the spelling / DNS, or use an IP address.',
  },
  ai_base_url_host_not_allowed: {
    key: 'ai_fail_base_url_host',
    zh: '该主机名被禁止（云元数据主机名或 .local/.internal/.svc 内网后缀）：请改用它的 IP 或 localhost。',
    en: 'This host name is not allowed (cloud-metadata host name or .local/.internal/.svc suffix). Use its IP address or localhost instead.',
  },
  ai_base_url_userinfo_not_allowed: {
    key: 'ai_fail_base_url_userinfo',
    zh: 'Base URL 里不能带用户名密码（user:pass@）：请把凭据填到「API Key」字段，地址只保留协议+主机+端口。',
    en: 'The Base URL must not embed credentials (user:pass@). Put them in the API Key field and keep only scheme + host + port.',
  },
  ai_base_url_scheme_not_allowed: {
    key: 'ai_fail_base_url_scheme',
    zh: 'Base URL 必须以 http:// 或 https:// 开头（file:/ftp:/gopher: 等协议不允许）。',
    en: 'The Base URL must start with http:// or https:// (file:/ftp:/gopher: are not allowed).',
  },
  ai_base_url_invalid: {
    key: 'ai_fail_base_url_invalid',
    zh: 'Base URL 格式不合法：请填完整地址，例如 http://127.0.0.1:3800/v1。',
    en: 'The Base URL is malformed. Use a full URL such as http://127.0.0.1:3800/v1.',
  },
  ai_base_url_too_long: {
    key: 'ai_fail_base_url_too_long',
    zh: 'Base URL 过长（超过 2048 字符）：请只填协议+主机+端口+路径前缀。',
    en: 'The Base URL is too long (over 2048 characters). Keep it to scheme + host + port + path prefix.',
  },
  // ===== 刷新模型列表（上游 GET {baseUrl}/models）本轮新增/复用的 code =====
  // 用户实测：服务端在 Docker 里 + Base URL 填 127.0.0.1:3800 ⇒ 必然连不上。旧实现把这理解成
  // "刷新成功但 0 个模型"。现在如实返回失败，并由这里翻译成人话（含容器那条可直接照做的建议）。
  ai_base_url_loopback_in_container: {
    key: 'ai_fail_base_url_loopback_in_container',
    // 服务端会带一条**含真实端口**的完整建议，UI 优先原样展示它；这条只是服务端没带 message 时的兜底
    zh: '服务端运行在 Docker 容器中，127.0.0.1 指向容器自身，无法访问你机器上的网关；请改用 http://host.docker.internal:<端口>/v1（本机 Docker Desktop 可直接解析）或宿主机内网 IP（如 http://192.168.x.x:<端口>/v1）。',
    en: 'The server runs in a Docker container, so 127.0.0.1 points at the container itself and cannot reach your machine. Use http://host.docker.internal:<port>/v1 (resolves out of the box on Docker Desktop) or your host LAN IP (e.g. http://192.168.x.x:<port>/v1).',
  },
  ai_upstream_invalid_response: {
    key: 'ai_fail_upstream_invalid_response',
    zh: '上游没有返回模型列表结构（{name}）：请确认 Base URL 指向 OpenAI 兼容网关，且该地址提供 /v1/models。',
    en: 'The upstream did not return a model-list payload ({name}). Make sure the Base URL points to an OpenAI-compatible gateway exposing /v1/models.',
  },
  ai_upstream_http_error: {
    key: 'ai_fail_upstream_http_error',
    zh: '上游拒绝了模型列表请求（{name}）：请查看下方状态码与上游原文。',
    en: 'The upstream rejected the model-list request ({name}). See the status code and upstream message below.',
  },
  ai_no_base_url: {
    key: 'ai_fail_no_base_url',
    zh: '该供应商没有配置 Base URL，无法拉取模型列表。',
    en: 'This provider has no Base URL configured, so the model list cannot be fetched.',
  },
  // 供应商预设为空 / 不在预设白名单（服务端 code=INVALID_PROVIDER；error 仍是英文 'Invalid provider'）。
  // 用户实测：新增供应商草稿态下「供应商」下拉为空 → 刷新直接 400，换 127.0.0.1 / host.docker.internal
  // 表现一模一样（看着像网络故障，其实根本没发出上游请求）。
  // 注意：服务端各端点会带自己的 message（供应商表单 / 搜索源），见 SERVER_MESSAGE_FIRST_CODES。
  INVALID_PROVIDER: {
    key: 'ai_fail_invalid_provider',
    zh: '请先选择供应商；自定义/本地网关请选 Custom。',
    en: 'Select a provider first; choose Custom for your own or local gateway.',
  },
  // 搜索源（SearXNG 等）测试失败：服务端 code=SEARCH_FAILED（地址策略拒绝时会给 ai_base_url_* 码）
  SEARCH_FAILED: {
    key: 'ai_fail_search_failed',
    zh: '搜索源连接失败：请检查自建地址、API Key 与网络（地址是否可达）。',
    en: 'Search source connection failed. Check the self-hosted URL, API key and network reachability.',
  },
}

/** code 是否在这张映射表里（未命中时调用方应继续沿用服务端原文案，不要拿泛化文案盖掉细节） */
export function hasAiFailureMapping(data: AiFailurePayload | null | undefined): boolean {
  return Boolean(REASON[String(data?.code || '')])
}

/**
 * 这些 code 的文案由**服务端**按真实参数生成，UI 应优先原样展示响应体里的 `message`；
 * 只有服务端没带 message 时才回退到 REASON 的通用文案。
 * - ai_base_url_loopback_in_container：message 里带真实端口与可照做的替换地址；
 * - INVALID_PROVIDER：同一个码在**供应商表单**（请先选择供应商…）与**搜索源**（请选择搜索源）
 *   两个端点语义不同，用服务端的分端 message 比一张通用表更准确。
 */
export const SERVER_MESSAGE_FIRST_CODES: ReadonlySet<string> = new Set([
  'ai_base_url_loopback_in_container',
  'INVALID_PROVIDER',
])

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
