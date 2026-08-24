/**
 * AI 供应商预设与上游请求构造工具
 *
 * 职责：
 * 1. 维护内置供应商预设（OpenAI / Anthropic / DeepSeek / Qwen / Hunyuan / MiMo /
 *    MiniMax / StepFun / LongCat / Custom），每个预设包含默认 base_url、默认 model、
 *    请求协议族（openai 兼容 / anthropic）、认证头字段。
 * 2. 根据供应商配置构造上游聊天请求（URL / headers / body）。
 *
 * 安全：本文件不接触任何密钥明文，密钥由调用方（路由层）从加密字段解密后传入。
 */

import { logger } from './logger.js'
import dns from 'node:dns'

/**
 * 协议族：
 * - 'openai'：OpenAI Chat Completions 兼容协议（OpenAI / DeepSeek / Qwen / Hunyuan /
 *   MiMo / MiniMax / StepFun / LongCat / 自定义均属此类）
 * - 'anthropic'：Anthropic Messages 协议（请求/响应结构不同，需单独处理）
 *
 * authHeader：默认 Authorization；MiMo 等部分平台需要 api-key 头。
 */

// ==================== SSRF 防护（上游 fetch 统一入口） ====================
// 供 chat / models / test / ocr 复用：URL 解析 + 协议/主机校验防内网 SSRF +
// 禁跟随重定向 + 超时。避免各调用点各自裸 fetch 造成"忘了校验"的漂移。

/** 是否为私网 / 保留网段 IP（IPv4 与常见 IPv6 链路本地/唯一本地地址） */
export function isPrivateIp(ip) {
  if (!ip) return false
  const v = String(ip).toLowerCase()
  if (v === '::1' || v === '::' || v === '0.0.0.0') return true
  // IPv6 link-local / 唯一本地地址
  if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v)
  if (m) {
    const p = m.slice(1).map(Number)
    if (p[0] === 10) return true // 10/8
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true // 172.16/12
    if (p[0] === 192 && p[1] === 168) return true // 192.168/16
    if (p[0] === 169 && p[1] === 254) return true // 169.254/16 link-local
    if (p[0] === 127) return true // loopback
    if (p[0] === 0) return true
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true // 100.64/10 CGNAT
  }
  return false
}

/** 明文禁用的上游主机名（本机回环别名 / 云元数据端点） */
export const BLOCKED_HOSTNAMES = ['localhost', 'metadata.google.internal', 'metadata']

/** 校验上游 URL：协议必须 http/https，且主机不得指向内网/保留网段。非法时抛错。 */
export async function assertSafeUpstreamUrl(input) {
  let parsed
  try {
    parsed = new URL(input)
  } catch {
    throw new Error('Invalid upstream URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Upstream URL must use http or https')
  }
  const host = parsed.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.includes(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.svc')) {
    throw new Error('Upstream URL host is not allowed')
  }
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) throw new Error('Upstream URL resolves to a blocked internal address')
    return
  }
  // 主机名：解析后再校验一次，防 DNS rebinding 指向内网
  try {
    const { address } = await dns.promises.lookup(host)
    if (isPrivateIp(address)) throw new Error('Upstream URL resolves to a blocked internal address')
  } catch {
    // 解析失败交给 fetch 自行报错
  }
}

/**
 * 安全的上游 fetch：URL 校验（协议 + 防内网 SSRF）+ 禁跟随重定向 + 超时。
 * 供 chat / models / test / ocr 统一复用，避免各调用点裸 fetch 遗漏校验。
 *
 * @param {string} url 上游请求地址
 * @param {RequestInit} [options] fetch 选项（method/headers/body/signal…）
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] 默认超时，默认 10000ms；options.signal 存在时优先用信号量
 * @returns {Promise<Response>}
 */
export async function safeUpstreamFetch(url, options = {}, { timeoutMs = 10000 } = {}) {
  await assertSafeUpstreamUrl(url)
  return fetch(url, {
    ...options,
    redirect: 'manual',
    signal: options.signal || AbortSignal.timeout(timeoutMs),
  })
}

