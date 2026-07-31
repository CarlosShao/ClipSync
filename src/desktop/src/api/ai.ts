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
}

export interface AiProviderPreset {
  provider: string
  label: string
  family: string
  defaultBaseUrl: string
  defaultModel: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  // 随消息一起发送的截图（data URL）。仅 user 消息使用，用于多模态（vision）提问。
  images?: ChatImage[]
  thinking?: string // 思考过程
  thinkingStartedAt?: number // 思考开始时间戳（毫秒），用于显示思考秒数
  toolCalls?: ToolCall[] // 工具调用
  toolResults?: ToolResult[] // 工具结果
  thinkingActive?: boolean // 思考阶段是否仍在进行：工具开始调用后视为结束（用于前端正确显示“思考完成”而非一直“思考中”）
  tool_call_id?: string // tool 角色消息关联的调用 id
  isError?: boolean // 标记该助手消息是否因出错而生成（不进入上游历史）
  agentRuns?: AgentRun[] // 多代理并行模式：本次回答中各子代理的运行状态卡片
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ToolResult {
  tool_call_id: string
  content: string
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
}

// 随消息发送的截图（粘贴得到）。data 为完整 data URL（含前缀），可直接放入
// OpenAI 风格 image_url.url，或经后端转换为 Anthropic base64 source。
export interface ChatImage {
  mime: string
  data: string
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
}

// AI 用户偏好（入库持久化）
export interface AiSettings {
  defaultProviderId: string | null
  defaultModel: string | null
  selectedModels: Record<string, string>
  defaultMode: 'ask' | 'agent'
  thinkingEnabled: boolean
  thinkingStrength: 'low' | 'medium' | 'high'
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

export function saveMessages(id: string, messages: ChatMessage[]) {
  return api<{ messages: ChatMessage[] }>('POST', `/api/ai/conversations/${id}/messages`, { messages })
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
