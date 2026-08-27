import { ref, shallowRef, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { getProviders, getSettings, saveSettings, updateProvider, approveToolAction } from '@/api/ai'
import type { AiProvider, ChatMessage, AiSettings, AiConversation, ContextUsage, ChatImage } from '@/api/ai'
import { useAiConversations, genMessageId } from './useAiConversations'
import { runStream } from './ai-stream/send'

interface SendOptions {
  mode?: 'ask' | 'agent'
  thinking?: boolean
  thinkingStrength?: 'low' | 'medium' | 'high'
  images?: ChatImage[]
  viewContext?: string
  quickAction?: 'summarize' | 'translate' | 'format' | 'explain' | 'optimize'
}

const VIEW_CTX_OPEN = '\u2404VIEWCTX\u2404'
const VIEW_CTX_CLOSE = '\u2404/VIEWCTX\u2404'
const USER_INPUT_OPEN = '\u2404USERINPUT\u2404'
const USER_INPUT_CLOSE = '\u2404/USERINPUT\u2404'
const NATIVE_REASONING_KEYWORDS = ['deepseek-r1','claude-3-7-sonnet','o1','o1-preview','o1-mini','o3','o4-mini','qwq','qwen3','minimax','mimo','step-']
function isNativeReasoningModel(m: string) { if (!m) return false; return NATIVE_REASONING_KEYWORDS.some(k => m.toLowerCase().includes(k)) }

export function useAiChat() {
  const { t } = useI18n()
  const providers = ref<AiProvider[]>([])
  const selectedProviderId = ref('')
  const selectedModel = ref('')
  const settings = ref<AiSettings | null>(null)
  const messages = ref<ChatMessage[]>([])
  const isStreaming = ref(false)
  const streamLastActivityAt = ref(0)
  const STREAM_HEALTH_TIMEOUT = 120_000
  const error = ref('')
  const contextUsage = ref<ContextUsage | null>(null)
  const duplicateImageNotice = ref<{ imageHash: string; existingId: string; createdAt: string; preview: string } | null>(null)
  const compressProgress = ref<{ status: 'compressing'|'done'|'too_short'|'failed'; source: 'manual'|'auto'; removed?: number; savedTokens?: number; error?: string } | null>(null)
  const pendingConfirm = ref<{ requestId: string; tool: string; argsSummary: string; impact: string } | null>(null)
  const sessionAllowedTools = ref<Set<string>>(new Set())
  const sessionAlwaysAllowAll = ref(false)
  const approving = ref(false)
  let compressProgressTimer: number | undefined
  function setCompressProgress(p: typeof compressProgress.value) {
    compressProgress.value = p
    if (compressProgressTimer) { window.clearTimeout(compressProgressTimer); compressProgressTimer = undefined }
    if (p && p.status !== 'compressing') compressProgressTimer = window.setTimeout(() => { compressProgress.value = null }, 5000)
  }
  const abortCtrl = shallowRef<AbortController | null>(null)
  const initialized = ref(false)
  const memoryEnabled = ref(false)
  function setMemoryEnabled(v: boolean) { memoryEnabled.value = v; persistSettings({ memoryEnabled: v }) }
  const conv = useAiConversations()
  const hasProviders = computed(() => providers.value.length > 0)
  const canSend = computed(() => !!selectedProviderId.value && !isStreaming.value)
  const providerSupportsCache = computed(() => !!providers.value.find(x => x.id === selectedProviderId.value)?.supports_cache)

  async function loadProviders() {
    const res = await getProviders()
    if (res.ok) { providers.value = res.data?.items || []; if (!selectedProviderId.value) { const def = providers.value.find(p => p.is_default) || providers.value[0]; selectedProviderId.value = def?.id || ''; selectedModel.value = settings.value?.selectedModels?.[def?.id || ''] || def?.model || '' } }
  }
  async function init() {
    if (initialized.value) return; initialized.value = true
    await Promise.all([loadProviders(), conv.loadConversations()])
    await loadSettings()
    if (!conv.currentConversationId.value && conv.conversations.value.length > 0) await loadConversation(conv.conversations.value[0].id)
    if (!contextUsage.value) contextUsage.value = conv.currentUsage.value
  }
  async function loadSettings() {
    try { const res = await getSettings(); if (res.ok && res.data) { settings.value = res.data; memoryEnabled.value = res.data.memoryEnabled ?? false; if (res.data.defaultProviderId) { const p = providers.value.find(x => x.id === res.data!.defaultProviderId); if (p) { selectedProviderId.value = p.id; selectedModel.value = res.data.selectedModels?.[p.id] || res.data.defaultModel || p.model } } } } catch { /* 不阻塞 */ }
  }
  function persistSettings(patch: Partial<AiSettings>) {
    const next: AiSettings = { defaultProviderId: settings.value?.defaultProviderId ?? null, defaultModel: settings.value?.defaultModel ?? null, selectedModels: settings.value?.selectedModels ?? {}, defaultMode: settings.value?.defaultMode ?? 'ask', thinkingEnabled: settings.value?.thinkingEnabled ?? false, thinkingStrength: settings.value?.thinkingStrength ?? 'medium', memoryEnabled: memoryEnabled.value, ...patch }
    settings.value = next; saveSettings(next).catch(() => {})
  }
  function selectProvider(id: string) {
    selectedProviderId.value = id
    const p = providers.value.find(x => x.id === id)
    if (p) { const remembered = settings.value?.selectedModels?.[p.id]; selectedModel.value = remembered || settings.value?.defaultModel || p.model; persistSettings({ defaultProviderId: id, defaultModel: selectedModel.value, selectedModels: { ...settings.value?.selectedModels, [id]: selectedModel.value } }) }
  }
  async function selectModel(model: string) {
    if (!model) return; selectedModel.value = model
    const p = providers.value.find(x => x.id === selectedProviderId.value)
    if (p) persistSettings({ defaultModel: model, selectedModels: { ...settings.value?.selectedModels, [p.id]: model } })
  }
  async function newConversation(opts?: { title?: string; mode?: 'ask'|'agent'; thinkingEnabled?: boolean }): Promise<AiConversation | null> {
    const p = providers.value.find(x => x.id === selectedProviderId.value)
    const created = await conv.createNew({ title: opts?.title || '新对话', providerId: selectedProviderId.value, model: selectedModel.value || p?.model, mode: opts?.mode, thinkingEnabled: opts?.thinkingEnabled })
    if (!created) { console.error('[useAiChat] newConversation failed'); return null }
    messages.value = []; error.value = ''; contextUsage.value = null; pendingConfirm.value = null; return created
  }
  const STREAM_SETTLE_TIMEOUT_MS = 1_500
  async function waitForStreamSettle() {
    const deadline = Date.now() + STREAM_SETTLE_TIMEOUT_MS
    while (isStreaming.value && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    if (isStreaming.value) console.warn('[useAiChat] previous stream did not settle within timeout')
  }
  async function loadConversation(id: string) {
    if (isStreaming.value) { stop(); await waitForStreamSettle() }
    const msgs = await conv.select(id)
    if (msgs) { messages.value = msgs; error.value = ''; contextUsage.value = conv.currentUsage.value }
  }
  function stripViewContext(content: string): string {
    if (!content || !content.includes(VIEW_CTX_OPEN)) return content
    const s = content.indexOf(VIEW_CTX_OPEN), e = content.indexOf(VIEW_CTX_CLOSE)
    return s >= 0 && e > s ? content.slice(0, s) + content.slice(e + VIEW_CTX_CLOSE.length) : content
  }

  async function send(content: string, options: SendOptions = {}) {
    const text = content.trim()
    if (isStreaming.value) {
      if (Date.now() - streamLastActivityAt.value > STREAM_HEALTH_TIMEOUT) { console.warn('[useAiChat] isStreaming stuck, forcing reset'); isStreaming.value = false; abortCtrl.value?.abort() }
      else return
    }
    if (!text) return
    duplicateImageNotice.value = null; compressProgress.value = null
    if (!selectedProviderId.value) { error.value = 'ai_no_provider_selected'; return }
    if (text === '/compact' || text === '/压缩' || text.startsWith('/compact ') || text.startsWith('/压缩 ')) { await manualCompact(); return }
    if (!conv.currentConversationId.value) {
      const created = await newConversation({ mode: options.mode, thinkingEnabled: options.thinking })
      if (!created) { error.value = 'ai_create_conversation_failed'; isStreaming.value = false; return }
    }
    error.value = ''
    const wrappedText = options.quickAction ? `${USER_INPUT_OPEN}${text}${USER_INPUT_CLOSE}` : text
    const now = new Date(), nowTs = now.toISOString(), tUser = new Date(now.getTime() + 1).toISOString(), tAssistant = new Date(now.getTime() + 2).toISOString()
    if (options.viewContext) messages.value.push({ id: genMessageId(), role: 'system', content: options.viewContext, systemMeta: { kind: 'view_context' }, createdAt: nowTs })
    messages.value.push({ id: genMessageId(), role: 'user', content: wrappedText, images: options.images, imageHash: options.images?.[0]?.hash, createdAt: tUser })
    if (options.quickAction) {
      let prompt = t(`ai_quick_${options.quickAction}_prompt`) || ''
      if (options.quickAction === 'translate' && prompt.includes('{{lang}}')) prompt = prompt.split('{{lang}}').join(/[\u4e00-\u9fa5]/.test(text) ? 'English' : '中文')
      if (prompt) messages.value.push({ id: genMessageId(), role: 'system', content: prompt, systemMeta: { kind: `quick_action_${options.quickAction}` } })
    }
    messages.value.push({ id: genMessageId(), role: 'assistant', content: '', thinking: '', thinkingActive: true, createdAt: tAssistant })
    const assistantMsg = messages.value[messages.value.length - 1]
    const selectedProvider = providers.value.find(p => p.id === selectedProviderId.value)!
    const nativeReasoning = isNativeReasoningModel(selectedModel.value || selectedProvider.model || '')
    const isFirstMessageInNewConv = !conv.currentConversation.value?.message_count || conv.currentConversation.value.message_count === 0
    const thisConversationId = conv.currentConversationId.value
    const ownsStream = () => conv.currentConversationId.value === thisConversationId
    const agentLastUpdateAt = new Map<string, number>()

    await runStream({
      messages, isStreaming, streamLastActivityAt, error, contextUsage, duplicateImageNotice,
      compressProgress, pendingConfirm, sessionAllowedTools, sessionAlwaysAllowAll, approving, abortCtrl,
      options, selectedProviderId: selectedProviderId.value, selectedProviderModel: selectedModel.value || selectedProvider?.model || '',
      conversationId: conv.currentConversationId.value, thisConversationId,
      assistantMsg, agentLastUpdateAt, isFirstMessageInNewConv, nativeReasoning,
      ownsStream, setCompressProgress,
      saveCurrent: (msgs) => conv.saveCurrent(msgs),
      renameConversation: (id, title) => conv.rename(id, title),
    })
  }

  async function approve(allow: boolean, scope: 'once'|'tool'|'all' = 'once') {
    if (!pendingConfirm.value || approving.value) return
    const req = pendingConfirm.value
    if (allow) {
      if (scope === 'tool' && req.tool) sessionAllowedTools.value.add(req.tool)
      else if (scope === 'all') sessionAlwaysAllowAll.value = true
    }
    approving.value = true
    const res = await approveToolAction(req.requestId, allow)
    pendingConfirm.value = null; approving.value = false
    if (!res.ok) error.value = res.error || 'ai_approve_failed'
  }

  function stop() { abortCtrl.value?.abort() }
  function clear() { if (isStreaming.value) stop(); messages.value = []; error.value = ''; pendingConfirm.value = null; conv.setCurrent('') }

  async function manualCompact() {
    if (isStreaming.value) { error.value = 'ai_streaming_busy'; return }
    if (!conv.currentConversationId.value) { error.value = 'ai_compact_no_active'; return }
    error.value = ''; setCompressProgress({ status: 'compressing', source: 'manual' })
    try {
      const res = await conv.compact(conv.currentConversationId.value, { providerId: selectedProviderId.value })
      if (res.ok) {
        const removed = res.removed || 0, saved = res.savedTokens || 0, after = res.afterTokens || 0
        setCompressProgress({ status: 'done', source: 'manual', removed, savedTokens: saved })
        const c = conv.currentConversation.value
        if (c?.context_window) {
          const cw = c.context_window
          if (cw > 0) contextUsage.value = { promptTokens: after, completionTokens: c.completion_tokens || 0, totalTokens: after + (c.completion_tokens || 0), contextWindow: cw, percent: Math.min(100, Math.round((after / cw) * 1000) / 10), cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: 0, thinkingTokens: c.thinking_tokens || 0, replyTokens: c.reply_tokens || 0 }
        }
      } else if (res.reason === 'too_short') setCompressProgress({ status: 'too_short', source: 'manual' })
      else setCompressProgress({ status: 'failed', source: 'manual', error: res.error || 'compact failed' })
    } catch (e) { setCompressProgress({ status: 'failed', source: 'manual', error: e instanceof Error ? e.message : 'compact failed' }) }
  }

  return { providers, selectedProviderId, selectedModel, settings, persistSettings, messages, isStreaming, error, contextUsage, duplicateImageNotice, compressProgress, pendingConfirm, sessionAllowedTools, sessionAlwaysAllowAll, approving, approve, hasProviders, canSend, providerSupportsCache, memoryEnabled, setMemoryEnabled, init, loadProviders, selectProvider, selectModel, send, stop, clear, manualCompact, stripViewContext, conversations: conv.conversations, currentConversationId: conv.currentConversationId, currentConversation: conv.currentConversation, loadConversations: conv.loadConversations, newConversation, loadConversation, renameConversation: conv.rename, deleteConversation: conv.remove }
}