/**
 * 协议族：
 * - 'openai'：OpenAI Chat Completions 兼容协议（OpenAI / DeepSeek / Qwen / Hunyuan /
 *   MiMo / MiniMax / StepFun / LongCat / 自定义均属此类）
 * - 'anthropic'：Anthropic Messages 协议（请求/响应结构不同，需单独处理）
 *
 * authHeader：默认 Authorization；MiMo 等部分平台需要 api-key 头。
 */
export const PROVIDER_PRESETS = {
  openai: {
    provider: 'openai',
    label: 'OpenAI',
    family: 'openai',
    authHeader: 'Authorization',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    supportsCache: true,
  },
  anthropic: {
    provider: 'anthropic',
    label: 'Anthropic',
    family: 'anthropic',
    authHeader: 'x-api-key',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-5-sonnet-latest',
    supportsCache: true,
  },
  deepseek: {
    provider: 'deepseek',
    label: 'DeepSeek',
    family: 'openai',
    authHeader: 'Authorization',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    supportsCache: false,
  },
  qwen: {
    provider: 'qwen',
    label: 'Qwen (通义千问)',
    family: 'openai',
    authHeader: 'Authorization',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    supportsCache: true,
  },
  hunyuan: {
    provider: 'hunyuan',
    label: 'Hunyuan (腾讯混元)',
    family: 'openai',
    authHeader: 'Authorization',
    defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    defaultModel: 'hunyuan-turbo',
    supportsCache: false,
  },
  mimo: {
    provider: 'mimo',
    label: 'MiMo (小米)',
    family: 'openai',
    authHeader: 'api-key',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    supportsCache: false,
  },
  minimax: {
    provider: 'minimax',
    label: 'MiniMax',
    family: 'openai',
    authHeader: 'Authorization',
    defaultBaseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M3',
    supportsCache: false,
  },
  stepfun: {
    provider: 'stepfun',
    label: 'StepFun (阶跃星辰)',
    family: 'openai',
    authHeader: 'Authorization',
    defaultBaseUrl: 'https://api.stepfun.com/step_plan/v1',
    defaultModel: 'step-3.7-flash',
    supportsCache: false,
  },
  longcat: {
    provider: 'longcat',
    label: 'LongCat (美团)',
    family: 'openai',
    authHeader: 'Authorization',
    defaultBaseUrl: 'https://api.longcat.chat/openai',
    defaultModel: 'LongCat-Flash-Chat',
    supportsCache: false,
  },
  custom: {
    provider: 'custom',
    label: 'Custom (OpenAI 兼容)',
    family: 'openai',
    authHeader: 'Authorization',
    defaultBaseUrl: '',
    defaultModel: '',
    supportsCache: false, // 未知，保守按不支持处理；如供应商支持可由前端 UI 显式声明
  },
}

/**
 * 取供应商预设（找不到返回 undefined）
 */
export function getPreset(provider) {
  return PROVIDER_PRESETS[provider]
}

/**
 * 该供应商是否在协议层支持 prompt cache 字段。
 * - true：上游会返回 cache_creation_input_tokens / cache_read_input_tokens
 *   （Anthropic 协议）/ prompt_tokens_details.cached_tokens（OpenAI 协议）等字段；
 *   圆环 / 面板应显示真实命中率。
 * - false：上游根本没有 cache 字段，UI 应显示"未启用 / N/A"而不是 0% 误导。
 * 命中不到时默认按 false 处理（保守），避免在不支持的供应商上"装作有缓存"。
 */
export function providerSupportsCache(provider) {
  const preset = PROVIDER_PRESETS[provider]
  if (!preset) return false
  return preset.supportsCache === true
}

/**
 * 常见模型的上下文窗口（token 数）。用于前端展示「上下文用量百分比」圆环。
 * 命中不到时用 DEFAULT_CONTEXT_WINDOW 兜底（现代模型大多 ≥ 32k）。
 * 注意：这是近似值，仅作 UI 指示；真实 token 数由上游 usage 返回。
 */
