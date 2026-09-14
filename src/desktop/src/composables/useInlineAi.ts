// === 页内内联 AI（不进侧栏消息流）：一次性调用 /api/ai/inline，统一 loading/结果/错误/取消 ===
import { ref } from 'vue'
import { inlineChat } from '@/api/ai'

export type InlineAiStatus = 'idle' | 'loading' | 'done' | 'error'

export function useInlineAi() {
  const status = ref<InlineAiStatus>('idle')
  const text = ref('')
  const error = ref('')

  // api() 会把 AbortError 吞成 { ok:false }，用序号守卫：只有最新一次调用允许写状态
  let seq = 0
  let controller: AbortController | null = null

  /** 发起内联 AI 调用；重复调用会取消前一次 */
  async function run(prompt: string, context?: string, opts?: { maxTokens?: number }) {
    const my = ++seq
    controller?.abort()
    controller = new AbortController()
    status.value = 'loading'
    text.value = ''
    error.value = ''
    try {
      const res = await inlineChat(prompt, context, controller.signal, opts?.maxTokens)
      if (my !== seq) return
      if (res.ok && typeof res.data?.text === 'string') {
        // 防御：done 但正文为空（推理型 provider 预算耗尽等）→ 转错误态，不出白卡
        if (!res.data.text.trim()) {
          error.value = 'inline_ai_empty'
          status.value = 'error'
          return
        }
        text.value = res.data.text
        status.value = 'done'
      } else {
        error.value = res.data?.error || res.error || 'inline_ai_failed'
        status.value = 'error'
      }
    } catch (e: any) {
      if (my !== seq) return
      error.value = String(e?.message || 'inline_ai_failed')
      status.value = 'error'
    }
  }

  function reset() {
    seq++
    controller?.abort()
    controller = null
    status.value = 'idle'
    text.value = ''
    error.value = ''
  }

  return { status, text, error, run, reset }
}
