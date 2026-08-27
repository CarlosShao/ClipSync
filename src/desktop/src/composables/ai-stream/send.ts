import type { Ref } from 'vue'
import type { ChatMessage, StreamDeltaMeta } from '@/api/ai'
import { streamChat, approveToolAction } from '@/api/ai'
import {
  processThinkContent, appendThinkingDelta, sealThinkingSegment, sealAllThinkingSegments,
} from './thinkTagger'
import { appendTextDelta, flushTextBuffer, flushAllTextBuffers, markThinkingHeartbeat } from './textBuffer'
import { useAgentRuns } from './useAgentRuns'
import { triggerRefreshAfterTool } from '@/composables/useAiDataRefresh'

interface SendOptions {
  mode?: 'ask' | 'agent'
  thinking?: boolean
  thinkingStrength?: 'low' | 'medium' | 'high'
  images?: any[]
  viewContext?: string
  quickAction?: 'summarize' | 'translate' | 'format' | 'explain' | 'optimize'
}

export interface SendStreamParams {
  messages: Ref<ChatMessage[]>
  isStreaming: Ref<boolean>
  streamLastActivityAt: Ref<number>
  error: Ref<string>
  contextUsage: Ref<any>
  duplicateImageNotice: Ref<any>
  compressProgress: Ref<any>
  pendingConfirm: Ref<any>
  sessionAllowedTools: Ref<Set<string>>
  sessionAlwaysAllowAll: Ref<boolean>
  approving: Ref<boolean>
  abortCtrl: Ref<AbortController | null>
  options: SendOptions
  selectedProviderId: string
  selectedProviderModel: string
  conversationId: string
  thisConversationId: string
  assistantMsg: any
  agentLastUpdateAt: Map<string, number>
  isFirstMessageInNewConv: boolean
  nativeReasoning: boolean
  ownsStream: () => boolean
  setCompressProgress: (p: any) => void
  saveCurrent: (msgs: any) => void
  renameConversation: (id: string, title: string) => void
}

type DeltaHandler = (d: string, thinkingNative?: string, toolCall?: any, toolResult?: any, meta?: StreamDeltaMeta) => void