// 真实模型的上下文窗口（token 数）。用于前端「上下文用量百分比」圆环，必须与模型实际一致。
// 精确匹配优先；带 `*` 的键用于前缀匹配（如 gpt-4o-2024-… → gpt-4o 的 128k）。
// 注意：这是各模型的官方上下文窗口，仅作 UI 指示；单次真实 token 数仍由上游 usage 返回。
const MODEL_CONTEXT_WINDOWS = {
  // ===== OpenAI =====
  'gpt-4o': 128000,
  'gpt-4o*': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-4-32k': 32768,
  'gpt-3.5-turbo': 16385,
  'gpt-4.1': 1047576,
  'gpt-4.1*': 1047576,
  'gpt-4.1-mini': 1047576,
  'gpt-4.1-nano': 1047576,
  'gpt-5': 272000,
  'gpt-5*': 272000,
  'o1': 200000,
  'o1-mini': 128000,
  'o1-preview': 128000,
  'o3': 200000,
  'o3-mini': 200000,
  'o4-mini': 200000,
  'chatgpt-4o-latest': 128000,

  // ===== Anthropic =====
  'claude-3-5-sonnet': 200000,
  'claude-3-5-sonnet*': 200000,
  'claude-3-5-haiku': 200000,
  'claude-3-5-haiku*': 200000,
  'claude-3-opus': 200000,
  'claude-3-opus*': 200000,
  'claude-3-haiku': 200000,
  'claude-3-haiku*': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-7-sonnet': 200000,
  'claude-3-7-sonnet*': 200000,
  'claude-sonnet-4': 200000,
  'claude-sonnet-4*': 200000,
  'claude-opus-4': 200000,
  'claude-opus-4*': 200000,

  // ===== Google Gemini（OpenAI 兼容网关） =====
  'gemini-1.5-pro': 2000000,
  'gemini-1.5-pro*': 2000000,
  'gemini-1.5-flash': 1000000,
  'gemini-1.5-flash*': 1000000,
  'gemini-2.0-flash': 1000000,
  'gemini-2.0-flash*': 1000000,
  'gemini-2.5-pro': 1000000,
  'gemini-2.5-pro*': 1000000,
  'gemini-2.5-flash': 1000000,
  'gemini-2.5-flash*': 1000000,

  // ===== DeepSeek =====
  'deepseek-chat': 64000,
  'deepseek-reasoner': 64000,
  'deepseek-coder': 128000,
  'deepseek-*': 64000,

  // ===== 阿里 Qwen / 通义 =====
  'qwen-plus': 131072,
  'qwen-max': 32768,
  'qwen-max-longcontext': 1000000,
  'qwen-turbo': 131072,
  'qwen-long': 10000000,
  'qwen2.5-7b-instruct': 32768,
  'qwen2.5-14b-instruct': 32768,
  'qwen2.5-32b-instruct': 32768,
  'qwen2.5-72b-instruct': 32768,
  'qwen2.5*': 131072,
  'qwen3': 131072,
  'qwen3*': 131072,
  'qwq': 32768,
  'qwq*': 32768,

  // ===== Moonshot / Kimi =====
  'moonshot-v1-8k': 8192,
  'moonshot-v1-32k': 32768,
  'moonshot-v1-128k': 131072,
  'moonshot-v1*': 131072,
  'kimi-k2': 256000,
  'kimi-*': 256000,

  // ===== 智谱 GLM =====
  'glm-4': 128000,
  'glm-4*': 128000,
  'glm-4-long': 1000000,
  'glm-4.5': 128000,
  'glm-4.5*': 128000,

  // ===== MiniMax =====
  'abab6.5': 245760,
  'abab6.5s': 200000,
  'abab5.5': 245760,
  'minimax-01': 4000000,
  'minimax-text-01': 4000000,
  'minimax*': 200000,

  // ===== 阶跃 StepFun =====
  'step-1': 32768,
  'step-2': 32768,
  'step-1v': 32768,
  'step*': 32768,

  // ===== 百川 Baichuan =====
  'baichuan4': 32768,
  'baichuan3-turbo': 32768,
  'baichuan*': 32768,
}

const DEFAULT_CONTEXT_WINDOW = 128000

/**
 * 解析模型上下文窗口（token 数）。解析优先级：
 *   1. override（provider 上用户明确配置的 context_window，最权威）
 *   2. 精确匹配模型名 → 前缀匹配（带 `*` 的键）
 *   3. 从模型名解析 "128k" / "200k" / "1m" 等上下文标记
 *   4. DEFAULT_CONTEXT_WINDOW 兜底
 * @param {string} model 模型标识
 * @param {number} [override] provider 级显式上下文窗口（用户配置，最权威）
 * @returns {number} 上下文窗口 token 数
 */
