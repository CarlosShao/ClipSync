/**
 * 消息格式转换器：OpenAI 协议 ↔ Anthropic Messages 协议
 *
 * 两个协议的消息结构差异巨大，本模块负责在两者之间做无损转换。
 * 核心差异：
 * 1. 工具调用/回传的角色与格式不同
 *    - OpenAI:    { role:'assistant', content:'...', tool_calls:[{type:'function', function:{name, arguments}}] }
 *    - Anthropic: { role:'assistant', content:[{type:'text', text:'...'}, {type:'tool_use', id, name, input}] }
 *    - OpenAI:    { role:'tool', tool_call_id, content }
 *    - Anthropic: { role:'user', content:[{type:'tool_result', tool_use_id, content}] }
 * 2. content 字段：OpenAI 用字符串或简单块数组，Anthropic 必须用 block 数组
 * 3. system 消息：OpenAI 放在 messages 里，Anthropic 独立为 system 字段
 *
 * 设计原则：本模块不依赖任何 routes 层代码，避免循环依赖。
 */

/**
 * 将 OpenAI 格式的消息历史转换为 Anthropic Messages 协议格式。
 *
 * @param {Array} messages OpenAI 格式消息数组
 * @returns {Array} Anthropic Messages 协议格式消息数组（system 消息已过滤，由调用方单独处理）
 */
export function convertMessagesForAnthropic(messages) {
  if (!Array.isArray(messages)) return []
  const result = []
  // 暂存待合并的 tool_result（连续多个 tool_result 合并到一个 user 消息的 content 数组里）
  let pendingToolResults = null

  const flushPending = () => {
    if (pendingToolResults && pendingToolResults.length > 0) {
      result.push({
        role: 'user',
        content: pendingToolResults,
      })
      pendingToolResults = null
    }
  }

  for (const msg of messages) {
    if (!msg) continue
    const role = msg.role

    if (role === 'system') {
      // system 消息由 buildUpstreamChat 单独处理，跳过
      continue
    }

    if (role === 'tool') {
      // OpenAI tool 消息 → Anthropic tool_result block（挂到后续 user 消息里）
      if (!pendingToolResults) pendingToolResults = []
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: msg.tool_call_id || '',
        content: msg.content || '',
      })
      continue
    }

    // role === 'user' 或 'assistant'
    if (pendingToolResults) {
      flushPending()
    }

    if (role === 'assistant') {
      const blocks = []
      if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
        blocks.push({ type: 'text', text: msg.content })
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {}
          let input = {}
          try {
            input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments || {})
          } catch {
            input = { _raw: fn.arguments }
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id || '',
            name: fn.name || '',
            input,
          })
        }
      }
      if (blocks.length === 0) {
        blocks.push({ type: 'text', text: '' })
      }
      result.push({ role: 'assistant', content: blocks })
    } else if (role === 'user') {
      const blocks = []
      if (typeof msg.content === 'string') {
        blocks.push({ type: 'text', text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === 'string') {
            blocks.push({ type: 'text', text: part })
          } else if (part?.type === 'text') {
            blocks.push({ type: 'text', text: part.text || '' })
          } else if (part?.type === 'image_url') {
            // OpenAI 风格 data URL → Anthropic base64 source（仅支持内联 data URL）
            const url = part.image_url?.url || ''
            const m = url.match(/^data:([^;]+);base64,(.*)$/s)
            if (m) {
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: m[1] || 'image/png', data: m[2] },
              })
            }
            // 非 data URL 的远程图片 Anthropic 不支持，直接丢弃
          } else if (part?.type === 'image' && part.source?.type === 'base64') {
            // 兼容 normalizeVisionMessages 已产出的 {type:'image',source:{type:'base64',...}} 块，原样透传
            blocks.push({ type: 'image', source: part.source })
          }
        }
      }
      if (blocks.length === 0) {
        blocks.push({ type: 'text', text: '' })
      }
      result.push({ role: 'user', content: blocks })
    }
  }

  if (pendingToolResults) {
    flushPending()
  }

  return result
}