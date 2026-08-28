import { ref, shallowRef, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { getProviders, streamChat, getSettings, saveSettings, updateProvider, approveToolAction } from '@/api/ai'
import type {
  AiProvider,
  ChatMessage,
  AgentRun,
  StreamDeltaMeta,
  AiSettings,
  AiConversation,
  ContextUsage,
  ChatImage,
} from '@/api/ai'
import { useAiConversations } from './useAiConversations'
import { triggerRefreshAfterTool } from './useAiDataRefresh'

interface SendOptions {
  mode?: 'ask' | 'agent'
  thinking?: boolean
  thinkingStrength?: 'low' | 'medium' | 'high'
  // 随消息一起发送的截图（粘贴得到）。构造上游历史时会转成 vision content 数组。
  images?: ChatImage[]
  // 上下文感知（任务 #229）：当前页面/视图上下文，注入到 user 消息开头让 AI 感知。
  // 用不可见标记包裹，前端渲染 user 消息时剥离，避免打扰用户。
  viewContext?: string
  // 快捷指令（总结/翻译/格式化/解释/优化）：不污染输入框，仅在内部 inject 一条隐藏
  // 的 system 消息（systemMeta.kind='quick_action_<action>'）作为模型指令上下文。
  // 前端 AiMessage.vue 不会渲染该 system 消息，UI 上看不到 prompt 文本。
  quickAction?: 'summarize' | 'translate' | 'format' | 'explain' | 'optimize'
}

// 上下文感知标记：包裹注入的"当前页面"上下文，前端渲染时剥离。
const VIEW_CTX_OPEN = '\u2404VIEWCTX\u2404'
const VIEW_CTX_CLOSE = '\u2404/VIEWCTX\u2404'
// 快捷指令用户内容标记：包裹真正的用户输入文本，指令型 system 消息
// 借此向 LLM 明确"只对这块内容做处理"，渲染时同样剥离。
const USER_INPUT_OPEN = '\u2404USERINPUT\u2404'
const USER_INPUT_CLOSE = '\u2404/USERINPUT\u2404'

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
  const { t } = useI18n()
  const providers = ref<AiProvider[]>([])
  const selectedProviderId = ref<string>('')
  const selectedModel = ref<string>('') // 当前选中的模型（= 选中供应商的 model）
  const settings = ref<AiSettings | null>(null) // 用户 AI 偏好（DB 持久化）
  const messages = ref<ChatMessage[]>([])
  const isStreaming = ref(false)
  // 流健康检查：记录最后一次活动时间，超时强制重置 isStreaming
  const streamLastActivityAt = ref(0)
  const STREAM_HEALTH_TIMEOUT = 120_000 // 120秒无活动则视为卡死
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
  // 上下文压缩进度提示（手动 /compact 与后端自动压缩共用）：
  // 分割线样式，压缩中文字带扫光动画；完成后自动消失。
  const compressProgress = ref<{
    status: 'compressing' | 'done' | 'too_short' | 'failed'
    source: 'manual' | 'auto'
    removed?: number
    savedTokens?: number
    error?: string
  } | null>(null)
  // 破坏性工具确认门控（Agent-C）：后端在"需确认"工具触发时下发 confirm_tool_action，
  // 前端据此渲染确认卡片；用户允许/拒绝后调用 POST /api/ai/chat/approve 放行或拒绝。
  // 由于后端确认门控并发上限为 1，这里只保留最近一个待确认请求。
  const pendingConfirm = ref<{
    requestId: string
    tool: string
    argsSummary: string
    impact: string
  } | null>(null)
  // 当前会话内免确认白名单（工具名集合或始终允许全部）
  const sessionAllowedTools = ref<Set<string>>(new Set())
  const sessionAlwaysAllowAll = ref(false)
  // 当前正在向后端提交确认结果（避免连点导致重复请求）
  const approving = ref(false)
  let compressProgressTimer: number | undefined
  function setCompressProgress(p: typeof compressProgress.value) {
    compressProgress.value = p
    if (compressProgressTimer) {
      window.clearTimeout(compressProgressTimer)
      compressProgressTimer = undefined
    }
    // 终态提示停留 5 秒后自动消失（压缩中状态由事件驱动结束）
    if (p && p.status !== 'compressing') {
      compressProgressTimer = window.setTimeout(() => {
        compressProgress.value = null
      }, 5000)
    }
  }
  const abortCtrl = shallowRef<AbortController | null>(null)
  const initialized = ref(false)
  // 长程记忆模式：开启时把用户记忆注入系统提示词，让 AI 跨会话“记得”用户。
  // 开关持久化在服务端 ai_settings，服务端据此决定是否注入记忆；这里仅保留前端 UI 状态。
  const memoryEnabled = ref(false)
  function setMemoryEnabled(v: boolean) {
    memoryEnabled.value = v
    persistSettings({ memoryEnabled: v })
  }

  const conv = useAiConversations()

  const hasProviders = computed(() => providers.value.length > 0)
  const canSend = computed(() => !!selectedProviderId.value && !isStreaming.value)
  // 当前选中的供应商在协议层是否支持 prompt cache。
  // 用于 UI 区分"供应商不支持"（显示「未启用/N/A」而不是 0%）与"支持但还没命中"。
  const providerSupportsCache = computed(() => {
    const p = providers.value.find((x) => x.id === selectedProviderId.value)
    return !!p?.supports_cache
  })

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
        memoryEnabled.value = res.data.memoryEnabled ?? false
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
      memoryEnabled: memoryEnabled.value,
      ...patch,
    }
    settings.value = next
    saveSettings(next).catch(() => {})
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
    pendingConfirm.value = null
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
        // 通过事件通知上层（AiChatPanel）同步模式，这里不直接修改 props
      }
    }
  }

  // 渲染时剥离上下文感知标记（#229）：把注入的"当前页面"上下文从 user 消息 UI 中去掉。
  function stripViewContext(content: string): string {
    if (!content || !content.includes(VIEW_CTX_OPEN)) return content
    const start = content.indexOf(VIEW_CTX_OPEN)
    const end = content.indexOf(VIEW_CTX_CLOSE)
    if (start >= 0 && end > start) return content.slice(0, start) + content.slice(end + VIEW_CTX_CLOSE.length)
    return content
  }

  // 「重新编辑」= 编辑即回滚（对齐主流 agent 语义）：把指定 createdAt 的消息及其之后的
  // 所有本地消息移除，并立即全量持久化——saveMessages 是替换语义（删除全部非摘要行再重插），
  // DB 中的旧轮次随之消失；"上下文压缩摘要"行受后端保护不受影响。
  // 之后正常 send() 即等价于"回到该消息发送前的状态后初次发送"。
  // 找不到目标（已切换会话/时间戳不匹配）时返回 false，调用方应放弃本次编辑语义。
  function truncateFrom(createdAt: string): boolean {
    if (!createdAt) return false
    const idx = messages.value.findIndex((m) => m.createdAt === createdAt)
    if (idx < 0) return false
    messages.value = messages.value.slice(0, idx)
    conv.saveCurrent(messages.value)
    return true
  }

  async function send(content: string, options: SendOptions = {}) {
    const text = content.trim()
    // 健康检查：如果 isStreaming 卡住超过 30 秒，强制重置（防止异常断流后无法发送）
    if (isStreaming.value) {
      if (Date.now() - streamLastActivityAt.value > STREAM_HEALTH_TIMEOUT) {
        console.warn('[useAiChat] isStreaming stuck for >30s, forcing reset')
        isStreaming.value = false
        abortCtrl.value?.abort()
      } else {
        return
      }
    }
    if (!text) return
    // 新一轮发送：清空上一次的图片重复提示与上下文压缩提示
    duplicateImageNotice.value = null
    compressProgress.value = null
    if (!selectedProviderId.value) {
      error.value = 'ai_no_provider_selected'
      return
    }

    // ===== 斜杠命令拦截：/compact (压缩上下文) =====
    // 直接当作客户端命令处理，不发 LLM；调用后端压缩接口，结果以"系统消息"
    // 形式 push 到当前对话 UI，让用户看见刚才发生了什么。
    if (text === '/compact' || text === '/压缩' || text.startsWith('/compact ') || text.startsWith('/压缩 ')) {
      await manualCompact()
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
    // 快捷指令（总结/翻译/格式化/解释）：用不可见标记包裹真正要处理的文本，
    // 让 LLM 明确"只对 ␄USERINPUT␄...␄/USERINPUT␄ 之间的内容做操作"，
    // 并把指令 system 消息放在 user 消息之后（"最近一条指令优先"），
    // 避免被 system 提示里关于 ClipSync 应用的全局说明抢走注意力。
    const wrappedText = options.quickAction ? `${USER_INPUT_OPEN}${text}${USER_INPUT_CLOSE}` : text
    const now = new Date()
    const nowTs = now.toISOString()
    // 关键修复：给每条消息分配递增的 created_at，确保后端 ORDER BY created_at ASC 排序稳定
    // （全量替换语义下 created_at 相同时排序依赖 DB 自增 id，可能导致消息乱序）
    const tUser = new Date(now.getTime() + 1).toISOString()
    const tAssistant = new Date(now.getTime() + 2).toISOString()
    // 上下文感知（#229）：改为独立的隐藏 system 消息，避免与用户问题混淆。
    // 之前 prepend 到 user 消息开头会导致模型把上下文当成问题来回答。
    if (options.viewContext) {
      messages.value.push({
        role: 'system',
        content: options.viewContext,
        systemMeta: { kind: 'view_context' },
        createdAt: nowTs,
      })
    }
    messages.value.push({
      role: 'user',
      content: wrappedText,
      images: options.images,
      imageHash: options.images?.[0]?.hash,
      createdAt: tUser,
    })
    if (options.quickAction) {
      let prompt = t(`ai_quick_${options.quickAction}_prompt`) || ''
      // 翻译指令占位符 {{lang}} → 依据文本实际语种决定目标语种。
      if (options.quickAction === 'translate' && prompt.includes('{{lang}}')) {
        const isChinese = /[\u4e00-\u9fa5]/.test(text)
        const targetLang = isChinese ? 'English' : '中文'
        prompt = prompt.split('{{lang}}').join(targetLang)
      }
      if (prompt)
        messages.value.push({
          role: 'system',
          content: prompt,
          systemMeta: { kind: `quick_action_${options.quickAction}` },
        })
    }
    messages.value.push({ role: 'assistant', content: '', thinking: '', thinkingActive: true, createdAt: tAssistant })
    // 必须引用 messages 数组里的 reactive proxy，后续 mutations 才能触发 Vue 响应式更新。
    // 注意：若用户在流式进行中途切换历史对话，messages.value 会被替换，但 assistantMsg
    // 仍指向旧 proxy。因此在 loadConversation 时要先中止当前流，防止旧 proxy 继续被改。
    const assistantMsg = messages.value[messages.value.length - 1]

    // ===== 思考 → 文本 的时序缓冲（解决“思考还没完正文抢着输出”）=====
    // 当 thinking 仍在活跃输出时，text 增量先暂存到 textBuffer，
    // 直到 thinking 静默 THINKING_SILENCE_MS 毫秒后再统一 flush 到 content 显示，
    // 从而在视觉上实现“先完整思考、再输出正文”的节奏。
    const THINKING_SILENCE_MS = 600
    // 每个 bucket（主气泡 / 子代理 run）对应一个缓冲单元
    interface TextBufferSlot {
      buffer: string
      lastThinkingAt: number
      flushTimer: number | null
    }
    const bufferByBucket = new WeakMap<object, TextBufferSlot>()
    function getOrCreateSlot(bucket: object): TextBufferSlot {
      let s = bufferByBucket.get(bucket)
      if (!s) {
        s = { buffer: '', lastThinkingAt: 0, flushTimer: null }
        bufferByBucket.set(bucket, s)
      }
      return s
    }
    // 思考增量到达 → 记录心跳时间；若之前挂了 flushTimer 则取消（思考还在继续，不要释放文本）
    function markThinkingHeartbeat(bucket: object) {
      const slot = getOrCreateSlot(bucket)
      slot.lastThinkingAt = Date.now()
      if (slot.flushTimer !== null) {
        window.clearTimeout(slot.flushTimer)
        slot.flushTimer = null
      }
    }
    // 判断当前思考是否处于活跃期：thinkingActive=true 且 最近收到过思考增量
    function isThinkingStillLive(bucket: any): boolean {
      if (bucket.thinkingActive === false) return false
      const slot = bufferByBucket.get(bucket)
      if (!slot) return false
      return Date.now() - slot.lastThinkingAt < 1200
    }
    // 把 text 增量追加到 bucket.content；若思考仍在活跃则先存 buffer 挂定时释放
    function appendTextDelta(bucket: any, delta: string) {
      if (!delta) return
      const slot = getOrCreateSlot(bucket)
      if (isThinkingStillLive(bucket)) {
        // 思考仍在活跃输出 → 先缓冲，等静默期后再一次性显示
        slot.buffer += delta
        if (slot.flushTimer === null) {
          slot.flushTimer = window.setTimeout(() => {
            slot.flushTimer = null
            // 思考静默期结束且无新思考 token：标记思考结束、封段并释放正文
            if (bucket.thinkingActive !== false) {
              bucket.thinkingActive = false
              sealThinkingSegment(bucket)
            }
            flushTextBuffer(bucket)
          }, 1250)
        }
      } else {
        // 思考已暂停/结束 → 确保 buffer 释放并追加
        flushTextBuffer(bucket)
        ;(bucket as any).content = (bucket.content || '') + delta
      }
    }
    // 强制立刻释放缓冲（工具调用时/流结束时必须调用，避免内容卡在 buffer 里丢失）
    function flushTextBuffer(bucket: any) {
      const slot = bufferByBucket.get(bucket)
      if (!slot || !slot.buffer) return
      if (slot.flushTimer !== null) {
        window.clearTimeout(slot.flushTimer)
        slot.flushTimer = null
      }
      ;(bucket as any).content = (bucket.content || '') + slot.buffer
      slot.buffer = ''
    }
    // 对所有已知 bucket 统一 flush（用于 onDone / onError 兜底清理）
    function flushAllTextBuffers() {
      flushTextBuffer(assistantMsg)
      for (const run of assistantMsg.agentRuns || []) flushTextBuffer(run)
    }

    // ===== 多轮思考分段管理（解决"调工具前的思考"与"工具执行/拒绝后的思考"混在一段或丢失）=====
    // 约定：工具调用（tool_call 到达）时把当前思考段"封段"（closed: true, isLive: false, endedAt: now），
    // 之后新一轮 thinking 增量（如工具执行后的总结或第二阶段思考）开一个新段。
    // 渲染时（AiMessage.vue）按 segments 逐段独立展示，段间自然分隔。
    // 为兼容旧字段，仍同步维护 bucket.thinking（全量拼接串，供 AiProcessChips 总秒数等使用）。
    function appendThinkingDelta(bucket: any, delta: string, startedAtNow: number) {
      if (!delta) return
      // 兼容字段：全量拼接（保持历史行为，供 chips / 摘要用）
      bucket.thinking = (bucket.thinking || '') + delta
      // 段管理
      if (!bucket.thinkingSegments) bucket.thinkingSegments = []
      const segs: any[] = bucket.thinkingSegments
      const last = segs[segs.length - 1]
      if (last && last.closed !== true) {
        last.text += delta
        last.isLive = true
      } else {
        segs.push({
          id: 'think-seg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          text: delta,
          startedAt: startedAtNow,
          closed: false,
          isLive: true,
        })
      }
      // 若主动切段过（thinkingActive 曾是 false 又变 true），记录新一轮起始时间
      bucket.thinkingStartedAt ??= startedAtNow
      bucket.thinkingActive = true
    }
    // 封段：工具调用开始时调用，标记当前段结束，后续 thinking 开新段
    function sealThinkingSegment(bucket: any) {
      if (!bucket || !bucket.thinkingSegments || bucket.thinkingSegments.length === 0) return
      const segs: any[] = bucket.thinkingSegments
      const last = segs[segs.length - 1]
      if (last && last.closed !== true) {
        last.closed = true
        last.isLive = false
        if (!last.endedAt) last.endedAt = Date.now()
      }
    }
    function sealAllThinkingSegments() {
      sealThinkingSegment(assistantMsg)
      if (assistantMsg.thinkingSegments) {
        for (const seg of assistantMsg.thinkingSegments) {
          seg.closed = true
          seg.isLive = false
          if (!seg.endedAt) seg.endedAt = Date.now()
        }
      }
      for (const run of assistantMsg.agentRuns || []) {
        sealThinkingSegment(run)
        if (run.thinkingSegments) {
          for (const seg of run.thinkingSegments) {
            seg.closed = true
            seg.isLive = false
            if (!seg.endedAt) seg.endedAt = Date.now()
          }
        }
      }
    }

    // 智能标题：如果这是新对话的首条消息，用用户消息内容自动生成标题
    const isFirstMessageInNewConv = !conv.currentConversation.value?.message_count || conv.currentConversation.value.message_count === 0
    isStreaming.value = true
    streamLastActivityAt.value = Date.now() // 健康检查：记录流开始时间
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

    // 用于从 <think>...</think> 和 <Thought>...</Thought> 中提取思考过程。
    // 支持两种标签：
    //   1. <think> 标签：模型原生思考（如 deepseek-r1 等）
    //   2. <Thought> 标签：ReAct 范式的强制思考过程
    const thinkState = {
      raw: '',
      pos: 0,
      inThink: false,
      currentTag: '' as '' | 'think' | 'Thought',
    }
    const MAX_TAG_PREFIX_LEN = 12

    function processThinkContent(delta: string, isFinal = false): { textDelta: string; thinkingDelta: string } {
      thinkState.raw += delta
      let textDelta = ''
      let thinkingDelta = ''

      while (true) {
        if (!thinkState.inThink) {
          // 同时搜索 <think> 和 <Thought> 标签
          const thinkIdx = thinkState.raw.indexOf('<think>', thinkState.pos)
          const thoughtIdx = thinkState.raw.indexOf('<Thought>', thinkState.pos)

          let idx = -1
          let tag: 'think' | 'Thought' = 'think'

          if (thinkIdx !== -1 && thoughtIdx !== -1) {
            // 取最先出现的
            if (thinkIdx < thoughtIdx) {
              idx = thinkIdx
              tag = 'think'
            } else {
              idx = thoughtIdx
              tag = 'Thought'
            }
          } else if (thinkIdx !== -1) {
            idx = thinkIdx
            tag = 'think'
          } else if (thoughtIdx !== -1) {
            idx = thoughtIdx
            tag = 'Thought'
          }

          if (idx === -1) {
            // 未找到开启标签：如果不是最后终结块，保留末尾至多 MAX_TAG_PREFIX_LEN 个字符，防拆包漏判
            const safeEnd = isFinal ? thinkState.raw.length : Math.max(thinkState.pos, thinkState.raw.length - MAX_TAG_PREFIX_LEN)
            if (safeEnd > thinkState.pos) {
              textDelta += thinkState.raw.slice(thinkState.pos, safeEnd)
              thinkState.pos = safeEnd
            }
            break
          }
          textDelta += thinkState.raw.slice(thinkState.pos, idx)
          thinkState.pos = idx + (tag === 'think' ? 7 : 10)
          thinkState.inThink = true
          thinkState.currentTag = tag
        } else {
          // 根据当前标签搜索对应的结束标签
          const closeTag = thinkState.currentTag === 'think' ? '</think>' : '</Thought>'
          const closeLen = closeTag.length
          const idx = thinkState.raw.indexOf(closeTag, thinkState.pos)
          if (idx === -1) {
            // 未找到结束标签：如果不是最后终结块，保留末尾至多 MAX_TAG_PREFIX_LEN 个字符
            const safeEnd = isFinal ? thinkState.raw.length : Math.max(thinkState.pos, thinkState.raw.length - MAX_TAG_PREFIX_LEN)
            if (safeEnd > thinkState.pos) {
              thinkingDelta += thinkState.raw.slice(thinkState.pos, safeEnd)
              thinkState.pos = safeEnd
            }
            break
          }
          thinkingDelta += thinkState.raw.slice(thinkState.pos, idx)
          thinkState.pos = idx + closeLen
          thinkState.inThink = false
          thinkState.currentTag = ''
        }
      }

      return { textDelta, thinkingDelta }
    }

    // 系统提示词由服务端统一组装（buildSystemPrompt），前端只发送业务消息，
    // 不再从本地拼装上下文知识库。
    const selectedProvider = providers.value.find((p) => p.id === selectedProviderId.value)
    const modelName = selectedModel.value || selectedProvider?.model || ''
    const nativeReasoning = isNativeReasoningModel(modelName)

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
          imageHash: m.images[0]?.hash,
        })
      } else {
        historyMessages.push({ role: m.role, content: m.content })
      }
    }
    const history: any[] = [...historyMessages]

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
          streamLastActivityAt.value = Date.now() // 健康检查：持续刷新活动时间
          // token 用量事件：覆盖为最近一次（最代表当前上下文大小）
          if (meta?.usage) {
            const u = meta.usage
            const percent =
              u.contextWindow > 0 ? Math.min(100, Math.max(0, Math.round((u.totalTokens / u.contextWindow) * 100))) : 0
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
          // 破坏性工具确认门控（Agent-C）：后端请求用户放行，弹确认卡片等待允许/拒绝。
          if (mm?.type === 'confirm_tool_action') {
            if (sessionAlwaysAllowAll.value || (mm.tool && sessionAllowedTools.value.has(mm.tool))) {
              // 命中本会话白名单：直接自动批准放行，不弹确认卡片打断用户
              approveToolAction(mm.requestId, true).catch(() => {})
              return
            }
            pendingConfirm.value = {
              requestId: mm.requestId,
              tool: mm.tool,
              argsSummary: mm.argsSummary,
              impact: mm.impact,
            }
            approving.value = false
          }
          // 上下文自动压缩（上下文管理）：后端在上下文逼近上限时自动压缩较早历史。
          // 压缩期间下发 context_compress_started（显示"上下文压缩中"扫光分割线），
          // 压缩完成后下发 context_compressed（切换为"压缩已完成"）。任务本身不中断。
          if (mm?.type === 'context_compress_started') {
            setCompressProgress({ status: 'compressing', source: 'auto' })
          }
          if (mm?.type === 'context_compressed') {
            setCompressProgress({
              status: 'done',
              source: 'auto',
              removed: mm.removedMessages || 0,
              savedTokens: (mm.beforeTokens || 0) - (mm.afterTokens || 0),
            })
          }

          // 有 agentId 的增量属于某个子代理 → 路由到对应卡片；否则归到主气泡
          const target: AgentRun | null = meta?.agentId ? getOrCreateAgentRun(meta.agentId) : null

          // ask_user 交互卡片兜底（人类在回路）：正常路径由 tool_call 增量驱动卡片渲染，
          // 此处兜底覆盖 tool_call 缺失/后到的路径（统一管线保证 tool_call 先行，此为双保险）。
          // 已存在同 id 的 toolCall 时跳过，避免重复累积导致 arguments 拼接两份。
          if (mm?.type === 'ask_user_action' && mm.requestId) {
            const askBucket = target || assistantMsg
            const exists = (askBucket.toolCalls || []).some((tc) => tc.id === mm.requestId)
            if (!exists) {
              askBucket.thinkingActive = false
              sealThinkingSegment(askBucket)
              flushTextBuffer(askBucket)
              if (!askBucket.toolCalls) askBucket.toolCalls = []
              askBucket.toolCalls.push({
                id: mm.requestId,
                name: 'ask_user',
                arguments: JSON.stringify({
                  questions: Array.isArray(mm.questions) ? mm.questions : [],
                  context: mm.context || '',
                }),
                segIndex: Math.max(0, (askBucket.thinkingSegments?.length || 1) - 1),
              } as any)
            }
          }

          if (thinkingNative) {
            const bucket = target || assistantMsg
            // 多轮流式保护：上一轮工具调用把 thinkingActive=false 了，
            // 但新的一轮模型又开始输出 thinking（工具执行后的反思/规划），
            // 需要重新激活思考状态，避免 UI 显示"思考完成"但内容仍在继续写入
            if (bucket.thinkingActive === false) {
              bucket.thinkingActive = true
              bucket.thinkingStartedAt = Date.now()
            }
            appendThinkingDelta(bucket, thinkingNative, Date.now())
            // 思考增量到达 → 更新心跳，推迟后续文本的 flush 时机
            markThinkingHeartbeat(bucket)
          }

          if (d) {
            const res = processThinkContent(d)
            const bucket = target || assistantMsg
            // 使用时序缓冲：思考活跃时先暂存 text，静默后再统一释放，
            // 解决“思考折叠面板还在打字，下方正文就抢着出来”的观感问题
            appendTextDelta(bucket, res.textDelta)
            if (res.thinkingDelta && !nativeReasoning) {
              // 同上：多轮流式保护
              if (bucket.thinkingActive === false) {
                bucket.thinkingActive = true
                bucket.thinkingStartedAt = Date.now()
              }
              appendThinkingDelta(bucket, res.thinkingDelta, Date.now())
              markThinkingHeartbeat(bucket)
            }
            // 注意：不因为开始输出 text 就立即设置 thinkingActive=false
            // Step Explore 等 Anthropic 协议模型可能交错输出 thinking 和 text blocks，
            // 过早置为 false 会导致 thinking UI 显示为"思考完成"而实际仍在继续输出。
            // thinkingActive=false 只在：1) 工具调用时（见下方 toolCall 分支）、2) 流结束 onDone 触发时设置
          }

          if (toolCall) {
            // 工具一旦开始调用，对应气泡的思考阶段即视为结束
            const bucket = target || assistantMsg
            bucket.thinkingActive = false
            // 封段：当前思考（"我要调用工具"的规划）结束，拒绝/结果后的新一轮思考独立成段
            sealThinkingSegment(bucket)
            // 工具调用卡片必须立即显示 → 强制释放缓冲中的正文，避免被卡在静默期里
            flushTextBuffer(bucket)
            if (!bucket.toolCalls) bucket.toolCalls = []
            // 关联当前所属的思考段索引
            const currentSegIdx = Math.max(0, (bucket.thinkingSegments?.length || 1) - 1)
            const tcWithSeg = {
              ...toolCall,
              segIndex: (toolCall as any).segIndex ?? currentSegIdx,
            }
            const existing = bucket.toolCalls.find((tc) => tc.id === toolCall.id)
            if (existing) {
              existing.arguments = (existing.arguments || '') + (toolCall.arguments || '')
              if ((existing as any).segIndex === undefined) (existing as any).segIndex = currentSegIdx
            } else {
              bucket.toolCalls.push(tcWithSeg)
            }
          }

          if (toolResult) {
            const bucket = target || assistantMsg
            sealThinkingSegment(bucket)
            if (!bucket.toolResults) bucket.toolResults = []
            const existing = bucket.toolResults.find((tr) => tr.tool_call_id === toolResult.tool_call_id)
            if (existing) {
              existing.content = (existing.content || '') + (toolResult.content || '')
            } else {
              bucket.toolResults.push(toolResult)
            }
            
            // 工具执行完成后触发数据刷新（实现无感刷新）
            // 工具名优先取 tool_result 自带的 name（coordinator 路径只发 tool_result、不发
            // tool_call 事件，此时 toolCalls 里匹配不到对应项）；取不到再回退到 tool_call 匹配。
            const toolName =
              toolResult.name ||
              bucket.toolCalls?.find((tc) => tc.id === toolResult.tool_call_id)?.name
            if (toolName) {
              // 延迟 300ms 触发，等待后端数据落盘完成
              setTimeout(() => {
                triggerRefreshAfterTool(toolName, toolResult.content)
                // 收藏夹工具完成后，额外派发 clipsync:collections-updated 事件
                // useCollections / collectionStore 都监听此事件，确保双侧同步
                const collectionTools = ['create_collection', 'create_sub_collection']
                if (collectionTools.includes(toolName)) {
                  window.dispatchEvent(new CustomEvent('clipsync:collections-updated', {
                    detail: { reason: 'ai-tool', tool: toolName }
                  }))
                }
              }, 300)
            }
          }
        },
        onError: (msg) => {
          error.value = msg
          const last = messages.value[messages.value.length - 1]
          if (last && last.role === 'assistant') {
            last.isError = true
            last.thinkingActive = false
            for (const run of last.agentRuns || []) run.thinkingActive = false
          }
          sealAllThinkingSegments()
          // 出错必须释放缓冲，防止文本卡在静默期定时器里永远不显示
          flushAllTextBuffers()
        },
        onDone: () => {
          /* 流正常结束，最后统一持久化 */
          // 确保所有 think 标签 buffer 刷完
          const rem = processThinkContent('', true)
          if (rem.textDelta) appendTextDelta(assistantMsg, rem.textDelta)
          if (rem.thinkingDelta && !nativeReasoning) {
            appendThinkingDelta(assistantMsg, rem.thinkingDelta, Date.now())
          }

          // 确保 thinkingActive 在流结束时标记为 false，避免前端 UI 显示"思考中"永不结束
          assistantMsg.thinkingActive = false
          for (const run of assistantMsg.agentRuns || []) {
            run.thinkingActive = false
          }
          sealAllThinkingSegments()
          // 流结束：强制释放所有暂存文本缓冲，确保无内容丢失
          flushAllTextBuffers()
          // 流结束也触发一次规划卡片收敛
          convergePlanning()
        },
      })
    } catch (e: any) {
      error.value = String(e?.message || e)
      const last = messages.value[messages.value.length - 1]
      if (last && last.role === 'assistant') last.isError = true
      // 异常路径也要 flush，避免 catch 块触发时缓冲还挂着定时器未释放
      flushAllTextBuffers()
    } finally {
      clearInterval(silenceWatchdog)
      clearInterval(agentTimeoutWatchdog)
      // finally 在 onError/onDone 之后执行，但如果两者都没走到（例如同步抛错+未注册回调），这里兜底 flush
      flushAllTextBuffers()
      isStreaming.value = false
      streamLastActivityAt.value = 0 // 健康检查：重置活动时间
      abortCtrl.value = null
      // 收敛所有残留的非终态 agent 卡片（含上一条挂掉的并行请求残留），避免永久转圈
      settleAgentRuns()
      // 流结束：清掉可能残留的确认卡片（后端超时/断流已清对应 pending）
      pendingConfirm.value = null
      approving.value = false
      // 保存当前对话的消息（不等待，失败静默）
      conv.saveCurrent(messages.value).catch(() => {})
      // 智能标题：新对话首条消息 → 用用户消息内容自动命名（截取前 20 字符）
      if (isFirstMessageInNewConv) {
        const userMsg = messages.value.find((m) => m.role === 'user')
        if (userMsg?.content) {
          const title = userMsg.content.replace(/[\u2404].*?[\u2404]/g, '').trim().slice(0, 20) || '新对话'
          conv.rename(conv.currentConversationId.value, title).catch(() => {})
        }
      }
    }
  }

  // 破坏性工具确认门控：允许/拒绝待确认的破坏性工具执行。
  // 允许 → 后端执行并把 tool_result 回传 LLM；拒绝 → 不执行并以 REJECTED_BY_USER 回传。
  // scope: 'once' (仅本次) | 'tool' (本会话始终允许当前工具) | 'all' (本会话始终允许所有操作)
  async function approve(allow: boolean, scope: 'once' | 'tool' | 'all' = 'once') {
    if (!pendingConfirm.value || approving.value) return
    const req = pendingConfirm.value
    if (allow) {
      if (scope === 'tool' && req.tool) {
        sessionAllowedTools.value.add(req.tool)
      } else if (scope === 'all') {
        sessionAlwaysAllowAll.value = true
      }
    }
    approving.value = true
    const res = await approveToolAction(req.requestId, allow)
    // 无论成功与否都收起确认卡片，避免卡片滞留（后端已按其状态继续推进流）
    pendingConfirm.value = null
    approving.value = false
    if (!res.ok) {
      error.value = res.error || 'ai_approve_failed'
    }
  }

  function stop() {
    abortCtrl.value?.abort()
  }

  function clear() {
    if (isStreaming.value) stop()
    messages.value = []
    error.value = ''
    pendingConfirm.value = null
    conv.setCurrent('')
  }

  /**
   * 手动压缩当前对话的上下文历史（/compact 命令的内部实现 + 也供 UI 按钮直接调用）。
   * 流程：
   *  1) 若无当前对话 → 提示"请先选中一个对话"
   *  2) 显示一个 user 消息 "/compact" + 一个 system 消息 "正在压缩…"
   *  3) 调后端 POST /api/ai/conversations/:id/compact
   *  4) 把"正在压缩"那条 system 消息替换为成功/失败说明
   *  5) 触发上下文用量刷新（圆环更新）
   */
  async function manualCompact() {
    if (isStreaming.value) {
      error.value = 'ai_streaming_busy'
      return
    }
    if (!conv.currentConversationId.value) {
      // 没有对话就提示一下，不自动创建（避免污染对话列表）
      error.value = 'ai_compact_no_active'
      return
    }
    error.value = ''
    // 分割线提示：压缩中（扫光动画）
    setCompressProgress({ status: 'compressing', source: 'manual' })
    try {
      const res = await conv.compact(conv.currentConversationId.value, {
        providerId: selectedProviderId.value,
      })
      if (res.ok) {
        const removed = res.removed || 0
        const saved = res.savedTokens || 0
        const after = res.afterTokens || 0
        setCompressProgress({
          status: 'done',
          source: 'manual',
          removed,
          savedTokens: saved,
        })
        // 刷新上下文用量（用估算后值）—— 让圆环/面板立即显示压缩效果
        const conv2 = conv.currentConversation.value
        if (conv2) {
          const cw = conv2.context_window || 0
          if (cw > 0) {
            contextUsage.value = {
              promptTokens: after,
              completionTokens: conv2.completion_tokens || 0,
              totalTokens: after + (conv2.completion_tokens || 0),
              contextWindow: cw,
              percent: Math.min(100, Math.round((after / cw) * 1000) / 10),
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              cacheHitRate: 0,
              thinkingTokens: conv2.thinking_tokens || 0,
              replyTokens: conv2.reply_tokens || 0,
            }
          }
        }
      } else if (res.reason === 'too_short') {
        setCompressProgress({ status: 'too_short', source: 'manual' })
      } else {
        setCompressProgress({ status: 'failed', source: 'manual', error: res.error || 'compact failed' })
      }
    } catch (e) {
      setCompressProgress({
        status: 'failed',
        source: 'manual',
        error: e instanceof Error ? e.message : 'compact failed',
      })
    }
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
    compressProgress,
    pendingConfirm,
    sessionAllowedTools,
    sessionAlwaysAllowAll,
    approving,
    approve,
    hasProviders,
    canSend,
    providerSupportsCache,
    memoryEnabled,
    setMemoryEnabled,
    init,
    loadProviders,
    selectProvider,
    selectModel,
    send,
    stop,
    clear,
    truncateFrom,
    manualCompact,
    stripViewContext,
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