function buildDeltaHandler(inp: SendStreamParams, agentMgr: ReturnType<typeof useAgentRuns>, controller: AbortController): DeltaHandler {
  return (d, thinkingNative, toolCall, toolResult, meta) => {
    const { messages, isStreaming, streamLastActivityAt, contextUsage, duplicateImageNotice, compressProgress,
      pendingConfirm, sessionAllowedTools, sessionAlwaysAllowAll, approving, ownsStream, setCompressProgress } = inp
    streamLastActivityAt.value = Date.now()
    if (!ownsStream()) return

    if (meta?.usage) {
      const u = meta.usage
      const pct = u.contextWindow > 0 ? Math.min(100, Math.max(0, Math.round((u.totalTokens / u.contextWindow) * 100))) : 0
      contextUsage.value = { ...u, percent: pct }
    }

    if (Array.isArray(inp.assistantMsg.agentRuns)) {
      const now = Date.now()
      for (const r of inp.assistantMsg.agentRuns) {
        if (r.status === 'planning' || r.status === 'working' || r.status === 'synthesis')
          inp.agentLastUpdateAt.set(r.id, now)
      }
    }

    if (meta?.agent) agentMgr.upsert(inp.assistantMsg, meta.agent)
    const mm = meta as any

    if (mm?.type === 'duplicate_image') {
      duplicateImageNotice.value = { imageHash: mm.imageHash, existingId: mm.existingId, createdAt: mm.createdAt, preview: mm.preview }
    }

    if (mm?.type === 'confirm_tool_action') {
      if (sessionAlwaysAllowAll.value || (mm.tool && sessionAllowedTools.value.has(mm.tool))) {
        approveToolAction(mm.requestId, true).catch(() => {})
        return
      }
      pendingConfirm.value = { requestId: mm.requestId, tool: mm.tool, argsSummary: mm.argsSummary, impact: mm.impact }
      approving.value = false
    }

    if (mm?.type === 'context_compress_started') setCompressProgress({ status: 'compressing', source: 'auto' })
    if (mm?.type === 'context_compressed') {
      setCompressProgress({ status: 'done', source: 'auto', removedMessages: mm.removedMessages || 0, savedTokens: (mm.beforeTokens || 0) - (mm.afterTokens || 0) })
    }

    const bucket = mm?.agentId ? agentMgr.getOrCreate(inp.assistantMsg, mm.agentId) : null

    if (mm?.type === 'ask_user_action' && mm.requestId) {
      const ab = bucket || inp.assistantMsg
      if (!(ab.toolCalls || []).some((tc: any) => tc.id === mm.requestId)) {
        ab.thinkingActive = false
        sealThinkingSegment(ab)
        flushTextBuffer(ab)
        if (!ab.toolCalls) ab.toolCalls = []
        ab.toolCalls.push({ id: mm.requestId, name: 'ask_user', arguments: JSON.stringify({ questions: Array.isArray(mm.questions) ? mm.questions : [], context: mm.context || '' }), segIndex: Math.max(0, (ab.thinkingSegments?.length || 1) - 1) } as any)
      }
    }

    if (thinkingNative) {
      const tb = bucket || inp.assistantMsg
      if (tb.thinkingActive === false) { tb.thinkingActive = true; tb.thinkingStartedAt = Date.now() }
      appendThinkingDelta(tb, thinkingNative, Date.now())
      markThinkingHeartbeat(tb)
    }

    if (d) {
      const res = processThinkContent(d)
      const tb = bucket || inp.assistantMsg
      appendTextDelta(tb, res.textDelta)
      if (res.thinkingDelta && !inp.nativeReasoning) {
        if (tb.thinkingActive === false) { tb.thinkingActive = true; tb.thinkingStartedAt = Date.now() }
        appendThinkingDelta(tb, res.thinkingDelta, Date.now())
        markThinkingHeartbeat(tb)
      }
    }

    if (toolCall) {
      const tb = bucket || inp.assistantMsg
      tb.thinkingActive = false
      sealThinkingSegment(tb)
      flushTextBuffer(tb)
      if (!tb.toolCalls) tb.toolCalls = []
      const curSeg = Math.max(0, (tb.thinkingSegments?.length || 1) - 1)
      const tc = { ...toolCall, segIndex: (toolCall as any).segIndex ?? curSeg }
      const existing = tb.toolCalls.find((x: any) => x.id === toolCall.id)
      if (existing) { existing.arguments = (existing.arguments || '') + (toolCall.arguments || ''); if ((existing as any).segIndex === undefined) (existing as any).segIndex = curSeg }
      else tb.toolCalls.push(tc)
    }

    if (toolResult) {
      const tb = bucket || inp.assistantMsg
      sealThinkingSegment(tb)
      if (!tb.toolResults) tb.toolResults = []
      const existing = tb.toolResults.find((tr: any) => tr.tool_call_id === toolResult.tool_call_id)
      if (existing) { existing.content = (existing.content || '') + (toolResult.content || '') }
      else tb.toolResults.push(toolResult)

      const toolName = toolResult.name || tb.toolCalls?.find((tc: any) => tc.id === toolResult.tool_call_id)?.name
      if (toolName) {
        setTimeout(() => {
          triggerRefreshAfterTool(toolName, toolResult.content)
          if (['create_collection', 'create_sub_collection'].includes(toolName)) {
            window.dispatchEvent(new CustomEvent('clipsync:collections-updated', { detail: { reason: 'ai-tool', tool: toolName } }))
          }
        }, 300)
      }
    }
  }
}

