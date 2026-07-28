import { ref, computed } from 'vue'
import {
  getConversations,
  createConversation,
  getConversation,
  updateConversation,
  deleteConversation,
  saveMessages,
} from '@/api/ai'
import type { AiConversation, ChatMessage } from '@/api/ai'

export function useAiConversations() {
  const conversations = ref<AiConversation[]>([])
  const currentConversationId = ref<string>('')
  const loading = ref(false)

  const currentConversation = computed(() =>
    conversations.value.find((c) => c.id === currentConversationId.value) || null
  )

  async function loadConversations() {
    loading.value = true
    try {
      const res = await getConversations()
      if (res.ok) {
        conversations.value = res.data?.items || []
      }
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
    if (!res.ok || !res.data?.conversation) return null
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
    // 恢复时把 JSON 数组字段映射回 camelCase
    return msgs.map((m: any) => ({
      role: m.role,
      content: m.content || '',
      thinking: m.thinking || undefined,
      toolCalls: m.tool_calls || m.toolCalls || undefined,
      toolResults: m.tool_results || m.toolResults || undefined,
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

  async function saveCurrent(messages: ChatMessage[]) {
    if (!currentConversationId.value) return
    const toSave = messages.filter((m) => m.role !== 'system')
    if (toSave.length === 0) return
    await saveMessages(currentConversationId.value, toSave)
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
    loading,
    loadConversations,
    createNew,
    select,
    rename,
    remove,
    saveCurrent,
    setCurrent,
  }
}
