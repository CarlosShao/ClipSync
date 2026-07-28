import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { decrypt } from '../utils/encryption.js'
import { buildUpstreamChat } from '../utils/aiProviders.js'
import { logger } from '../utils/logger.js'

const router = Router()

/**
 * 解析单个 SSE 事件块（以 \n\n 分隔的原始文本）为 { event, data }
 */
function parseSSEEvent(block) {
  let eventName
  const dataLines = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    } else if (line.startsWith(':')) {
      // SSE 注释行，忽略
      continue
    }
  }
  return { event: eventName, data: dataLines.join('\n') }
}

// POST /api/ai/chat - SSE 流式代理
// body: { providerId, messages: [{role, content}], options?: { maxTokens, temperature } }
router.post('/chat', apiLimiter, async (req, res) => {
  try {
    const { providerId, messages, options } = req.body || {}
    if (!providerId) return res.status(400).json({ error: 'providerId is required' })
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required' })
    }

    const result = await pool.query('SELECT * FROM ai_providers WHERE id = $1 AND user_id = $2', [providerId, req.userId])
    if (result.rowCount === 0) return res.status(404).json({ error: 'Provider not found' })
    const providerRow = result.rows[0]
    if (!providerRow.api_key_encrypted) return res.status(400).json({ error: 'Provider has no API key' })

    const apiKey = decrypt(providerRow.api_key_encrypted)
    const upstream = buildUpstreamChat({
      provider: providerRow.provider,
      baseUrl: providerRow.base_url,
      model: providerRow.model,
      apiKey,
      messages,
      options: options || {},
    })

    const upstreamRes = await fetch(upstream.url, {
      method: 'POST',
      headers: { ...upstream.headers, Accept: 'text/event-stream' },
      body: JSON.stringify(upstream.body),
    })

    if (!upstreamRes.ok || !upstreamRes.body) {
      const text = await upstreamRes.text().catch(() => '')
      return res.status(502).json({ error: 'Upstream error', status: upstreamRes.status, detail: text.slice(0, 800) })
    }

    // SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    const reader = upstreamRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finished = false

    const sendOpenAIDelta = (obj) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    }
    const finish = () => {
      if (finished) return
      finished = true
      res.write('data: [DONE]\n\n')
      res.end()
    }

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const ev = parseSSEEvent(rawEvent)
          if (!ev || !ev.data) continue

          if (upstream.family === 'anthropic') {
            if (ev.event === 'content_block_delta') {
              try {
                const parsed = JSON.parse(ev.data)
                const text = parsed?.delta?.text
                if (text) {
                  sendOpenAIDelta({ choices: [{ delta: { content: text }, index: 0 }] })
                }
              } catch {
                // 跳过无法解析的块
              }
            }
          } else {
            // OpenAI 兼容：ev.data 是上游 JSON 字符串，parse 成对象后再统一包装，避免 double-stringify
            if (ev.data === '[DONE]') continue
            try {
              const obj = JSON.parse(ev.data)
              sendOpenAIDelta(obj)
            } catch {
              // 极少数非 JSON 行，原样透传
              res.write(`data: ${ev.data}\n\n`)
            }
          }
        }
      }
      // 上游可能以非 \n\n 结尾，尝试 flush 剩余 buffer
      if (buffer.trim()) {
        try {
          const obj = JSON.parse(buffer.trim())
          sendOpenAIDelta(obj)
        } catch {
          /* ignore trailing incomplete chunk */
        }
      }
      finish()
    } catch (streamErr) {
      logger.error('AI chat stream error:', streamErr)
      if (!finished) {
        sendOpenAIDelta({ error: 'stream interrupted' })
        finish()
      }
    }
  } catch (err) {
    logger.error('AI chat proxy error:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI chat failed', detail: err.message })
    } else {
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }
})

export default router
