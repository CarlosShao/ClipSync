import { Router } from 'express'
import pool from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { decrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { runChatLoop } from './aiChatCore.js'
import { resolveUserProvider } from '../utils/aiRuntimeConfig.js'
import { buildAiFailure, providerPrecheckFailure } from '../utils/aiFailure.js'
// 统一取模型（契约：小功能也要吃模型级 enabled —— 主模型被停用就改用另一个已启用模型）
import { resolveEffectiveModel } from '../utils/aiModelSettings.js'

const router = Router()

// POST /api/ai/inline - 单轮内联 AI（非流式、不建会话）：供桌面页内结果卡直接调用，
// 与 /summarize 同一套 runChatLoop 管线；不进侧栏消息流、不落会话用量
router.post('/', apiLimiter, async (req, res) => {
  // catch 里也要用它构造失败响应（告知用户是哪个供应商出了问题），所以提到 try 外
  let providerRow = null
  try {
    const { providerId, prompt, context, maxTokens } = req.body || {}
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt is required' })

    providerRow = await resolveUserProvider(req.userId, providerId)
    if (!providerRow) {
      // 兜底：账号没有任何 is_default provider 时（resolveUserProvider 返回 null），
      // 取任一启用且有 key 的 provider——与侧栏聊天 loadProviders 的「无默认取第一个」同语义，
      // 页内结果卡不应因「没设默认」而整体不可用
      const { rows } = await pool.query(
        `SELECT * FROM ai_providers
         WHERE user_id = $1 AND enabled = TRUE AND api_key_encrypted IS NOT NULL
         ORDER BY created_at ASC LIMIT 1`,
        [req.userId]
      )
      providerRow = rows[0] || null
    }
    if (!providerRow) { const f = providerPrecheckFailure('no_provider'); return res.status(f.httpStatus).json(f.body) }
    if (!providerRow.api_key_encrypted) { const f = providerPrecheckFailure('no_key', providerRow); return res.status(f.httpStatus).json(f.body) }

    const apiKey = decrypt(providerRow.api_key_encrypted)
    // 统一取模型：主模型被停用（模型级 enabled=false）时改用另一个已启用模型
    const effModel = await resolveEffectiveModel({ userId: req.userId, providerId, providerRow })
    if (effModel?.model) providerRow.model = effModel.model
    const MAX_INPUT = 24000
    const truncatedPrompt = prompt.slice(0, MAX_INPUT)
    const truncatedContext = typeof context === 'string' && context ? context.slice(0, MAX_INPUT) : ''
    // 默认 4096（服务端钳制上限）：推理型 provider（step-3.7-flash 等）的思维链会消耗
    // max_tokens 预算，1024 时正文 content 会被吃空（诊断/审查类长输出实测复现）。
    const maxTokensClamped = Math.min(Math.max(Number(maxTokens) || 4096, 64), 4096)

    const messages = []
    if (truncatedContext) {
      messages.push({ role: 'system', content: `以下是本次任务的参考上下文：\n${truncatedContext}` })
    }
    messages.push({ role: 'user', content: truncatedPrompt })

    const { finalContent } = await runChatLoop({
      messages,
      // buildUpstreamChat 读 options.maxTokens（驼峰）；传 max_tokens 会被忽略并兜底 1024
      options: { temperature: 0.4, maxTokens: maxTokensClamped },
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
    const f = buildAiFailure(err, providerRow, 'Inline AI failed')
    res.status(f.httpStatus).json({ ok: false, ...f.body })
  }
})

export default router