function buildHistory(messages: any[]): any[] {
  const out: any[] = []
  for (const m of messages.slice(0, -1)) {
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      out.push({ role: 'assistant', content: m.content || '', tool_calls: m.toolCalls.map((tc: any) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments || '' } })) })
      for (const tr of m.toolResults || []) out.push({ role: 'tool', content: tr.content, tool_call_id: tr.tool_call_id })
    } else if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content || '' }, ...m.images.map((img: any) => ({ type: 'image_url', image_url: { url: img.data } }))], imageHash: m.images[0]?.hash })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

export async function runStream(inp: SendStreamParams) {
  const agentMgr = useAgentRuns({ messages: inp.messages, agentLastUpdateAt: inp.agentLastUpdateAt })
  const onDelta = buildDeltaHandler(inp, agentMgr, new AbortController())
  const historyMessages = buildHistory(inp.messages.value)

  const controller = new AbortController()
  inp.abortCtrl.value = controller
  let lastActivityAt = Date.now()
  const silenceWatchdog = setInterval(() => {
    if (Date.now() - lastActivityAt > 200_000) { console.warn('[useAiChat] stream silent >200s'); controller.abort() }
  }, 10_000)
  const agentTimeoutWatchdog = agentMgr.startWatchdog(inp.assistantMsg)
  let streamInterrupted = false

  try {
    await streamChat({
      providerId: inp.selectedProviderId,
      messages: historyMessages,
      options: { mode: inp.options.mode, thinking: inp.options.thinking, thinkingStrength: inp.options.thinkingStrength, model: inp.selectedProviderModel, conversationId: inp.conversationId },
      signal: controller.signal,
      onDelta,
      onError: (msg) => {
        if (!inp.ownsStream()) return
        inp.error.value = msg
        const last = inp.messages.value[inp.messages.value.length - 1]
        if (last?.role === 'assistant') { last.isError = true; last.thinkingActive = false; for (const r of last.agentRuns || []) r.thinkingActive = false }
        sealAllThinkingSegments(inp.assistantMsg)
        flushAllTextBuffers(inp.assistantMsg, sealThinkingSegment)
      },
      onInterrupt: () => { streamInterrupted = true },
      onDone: () => {
        const rem = processThinkContent('', true)
        if (rem.textDelta) appendTextDelta(inp.assistantMsg, rem.textDelta)
        if (rem.thinkingDelta && !inp.nativeReasoning) { appendThinkingDelta(inp.assistantMsg, rem.thinkingDelta, Date.now()); markThinkingHeartbeat(inp.assistantMsg) }
        inp.assistantMsg.thinkingActive = false
        for (const run of inp.assistantMsg.agentRuns || []) run.thinkingActive = false
        sealAllThinkingSegments(inp.assistantMsg)
        flushAllTextBuffers(inp.assistantMsg, sealThinkingSegment)
        if (inp.ownsStream()) agentMgr.converge()
      },
    })
  } catch (e: any) {
    if (inp.ownsStream()) { inp.error.value = String(e?.message || e); const last = inp.messages.value[inp.messages.value.length - 1]; if (last?.role === 'assistant') last.isError = true }
    flushAllTextBuffers(inp.assistantMsg, sealThinkingSegment)
  } finally {
    clearInterval(silenceWatchdog)
    agentMgr.stopWatchdog(agentTimeoutWatchdog)
    flushAllTextBuffers(inp.assistantMsg, sealThinkingSegment)
    inp.isStreaming.value = false
    inp.streamLastActivityAt.value = 0
    inp.abortCtrl.value = null
    if (streamInterrupted) inp.assistantMsg.interrupted = true
    if (inp.ownsStream()) {
      agentMgr.settle()
      inp.pendingConfirm.value = null
      inp.approving.value = false
      inp.saveCurrent(inp.messages.value)
      if (inp.isFirstMessageInNewConv) {
        const userMsg = inp.messages.value.find((m: any) => m.role === 'user')
        if (userMsg?.content) inp.renameConversation(inp.conversationId, userMsg.content.replace(/[\u2404].*?[\u2404]/g, '').trim().slice(0, 20) || '新对话')
      }
    }
  }
}
