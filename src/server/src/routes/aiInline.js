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
// 契约 v6：X-UI-Locale → 生成内容的语言（页内结果卡的每个变体都走这里）
// + languageOverride：**目标语言固定**的变体（如详情抽屉「提取并翻译为英文」）显式 opt-out
import {
  resolveRequestLocale,
  resolveEffectiveLocale,
  languageDirective,
  inlineContextSystemPrompt,
  appendTrailingLanguageRequirement,
} from '../utils/aiLocale.js'

const router = Router()

// POST /api/ai/inline - 单轮内联 AI（非流式、不建会话）：供桌面页内结果卡直接调用，
// 与 /summarize 同一套 runChatLoop 管线；不进侧栏消息流、不落会话用量
router.post('/', apiLimiter, async (req, res) => {
  // catch 里也要用它构造失败响应（告知用户是哪个供应商出了问题），所以提到 try 外
  let providerRow = null
  try {
    const { providerId, prompt, context, maxTokens, languageOverride } = req.body || {}
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
    // 语言：界面语言（X-UI-Locale）× 可选 languageOverride（**只本路由支持**）。
    // 「目标语言固定」的变体（详情抽屉 drawerTranslate=提取并翻译为英文）会带 languageOverride:'en'
    // ⇒ 中文界面下也按英文要求作答（否则末尾会出现"只允许用简体中文回答"与翻译功能直接冲突）。
    // 非法/缺省值静默回落到界面语言（不 400，见 utils/aiLocale.normalizeLanguageOverride 注释）。
    // ⚠️ 生效语言**一个值贯穿全请求**（最前 system 段 / 上下文标签 / 末尾强化 / runChatLoop）：
    //    避免"最前说中文、末尾说英文"的自相矛盾。
    const effectiveLocale = resolveEffectiveLocale(resolveRequestLocale(req), languageOverride)
    const MAX_INPUT = 24000
    const truncatedPrompt = prompt.slice(0, MAX_INPUT)
    const truncatedContext = typeof context === 'string' && context ? context.slice(0, MAX_INPUT) : ''
    // 默认 4096（服务端钳制上限）：推理型 provider（step-3.7-flash 等）的思维链会消耗
    // max_tokens 预算，1024 时正文 content 会被吃空（诊断/审查类长输出实测复现）。
    const maxTokensClamped = Math.min(Math.max(Number(maxTokens) || 4096, 64), 4096)

    const messages = []
    // 契约 v6：语言要求**同时**放两处（缺一不可）：
    //   ① 最前的 system 段：全局语境（模型一开始就知道要说什么语言）；
    //   ② **最后一条 user 内容的末尾**（见下方 appendTrailingLanguageRequirement）：
    //      位置最权威 —— 用户实测"英文界面页内小功能仍输出中文"就是因为原来只在最前放了指令，
    //      被后面的大段中文 prompt 压住。要求必须紧贴模型开始生成的位置。
    // /inline 的各个"变体"（AI 诊断同步 / 审查设置 / 总结今日 / AI 整理收藏 / 生成模板 /
    // 收藏摘要 / 详情抽屉…）都由桌面端拼 prompt 文本，服务端看不到变体名；两处约束统一生效 ⇒
    // 逐个变体都被覆盖（无需按变体分支）。
    messages.push({ role: 'system', content: languageDirective(effectiveLocale).trim() })
    if (truncatedContext) {
      messages.push({ role: 'system', content: inlineContextSystemPrompt(effectiveLocale, truncatedContext) })
    }
    messages.push({ role: 'user', content: truncatedPrompt })
    // ⚠️ 末尾强化：追加到最后一条 user 消息末尾（三种协议下都真正位于最后）
    appendTrailingLanguageRequirement(messages, effectiveLocale)

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
      locale: effectiveLocale,
    })

    return res.json({ ok: true, text: (finalContent || '').trim() })
  } catch (err) {
    logger.error('[AI] inline error:', err)
    const f = buildAiFailure(err, providerRow, 'Inline AI failed')
    res.status(f.httpStatus).json({ ok: false, ...f.body })
  }
})

export default router
