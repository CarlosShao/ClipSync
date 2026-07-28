import { api, getCsrfToken } from './client'
import { useConfigStore } from '@/stores/configStore'

export interface AiProvider {
  id: string
  provider: string
  name: string
  base_url: string | null
  model: string
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
  role: 'system' | 'user' | 'assistant'
  content: string
  thinking?: string // 思考过程
  toolCalls?: ToolCall[] // 工具调用
  toolResults?: ToolResult[] // 工具结果
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

export interface ChatOptions {
  maxTokens?: number
  temperature?: number
}

export interface AiProviderInput {
  provider: string
  name: string
  apiKey?: string
  baseUrl?: string
  model: string
  isDefault?: boolean
}

// ===== CRUD =====

export function getProviders() {
  return api<{ items: AiProvider[]; count: number }>('GET', '/api/ai/providers')
}

export function getPresets() {
  return api<{ items: AiProviderPreset[] }>('GET', '/api/ai/presets')
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

// ===== SSE 流式聊天 =====

export interface StreamChatOptions {
  providerId: string
  messages: ChatMessage[]
  options?: ChatOptions
  signal?: AbortSignal
  onDelta: (text: string, thinking?: string, toolCall?: any, toolResult?: any) => void
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

  try {
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
          if (!data || data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            if (parsed.error) {
              errored = true
              opts.onError?.(parsed.error)
            }
            const delta = parsed?.choices?.[0]?.delta
            if (delta) {
              // 处理 thinking 内容
              if (delta.thinking) {
                opts.onDelta('', delta.thinking)
              }
              // 处理工具调用
              if (delta.tool_call) {
                opts.onDelta('', undefined, delta.tool_call)
              }
              // 处理工具结果
              if (delta.tool_result) {
                opts.onDelta('', undefined, undefined, delta.tool_result)
              }
              // 处理普通内容
              if (delta.content) {
                opts.onDelta(delta.content)
              }
            }
          } catch {
            /* 跳过无法解析的行 */
          }
        }
      }
    }
  } catch (e: any) {
    if (e?.name !== 'AbortError') {
      errored = true
      opts.onError?.(String(e?.message || e))
    }
  }

  if (!errored) opts.onDone?.()
}
