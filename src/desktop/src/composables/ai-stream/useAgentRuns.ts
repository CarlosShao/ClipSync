/**
 * AgentRunManager — 多代理并行模式运行状态管理
 *
 * 从 useAiChat.ts 的 streamChat 闭包内提取（ensureAgentRuns / upsertAgentRun /
 * getOrCreateAgentRun / settleAgentRuns / convergePlanning / 看门狗定时器）
 *
 * 暴露 useAgentRuns(deps) → { upsert, settle, converge, ensure, getOrCreate, startWatchdog }
 */

import type { AgentRun, AgentRunStatus, AgentRunKind } from '@/api/ai'

export interface AgentRunDeps {
  /** messages 引用（settle/converge 需要遍历全部消息） */
  messages: any
  /** 非响应式 map，记录每个 agent 的最后更新时间戳 */
  agentLastUpdateAt: Map<string, number>
}

export interface AgentRunHandle {
  /** 保证 assistantMsg.agentRuns 数组存在 */
  ensure: (assistantMsg: any) => AgentRun[]
  /** 根据 meta 增量创建或更新 agent run */
  upsert: (assistantMsg: any, a: { id: string; name: string; status: AgentRunStatus; kind?: AgentRunKind; error?: string | undefined }) => void
  /** 创建或获取 agent run（用于路由 to bucket） */
  getOrCreate: (assistantMsg: any, id: string) => AgentRun
  /** 流结束后收敛所有存活的 agent 卡片为终态 */
  settle: () => void
  /** 主答案已到达时收敛协调者卡片 */
  converge: () => void
  /** 启动子代理超时看门狗，返回 interval id（用于 stop） */
  startWatchdog: (assistantMsg: any) => number
  /** 停止看门狗定时器 */
  stopWatchdog: (id: number) => void
}

const TIMEOUT_PLANNING_MS = 120_000
const TIMEOUT_WORKING_MS = 60_000

export function useAgentRuns(deps: AgentRunDeps): AgentRunHandle {
  const { messages, agentLastUpdateAt } = deps

  function ensure(assistantMsg: any): AgentRun[] {
    if (!assistantMsg.agentRuns) assistantMsg.agentRuns = []
    return assistantMsg.agentRuns
  }

  function upsert(assistantMsg: any, a: { id: string; name: string; status: AgentRunStatus; kind?: AgentRunKind; error?: string | undefined }) {
    const runs = ensure(assistantMsg)
    let run = runs.find((r: AgentRun) => r.id === a.id) as AgentRun | undefined
    if (!run) {
      run = { id: a.id, name: a.name, status: a.status, kind: a.kind } as AgentRun
      runs.push(run)
    }
    run.name = a.name
    run.status = a.status
    if (a.kind) run.kind = a.kind
    agentLastUpdateAt.set(a.id, Date.now())
    if (a.error !== undefined) {
      run.status = 'failed'
      run.error = a.error
    }
  }

  function getOrCreate(assistantMsg: any, id: string): AgentRun {
    const runs = ensure(assistantMsg)
    let run = runs.find((r: AgentRun) => r.id === id)
    if (!run) {
      run = { id, name: id, status: 'working' }
      runs.push(run)
    }
    agentLastUpdateAt.set(id, Date.now())
    return run
  }

  function settle() {
    for (const m of messages.value) {
      if (m.role !== 'assistant' || !Array.isArray(m.agentRuns) || m.agentRuns.length === 0) continue
      for (const run of m.agentRuns) {
        if (run.status === 'planning' || run.status === 'working' || run.status === 'synthesis') {
          if (run.status === 'planning') {
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

  function converge() {
    for (const m of messages.value) {
      if (m.role !== 'assistant' || !Array.isArray(m.agentRuns) || m.agentRuns.length === 0) continue
      for (const run of m.agentRuns) {
        if (run.kind === 'coordinator' && run.status !== 'done' && run.status !== 'failed') {
          run.status = 'done'
        }
      }
    }
  }

  function startWatchdog(assistantMsg: any): number {
    return window.setInterval(() => {
      if (!Array.isArray(assistantMsg.agentRuns) || !assistantMsg.agentRuns.length) return
      const now = Date.now()
      for (const run of assistantMsg.agentRuns) {
        if (run.status !== 'planning' && run.status !== 'working' && run.status !== 'synthesis') continue
        const lastUpdate = agentLastUpdateAt.get(run.id) || 0
        if (!lastUpdate) continue
        const threshold = run.status === 'planning' ? TIMEOUT_PLANNING_MS : TIMEOUT_WORKING_MS
        if (now - lastUpdate > threshold) {
          console.warn(`[AgentRuns] agent ${run.id} timed out (>${threshold / 1000}s no update), auto-concluding`)
          run.status = run.content || run.thinking ? 'done' : 'failed'
          if (!run.error && !run.content && !run.thinking) {
            run.error = `agent timed out (no response for ${threshold / 1000}s)`
          }
        }
      }
    }, 5_000)
  }

  return { ensure, upsert, getOrCreate, settle, converge, startWatchdog, stopWatchdog: clearInterval }
}
