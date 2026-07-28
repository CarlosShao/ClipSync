import { ref, shallowRef, computed } from 'vue'
import { getProviders, getAiContext, streamChat } from '@/api/ai'
import type { AiProvider, ChatMessage, AiContext, AgentRun, StreamDeltaMeta } from '@/api/ai'
import { buildSystemPrompt } from '@/utils/aiSystemPrompt'
import { useAiConversations } from './useAiConversations'

let cachedContext: AiContext | null = null
let contextFetchedAt = 0
const CONTEXT_TTL_MS = 30_000

interface SendOptions {
  mode?: 'ask' | 'agent'
  thinking?: boolean
  thinkingStrength?: 'low' | 'medium' | 'high'
  parallel?: boolean
}

// 原生支持 reasoning 的模型关键词
const NATIVE_REASONING_KEYWORDS = [
  'deepseek-r1',
  'claude-3-7-sonnet',
  'o1',
  'o1-preview',
  'o1-mini',
  'o3',
  'o4-mini',
  'qwq',
  'qwen3',
  'minimax',
  'mimo',
  'step-',
]

function isNativeReasoningModel(model: string): boolean {
  if (!model) return false
  const lower = model.toLowerCase()
  return NATIVE_REASONING_KEYWORDS.some((k) => lower.includes(k))
}

