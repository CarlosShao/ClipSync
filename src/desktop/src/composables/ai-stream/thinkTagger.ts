/**
 * ThinkTagger — <think> / <Thought> 标签增量拆包器 + 多轮思考分段管理
 *
 * 从 useAiChat.ts 的 processThinkContent() / appendThinkingDelta() / sealThinkingSegment()
 * / sealAllThinkingSegments() 提取。
 *
 * 【边界单测思路】
 * 1. 流式边界：`processThinkContent('<think>')` 传入不完整开标签 → textDelta 应为 ''，inThink 应为 false
 *    预期通过：系统只接受完整的 <think> 或 <Thought> 开标签，拒绝除完整标签外的任何序列
 * 2. 流式边界：`processThinkContent('<think>abc', false)` → thinkingDelta=''，textDelta=''；再调用 `processThinkContent('</think>', false)` → thinkingDelta='abc'
 *    预期通过：增量更新 Never Lose 字符
 * 3. 流式收尾：`processThinkContent('<think>partial', true)` → thinkingDelta='partial'，textDelta=''
 *    预期通过：isFinal=true 时，即使找不到闭合标签也把剩余内容推入 thinkingDelta
 * 4. 多标签切换：`processThinkContent('<think>a</think>text<think>b')` → textDelta 含 'text'，并输出两次 thinking
 *    预期通过：同一段 delta 内可正确识别多次 标签开闭，不会漏段
 * 5. 混合标签：`processThinkContent('<think>a</think>text<Thought>b</Thought>c')` → 正确拆分 think/Thought 两段
 *    预期通过：两种标签类型无交叉混用，各自有对应的闭合标签
 */

const MAX_TAG_PREFIX_LEN = 12

type ThinkTag = '' | 'think' | 'Thought'

interface ThinkState {
  raw: string
  pos: number
  inThink: boolean
  currentTag: ThinkTag
}

const state: ThinkState = { raw: '', pos: 0, inThink: false, currentTag: '' }

export interface ThinkResult {
  textDelta: string
  thinkingDelta: string
}

export interface ThinkingSegment {
  id: string
  text: string
  startedAt: number
  closed: boolean
  isLive: boolean
  endedAt?: number
}

/**
 * 增量处理一段文本，分离出：
 *   - textDelta：标签外的正文（可直接显示给用户）
 *   - thinkingDelta：标签内的思考过程（可折叠展示）
 *
 * 函数是可重入的：连续调用同一实例会累积 raw buffer，
 * 因此需要确保每轮新的流之前调用 resetThinkState() 清空。
 */
export function processThinkContent(delta: string, flush = false): ThinkResult {
  state.raw += delta
  let textDelta = ''
  let thinkingDelta = ''

  while (true) {
    if (!state.inThink) {
      const thinkIdx = state.raw.indexOf('<think>', state.pos)
      const thoughtIdx = state.raw.indexOf('<Thought>', state.pos)

      let idx = -1
      let tag: ThinkTag = ''

      if (thinkIdx !== -1 && thoughtIdx !== -1) {
        if (thinkIdx <= thoughtIdx) { idx = thinkIdx; tag = 'think' }
        else { idx = thoughtIdx; tag = 'Thought' }
      } else if (thinkIdx !== -1) {
        idx = thinkIdx; tag = 'think'
      } else if (thoughtIdx !== -1) {
        idx = thoughtIdx; tag = 'Thought'
      }

      if (idx === -1) {
        const safeEnd = flush ? state.raw.length : Math.max(state.pos, state.raw.length - MAX_TAG_PREFIX_LEN)
        if (safeEnd > state.pos) {
          textDelta += state.raw.slice(state.pos, safeEnd)
          state.pos = safeEnd
        }
        break
      }

      textDelta += state.raw.slice(state.pos, idx)
      state.pos = idx + (tag === 'think' ? 7 : 10)
      state.inThink = true
      state.currentTag = tag
    } else {
      const closeTag: string = state.currentTag === 'think' ? '</think>' : '</Thought>'
      const idx = state.raw.indexOf(closeTag, state.pos)

      if (idx === -1) {
        const safeEnd = flush ? state.raw.length : Math.max(state.pos, state.raw.length - MAX_TAG_PREFIX_LEN)
        if (safeEnd > state.pos) {
          thinkingDelta += state.raw.slice(state.pos, safeEnd)
          state.pos = safeEnd
        }
        break
      }

      thinkingDelta += state.raw.slice(state.pos, idx)
      state.pos = idx + closeTag.length
      state.inThink = false
      state.currentTag = ''
    }
  }

  return { textDelta, thinkingDelta }
}

/** 每轮流开始前重置状态，防止上一轮残留渗透 */
export function resetThinkState() {
  state.raw = ''
  state.pos = 0
  state.inThink = false
  state.currentTag = ''
}

// ===== 多轮思考分段管理（解决"调工具前的思考"与"工具执行/拒绝后的思考"混在一段） =====

/** 往 bucket 追加一段 thinking 增量，维护 thinkingSegments 多段列表 */
export function appendThinkingDelta(bucket: any, delta: string, startedAtNow: number) {
  if (!delta) return
  bucket.thinking = (bucket.thinking || '') + delta
  if (!bucket.thinkingSegments) bucket.thinkingSegments = []
  const segs: ThinkingSegment[] = bucket.thinkingSegments
  const last = segs[segs.length - 1]
  if (last && last.closed !== true) {
    last.text += delta
    last.isLive = true
  } else {
    segs.push({
      id: 'think-seg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      text: delta, startedAt: startedAtNow, closed: false, isLive: true,
    })
  }
  bucket.thinkingStartedAt ??= startedAtNow
  bucket.thinkingActive = true
}

/** 封段：把当前活跃的思考段标记为 closed，后续 thinking 开新段 */
export function sealThinkingSegment(bucket: any) {
  if (!bucket || !bucket.thinkingSegments || bucket.thinkingSegments.length === 0) return
  const segs: ThinkingSegment[] = bucket.thinkingSegments
  const last = segs[segs.length - 1]
  if (last && last.closed !== true) {
    last.closed = true; last.isLive = false
    if (!last.endedAt) last.endedAt = Date.now()
  }
}

/** 对消息及其所有 agent run 统一封段（流结束 / 出错时兜底） */
export function sealAllThinkingSegments(msg: any) {
  sealThinkingSegment(msg)
  if (msg.thinkingSegments) {
    for (const seg of msg.thinkingSegments) { if (seg.closed !== true) { seg.closed = true; seg.isLive = false; if (!seg.endedAt) seg.endedAt = Date.now() } }
  }
  for (const run of msg.agentRuns || []) {
    sealThinkingSegment(run)
    if (run.thinkingSegments) {
      for (const seg of run.thinkingSegments) { if (seg.closed !== true) { seg.closed = true; seg.isLive = false; if (!seg.endedAt) seg.endedAt = Date.now() } }
    }
  }
}
