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
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { convertMessagesForAnthropic } from './messageConverter.js'
// AN-03：ai_max_tokens 全链路统一钳制点（system_configs 5s TTL 缓存，fail-open 默认 4096）
import { clampMaxTokens } from './aiRuntimeConfig.js'

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

function parseIpv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const p = m.slice(1).map(Number)
  if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return p
}

function isPrivateIpv4(p) {
  const [a, b] = p
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  if (a === 127) return true // 127/8 loopback
  if (a === 169 && b === 254) return true // 169.254/16 link-local（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 192 && p[1] === 0 && p[2] === 2) return true // 192.0.2/24 TEST-NET-1
  if (a === 198 && b === 51 && p[2] === 100) return true // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && p[2] === 113) return true // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true // 224/4 组播 + 240/4 保留 + 255.255.255.255 广播
  return false
}

/** 展开 IPv6 字面量为 8 个 16-bit 组；支持 :: 缩写与内嵌 IPv4（::ffff:a.b.c.d）。非法返回 null。 */
function parseIpv6(input) {
  let s = input
  const lastColon = s.lastIndexOf(':')
  if (lastColon !== -1 && s.slice(lastColon + 1).includes('.')) {
    const p = parseIpv4(s.slice(lastColon + 1))
    if (!p) return null
    const hi = ((p[0] << 8) | p[1]).toString(16)
    const lo = ((p[2] << 8) | p[3]).toString(16)
    s = s.slice(0, lastColon + 1) + hi + ':' + lo
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  let parts
  if (halves.length === 2) {
    const l = halves[0] === '' ? [] : halves[0].split(':')
    const r = halves[1] === '' ? [] : halves[1].split(':')
    const missing = 8 - l.length - r.length
    if (missing < 0) return null
    parts = [...l, ...Array(missing).fill('0'), ...r]
  } else {
    parts = s.split(':')
  }
  if (parts.length !== 8) return null
  const groups = []
  for (const g of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    groups.push(parseInt(g, 16))
  }
  return groups
}

function v4FromGroups(g6, g7) {
  return [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff]
}

function isPrivateIpv6(g) {
  if (g.every((x) => x === 0)) return true // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true // ::1
  if (g.slice(0, 5).every((x) => x === 0)) {
    if (g[5] === 0xffff) return isPrivateIpv4(v4FromGroups(g[6], g[7])) // ::ffff:a.b.c.d IPv4-mapped
    if (g[5] === 0) return true // ::/96 IPv4-compatible（已废弃、不可路由）一律拒绝
  }
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 唯一本地
  if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8 组播
  if (g[0] === 0x100 && g.slice(1, 5).every((x) => x === 0)) return true // 100::/64 discard-only
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true // 2001:db8::/32 文档段
  if (g[0] === 0x2002) return isPrivateIpv4(v4FromGroups(g[1], g[2])) // 6to4 内嵌 IPv4
  if (g[0] === 0x2001 && g[1] === 0) {
    // Teredo：groups[2..3] 内嵌服务器 IPv4，groups[6..7] 内嵌客户端 IPv4（按位取反）
    if (isPrivateIpv4(v4FromGroups(g[2], g[3]))) return true
    const c = v4FromGroups(g[6], g[7]).map((x) => (~x) & 0xff)
    return isPrivateIpv4(c)
  }
  return false
}

/**
 * 是否为私网/保留网段 IP（fail-closed：无法解析为合法 IP 字面量时一律返回 true 视为被禁）。
 * 接受带方括号（[::1]）、带 zone（fe80::1%eth0）、IPv4-mapped/兼容 IPv6、:: 缩写等形态。
 */
export function isPrivateIp(ip) {
  if (ip === null || ip === undefined) return true
  let v = String(ip).trim().toLowerCase()
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1)
  const zone = v.indexOf('%')
  if (zone !== -1) v = v.slice(0, zone)
  const kind = net.isIP(v)
  if (kind === 4) {
    const p = parseIpv4(v)
    return p ? isPrivateIpv4(p) : true
  }
  if (kind === 6) {
    const g = parseIpv6(v)
    return g ? isPrivateIpv6(g) : true
  }
  return true
}