export function useAiChat() {
  const providers = ref<AiProvider[]>([])
  const selectedProviderId = ref<string>('')
  const messages = ref<ChatMessage[]>([])
  const isStreaming = ref(false)
  const error = ref('')
  const abortCtrl = shallowRef<AbortController | null>(null)
  const initialized = ref(false)
  // 长程记忆模式：开启时把用户记忆注入系统提示词，让 AI 跨会话“记得”用户
  const memoryEnabled = ref(localStorage.getItem('clipsync-ai-memory') !== '0')
  function setMemoryEnabled(v: boolean) {
    memoryEnabled.value = v
    localStorage.setItem('clipsync-ai-memory', v ? '1' : '0')
  }

  const conv = useAiConversations()

  const hasProviders = computed(() => providers.value.length > 0)
  const canSend = computed(() => !!selectedProviderId.value && !isStreaming.value)

  async function loadProviders() {
    const res = await getProviders()
    if (res.ok) {
      providers.value = res.data?.items || []
      if (!selectedProviderId.value) {
        const def = providers.value.find((p) => p.is_default) || providers.value[0]
        selectedProviderId.value = def?.id || ''
      }
    }
  }

  async function init() {
    if (initialized.value) return
    initialized.value = true
    await Promise.all([loadProviders(), conv.loadConversations()])
  }

  async function fetchContext(): Promise<AiContext | null> {
    try {
      if (cachedContext && Date.now() - contextFetchedAt < CONTEXT_TTL_MS) {
        return cachedContext
      }
      const res = await getAiContext()
      if (res.ok && res.data?.context) {
        cachedContext = res.data.context
        contextFetchedAt = Date.now()
        return cachedContext
      }
    } catch {
      /* ignore */
    }
    return cachedContext
  }

  function selectProvider(id: string) {
    selectedProviderId.value = id
  }

  async function newConversation(options?: {
    title?: string
    mode?: 'ask' | 'agent'
    thinkingEnabled?: boolean
  }): Promise<AiConversation | null> {
    const p = providers.value.find((x) => x.id === selectedProviderId.value)
    const created = await conv.createNew({
      title: options?.title || '新对话',
      providerId: selectedProviderId.value,
      model: p?.model || undefined,
      mode: options?.mode,
      thinkingEnabled: options?.thinkingEnabled,
    })
    if (!created) {
      console.error('[useAiChat] newConversation failed: backend did not create conversation')
      return null
    }
    messages.value = []
    error.value = ''
    return created
  }

  async function loadConversation(id: string) {
    const msgs = await conv.select(id)
    if (msgs) {
      messages.value = msgs
      error.value = ''
      // 同步 provider/model/mode
      const c = conv.currentConversation.value
      if (c?.mode) {
        // 通过事件通知上层（AISidebar）同步模式，这里不直接修改 props
      }
    }
  }

  async function send(content: string, options: SendOptions = {}) {
    const text = content.trim()
    if (!text || isStreaming.value) return
    if (!selectedProviderId.value) {
      error.value = 'ai_no_provider_selected'
      return
    }

    // 确保有当前对话；首次发送时创建
    if (!conv.currentConversationId.value) {
      const created = await newConversation({ mode: options.mode, thinkingEnabled: options.thinking })
      if (!created) {
        error.value = 'ai_create_conversation_failed'
        isStreaming.value = false
        return
      }
    }

    error.value = ''
    messages.value.push({ role: 'user', content: text })
    const assistantMsg: ChatMessage = { role: 'assistant', content: '', thinking: '', thinkingActive: true }
    messages.value.push(assistantMsg)
    isStreaming.value = true

    // —— 多代理并行模式：子代理运行状态维护 ——
    function ensureAgentRuns(): AgentRun[] {
      if (!assistantMsg.agentRuns) assistantMsg.agentRuns = []
      return assistantMsg.agentRuns
    }
    function upsertAgentRun(a: NonNullable<StreamDeltaMeta['agent']>) {
      const runs = ensureAgentRuns()
      let run = runs.find((r) => r.id === a.id)
      if (!run) {
        run = { id: a.id, name: a.name, status: a.status, kind: a.kind }
        runs.push(run)
      }
      run.name = a.name
      run.status = a.status
      if (a.kind) run.kind = a.kind
      // 携带 error 视为失败（后端把 error 放在 failed 事件中）
      if (a.error !== undefined) {
        run.status = 'failed'
        run.error = a.error
      }
    }
    function getOrCreateAgentRun(id: string): AgentRun {
      const runs = ensureAgentRuns()
      let run = runs.find((r) => r.id === id)
      if (!run) {
        run = { id, name: id, status: 'working' }
        runs.push(run)
      }
      return run
    }

    const controller = new AbortController()
    abortCtrl.value = controller

    // 用于从 <think>...</think> 中提取思考过程。
    const thinkState = {
      raw: '',
      pos: 0,
      inThink: false,
    }
    function processThinkContent(delta: string): { textDelta: string; thinkingDelta: string } {
      thinkState.raw += delta
      let textDelta = ''
      let thinkingDelta = ''

      while (true) {
        if (!thinkState.inThink) {
          const idx = thinkState.raw.indexOf('<think>', thinkState.pos)
          if (idx === -1) {
            textDelta += thinkState.raw.slice(thinkState.pos)
            thinkState.pos = thinkState.raw.length
            break
          }
          textDelta += thinkState.raw.slice(thinkState.pos, idx)
          thinkState.pos = idx + 7
          thinkState.inThink = true
        } else {
          const idx = thinkState.raw.indexOf('</think>', thinkState.pos)
          if (idx === -1) {
            thinkingDelta += thinkState.raw.slice(thinkState.pos)
            thinkState.pos = thinkState.raw.length
            break
          }
          thinkingDelta += thinkState.raw.slice(thinkState.pos, idx)
          thinkState.pos = idx + 8
          thinkState.inThink = false
        }
      }

      return { textDelta, thinkingDelta }
    }

    // 从后端获取完整、真实的 ClipSync 上下文
    const ctx = await fetchContext()
    const ctxData = ctx
      ? {
          total: ctx.stats.total,
          favoriteItemsCount: ctx.stats.favoriteItemsCount,
          collectionsCount: ctx.collections.collectionsCount,
          devicesCount: ctx.devices.devicesCount,
          templatesCount: ctx.templates.templatesCount,
          sharedLinksCount: ctx.sharedLinks.sharedLinksCount,
          recentItems: ctx.recentItems
            .map((i) => `- [${i.type}] ${i.preview}${i.preview.length >= 120 ? '...' : ''}${i.isFavorite ? ' ⭐' : ''}`)
            .join('\n'),
          memories: (ctx.memories || []).map((m) => ({ category: m.category, title: m.title, content: m.content })),
          memoryEnabled: memoryEnabled.value,
        }
      : undefined

    const selectedProvider = providers.value.find((p) => p.id === selectedProviderId.value)
    const modelName = selectedProvider?.model || ''
    const nativeReasoning = isNativeReasoningModel(modelName)

    const systemPrompt = buildSystemPrompt(ctxData)
    // 构造上游历史：保留工具调用结构（转换为 OpenAI 嵌套格式），确保多轮 Agent 上下文正确
    const historyMessages: any[] = []
    for (const m of messages.value.slice(0, -1)) {
      // 保留出错消息：如果跳过 isError，继续/resume 时会丢失上下文，导致模型“看不到之前对话”
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        historyMessages.push({
          role: 'assistant',
          content: m.content || '',
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments || '' },
          })),
        })
        for (const tr of m.toolResults || []) {
          historyMessages.push({ role: 'tool', content: tr.content, tool_call_id: tr.tool_call_id })
        }
      } else {
        historyMessages.push({ role: m.role, content: m.content })
      }
    }
    const history: any[] = [{ role: 'system', content: systemPrompt }, ...historyMessages]

    if (options.thinking) {
      const strengthMap = {
        low: 'Think step by step briefly.',
        medium: 'Think step by step with moderate detail.',
        high: 'Think step by step with thorough analysis.',
      }
      history[0].content += `\n\n${strengthMap[options.thinkingStrength || 'medium']}`

      if (!nativeReasoning) {
        history[0].content += `\n\nWhen you need to think before answering, put your step-by-step reasoning inside <think>...</think> tags. Only the final answer should appear outside the tags. Keep the reasoning concise.`
      }
    }

    if (options.mode === 'agent') {
      history[0].content += `\n\nYou are in Agent mode. When the user asks you to perform actions, you may call available tools to get real-time data. After tools return results, provide a clear final answer based on the tool outputs.`
    }

    try {
      await streamChat({
        providerId: selectedProviderId.value,
        messages: history,
        options: {
          mode: options.mode,
          thinking: options.thinking,
          thinkingStrength: options.thinkingStrength,
          parallel: options.parallel,
        },
        signal: controller.signal,
        onDelta: (d, thinkingNative?: string, toolCall?: any, toolResult?: any, meta?: StreamDeltaMeta) => {
          // 生命周期事件（coordinator/worker/synthesis 状态切换）始终 upsert 到 agentRuns
          if (meta?.agent) {
            upsertAgentRun(meta.agent)
          }

          // 有 agentId 的增量属于某个子代理 → 路由到对应卡片；否则归到主气泡
          const target: AgentRun | null = meta?.agentId ? getOrCreateAgentRun(meta.agentId) : null

          if (thinkingNative) {
            const bucket = target || assistantMsg
            if (!bucket.thinkingStartedAt) bucket.thinkingStartedAt = Date.now()
            bucket.thinking = (bucket.thinking || '') + thinkingNative
          }

          if (d) {
            const res = processThinkContent(d)
            const bucket = target || assistantMsg
            ;(bucket as any).content = (bucket.content || '') + res.textDelta
            if (res.thinkingDelta && !nativeReasoning) {
              if (!bucket.thinkingStartedAt) bucket.thinkingStartedAt = Date.now()
              bucket.thinking = (bucket.thinking || '') + res.thinkingDelta
            }
          }

          if (toolCall) {
            // 工具一旦开始调用，对应气泡的思考阶段即视为结束
            const bucket = target || assistantMsg
            bucket.thinkingActive = false
            if (!bucket.toolCalls) bucket.toolCalls = []
            const existing = bucket.toolCalls.find((tc) => tc.id === toolCall.id)
            if (existing) {
              existing.arguments = (existing.arguments || '') + (toolCall.arguments || '')
            } else {
              bucket.toolCalls.push(toolCall)
            }
          }

          if (toolResult) {
            const bucket = target || assistantMsg
            if (!bucket.toolResults) bucket.toolResults = []
            const existing = bucket.toolResults.find((tr) => tr.tool_call_id === toolResult.tool_call_id)
            if (existing) {
              existing.content = (existing.content || '') + (toolResult.content || '')
            } else {
              bucket.toolResults.push(toolResult)
            }
          }
        },
        onError: (msg) => {
          error.value = msg
          const last = messages.value[messages.value.length - 1]
          if (last && last.role === 'assistant') {
            last.isError = true
          }
        },
        onDone: () => {
          /* 流正常结束，最后统一持久化 */
        },
      })
    } catch (e: any) {
      error.value = String(e?.message || e)
      const last = messages.value[messages.value.length - 1]
      if (last && last.role === 'assistant') last.isError = true
    } finally {
      isStreaming.value = false
      abortCtrl.value = null
      // 保存当前对话的消息（不等待，失败静默）
      conv.saveCurrent(messages.value).catch(() => {})
    }
  }

  function stop() {
    abortCtrl.value?.abort()
  }

  function clear() {
    if (isStreaming.value) stop()
    messages.value = []
    error.value = ''
    conv.setCurrent('')
  }

  return {
    providers,
    selectedProviderId,
    messages,
    isStreaming,
    error,
    hasProviders,
    canSend,
    memoryEnabled,
    setMemoryEnabled,
    init,
    loadProviders,
    selectProvider,
    send,
    stop,
    clear,
    // 会话相关
    conversations: conv.conversations,
    currentConversationId: conv.currentConversationId,
    currentConversation: conv.currentConversation,
    loadConversations: conv.loadConversations,
    newConversation,
    loadConversation,
    renameConversation: conv.rename,
    deleteConversation: conv.remove,
  }
}
