import { api, getCsrfToken } from './client'
import { useConfigStore } from '@/stores/configStore'

export interface AiProvider {
  id: string
  provider: string
  name: string
  base_url: string | null
  model: string
  models?: string[] // 该配置下可用模型列表（由上游 /models 刷新得到）
  is_default: boolean
  created_at: string
  updated_at: string
  has_key: boolean
  context_window?: number | null // 模型上下文窗口（token 数）；非空时优先级高于内置表
  // 协议层是否支持 prompt cache（由后端 aiProviders.js 给出）。
  // - true：上游会返回 cache_read/cache_write tokens，应展示真实命中率
  // - false：上游没有 cache 字段，UI 应显示"未启用 / N/A"而不是 0% 误导
  supports_cache?: boolean
}

export interface AiProviderPreset {
  provider: string
  label: string
  family: string
  defaultBaseUrl: string
  defaultModel: string
}

export interface ChatMessage {
  id?: string // 消息 id（部分场景由后端下发，用于调试/去重）
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /**
   * 消息原始创建时间（ISO 字符串，来自 DB 的 created_at）。
   * 后端 saveMessages 用"全量替换"语义（DELETE + 重插），若不加这个字段，重插时
   * created_at 会被刷成同一次 NOW()，导致 GET 按 created_at ASC 排序失效（全相同），
   * 消息顺序退化为随机 UUID，聊天区就出现"消息乱序/凭空冒出"的现象。
   * 因此：select() 加载时保留它，saveCurrent 保存时带回后端，重插后顺序稳定。
   */
  createdAt?: string
  // 随消息一起发送的截图（data URL）。仅 user 消息使用，用于多模态（vision）提问。
  images?: ChatImage[]
  /** 当消息包含图片时，前端提供的原图 SHA-256，供后端重复检测直接使用 */
  imageHash?: string
  thinking?: string // 思考过程
  thinkingStartedAt?: number // 思考开始时间戳（毫秒），用于显示思考秒数
  toolCalls?: ToolCall[] // 工具调用
  toolResults?: ToolResult[] // 工具结果
  thinkingActive?: boolean // 思考阶段是否仍在进行：工具开始调用后视为结束（用于前端正确显示“思考完成”而非一直“思考中”）
  tool_call_id?: string // tool 角色消息关联的调用 id
  isError?: boolean // 标记该助手消息是否因出错而生成（不进入上游历史）
  agentRuns?: AgentRun[] // 多代理并行模式：本次回答中各子代理的运行状态卡片
  /** 前端内部附带的 system 消息元信息（如手动压缩命令的 loading/成功卡片） */
  systemMeta?: {
    kind?: string
    removed?: number
    savedTokens?: number
    summaryTokens?: number
    afterTokens?: number
    summaryPreview?: string
    reason?: string
  }
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ToolResult {
  tool_call_id: string
  content: string
  name?: string // 工具名（部分实现只在 result 下发，无 toolCalls 时用此兜底展示）
}

// 多代理并行模式：子代理运行状态
export type AgentRunStatus = 'planning' | 'working' | 'done' | 'failed' | 'synthesis'
export type AgentRunKind = 'coordinator' | 'worker' | 'synthesis'

export interface AgentRun {
  id: string
  name: string
  status: AgentRunStatus
  kind?: AgentRunKind
  error?: string
  thinking?: string
  thinkingStartedAt?: number
  thinkingActive?: boolean
  content?: string
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  // 子代理并行卡片展示用：本轮任务的简要目标，以及它用到的工具名列表
  objective?: string
  tools?: string[]
  // 执行耗时（毫秒）
  duration?: number
  // 协调代理下的子代理列表（用于嵌套展示，可选）
  subagentRuns?: AgentRun[]
}

// 随消息发送的截图（粘贴得到）。data 为完整 data URL（含前缀），可直接放入
// OpenAI 风格 image_url.url，或经后端转换为 Anthropic base64 source。
export interface ChatImage {
  mime: string
  data: string
  /** 原始 data URL 字节的 SHA-256，用于与服务端剪贴板图片哈希比对 */
  hash?: string
}

// 上下文用量（token 计数，由上游 usage 返回）
export interface ContextUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  contextWindow: number
  percent: number // 0-100，已 clamp
  // 缓存命中/写入 token 数（prompt_tokens_details.cached_tokens / cache_written_tokens）。
  // 占 promptTokens 的比例即「缓存命中率」，命中越高越省 token 成本。
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cacheHitRate?: number
  thinkingTokens?: number
  replyTokens?: number
}