/** 明文禁用的上游主机名（本机回环别名 / 云元数据端点） */
export const BLOCKED_HOSTNAMES = ['localhost', 'metadata.google.internal', 'metadata']

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** 校验上游 URL：协议必须 http/https，且主机不得指向内网/保留网段。非法时抛错（fail-closed）。 */
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
  const bare = stripBrackets(host)
  if (net.isIP(bare)) {
    if (isPrivateIp(bare)) throw new Error('Upstream URL resolves to a blocked internal address')
    return
  }
  // 主机名：解析出全部地址逐个校验；解析失败/为空一律拒绝（fail-closed，不能把
  // DNS 失败与"内网判定抛错"混在同一个 catch 里吞掉）
  let addresses
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error('Upstream URL host cannot be resolved')
  }
  if (!addresses || addresses.length === 0) {
    throw new Error('Upstream URL host cannot be resolved')
  }
  for (const a of addresses) {
    if (isPrivateIp(a.address)) throw new Error('Upstream URL resolves to a blocked internal address')
  }
}

/** 连接期兜底：对 socket 实际要连接的每个解析结果再判一次，消除校验与建连之间的 DNS rebinding 窗口 */
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address, family)
    const list = Array.isArray(address) ? address.map((x) => (typeof x === 'string' ? x : x.address)) : [address]
    for (const ip of list) {
      if (isPrivateIp(ip)) {
        return callback(new Error('Upstream URL resolves to a blocked internal address'), address, family)
      }
    }
    callback(null, address, family)
  })
}

/** 把 node:http(s) IncomingMessage 适配成调用方使用的 fetch Response 子集 */
function wrapResponse(res) {
  const headers = new Headers()
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue
    headers.append(k, Array.isArray(v) ? v.join(', ') : String(v))
  }
  let webBody = null
  const resp = {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage || '',
    headers,
    get body() {
      if (!webBody) webBody = Readable.toWeb(res)
      return webBody
    },
    async arrayBuffer() {
      const reader = resp.body.getReader()
      const chunks = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(Buffer.from(value))
      }
      const buf = Buffer.concat(chunks)
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    },
    async text() {
      const ab = await resp.arrayBuffer()
      return Buffer.from(ab).toString('utf8')
    },
    async json() {
      return JSON.parse(await resp.text())
    },
  }
  return resp
}

/**
 * 安全的上游 fetch：URL 校验（协议 + 防内网 SSRF）+ 禁跟随重定向 + 超时。
 * 供 chat / models / test / ocr 统一复用，避免各调用点裸 fetch 遗漏校验。
 *
 * 底层用 node:http(s)（而非全局 fetch）以便挂 lookup 钩子：连接建立时对
 * socket 实际使用的 IP 再判一次内网，DNS rebinding 的 TOCTOU 窗口因此被消除。
 *
 * @param {string} url 上游请求地址
 * @param {object} [options] { method, headers, body, signal }（与 fetch 常用子集一致）
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] 默认超时，默认 10000ms；options.signal 存在时优先用信号量
 * @returns {Promise<object>} fetch Response 子集（ok/status/statusText/headers/body/text/json/arrayBuffer）
 */
