// === 页内内联 AI（不进侧栏消息流）：一次性调用 /api/ai/inline，统一 loading/结果/错误/取消 ===
import { ref } from 'vue'
import { inlineChat } from '@/api/ai'

export type InlineAiStatus = 'idle' | 'loading' | 'done' | 'error'

export function useInlineAi() {
  const status = ref<InlineAiStatus>('idle')
  // text：完整正文（复制/「在助手中继续」用）；displayText：打字机逐字追加的展示值
  const text = ref('')
  const displayText = ref('')
  const streaming = ref(false)
  const error = ref('')

  // api() 会把 AbortError 吞成 { ok:false }，用序号守卫：只有最新一次调用允许写状态
  let seq = 0
  let controller: AbortController | null = null
  let typeTimer: ReturnType<typeof setInterval> | null = null

  // 打字机节奏：每 24ms 追加一块，长度按剩余量自适应（短文本快、长文本不拖）
  const TYPE_INTERVAL_MS = 24

  function stopTyping() {
    if (typeTimer !== null) {
      clearInterval(typeTimer)
      typeTimer = null
    }
  }

  // run() 的返回 promise 在打字机播完（或被取代/取消）后 resolve，
  // 使「run().then(…done 后解析…)」类调用仍在终态触发。
  let typingResolve: (() => void) | null = null
  function resolveTyping() {
    typingResolve?.()
    typingResolve = null
  }

  /** 完整文本到手后启动打字机；播完后落 status=done（文本为空时转 error） */
  function startTyping(my: number, full: string): Promise<void> {
    stopTyping()
    // status 保持 loading（四态契约不变：JSON 解析类消费者只认 done 才渲染结果，
    // 打字机期间它们继续显示各自的 loading 态，无需改模板）；流式用 streaming 表达
    streaming.value = true
    displayText.value = ''
    let i = 0
    return new Promise<void>((resolve) => {
      typingResolve = resolve
      typeTimer = setInterval(() => {
        if (my !== seq) {
          stopTyping()
          resolveTyping()
          return
        }
        const remain = full.length - i
        if (remain <= 0) {
          stopTyping()
          streaming.value = false
          status.value = 'done'
          resolveTyping()
          return
        }
        // 步长自适应：剩余越多单步越大，保证总时长收敛到合理范围
        const step = remain > 800 ? 12 : remain > 300 ? 6 : 2
        i += step
        displayText.value = full.slice(0, i)
      }, TYPE_INTERVAL_MS)
    })
  }

  /** 发起内联 AI 调用；重复调用会取消前一次 */
  async function run(prompt: string, context?: string, opts?: { maxTokens?: number }) {
    const my = ++seq
    controller?.abort()
    controller = new AbortController()
    stopTyping()
    status.value = 'loading'
    text.value = ''
    displayText.value = ''
    streaming.value = false
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
        await startTyping(my, res.data.text)
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
    stopTyping()
    resolveTyping()
    status.value = 'idle'
    text.value = ''
    displayText.value = ''
    streaming.value = false
    error.value = ''
  }

  return { status, text, displayText, streaming, error, run, reset }
}