// SSE 增量附带的元信息（多代理路由用）
export interface StreamDeltaMeta {
  // 该增量所属的“子代理”id（worker 的 thinking/content/tool 增量携带）
  agentId?: string
  // 代理生命周期事件（coordinator/worker/synthesis 的状态切换携带，无 agent_id）
  agent?: {
    id: string
    name: string
    status: AgentRunStatus
    kind?: AgentRunKind
    error?: string
  }
  // token 用量事件（每轮上游调用结束时下发，前端保留最近一次）
  usage?: ContextUsage
  // 破坏性工具确认门控（Agent-C 契约）：meta.type === 'confirm_tool_action' 时，
  // 后端请求用户对模型请求的破坏性/写操作放行，前端据此渲染确认卡片。
  // requestId 随 POST /api/ai/chat/approve 回传，用于将确认结果关联到对应待办。
  type?: 'confirm_tool_action'
  requestId?: string
  tool?: string
  argsSummary?: string
  impact?: string
}

export interface ChatOptions {
  maxTokens?: number
  temperature?: number
  mode?: 'ask' | 'agent'
  thinking?: boolean
  thinkingStrength?: 'low' | 'medium' | 'high'
  // 本次请求使用的模型（覆盖供应商默认 model，用于多选标签场景）
  model?: string
  // 当前对话 id，后端在流结束后把 token 用量持久化到该对话
  conversationId?: string
}

export interface AiConversation {
  id: string
  title: string
  model: string | null
  mode: 'ask' | 'agent'
  thinking_enabled: boolean
  created_at: string
  updated_at: string
  message_count: number
  // 持久化的 token 用量（#226+）
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  cache_hit_rate?: number
  thinking_tokens?: number
  reply_tokens?: number
  context_window?: number
}

export interface AiConversationInput {
  title?: string
  providerId?: string
  model?: string
  mode?: 'ask' | 'agent'
  thinkingEnabled?: boolean
}

export interface AiProviderInput {
  provider: string
  name: string
  apiKey?: string
  baseUrl?: string
  model: string
  models?: string[]
  isDefault?: boolean
  contextWindow?: number | null
}

// AI 用户偏好（入库持久化）
export interface AiSettings {
  defaultProviderId: string | null
  defaultModel: string | null
  selectedModels: Record<string, string>
  defaultMode: 'ask' | 'agent'
  thinkingEnabled: boolean
  thinkingStrength: 'low' | 'medium' | 'high'
  // 长程记忆开关：是否把用户记忆注入 AI system prompt（服务端读 ai_settings，前端持久化）
  memoryEnabled: boolean
}

// ===== CRUD =====

export function getProviders() {
  return api<{ items: AiProvider[]; count: number }>('GET', '/api/ai/providers')
}

export function getPresets() {
  return api<{ items: AiProviderPreset[] }>('GET', '/api/ai/presets')
}

export interface AiContext {
  stats: {
    total: number
    textCount: number
    imageCount: number
    fileCount: number
    linkCount: number
    codeCount: number
    favoriteItemsCount: number
    archivedCount: number
  }
  collections: { collectionsCount: number; collectionItemsCount: number }
  tags: { tagsCount: number }
  devices: { devicesCount: number; onlineDevicesCount: number }
  templates: { templatesCount: number; variablesCount: number }
  sharedLinks: { sharedLinksCount: number }
  recentItems: Array<{ id: string; type: string; preview: string; isFavorite: boolean; createdAt: string }>
  subscription: { planName: string; displayName: string; maxDevices: number; maxClipboardItems: number; maxFileSizeMb: number; maxStorageMb: number } | null
  memories: AiMemory[]
}