export async function safeUpstreamFetch(url, options = {}, { timeoutMs = 10000 } = {}) {
  await assertSafeUpstreamUrl(url)
  const parsed = new URL(url)
  const transport = parsed.protocol === 'https:' ? https : http
  const headers = { ...(options.headers || {}) }
  // 本实现不做内容解压，显式要求 identity，防止上游返回 gzip 后调用方拿到二进制
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept-encoding')) {
    headers['accept-encoding'] = 'identity'
  }
  const signal = options.signal || AbortSignal.timeout(timeoutMs)
  return await new Promise((resolve, reject) => {
    const req = transport.request(
      parsed,
      {
        method: options.method || 'GET',
        headers,
        signal,
        lookup: guardedLookup,
      },
      (res) => resolve(wrapResponse(res)),
    )
    req.on('error', reject)
    if (options.body !== undefined && options.body !== null) req.write(options.body)
    req.end()
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
    // DeepSeek 官方支持上下文缓存（自动，>256 token 起），usage 返回
    // prompt_cache_hit_tokens；UI 应按真实命中率展示而非"未启用"。
    supportsCache: true,
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
    // 官方主推标准通道（开放平台 key，OpenAI 兼容，GET /models 可用）。
    // Step Plan 订阅专用通道为 https://api.stepfun.com/step_plan/v1（需 Step Plan key），
    // 有需求的用户可在表单里手动覆盖 baseUrl。
    defaultBaseUrl: 'https://api.stepfun.com/v1',
    defaultModel: 'step-3.7-flash',
    // 阶跃星辰官方支持 prompt cache（step-3.7-flash 等 >256 token 自动启用，
    // usage 返回顶层 cached_tokens）。此前硬编码 false 导致前端永远显示「未启用」。
    supportsCache: true,
  },
  // Step Explore：阶跃星辰面向 Agent/Coding 的新模型，申请制开通，
  // 仅支持 Anthropic Messages 协议（Step Plan 通道），认证为 Authorization: Bearer，
  // 推理强度用 output_config.effort（不是原生 anthropic 的 thinking 块）。
  'stepfun-anthropic': {
    provider: 'stepfun-anthropic',
    label: 'StepFun Explore (阶跃星辰 · Anthropic)',
    family: 'anthropic',
    authHeader: 'Authorization',
    defaultBaseUrl: 'https://api.stepfun.com/step_plan/v1',
    defaultModel: 'step-explore',
    supportsCache: false,
    anthropicEffortField: 'output_config',
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
    label: 'Custom',
    family: 'openai',
    authHeader: 'Authorization',
    defaultBaseUrl: '',
    defaultModel: '',
    supportsCache: false, // 未知，保守按不支持处理；如供应商支持可由前端 UI 显式声明
  },
}

/**
 * 解析供应商实际使用的协议族。
 *
 * - 非 custom 预设：固定取预设内置 family（openai / anthropic）。
 * - custom 预设：取用户显式配置的 apiFormat（openai / anthropic / responses），
 *   未配置时默认为 'openai'（兼容历史表单 / 老数据）。
 *
 * @param {string} provider 供应商标识（PROVIDER_PRESETS 的 key）
 * @param {string} [apiFormat] 用户配置的兼容格式（仅 custom 生效）
 * @returns {'openai'|'anthropic'|'responses'}
 */