export function getContextWindow(model, override) {
  if (typeof override === 'number' && override > 0) return Math.floor(override)
  if (!model) return DEFAULT_CONTEXT_WINDOW
  const m = String(model).toLowerCase()
  if (MODEL_CONTEXT_WINDOWS[m]) return MODEL_CONTEXT_WINDOWS[m]
  for (const key of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (key.endsWith('*') && m.startsWith(key.slice(0, -1))) {
      return MODEL_CONTEXT_WINDOWS[key]
    }
  }
  const nameMatch = m.match(/(\d+)\s*(k|m)\b/)
  if (nameMatch) {
    const n = parseInt(nameMatch[1], 10)
    const unit = nameMatch[2] === 'k' ? 1000 : 1000000
    return n * unit
  }
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * 把前端传来的「带图用户消息」规范化为目标协议族能识别的格式。
 *
 * 前端统一用 OpenAI 风格的 vision content 数组表达图片：
 *   { role:'user', content: [ {type:'text', text}, {type:'image_url', image_url:{url:'data:image/png;base64,...'}} ] }
 *
 * - OpenAI 兼容族：image_url（data URL）原生支持，原样透传即可。
 * - Anthropic 族：需要转成 { type:'image', source:{ type:'base64', media_type, data } }，
 *   并把 text 块保持为 { type:'text', text }。非 data URL 的图片（理论上不会出现）跳过。
 *
 * 非 user 消息 / 纯字符串 content 不做任何处理，直接返回。
 */
function normalizeVisionMessages(messages, family) {
  if (family !== 'anthropic') return messages
  return messages.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m
    const content = m.content
      .map((block) => {
        if (block.type === 'image_url') {
          const url = block.image_url?.url || ''
          const match = url.match(/^data:([^;]+);base64,(.*)$/s)
          if (match) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: match[1] || 'image/png',
                data: match[2],
              },
            }
          }
          return null
        }
        return block
      })
      .filter(Boolean)
    return { ...m, content }
  })
}

/**
 * 取所有预设（脱敏，仅给前端做下拉用，不含任何密钥）
 */
export function listPresets() {
  return Object.values(PROVIDER_PRESETS).map((p) => ({
    provider: p.provider,
    label: p.label,
    family: p.family,
    defaultBaseUrl: p.defaultBaseUrl,
    defaultModel: p.defaultModel,
  }))
}

/**
 * 构造上游聊天请求。
 *
 * @param {object} cfg
 * @param {string} cfg.provider   供应商标识（对应 PROVIDER_PRESETS 的 key）
 * @param {string} [cfg.baseUrl]  用户自定义 base_url（覆盖预设默认值）
 * @param {string} cfg.model      模型标识
 * @param {string} cfg.apiKey     已解密的明文密钥
 * @param {Array}  cfg.messages   对话消息 [{ role, content }]
 * @param {object} [cfg.options]  { maxTokens, temperature }
 * @returns {{ url: string, headers: object, body: object, family: string }}
 */
