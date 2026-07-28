import { ref, shallowRef, computed } from 'vue'
import { getProviders, streamChat } from '@/api/ai'
import type { AiProvider, ChatMessage } from '@/api/ai'
import { useClipboard } from '@/composables/useClipboard'

// ClipSync 产品上下文提示词
function buildSystemPrompt(clipboardData?: string) {
  return `You are ClipSync AI, an intelligent assistant integrated into the ClipSync clipboard synchronization application.

## About ClipSync
ClipSync is a cross-device clipboard synchronization tool that allows users to:
- Sync clipboard content (text, images, files) across multiple devices
- Organize clips with favorites, tags, and collections
- Preview various file formats (Markdown, Word, Excel, PDF, code)
- Share clips via links
- Protect sensitive content with passwords and PIN
- Use templates for quick pasting
- Manage multiple devices

## Your Capabilities
As ClipSync AI, you can:
- Answer questions about the user's clipboard data
- Help organize and categorize clips
- Suggest ways to use templates
- Provide insights about clipboard usage patterns
- Help with file format conversions
- Assist with device management

${clipboardData ? `## Current Clipboard Data\nThe user currently has the following clipboard data:\n${clipboardData}` : ''}

## Current Context
The user is currently using ClipSync desktop app. You have access to their clipboard data and can help them manage it effectively.
Always respond in the user's language. Be helpful, concise, and focused on clipboard management tasks.`
}

interface SendOptions {
  mode?: 'ask' | 'agent'
  thinking?: boolean
  thinkingStrength?: 'low' | 'medium' | 'high'
}

export function useAiChat() {
  const providers = ref<AiProvider[]>([])
  const selectedProviderId = ref<string>('')
  const messages = ref<ChatMessage[]>([])
  const isStreaming = ref(false)
  const error = ref('')
  const abortCtrl = shallowRef<AbortController | null>(null)
  const initialized = ref(false)

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
    await loadProviders()
  }

  function selectProvider(id: string) {
    selectedProviderId.value = id
  }

  function lastAssistant() {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].role === 'assistant') return messages.value[i]
    }
    return null
  }

  async function send(content: string, options: SendOptions = {}) {
    const text = content.trim()
    if (!text || isStreaming.value) return
    if (!selectedProviderId.value) {
      error.value = 'ai_no_provider_selected'
      return
    }
    error.value = ''
    messages.value.push({ role: 'user', content: text })
    // 创建 assistant 消息，包含 thinking 字段
    const assistantMsg: ChatMessage = { role: 'assistant', content: '', thinking: '' }
    messages.value.push(assistantMsg)
    isStreaming.value = true

    const controller = new AbortController()
    abortCtrl.value = controller

    // 获取更多实时数据注入系统提示词
    let clipboardData = ''
    try {
      const clip = useClipboard()
      const total = clip.mainTotalItems.value || 0
      const items = clip.items.value || []
      const textCount = items.filter((i: any) => i.type === 'text').length
      const imageCount = items.filter((i: any) => i.type === 'image').length
      const fileCount = items.filter((i: any) => i.type === 'file').length
      const linkCount = items.filter((i: any) => i.type === 'link').length
      
      // 获取最近的 5 条记录内容预览
      const recentItems = items.slice(0, 5).map((i: any) => {
        const preview = (i.content || '').slice(0, 100)
        return `- [${i.type}] ${preview}${preview.length >= 100 ? '...' : ''}`
      }).join('\n')
      
      // 获取当前选中的条目
      const selectedItems = items.filter((i: any) => i.selected).map((i: any) => i.id)
      
      // 获取收藏夹数据
      const favorites = items.filter((i: any) => i.isFavorite).length
      
      clipboardData = `Total clips: ${total}
Breakdown: ${textCount} text, ${imageCount} images, ${fileCount} files, ${linkCount} links
Favorites: ${favorites}
Selected items: ${selectedItems.length > 0 ? selectedItems.join(', ') : 'none'}
Recent items:
${recentItems || '(empty)'}

You can help the user manage these clips, answer questions about them, or perform actions like organizing, searching, or analyzing patterns.`
    } catch {
      /* ignore */
    }

    const systemPrompt = buildSystemPrompt(clipboardData)
    const history: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages.value.slice(0, -1)
    ]
    
    // 如果启用思考模式，添加思考指令
    if (options.thinking) {
      const strengthMap = {
        low: 'Think step by step briefly.',
        medium: 'Think step by step with moderate detail.',
        high: 'Think step by step with thorough analysis.'
      }
      history[0].content += `\n\n${strengthMap[options.thinkingStrength || 'medium']}`
    }

    // Agent 模式：添加工作流指令
    if (options.mode === 'agent') {
      history[0].content += `\n\nYou are in Agent mode. When the user asks you to perform actions, describe the workflow steps clearly. Use structured output with numbered steps.`
    }

    try {
      await streamChat({
        providerId: selectedProviderId.value,
        messages: history,
        signal: controller.signal,
        onDelta: (d, thinking?: string, toolCall?: any, toolResult?: any) => {
          // 处理 thinking 内容
          if (thinking) {
            assistantMsg.thinking = (assistantMsg.thinking || '') + thinking
          }
          // 处理工具调用
          if (toolCall) {
            if (!assistantMsg.toolCalls) assistantMsg.toolCalls = []
            assistantMsg.toolCalls.push(toolCall)
          }
          // 处理工具结果
          if (toolResult) {
            if (!assistantMsg.toolResults) assistantMsg.toolResults = []
            assistantMsg.toolResults.push(toolResult)
          }
          // 处理普通内容
          if (d) {
            assistantMsg.content += d
          }
        },
        onError: (msg) => {
          error.value = msg
          const last = lastAssistant()
          if (last && last.role === 'assistant') {
            last.content += `\n[${msg}]`
          }
        },
        onDone: () => {
          /* no-op */
        },
      })
    } catch (e: any) {
      error.value = String(e?.message || e)
    } finally {
      isStreaming.value = false
      abortCtrl.value = null
    }
  }

  function stop() {
    abortCtrl.value?.abort()
  }

  function clear() {
    if (isStreaming.value) stop()
    messages.value = []
    error.value = ''
  }

  return {
    providers,
    selectedProviderId,
    messages,
    isStreaming,
    error,
    hasProviders,
    canSend,
    init,
    loadProviders,
    selectProvider,
    send,
    stop,
    clear,
  }
}