export function resolveFamily(provider, apiFormat) {
  const preset = getPreset(provider)
  if (!preset || provider !== 'custom') {
    return preset?.family === 'anthropic' ? 'anthropic' : 'openai'
  }
  return ['openai', 'anthropic', 'responses'].includes(apiFormat) ? apiFormat : 'openai'
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
  'step-explore': 1000000, // Step Explore：申请制开通，最高 1M token 上下文

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
 * 把 OpenAI 风格消息数组转换为 OpenAI Responses API 的 input 数组。
 *
 * 前端 / 多轮循环内部统一使用 OpenAI 风格消息（role: user/assistant/tool），
 * Responses 协议走独立的 input 结构，这里做无损映射：
 * - assistant 的文本内容 → { type:'message', role:'assistant', content:[{type:'output_text',text}] }
 * - assistant 的 tool_calls 数组 → 逐条 { type:'function_call', call_id, name, arguments }
 * - role:'tool' 消息 → { type:'function_call_output', call_id, output }
 * - user 消息 → { type:'message', role:'user', content }（图片块转 input_image）
 * - system 消息被跳过（调用方负责提取到 instructions）
 *
 * @param {Array} messages OpenAI 风格的消息数组
 * @returns {Array} Responses 协议的 input 项数组
 */
export function messagesToResponsesInput(messages) {
  const input = []
  for (const m of messages || []) {
    if (!m || m.role === 'system') continue
    if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b) => (b?.type === 'text' ? b.text : '')).join('') : ''
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        })
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc || !tc.function?.name) continue
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments || '',
          })
        }
      }
      continue
    }
    if (m.role === 'tool') {
      const output = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output,
      })
      continue
    }
    // user 消息（含可能的图片块）
    let content = m.content
    if (Array.isArray(m.content)) {
      content = m.content.map((b) => {
        if (!b || b.type === 'text') return { type: 'input_text', text: b?.text ?? '' }
        if (b.type === 'image_url') return { type: 'input_image', image_url: b.image_url?.url }
        return { type: 'input_text', text: '' }
      })
    }
    input.push({ type: 'message', role: 'user', content })
  }
  return input
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
 * @param {string} cfg.provider      供应商标识（对应 PROVIDER_PRESETS 的 key）
 * @param {string} [cfg.baseUrl]     用户自定义 base_url（覆盖预设默认值）
 * @param {string} cfg.model         模型标识
 * @param {string} cfg.apiKey        已解密的明文密钥
 * @param {Array}  cfg.messages      对话消息 [{ role, content }]
 * @param {string} [cfg.apiFormat]   兼容格式（仅 custom 生效：openai/anthropic/responses）
 * @param {object} [cfg.options]     { maxTokens, temperature }
 * @returns {{ url: string, headers: object, body: object, family: string }}
 */
