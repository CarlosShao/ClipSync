import { ref, shallowRef, computed } from 'vue'
import { getProviders, streamChat } from '@/api/ai'
import type { AiProvider, ChatMessage } from '@/api/ai'

/**
 * AI 聊天状态机 composable。
 * - 负责加载当前用户的供应商列表并默认选中（default 优先）。
 * - send() 把用户消息入栈、追加空 assistant 占位、调用流式接口逐字回填。
 * - stop() 通过 AbortController 中断当前流。
 */
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
    const arr = messages.value
    return arr[arr.length - 1]
  }

  async function send(content: string) {
    const text = content.trim()
    if (!text || isStreaming.value) return
    if (!selectedProviderId.value) {
      error.value = 'ai_no_provider_selected'
      return
    }
    error.value = ''
    messages.value.push({ role: 'user', content: text })
    messages.value.push({ role: 'assistant', content: '' })
    isStreaming.value = true

    const controller = new AbortController()
    abortCtrl.value = controller
    const history = messages.value.slice(0, -1) // 不含空 assistant 占位

    try {
      await streamChat({
        providerId: selectedProviderId.value,
        messages: history,
        signal: controller.signal,
        onDelta: (d) => {
          const last = lastAssistant()
          if (last && last.role === 'assistant') last.content += d
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
