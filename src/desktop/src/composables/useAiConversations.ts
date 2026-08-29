import { ref, computed } from 'vue'
import {
  getConversations,
  createConversation,
  getConversation,
  updateConversation,
  deleteConversation,
  saveMessages,
  compactConversation,
  type CompactResult,
} from '@/api/ai'
import type { AiConversation, ChatMessage, ContextUsage } from '@/api/ai'

function mapUsage(conv: AiConversation | null | undefined): ContextUsage | null {
  if (!conv || !conv.total_tokens) return null
  const contextWindow = conv.context_window || 0
  const total = conv.total_tokens || 0
  return {
    promptTokens: conv.prompt_tokens || 0,
    completionTokens: conv.completion_tokens || 0,
    totalTokens: total,
    contextWindow,
    percent: contextWindow > 0 ? Math.min(100, Math.round((total / contextWindow) * 1000) / 10) : 0,
    cacheReadTokens: conv.cache_read_tokens || 0,
    cacheWriteTokens: conv.cache_write_tokens || 0,
    cacheHitRate: conv.cache_hit_rate || 0,
    thinkingTokens: conv.thinking_tokens || 0,
    replyTokens: conv.reply_tokens || 0,
  }
}

export function useAiConversations() {
  const conversations = ref<AiConversation[]>([])
  const currentConversationId = ref<string>('')
  const loading = ref(false)

  const currentConversation = computed(() =>
    conversations.value.find((c) => c.id === currentConversationId.value) || null
  )

  const currentUsage = computed(() => mapUsage(currentConversation.value))

  async function loadConversations() {
    loading.value = true
    try {
      const res = await getConversations()
      if (res.ok) {
        conversations.value = res.data?.items || []
      } else {
        console.error('[useAiConversations] loadConversations failed:', res.status, res.error)
      }
    } catch (e: any) {
      console.error('[useAiConversations] loadConversations error:', e?.message || e)
    } finally {
      loading.value = false
    }
  }

  async function createNew(options: {
    title?: string
    providerId?: string
    model?: string
    mode?: 'ask' | 'agent'
    thinkingEnabled?: boolean
  }): Promise<AiConversation | null> {
    const res = await createConversation({
      title: options.title || '新对话',
      providerId: options.providerId,
      model: options.model,
      mode: options.mode || 'ask',
      thinkingEnabled: options.thinkingEnabled || false,
    })
    if (!res.ok || !res.data?.conversation) {
      console.error('[useAiConversations] createConversation failed:', res.status, res.error)
      return null
    }
    const conv = res.data.conversation
    conversations.value.unshift(conv)
    currentConversationId.value = conv.id
    return conv
  }

  async function select(id: string): Promise<ChatMessage[] | null> {
    currentConversationId.value = id
    const res = await getConversation(id)
    if (!res.ok) return null
    const msgs = res.data?.messages || []
    // 恢复时把 JSON 数组字段映射回 camelCase；
    // 过滤掉后端写入的"上下文压缩摘要"（role='system' AND metadata.is_context_summary=true），
    // 对用户保持 UI 上的"无感"，但后端 runChatLoop 会在下次入口自动注入到 prompt 头部。
    return msgs
      .filter((m: any) => !(m.role === 'system' && m.metadata?.is_context_summary === true))
      .map((m: any) => ({
        role: m.role,
        content: m.content || '',
        thinking: m.thinking || undefined,
        thinkingSegments: m.thinkingSegments || m.metadata?.thinkingSegments || undefined,
        toolCalls: m.tool_calls || m.toolCalls || undefined,
        toolResults: m.tool_results || m.toolResults || undefined,
        // 保留原始 created_at，供 saveMessages 全量重插后仍能稳定按时间排序
        createdAt: m.created_at || m.createdAt || undefined,
      })) as ChatMessage[]
  }

  async function rename(id: string, title: string) {
    const res = await updateConversation(id, title)
    if (res.ok && res.data?.conversation) {
      const idx = conversations.value.findIndex((c) => c.id === id)
      if (idx !== -1) {
        conversations.value[idx] = { ...conversations.value[idx], ...res.data.conversation }
      }
    }
  }

  async function remove(id: string) {
    const res = await deleteConversation(id)
    if (res.ok) {
      conversations.value = conversations.value.filter((c) => c.id !== id)
      if (currentConversationId.value === id) {
        currentConversationId.value = ''
      }
    }
    return res.ok
  }

  /**
   * 手动压缩当前对话的上下文历史（/compact 命令触发）。
   * 调后端 POST /api/ai/conversations/:id/compact，成功后新摘要已写入 ai_messages
   * （前端 UI 看不到），下次发消息时 runChatLoop 入口会自动注入。
   * @returns {Promise<CompactResult>}
   */
  async function compact(id: string, opts?: { providerId?: string }): Promise<CompactResult> {
    if (!id) return { ok: false, reason: 'not_found', error: 'no conversation' }
    const res = await compactConversation(id, opts || {})
    if (res.ok && res.data) return res.data
    return { ok: false, reason: 'failed', error: res.error || 'compact failed' }
  }

  async function saveCurrent(messages: ChatMessage[]) {
    if (!currentConversationId.value) return
    const toSave = messages.filter((m) => m.role !== 'system')
    if (toSave.length === 0) return
    try {
      const res = await saveMessages(currentConversationId.value, toSave)
      if (!res.ok) {
        console.warn('[useAiConversations] saveMessages failed:', res.error)
      }
    } catch (e: any) {
      console.warn('[useAiConversations] saveMessages error:', e?.message || e)
    }
    // 更新本地 updated_at，让排序保持最新
    const idx = conversations.value.findIndex((c) => c.id === currentConversationId.value)
    if (idx !== -1) {
      conversations.value[idx] = {
        ...conversations.value[idx],
        updated_at: new Date().toISOString(),
        message_count: toSave.length,
      }
    }
  }

  function setCurrent(id: string) {
    currentConversationId.value = id
  }

  return {
    conversations,
    currentConversationId,
    currentConversation,
    currentUsage,
    loading,
    loadConversations,
    createNew,
    select,
    rename,
    remove,
    saveCurrent,
    setCurrent,
    compact,
  }
}