export function buildUpstreamChat(cfg) {
  const { provider, baseUrl, model, apiKey, messages, options = {} } = cfg
  const preset = getPreset(provider)
  if (!preset) {
    throw new Error(`Unknown provider: ${provider}`)
  }

  // 把前端传来的带图 user 消息规范化为当前协议族可识别的格式（OpenAI 兼容原样、
  // Anthropic 转 base64 source）。非 user / 纯文本消息不受影响。
  const normalizedMessages = normalizeVisionMessages(messages, preset.family)

  const resolvedBaseUrl = (baseUrl || preset.defaultBaseUrl || '').replace(/\/+$/, '')
  if (!resolvedBaseUrl) {
    throw new Error('base_url is required for custom provider')
  }

  const stream = options.stream !== false

  if (preset.family === 'anthropic') {
    // Anthropic Messages 协议：system 必须独立成字段，不能放在 messages 里
    const systemMessages = normalizedMessages.filter((m) => m.role === 'system')
    const chatMessages = normalizedMessages.filter((m) => m.role !== 'system')
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }
    const body = {
      model,
      messages: chatMessages,
      max_tokens: options.maxTokens || 1024,
      stream,
    }
    // Anthropic 原生 thinking 参数（OpenAI 兼容族不支持该字段，由 reasoning_content 自动下发）
    if (options.thinking) {
      body.thinking = { type: 'enabled', budget_tokens: options.thinkingBudget || 4096 }
    }
    if (systemMessages.length > 0) {
      body.system = [{ type: 'text', text: systemMessages.map((m) => m.content).join('\n\n') }]
      // 开启 prompt caching：稳定的 system 前缀标记为可缓存，后续请求命中缓存后上游会返回
      // cache_read_input_tokens，前端「缓存命中率」才是真实数据（而非恒为 0）。
      body.system[0].cache_control = { type: 'ephemeral' }
    }
    if (typeof options.temperature === 'number') {
      body.temperature = options.temperature
    }
    return {
      url: `${resolvedBaseUrl}/messages`,
      headers,
      body,
      family: 'anthropic',
    }
  }

  // OpenAI 兼容协议
  const authHeader = preset.authHeader || 'Authorization'
  const headers = { 'Content-Type': 'application/json' }
  if (authHeader === 'Authorization') {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    // MiMo 等平台使用 api-key 头，且不需要 Bearer 前缀
    headers[authHeader] = apiKey
  }
  const body = {
    model,
    messages: normalizedMessages,
    stream,
  }
  if (typeof options.temperature === 'number') {
    body.temperature = options.temperature
  }
  if (options.maxTokens) {
    body.max_tokens = options.maxTokens
  }
  // 支持工具定义
  if (options.tools) {
    body.tools = options.tools
  }
  if (options.tool_choice) {
    body.tool_choice = options.tool_choice
  }
  // 请求上游返回 token 用量（OpenAI 兼容协议支持 stream_options.include_usage）。
  // 流式响应最后一个 chunk 会携带顶层 usage 对象，供前端展示上下文占用百分比。
  if (stream) {
    body.stream_options = { include_usage: true }
  }
  return {
    url: `${resolvedBaseUrl}/chat/completions`,
    headers,
    body,
    family: 'openai',
  }
}

/**
 * 向上游拉取该供应商可用的模型列表（用于「一个配置支持多模型」的标签展示）。
 *
 * - OpenAI 兼容族：GET {baseUrl}/models，解析 data[].id
 * - Anthropic 族：GET {baseUrl}/models（需 x-api-key + anthropic-version），解析 data[].id
 * - 任何失败（无密钥 / 网络 / 鉴权）均回退到预设 defaultModel，保证至少有 1 个标签可点。
 *
 * @param {object} cfg { provider, baseUrl, apiKey }
 * @returns {Promise<string[]>} 模型标识数组
 */
export async function fetchProviderModels(cfg) {
  const { provider, baseUrl, apiKey } = cfg || {}
  const preset = getPreset(provider)
  if (!preset) return []
  const resolvedBaseUrl = (baseUrl || preset.defaultBaseUrl || '').replace(/\/+$/, '')
  // 自定义供应商未填 base_url 或没有密钥：无法拉取，回退预设默认模型
  if (!resolvedBaseUrl || !apiKey) {
    return preset.defaultModel ? [preset.defaultModel] : []
  }

  const authHeader = preset.authHeader || 'Authorization'
  const headers = {}
  if (authHeader === 'Authorization') {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers[authHeader] = apiKey
  }
  if (preset.family === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await safeUpstreamFetch(`${resolvedBaseUrl}/models`, { headers, signal: ctrl.signal })
    if (!res.ok) throw new Error(`models endpoint status ${res.status}`)
    const json = await res.json()
    const list = Array.isArray(json?.data)
      ? json.data.map((m) => m.id).filter(Boolean)
      : []
    // 去重并保持稳定顺序
    const unique = Array.from(new Set(list))
    return unique.length ? unique : (preset.defaultModel ? [preset.defaultModel] : [])
  } catch (e) {
    logger.warn('fetchProviderModels fallback to preset default:', e.message)
    return preset.defaultModel ? [preset.defaultModel] : []
  } finally {
    clearTimeout(timer)
  }
}

export default {
  PROVIDER_PRESETS,
  getPreset,
  listPresets,
  buildUpstreamChat,
  fetchProviderModels,
}