export function buildUpstreamChat(cfg) {
  const { provider, baseUrl, model, apiKey, messages, options = {}, apiFormat } = cfg
  const preset = getPreset(provider)
  if (!preset) {
    throw new Error(`Unknown provider: ${provider}`)
  }
  const family = resolveFamily(provider, apiFormat)

  let resolvedBaseUrl = (baseUrl || preset.defaultBaseUrl || '').replace(/\/+$/, '')
  if (!resolvedBaseUrl) {
    throw new Error('base_url is required for custom provider')
  }
  // Step Fun Step Plan 通道 URL 规范化：
  // 用户可能配置 https://api.stepfun.com/step_plan（按 Anthropic SDK 习惯写法），
  // 但实际上完整路径需带 /v1（如 /step_plan/v1/messages），这里自动补全避免 404。
  if (/api\.stepfun\.com\/step_plan$/.test(resolvedBaseUrl)) {
    resolvedBaseUrl = `${resolvedBaseUrl}/v1`
  }

  const stream = options.stream !== false

  if (family === 'anthropic') {
    // 把前端传来的带图 user 消息规范化为 Anthropic 可识别的 base64 source
    const visionNormalized = normalizeVisionMessages(messages, 'anthropic')
    // Anthropic Messages 协议：system 必须独立成字段，从输入 messages 中提取
    const systemMessages = (messages || []).filter((m) => m && m.role === 'system')
    const normalizedMessages = convertMessagesForAnthropic(visionNormalized)
    const chatMessages = normalizedMessages.filter((m) => m.role !== 'system')
    // 认证头按预设配置：原生 Anthropic 用 x-api-key；
    // StepFun Explore 等第 3 方 Anthropic 兼容网关用 Authorization: Bearer（见 step-explore 官方文档）。
    // custom + anthropic 无法预知目标网关的认证方式，双头发送（x-api-key 为 Anthropic 原生标准、
    // Authorization 为兼容网关常用），服务端按需识别其中一个。
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }
    if (preset.provider === 'custom') {
      headers['x-api-key'] = apiKey
      headers.Authorization = `Bearer ${apiKey}`
    } else if (preset.authHeader === 'Authorization') {
      headers.Authorization = `Bearer ${apiKey}`
    } else {
      headers['x-api-key'] = apiKey
    }
    const body = {
      model,
      messages: chatMessages,
      // AN-03：max_tokens 经全局 ai_max_tokens 钳制（缺省 1024 兜底后取 min）
      max_tokens: clampMaxTokens(options.maxTokens),
      stream,
    }
    // 原生 Anthropic thinking 参数（OpenAI 兼容族不支持该字段，由 reasoning_content 自动下发）
    if (options.thinking) {
      const isStepExploreModel = /step-explore/i.test(model)
      // Step Explore 文档明确说明不支持 thinking 参数，也不支持 output_config。
      // 对于使用 custom 供应商 + step-explore 模型的场景，跳过 thinking 字段。
      if (isStepExploreModel) {
        // 不发送 thinking 或 output_config
      } else if (preset.anthropicEffortField === 'output_config') {
        // 其他自定义 Anthropic 网关：推理强度字段为 output_config.effort（low/medium/high）
        const effort =
          options.thinkingStrength || options.thinkingEffort ||
          (options.thinkingBudget > 8192 ? 'high' : options.thinkingBudget < 2048 ? 'low' : 'medium')
        body.output_config = { effort }
      } else {
        body.thinking = { type: 'enabled', budget_tokens: options.thinkingBudget || 4096 }
      }
    }
    if (systemMessages.length > 0) {
      body.system = [{ type: 'text', text: systemMessages.map((m) => m.content).join('\n\n') }]
      // Step Explore 文档未列出 cache_control 字段，传了可能报 Unsupported parameter。
      // 对于使用 custom 供应商 + step-explore 模型的场景，也跳过 cache_control。
      const isStepExploreModel = /step-explore/i.test(model)
      if (preset.supportsCache !== false && !isStepExploreModel) {
        body.system[0].cache_control = { type: 'ephemeral' }
      }
    }
    if (typeof options.temperature === 'number') {
      body.temperature = options.temperature
    }
    // 工具定义（Anthropic Messages 协议：tools 数组放在顶层，与 model/messages 同级）
    // OpenAI 格式 { type: "function", function: { name, description, parameters } }
    //  → Anthropic 格式 { name, description, input_schema }
    if (options.tools && options.tools.length > 0) {
      const convertedTools = options.tools.map((t) => {
        const fn = t.function || {}
        const params = fn.parameters || {}
        const schema = {
          type: 'object',
          properties: params.properties || {},
        }
        const required = params.required
        if (Array.isArray(required) && required.length > 0) schema.required = required
        return {
          name: fn.name || t.name,
          description: fn.description || t.description || '',
          input_schema: schema,
        }
      })
      const deleteTool = convertedTools.find(t => t.name === 'delete_collection')
      logger.info('[buildUpstreamChat] anthropic tools count:', convertedTools.length, 'has delete_collection:', !!deleteTool, 'delete_collection schema:', deleteTool ? JSON.stringify(deleteTool.input_schema).substring(0, 200) : 'N/A')
      body.tools = convertedTools
      // tool_choice: auto / tool / { type: 'tool_use', name: 'xxx' } / 'none'
      if (options.tool_choice) {
        const tc = options.tool_choice
        if (typeof tc === 'string') {
          body.tool_choice = tc === 'auto' ? 'auto' : tc === 'none' ? 'none' : tc === 'required' ? 'any' : tc
        } else if (tc?.type === 'function') {
          body.tool_choice = { type: 'tool_use', name: tc.function?.name || '' }
        } else {
          body.tool_choice = tc
        }
      } else {
        body.tool_choice = 'auto'
      }
    }
    // DEBUG: 记录 Anthropic 请求体（脱敏），排查 Step Explore 工具调用失败原因
    if (family === 'anthropic') {
      const logBody = { ...body }
      if (logBody.system) logBody.system = '[SYSTEM_PROMPT_OMITTED]'
      if (Array.isArray(logBody.messages)) {
        logBody.messages = logBody.messages.map((m) => ({
          role: m.role,
          content_blocks: Array.isArray(m.content) ? m.content.map((b) => ({ type: b.type, len: (b.text || b.input || '').toString().length })) : typeof m.content === 'string' ? m.content.length : typeof m.content
        }))
      }
      logger.info('[buildUpstreamChat] anthropic request body:', JSON.stringify(logBody).substring(0, 800))
    }
    return {
      url: `${resolvedBaseUrl}/messages`,
      headers,
      body,
      family: 'anthropic',
    }
  }

  if (family === 'responses') {
    // OpenAI Responses 协议：输入走独立 input 结构（可由 OpenAI 风格消息无损转换），
    // system 提取到 instructions。认证为 Authorization: Bearer。
    const systemMessages = (messages || []).filter((m) => m.role === 'system')
    const input = messagesToResponsesInput(messages)
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }
    const body = {
      model,
      input,
      stream,
      // AN-03：max_output_tokens 经全局 ai_max_tokens 钳制（缺省 1024 兜底后取 min）
      max_output_tokens: clampMaxTokens(options.maxTokens),
    }
    if (typeof options.temperature === 'number') {
      body.temperature = options.temperature
    }
    if (systemMessages.length > 0) {
      body.instructions = systemMessages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n\n')
    }
    // 工具定义
    if (options.tools) {
      body.tools = options.tools
    }
    if (options.tool_choice) {
      body.tool_choice = options.tool_choice
    }
    return {
      url: `${resolvedBaseUrl}/responses`,
      headers,
      body,
      family: 'responses',
    }
  }

  // OpenAI 兼容协议
  const normalizedMessages = normalizeVisionMessages(messages, 'openai')
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
  // AN-03：max_tokens 恒发送并经全局 ai_max_tokens 钳制
  //（原先缺省不发送 = 上游默认上限；现统一受后台 ai_max_tokens 约束，可在管理台调大）
  body.max_tokens = clampMaxTokens(options.maxTokens)
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
 * - OpenAI 兼容族：GET {baseUrl}/models，解析 data[].id（Authorization: Bearer）
 * - Anthropic 族：GET {baseUrl}/models（需 x-api-key + anthropic-version），解析 data[].id
 * - Responses 族：GET {baseUrl}/models，Authorization: Bearer
 * - 任何失败（无密钥 / 网络 / 鉴权）均回退到预设 defaultModel，保证至少有 1 个标签可点。
 *
 * @param {object} cfg { provider, baseUrl, apiKey, apiFormat }
 * @returns {Promise<string[]>} 模型标识数组
 */