export interface AiMemory {
  id: string
  category: 'preference' | 'fact' | 'project' | 'feedback' | 'other'
  title: string
  content: string
  updatedAt: string
}

export interface AiMemoryInput {
  category?: AiMemory['category']
  title: string
  content: string
}

export function getAiContext() {
  return api<{ context: AiContext }>('GET', '/api/ai/context')
}

/**
 * 流式「提示词改写」：不进入对话历史，不下发 SSE error 流式推送。
 * 解析规则与 streamChat 一致：当后端写 `data: {"error":"..."}` 时，前端 onError 拿到异常信息并展示。
 * 设计目标：行为对齐 WorkBuddy 的 Sparkles 图标 —— 点一下，AI 润色当前输入，结果覆盖回输入框。
 */
export async function streamRefactorPrompt(opts: {
  providerId: string
  content: string
  onDelta: (text: string) => void
  onError?: (msg: string, detail?: string) => void
  onDone?: () => void
  signal?: AbortSignal
}): Promise<void> {
  const config = useConfigStore()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = config.config.token
  if (token) headers['Authorization'] = `Bearer ${token}`
  const csrf = await getCsrfToken()
  if (csrf) headers['X-CSRF-Token'] = csrf

  let res: Response
  try {
    res = await fetch(`${config.serverUrl}/api/ai/refactor-prompt`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ providerId: opts.providerId, content: opts.content }),
      signal: opts.signal,
    })
  } catch (e: any) {
    if (e?.name === 'AbortError') return
    opts.onError?.(String(e?.message || e))
    return
  }

  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`
    let detail: string | undefined
    try {
      const j = await res.json()
      msg = j?.error || j?.message || msg
      detail = j?.detail
    } catch { /* ignore */ }
    opts.onError?.(msg, detail)
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const dataLines = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
      for (const data of dataLines) {
        if (!data) continue
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          if (parsed?.error) {
            opts.onError?.(parsed.error, parsed.detail)
            return
          }
          const delta = parsed?.choices?.[0]?.delta
          if (delta?.content && typeof delta.content === 'string') {
            opts.onDelta(delta.content)
          }
        } catch (e) {
          console.warn('[streamRefactorPrompt] bad SSE chunk:', data, e)
        }
      }
    }
  }
  opts.onDone?.()
}

export function createProvider(input: AiProviderInput) {
  return api<AiProvider>('POST', '/api/ai/providers', input)
}

export function updateProvider(id: string, input: Partial<AiProviderInput>) {
  return api<AiProvider>('PUT', `/api/ai/providers/${id}`, input)
}

export function deleteProvider(id: string) {
  return api('DELETE', `/api/ai/providers/${id}`)
}

export function testProvider(id: string) {
  return api<{ ok: boolean; detail?: string; status?: number }>('POST', `/api/ai/providers/${id}/test`)
}

// 拉取某供应商可用模型列表（上游 /models 刷新），返回 { models: string[] }
export function getProviderModels(id: string) {
  return api<{ models: string[] }>('GET', `/api/ai/providers/${id}/models`)
}

// 未保存供应商预览可用模型列表（不落地）
export function fetchProviderModels(input: { provider: string; baseUrl?: string; apiKey: string }) {
  return api<{ models: string[] }>('POST', '/api/ai/providers/fetch-models', input)
}

// AI 用户偏好
export function getSettings() {
  return api<AiSettings>('GET', '/api/ai/settings')
}

export function saveSettings(settings: Partial<AiSettings>) {
  return api<AiSettings>('PUT', '/api/ai/settings', settings)
}

// ===== Conversations =====

export function getConversations() {
  return api<{ items: AiConversation[]; count: number }>('GET', '/api/ai/conversations')
}

export function createConversation(input: AiConversationInput) {
  return api<{ conversation: AiConversation }>('POST', '/api/ai/conversations', input)
}

export function getConversation(id: string) {
  return api<{ conversation: AiConversation; messages: ChatMessage[] }>('GET', `/api/ai/conversations/${id}`)
}

export function updateConversation(id: string, title: string) {
  return api<{ conversation: AiConversation }>('PUT', `/api/ai/conversations/${id}`, { title })
}

export function deleteConversation(id: string) {
  return api<{ deleted: boolean }>('DELETE', `/api/ai/conversations/${id}`)
}

// 手动压缩指定对话的上下文历史（前端 /compact 命令触发）。
// 后端会：加载 messages → LLM 生成摘要 → 持久化到 ai_messages → 返回压缩结果。
export interface CompactResult {
  ok: boolean
  reason?: 'too_short' | 'not_found' | 'no_provider' | 'no_key' | 'failed'
  error?: string
  removed?: number // 被压缩掉的消息条数
  summaryTokens?: number // 新摘要占用的估算 token
  beforeTokens?: number // 压缩前总估算 token
  afterTokens?: number // 压缩后总估算 token（含新摘要）
  savedTokens?: number // 节省的 token（before - after）
  summaryPreview?: string // 新摘要的前 600 字符
  summaryLength?: number // 新摘要的完整字符数
}
export function compactConversation(
  id: string,
  body?: { providerId?: string },
) {
  return api<CompactResult>('POST', `/api/ai/conversations/${id}/compact`, body || {})
}

export function saveMessages(id: string, messages: ChatMessage[]) {
  return api<{ messages: ChatMessage[] }>('POST', `/api/ai/conversations/${id}/messages`, { messages })
}

// ===== 破坏性工具确认门控（Agent-C 契约） =====
// 模型请求"需确认"的破坏性/写工具时，后端先下发 { meta: { type:'confirm_tool_action',
// requestId, tool, argsSummary, impact } } 悬停等待用户放行，前端据此弹确认卡片。
// 用户允许/拒绝后调用本接口：allow=true 执行并把 tool_result 回传 LLM；
// allow=false 不执行并以 REJECTED_BY_USER 回传；final 为后端回传的最终结果（可选）。

export interface ApproveResult {
  accepted: boolean
  final?: string
}

export function approveToolAction(requestId: string, allow: boolean) {
  return api<ApproveResult>('POST', '/api/ai/chat/approve', { requestId, allow })
}

// ===== 长程记忆（记忆管理） =====

export function getMemories(category?: AiMemory['category']) {
  const q = category ? `?category=${category}` : ''
  return api<{ items: AiMemory[]; count: number }>('GET', `/api/ai/memories${q}`)
}

export function createMemory(input: AiMemoryInput) {
  return api<{ memory: AiMemory }>('POST', `/api/ai/memories`, input)
}

export function updateMemory(id: string, input: Partial<AiMemoryInput>) {
  return api<{ memory: AiMemory }>('PUT', `/api/ai/memories/${id}`, input)
}

export function deleteMemory(id: string) {
  return api<{ deleted: boolean }>('DELETE', `/api/ai/memories/${id}`)
}

// ===== 工具确认门控（UI-E，对接后端 Package C）=====
// SSE meta.type==='confirm_tool_action' 弹出确认卡后，用户批准/拒绝回调此接口。
// 后端未就绪时返回 404 属预期：卡片显示错误并允许重试，不阻塞组件。
export function approveAiChatTool(body: { requestId: string; allow: boolean }) {
  return api<{ ok: boolean }>('POST', '/api/ai/chat/approve', body)
}

// ===== SSE 流式聊天 =====

export interface StreamChatOptions {
  providerId: string
  messages: ChatMessage[]
  options?: ChatOptions
  signal?: AbortSignal
  onDelta: (text: string, thinking?: string, toolCall?: any, toolResult?: any, meta?: StreamDeltaMeta) => void
  onError?: (msg: string) => void
  onDone?: () => void
}

/**
 * 流式调用 /api/ai/chat。后端已统一把各厂商响应转成 OpenAI 风格 SSE：
 *   data: {"choices":[{"delta":{"content":"..."}}]}
 *   data: [DONE]
 * 本函数负责解析并逐块回调 onDelta。
 */
export async function streamChat(opts: StreamChatOptions): Promise<void> {
  const config = useConfigStore()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = config.config.token
  if (token) headers['Authorization'] = `Bearer ${token}`
  const csrf = await getCsrfToken()
  if (csrf) headers['X-CSRF-Token'] = csrf

  let res: Response
  try {
    res = await fetch(`${config.serverUrl}/api/ai/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        providerId: opts.providerId,
        messages: opts.messages,
        options: opts.options || {},
      }),
      credentials: 'include',
      signal: opts.signal,
    })
  } catch (e: any) {
    // 网络/中断错误（含 AbortError）
    if (e?.name === 'AbortError') return
    opts.onError?.(String(e?.message || e))
    return
  }

  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`
    try {
      const j = await res.json()
      msg = j?.error || j?.message || msg
      if (j?.detail) msg += `: ${j.detail}`
    } catch {
      /* ignore */
    }
    opts.onError?.(msg)
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let errored = false
  let streamDone = false
  // 最后一次收到增量事件的时间戳：用于在流结束时判断是否还有未处理的 agent 事件
  let lastEventAt = Date.now()

  // 处理 buffer 中的所有完整 SSE 事件
  function processBuffer() {
    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const dataLines = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
      for (const data of dataLines) {
        if (!data) continue
        if (data === '[DONE]') continue  // [DONE] 仅标记结束，不触发回调
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) {
            errored = true
            opts.onError?.(parsed.error)
          }
          const delta = parsed?.choices?.[0]?.delta
          // 顶层 meta 事件（如 token 用量 usage），与 delta 内的 agent 路由元信息相互独立
          if (parsed.meta) {
            lastEventAt = Date.now()
            opts.onDelta('', undefined, undefined, undefined, parsed.meta)
          }
          if (delta) {
            lastEventAt = Date.now()
            // 多代理路由元信息：delta.agent_id（子代理增量）→ 路由到对应卡片；
            // delta.agent（生命周期事件）→ upsert agentRuns。
            const meta: StreamDeltaMeta = {}
            if (delta.agent_id) meta.agentId = delta.agent_id
            if (delta.agent) meta.agent = delta.agent
            const hasMeta = !!(meta.agentId || meta.agent)

            if (hasMeta) {
              const hasPayload = delta.thinking || delta.tool_call || delta.tool_result || delta.content
              if (!hasPayload) {
                // 纯生命周期事件（无 content）：必须转发以触发 agentRuns upsert
                opts.onDelta('', undefined, undefined, undefined, meta)
              } else {
                if (delta.thinking) opts.onDelta('', delta.thinking, undefined, undefined, meta)
                if (delta.tool_call) opts.onDelta('', undefined, delta.tool_call, undefined, meta)
                if (delta.tool_result) opts.onDelta('', undefined, undefined, delta.tool_result, meta)
                if (delta.content) opts.onDelta(delta.content, undefined, undefined, undefined, meta)
              }
            } else {
              // 单代理（非并行）模式：不携带任何路由元信息，保持原始行为
              if (delta.thinking) opts.onDelta('', delta.thinking)
              if (delta.tool_call) opts.onDelta('', undefined, delta.tool_call)
              if (delta.tool_result) opts.onDelta('', undefined, undefined, delta.tool_result)
              if (delta.content) opts.onDelta(delta.content)
            }
          }
        } catch {
          /* 跳过无法解析的行 */
        }
      }
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      // 关键修复：即使 done 为 true，也要先处理本次 value 和 buffer 中剩余数据
      // 否则最后几个 SSE 事件（特别是 agent 的 done 事件）可能丢失
      if (value) {
        buffer += decoder.decode(value, { stream: true })
      }
      processBuffer()

      if (done) {
        // 流结束：buffer 中可能还有未完整接收的 SSE 数据（最后一行没有 \n\n）
        // 强制处理剩余内容，避免最后一个 agent done 事件丢失
        if (buffer.trim()) {
          // 模拟一个完整的事件边界，强制解析剩余内容
          buffer += '\n\n'
          processBuffer()
        }
        streamDone = true
        break
      }
    }
  } catch (e: any) {
    if (e?.name !== 'AbortError') {
      errored = true
      opts.onError?.(String(e?.message || e))
    } else {
      streamDone = true
    }
  }

  // 最终安全网：流结束后如果距离最后一个事件不足 50ms，等待一下再触发 onDone
  // 确保浏览器端 SSE 事件全部处理完毕，避免子 agent 状态卡住
  if (!errored) {
    const timeSinceLastEvent = Date.now() - lastEventAt
    if (timeSinceLastEvent < 50) {
      await new Promise((r) => setTimeout(r, 50 - timeSinceLastEvent))
    }
    opts.onDone?.()
  }
}

// 剪贴板 AI 摘要浮窗：轻量非流式摘要
export interface SummarizeResult {
  summary: string
}

export function summarizeClipboard(params: { providerId: string; content: string }) {
  return api<SummarizeResult>('POST', '/api/ai/summarize', params)
}

// 主动建议（#230）：根据剪贴板内容给出收藏/分类/清理建议
export interface ClipSuggestion {
  worth_favorite: boolean
  reason: string
  suggested_collection: string | null
  action: 'keep' | 'archive' | 'cleanup'
  action_reason: string
  /** 智能标签（#235）：推荐 2-5 个简洁标签 */
  suggested_tags: string[]
}

/** 批量建议返回的"一条 item 的结果"（id 用于前端按 id 命中对应 ClipItem） */
export interface ClipSuggestionItem {
  id: string
  suggestion: ClipSuggestion | null
}

export interface SuggestResult {
  /** 单条模式：返回单条建议 */
  suggestion?: ClipSuggestion | null
  /** 批量模式：返回 N 条建议，按后端输入顺序 */
  suggestions?: ClipSuggestionItem[]
  raw?: string
  error?: string
}

export interface SuggestBatchItem {
  id: string
  content: string
  /** 当前条目是否已收藏（后端 system prompt 据此跳过"建议收藏"） */
  isFavorite?: boolean
}

/** 单条建议（向后兼容） */
export function suggestClipboard(params: { providerId: string; content: string; collections?: string[] }) {
  return api<SuggestResult>('POST', '/api/ai/suggest', params)
}

/** 批量建议（方案 A）：一次拿 N 条建议，AI 一次返回数组，效率更高 */
export function suggestClipboardBatch(params: {
  providerId: string
  items: SuggestBatchItem[]
  collections?: string[]
}) {
  return api<SuggestResult>('POST', '/api/ai/suggest', params)
}

// 语义相似度检测（#236）：判断内容与候选条目哪些语义重复
export interface SimilarityCandidate {
  id: string
  text: string
}
export interface DuplicateHit {
  id: string
  reason: string
  degree: 'high' | 'medium'
}
export interface SimilarityResult {
  duplicates: DuplicateHit[]
  checked: number
}

export function similarityCheck(params: { providerId: string; content: string; candidates: SimilarityCandidate[] }) {
  return api<SimilarityResult>('POST', '/api/ai/similarity', params)
}

// 聊天历史关键词搜索（#231）：在会话列表提供历史消息搜索，返回命中的对话+片段+位置
export interface ConversationSearchHit {
  conversationId: string
  conversationTitle: string
  messageId: string
  role: 'user' | 'assistant'
  snippet: string
  snippetStart: number
  posInConv: number
  totalInConv: number
  messageCreatedAt: string
}

export interface ConversationSearchResult {
  items: ConversationSearchHit[]
  count: number
  query: string
}

export function searchConversationHistory(q: string) {
  return api<ConversationSearchResult>('GET', `/api/ai/conversations/search?q=${encodeURIComponent(q)}`)
}
