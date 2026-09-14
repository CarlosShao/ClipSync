import { Router } from 'express'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { decrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { runChatLoop } from './aiChatCore.js'
import { resolveUserProvider } from '../utils/aiRuntimeConfig.js'

const router = Router()

// POST /api/ai/inline - 单轮内联 AI（非流式、不建会话）：供桌面页内结果卡直接调用，
// 与 /summarize 同一套 runChatLoop 管线；不进侧栏消息流、不落会话用量
router.post('/', apiLimiter, async (req, res) => {
  try {
    const { providerId, prompt, context, maxTokens } = req.body || {}
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt is required' })

    const providerRow = await resolveUserProvider(req.userId, providerId)
    if (!providerRow) return res.status(404).json({ error: 'Provider not found' })
    if (!providerRow.api_key_encrypted) return res.status(400).json({ error: 'Provider has no API key' })

    const apiKey = decrypt(providerRow.api_key_encrypted)
    const MAX_INPUT = 24000
    const truncatedPrompt = prompt.slice(0, MAX_INPUT)
    const truncatedContext = typeof context === 'string' && context ? context.slice(0, MAX_INPUT) : ''
    const maxTokensClamped = Math.min(Math.max(Number(maxTokens) || 1024, 64), 4096)

    const messages = []
    if (truncatedContext) {
      messages.push({ role: 'system', content: `以下是本次任务的参考上下文：\n${truncatedContext}` })
    }
    messages.push({ role: 'user', content: truncatedPrompt })

    const { finalContent } = await runChatLoop({
      messages,
      options: { temperature: 0.4, max_tokens: maxTokensClamped },
      providerRow,
      apiKey,
      tools: [],
      userId: req.userId,
      sendDelta: () => {},
      role: 'user',
    })

    return res.json({ ok: true, text: (finalContent || '').trim() })
  } catch (err) {
    logger.error('[AI] inline error:', err)
    res.status(500).json({ ok: false, error: 'Inline AI failed', detail: err.message })
  }
})

export default router