export async function fetchProviderModels(cfg) {
  const { provider, baseUrl, apiKey, apiFormat } = cfg || {}
  const preset = getPreset(provider)
  if (!preset) return []
  const resolvedBaseUrl = (baseUrl || preset.defaultBaseUrl || '').replace(/\/+$/, '')
  // 自定义供应商未填 base_url 或没有密钥：无法拉取，回退预设默认模型
  if (!resolvedBaseUrl || !apiKey) {
    return preset.defaultModel ? [preset.defaultModel] : []
  }

  const family = resolveFamily(provider, apiFormat)
  const headers = {}
  if (family === 'anthropic') {
    if (preset.provider === 'custom') {
      headers['x-api-key'] = apiKey
      headers.Authorization = `Bearer ${apiKey}`
    } else if (preset.authHeader === 'Authorization') {
      headers.Authorization = `Bearer ${apiKey}`
    } else {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    }
  } else {
    const authHeader = preset.authHeader || 'Authorization'
    if (authHeader === 'Authorization') {
      headers.Authorization = `Bearer ${apiKey}`
    } else {
      headers[authHeader] = apiKey
    }
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
  resolveFamily,
  listPresets,
  buildUpstreamChat,
  messagesToResponsesInput,
  fetchProviderModels,
  safeUpstreamFetch,
}
