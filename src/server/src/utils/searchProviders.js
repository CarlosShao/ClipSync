/**
 * 联网搜索源适配器（web_search 工具的多源路由层）
 *
 * 每个搜索源实现 `search(query, { apiKey, baseUrl, count })`，返回统一形状：
 *   { provider, items: [{ title, url, snippet }] }
 *
 * 支持的源（与桌面端设置下拉 / 管理台全局配置选项对齐）：
 * - anysearch：POST https://api.anysearch.com/v1/search（Bearer，搜+抓一体，content 折进 snippet 备注）
 * - bocha：POST https://api.bochaai.com/v1/web-search（Bearer，国产，summary 摘要）
 * - brave：GET https://api.search.brave.com/res/v1/web/search（X-Subscription-Token）
 * - tavily：POST https://api.tavily.com/search（body.api_key）
 * - searxng：GET {baseUrl}/search?q=&format=json（自建，无 key；baseUrl 必填）
 *
 * 安全：出站一律走 safeUpstreamFetch（协议/内网/元数据 차단 + DNS 复检 + 手动重定向 + 超时），
 * 因此 SearXNG 自建源指向内网同样会被拒绝 —— 自建源必须挂公网域名。
 */
import { logger } from './logger.js'
import { safeUpstreamFetch } from './aiProviders.js'

export const SEARCH_PROVIDERS = ['anysearch', 'bocha', 'brave', 'tavily', 'searxng']

const DEFAULT_BASE_URLS = {
  anysearch: 'https://api.anysearch.com',
  bocha: 'https://api.bochaai.com',
  brave: 'https://api.search.brave.com',
  tavily: 'https://api.tavily.com',
  searxng: '',
}

function clip(s, n = 500) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

async function readJson(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`对方返回非 JSON（HTTP ${res.status}）`)
  }
}

async function anysearchSearch(query, { apiKey, baseUrl, count }) {
  const base = (baseUrl || DEFAULT_BASE_URLS.anysearch).replace(/\/+$/, '')
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await safeUpstreamFetch(
    `${base}/v1/search`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, max_results: count }),
    },
    { timeoutMs: 15000 },
  )
  if (!res.ok) throw new Error(`AnySearch 返回 HTTP ${res.status}`)
  const body = await readJson(res)
  const results = body?.data?.results || body?.results || []
  return {
    provider: 'anysearch',
    items: results.map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: clip(r.snippet || r.content || ''),
    })),
  }
}

async function bochaSearch(query, { apiKey, baseUrl, count }) {
  if (!apiKey) throw new Error('博查搜索需要 API Key（open.bochaai.com 控制台获取）')
  const base = (baseUrl || DEFAULT_BASE_URLS.bocha).replace(/\/+$/, '')
  const res = await safeUpstreamFetch(
    `${base}/v1/web-search`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, summary: true, count }),
    },
    { timeoutMs: 15000 },
  )
  if (!res.ok) throw new Error(`博查返回 HTTP ${res.status}`)
  const body = await readJson(res)
  const values = body?.webPages?.value || []
  return {
    provider: 'bocha',
    items: values.map((v) => ({
      title: v.name || v.title || '',
      url: v.url || '',
      snippet: clip(v.summary || v.snippet || ''),
    })),
  }
}

async function braveSearch(query, { apiKey, baseUrl, count }) {
  if (!apiKey) throw new Error('Brave Search 需要 API Key（brave.com 开发者后台获取）')
  const base = (baseUrl || DEFAULT_BASE_URLS.brave).replace(/\/+$/, '')
  const url = `${base}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`
  const res = await safeUpstreamFetch(
    url,
    { headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey } },
    { timeoutMs: 15000 },
  )
  if (!res.ok) throw new Error(`Brave 返回 HTTP ${res.status}`)
  const body = await readJson(res)
  const results = body?.web?.results || []
  return {
    provider: 'brave',
    items: results.map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: clip(r.description || ''),
    })),
  }
}

async function tavilySearch(query, { apiKey, baseUrl, count }) {
  if (!apiKey) throw new Error('Tavily 需要 API Key（tavily.com 控制台获取）')
  const base = (baseUrl || DEFAULT_BASE_URLS.tavily).replace(/\/+$/, '')
  const res = await safeUpstreamFetch(
    `${base}/search`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: count, include_answer: false }),
    },
    { timeoutMs: 15000 },
  )
  if (!res.ok) throw new Error(`Tavily 返回 HTTP ${res.status}`)
  const body = await readJson(res)
  const results = body?.results || []
  return {
    provider: 'tavily',
    items: results.map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: clip(r.content || r.snippet || ''),
    })),
  }
}

async function searxngSearch(query, { baseUrl, count }) {
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new Error('自建 SearXNG 需要填写公网 BaseURL（如 https://search.example.com）')
  }
  const base = baseUrl.replace(/\/+$/, '')
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN`
  // safeUpstreamFetch 内含 SSRF 校验：内网自建源会被拒绝，必须挂公网域名
  const res = await safeUpstreamFetch(url, {}, { timeoutMs: 15000 })
  if (!res.ok) throw new Error(`SearXNG 返回 HTTP ${res.status}`)
  const body = await readJson(res)
  const results = body?.results || []
  return {
    provider: 'searxng',
    items: results.slice(0, count).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: clip(r.content || ''),
    })),
  }
}

const ADAPTERS = {
  anysearch: anysearchSearch,
  bocha: bochaSearch,
  brave: braveSearch,
  tavily: tavilySearch,
  searxng: searxngSearch,
}

/**
 * 统一搜索入口（web_search 工具调用）。
 * @param {string} provider 搜索源（非法/空 → anysearch）
 * @param {string} query 查询
 * @param {object} opts { apiKey, baseUrl, count, userId }（userId 仅日志）
 */
export async function searchWeb(provider, query, opts = {}) {
  const name = SEARCH_PROVIDERS.includes(provider) ? provider : 'anysearch'
  const count = Math.min(10, Math.max(1, parseInt(opts.count, 10) || 5))
  try {
    const out = await ADAPTERS[name](query, {
      apiKey: opts.apiKey || '',
      baseUrl: opts.baseUrl || '',
      count,
    })
    return { ...out, query, count: out.items.length }
  } catch (e) {
    logger.warn('[searchProviders] search failed:', { provider: name, error: e?.message })
    return { error: 'SEARCH_FAILED', code: 'SEARCH_FAILED', provider: name, message: String(e?.message || e) }
  }
}

/**
 * 测试搜索配置连通性（设置页"测试"按钮用）：只取 1 条，返回首条标题验证。
 */
export async function testSearchConfig(provider, { apiKey, baseUrl }) {
  const out = await searchWeb(provider, 'ClipSync', { apiKey, baseUrl, count: 1 })
  if (out.error) return out
  return { ok: true, provider: out.provider, firstTitle: out.items[0]?.title || '', count: out.items.length }
}
