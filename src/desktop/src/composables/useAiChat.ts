import { ref, shallowRef, computed } from 'vue'
import { getProviders, getAiContext, streamChat, getSettings, saveSettings, updateProvider } from '@/api/ai'
import type { AiProvider, ChatMessage, AiContext, AgentRun, StreamDeltaMeta, AiSettings, AiConversation, ContextUsage, ChatImage } from '@/api/ai'
import { buildSystemPrompt } from '@/utils/aiSystemPrompt'
import { useAiConversations } from './useAiConversations'

let cachedContext: AiContext | null = null
let contextFetchedAt = 0
const CONTEXT_TTL_MS = 30_000

interface SendOptions {
  mode?: 'ask' | 'agent'
  thinking?: boolean
  thinkingStrength?: 'low' | 'medium' | 'high'
  // 随消息一起发送的截图（粘贴得到）。构造上游历史时会转成 vision content 数组。
  images?: ChatImage[]
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
  const selectedModel = ref<string>('') // 当前选中的模型（= 选中供应商的 model）
  const settings = ref<AiSettings | null>(null) // 用户 AI 偏好（DB 持久化）
  const messages = ref<ChatMessage[]>([])
  const isStreaming = ref(false)
  const error = ref('')
  // 上下文用量（token 计数，由后端 usage 事件下发；保留最近一次调用，代表当前上下文占用）
  const contextUsage = ref<ContextUsage | null>(null)
  // 图片重复感知（#225）：后端检测到本次发送的图片已存在于剪贴板历史时下发，前端展示提示横幅
  const duplicateImageNotice = ref<{
    imageHash: string
    existingId: string
    createdAt: string
    preview: string
  } | null>(null)
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
        selectedModel.value = settings.value?.selectedModels?.[def?.id || ''] || def?.model || ''
      }
    }
  }

  async function init() {
    if (initialized.value) return
    initialized.value = true
    await Promise.all([loadProviders(), conv.loadConversations()])
    await loadSettings()
    // 打开 AI 面板时自动加载最近一条对话，避免"已有几轮对话却显示暂无数据"
    if (!conv.currentConversationId.value && conv.conversations.value.length > 0) {
      await loadConversation(conv.conversations.value[0].id)
    }
    // 若当前有历史对话，恢复持久化用量
    if (!contextUsage.value) {
      contextUsage.value = conv.currentUsage.value
    }
  }

  // 加载并应用用户 AI 偏好（默认供应商 / 模型 / 模式 / 思考 / 并行）
  async function loadSettings() {
    try {
      const res = await getSettings()
      if (res.ok && res.data) {
        settings.value = res.data
        if (res.data.defaultProviderId) {
          const p = providers.value.find((x) => x.id === res.data!.defaultProviderId)
          if (p) {
            selectedProviderId.value = p.id
            // 优先使用 per-provider 记忆模型，其次用供应商默认 model
            selectedModel.value = res.data.selectedModels?.[p.id] || res.data.defaultModel || p.model
          }
        }
      }
    } catch {
      /* 偏好加载失败不阻塞聊天 */
    }
  }

  // 增量持久化 AI 偏好到 DB（不阻塞 UI）
  function persistSettings(patch: Partial<AiSettings>) {
    const next: AiSettings = {
      defaultProviderId: settings.value?.defaultProviderId ?? null,
      defaultModel: settings.value?.defaultModel ?? null,
      selectedModels: settings.value?.selectedModels ?? {},
      defaultMode: settings.value?.defaultMode ?? 'ask',
      thinkingEnabled: settings.value?.thinkingEnabled ?? false,
      thinkingStrength: settings.value?.thinkingStrength ?? 'medium',
      ...patch,
    }
    settings.value = next
    saveSettings(next).catch(() => {})
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
    const p = providers.value.find((x) => x.id === id)
    if (p) {
      // per-provider 记忆模型 > 全局默认 > 供应商默认
      const remembered = settings.value?.selectedModels?.[p.id]
      selectedModel.value = remembered || settings.value?.defaultModel || p.model
      persistSettings({
        defaultProviderId: id,
        defaultModel: selectedModel.value,
        selectedModels: { ...settings.value?.selectedModels, [id]: selectedModel.value },
      })
    }
  }

  // 选择当前供应商下的某个模型（多选标签场景）
  async function selectModel(model: string) {
    if (!model) return
    selectedModel.value = model
    const p = providers.value.find((x) => x.id === selectedProviderId.value)
    if (p) {
      persistSettings({
        defaultModel: model,
        selectedModels: { ...settings.value?.selectedModels, [p.id]: model },
      })
    }
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
      model: selectedModel.value || p?.model || undefined,
      mode: options?.mode,
      thinkingEnabled: options?.thinkingEnabled,
    })
    if (!created) {
      console.error('[useAiChat] newConversation failed: backend did not create conversation')
      return null
    }
    messages.value = []
    error.value = ''
    contextUsage.value = null
    return created
  }

  async function loadConversation(id: string) {
    // 若当前正在流式生成，先中止，避免旧 assistantMsg proxy 在 messages.value 被替换后继续被改。
    if (isStreaming.value) {
      stop()
      // 给 finally 块一点时间收敛状态，避免竞态
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const msgs = await conv.select(id)
    if (msgs) {
      messages.value = msgs
      error.value = ''
      // 恢复持久化的上下文用量
      contextUsage.value = conv.currentUsage.value
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
    // 新一轮发送：清空上一次的图片重复提示
    duplicateImageNotice.value = null
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
    messages.value.push({ role: 'user', content: text, images: options.images })
    messages.value.push({ role: 'assistant', content: '', thinking: '', thinkingActive: true })
    // 必须引用 messages 数组里的 reactive proxy，后续 mutations 才能触发 Vue 响应式更新。
    // 注意：若用户在流式进行中途切换历史对话，messages.value 会被替换，但 assistantMsg
    // 仍指向旧 proxy。因此在 loadConversation 时要先中止当前流，防止旧 proxy 继续被改。
    const assistantMsg = messages.value[messages.value.length - 1]
    isStreaming.value = true
    // 新一轮对话开始：重置上下文用量，圆环回到 0%
    contextUsage.value = null

    // 子代理最后更新时间（非响应式 Map，避免每秒级更新触发无关重渲染）
    const agentLastUpdateAt = new Map<string, number>()

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
  // 记录最后更新时间到非响应式 Map，避免每秒级更新触发无关重渲染
  agentLastUpdateAt.set(a.id, Date.now())
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
      agentLastUpdateAt.set(id, Date.now())
      return run
    }

    const controller = new AbortController()
    abortCtrl.value = controller

    // 最后收到增量的时间戳：用于前端静默看门狗，防止连接挂起导致 isStreaming 永远卡 true。
    let lastActivityAt = Date.now()
    // 流结束（含正常结束与异常）后，把任何仍停留在非终态的 agent 卡片收敛为终态，
    // 彻底杜绝“子代理永久转圈”。跨消息生效：也会清理上一条挂掉的并行请求残留的卡片。
    function settleAgentRuns() {
      for (const m of messages.value) {
        if (m.role !== 'assistant' || !m.agentRuns?.length) continue
        for (const run of m.agentRuns) {
          if (run.status === 'planning' || run.status === 'working' || run.status === 'synthesis') {
            if (run.status === 'planning') {
              // 规划阶段本就无内容产出，直接标完成，避免被误判为失败
              run.status = 'done'
            } else if (run.content || run.thinking) {
              run.status = 'done'
            } else {
              run.status = 'failed'
              if (!run.error) run.error = 'stream ended unexpectedly'
            }
          }
        }
      }
    }
    // 主答案内容开始抵达（未携带 agentId 的增量）→ 立即把协调者（任务规划）卡片收敛为 done，
    // 避免“答案都出来了，协调器还在转圈”的违和感。worker/synthesis 仍按各自生命周期收敛。
    function convergePlanning() {
      for (const m of messages.value) {
        if (m.role !== 'assistant' || !m.agentRuns?.length) continue
        for (const run of m.agentRuns) {
          // 不论是 planning 还是 working，只要主答案已输出，协调者即视为完成
          if (run.kind === 'coordinator' && run.status !== 'done' && run.status !== 'failed') {
            run.status = 'done'
          }
        }
      }
    }
    // 静默看门狗：超过 200s 没有任何增量（后端 180s 上游超时本应已关流），强制中止并复位，
    // 作为后端异常挂死时的最后兜底，避免 isStreaming 永久卡 true / 思考面板永久"思考中"。
    const silenceWatchdog = setInterval(() => {
      if (Date.now() - lastActivityAt > 200_000) {
        console.warn('[useAiChat] stream silent >200s, aborting to avoid stuck state')
        controller.abort()
      }
    }, 10_000)

    // 子代理超时看门狗：每 5 秒检查一次，如果某个 agent 超过阈值没有更新，
    // 自动收敛为 done/failed，避免后端丢失 agent done 事件导致卡片永久转圈。
    // planning 阶段本身无内容产出，可能持续较久，阈值放宽到 120s；working/synthesis 保持 60s。
    // 只在 streaming 期间激活，streaming 结束后由 settleAgentRuns 最终收敛。
    const agentTimeoutWatchdog = setInterval(() => {
      if (!assistantMsg.agentRuns?.length) return
      const now = Date.now()
      for (const run of assistantMsg.agentRuns) {
        if (run.status === 'planning' || run.status === 'working' || run.status === 'synthesis') {
          const lastUpdate = agentLastUpdateAt.get(run.id) || 0
          if (!lastUpdate) continue
          const threshold = run.status === 'planning' ? 120_000 : 60_000
          if (now - lastUpdate > threshold) {
            console.warn(`[useAiChat] agent ${run.id} timed out (>${threshold / 1000}s no update), auto-concluding`)
            run.status = run.content || run.thinking ? 'done' : 'failed'
            if (!run.error && !run.content && !run.thinking) {
              run.error = `agent timed out (no response for ${threshold / 1000}s)`
            }
          }
        }
      }
    }, 5_000)

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
    const modelName = selectedModel.value || selectedProvider?.model || ''
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
      } else if (m.role === 'user' && m.images && m.images.length) {
        // 多模态（vision）：把截图转成 OpenAI 风格 image_url content 数组
        historyMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: m.content || '' },
            ...m.images.map((img) => ({ type: 'image_url', image_url: { url: img.data } })),
          ],
        })
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
          model: selectedModel.value || selectedProvider?.model || undefined,
          conversationId: conv.currentConversationId.value,
        },
        signal: controller.signal,
        onDelta: (d, thinkingNative?: string, toolCall?: any, toolResult?: any, meta?: StreamDeltaMeta) => {
          lastActivityAt = Date.now()
          // token 用量事件：覆盖为最近一次（最代表当前上下文大小）
          if (meta?.usage) {
            const u = meta.usage
            const percent = u.contextWindow > 0
              ? Math.min(100, Math.max(0, Math.round((u.totalTokens / u.contextWindow) * 100)))
              : 0
            contextUsage.value = { ...u, percent }
          }
          // 非响应式 Map 记录活跃 agent 的最后更新时间，避免直接改 run._lastUpdateAt 触发重渲染
          if (assistantMsg.agentRuns?.length) {
            const now = Date.now()
            for (const r of assistantMsg.agentRuns) {
              if (r.status === 'planning' || r.status === 'working' || r.status === 'synthesis') {
                agentLastUpdateAt.set(r.id, now)
              }
            }
          }
          // 生命周期事件（coordinator/worker/synthesis 状态切换）始终 upsert 到 agentRuns
          if (meta?.agent) {
            upsertAgentRun(meta.agent)
          }

          // 图片重复感知（#225）：本次发送的图片已在 TA 的剪贴板历史中存在，展示提示横幅
          const mm = meta as any
          if (mm?.type === 'duplicate_image') {
            duplicateImageNotice.value = {
              imageHash: mm.imageHash,
              existingId: mm.existingId,
              createdAt: mm.createdAt,
              preview: mm.preview,
            }
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
            // 主答案（未路由给子代理）开始输出 → 思考阶段结束，规划态卡片立即收敛
            if (target === null && res.textDelta) {
              assistantMsg.thinkingActive = false
              convergePlanning()
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
      clearInterval(silenceWatchdog)
      clearInterval(agentTimeoutWatchdog)
      isStreaming.value = false
      abortCtrl.value = null
      // 收敛所有残留的非终态 agent 卡片（含上一条挂掉的并行请求残留），避免永久转圈
      settleAgentRuns()
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
    selectedModel,
    settings,
    persistSettings,
    messages,
    isStreaming,
    error,
    contextUsage,
    duplicateImageNotice,
    hasProviders,
    canSend,
    memoryEnabled,
    setMemoryEnabled,
    init,
    loadProviders,
    selectProvider,
    selectModel,
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
