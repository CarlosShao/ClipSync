import { pool } from '../db/pool.js'
import { decrypt } from './encryption.js'
import { buildUpstreamChat, safeUpstreamFetch } from './aiProviders.js'
import logger from './logger.js'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const UPLOAD_BASE = path.join(__dirname, '../../uploads')

// 视觉能力快速判定：避免对纯文本模型白白跑 OCR（浪费 token 且必失败）
const VISION_LIKELY = /(vl|vision|4o|4v|4-turbo|gpt-4|claude|gemini|qwen-vl|qwen2?-vl|llava|qwq|o1|o3|o4|gpt-image|moondream|smolvlm|minicpm-v|pixtral|internvl)/i
// 明确不支持视觉的模型（省一次必失败的调用）
const TEXT_ONLY = /(embedding|tts|whisper|moderation|davinci|babbage|ada|instruct|text-.*-001|3\.5-turbo|gpt-3|reasoning-mini|reasoning)/i

export function providerSupportsVision(row) {
  if (!row) return false
  const provider = (row.provider || '').toLowerCase()
  const model = (row.model || '').toLowerCase()
  const s = `${provider} ${model}`
  if (TEXT_ONLY.test(model)) return false
  // 已知多模态家族（现代模型普遍支持视觉）放行
  if (/(openai|anthropic|gemini|claude|gpt|qwen|doubao|moonshot|deepseek|zhipu|kimi|minimax)/.test(provider)) return true
  // 本地/自定义 OpenAI 兼容端点：用户通常只配置视觉模型，放行
  if (/(ollama|local|lmstudio|vllm|compatible|custom|xai|grok)/.test(provider)) return true
  // 兜底：模型名含视觉关键词
  return VISION_LIKELY.test(s)
}

// 取用户「默认 / 第一个带密钥」且支持视觉的供应商；没有则回 null（OCR 静默跳过）
export async function getOcrProvider(userId) {
  const result = await pool.query(
    `SELECT * FROM ai_providers
     WHERE user_id = $1 AND api_key_encrypted IS NOT NULL AND api_key_encrypted <> ''
     ORDER BY is_default DESC, created_at ASC
     LIMIT 1`,
    [userId]
  )
  if (result.rowCount === 0) return null
  const row = result.rows[0]
  if (!providerSupportsVision(row)) return null
  return row
}

function parseVisionText(json, family) {
  try {
    if (family === 'anthropic') {
      const blocks = Array.isArray(json?.content) ? json.content : []
      return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
    }
    if (family === 'gemini') {
      const parts = json?.candidates?.[0]?.content?.parts || []
      return parts.map((p) => p.text || '').join('\n').trim()
    }
    return json?.choices?.[0]?.message?.content?.trim() || ''
  } catch {
    return ''
  }
}

// 调用视觉模型提取图片文字。dataUrl 可以是完整 data URL 或裸 base64（此时用 mime 补全）
export async function ocrImage({ providerRow, apiKey, dataUrl, mime = 'image/png' }) {
  const matches = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '')
  const imageUrl = matches ? dataUrl : `data:${mime};base64,${dataUrl}`

  const messages = [
    {
      role: 'system',
      content:
        'You are a precise OCR engine. Extract ALL text visible in the image, preserving line breaks and reading order. Return ONLY the extracted text — no commentary, no markdown code fences. If there is no text in the image, return an empty string.',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Extract the text shown in this image.' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    },
  ]

  const upstream = buildUpstreamChat({
    provider: providerRow.provider,
    baseUrl: providerRow.base_url,
    model: providerRow.model,
    apiKey,
    messages,
    options: { maxTokens: 2000, temperature: 0, stream: false },
  })

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30000)
  try {
    const res = await safeUpstreamFetch(upstream.url, {
      method: 'POST',
      headers: upstream.headers,
      body: JSON.stringify(upstream.body),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`OCR upstream ${res.status}: ${text.slice(0, 300)}`)
    }
    const json = await res.json()
    return parseVisionText(json, upstream.family)
  } finally {
    clearTimeout(timer)
  }
}

// 把图片字节（data URL / 裸 base64 / 磁盘文件名）解析为可被视觉模型消费的 data URL
export async function resolveImageDataUrl(contentEncrypted) {
  if (!contentEncrypted) return null
  if (contentEncrypted.startsWith('data:')) return contentEncrypted
  // 裸 base64：按 PNG 处理
  if (/^[A-Za-z0-9+/=]+$/.test(contentEncrypted.slice(0, 64))) {
    return `data:image/png;base64,${contentEncrypted}`
  }
  // 磁盘文件名（case B）：在 uploads 目录树里定位
  const name = contentEncrypted
  const dirs = [path.join(UPLOAD_BASE, 'images'), path.join(UPLOAD_BASE, 'files'), UPLOAD_BASE]
  for (const d of dirs) {
    const p = path.join(d, name)
    try {
      const buf = await fs.readFile(p)
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch {
      /* try next */
    }
  }
  return null
}

// 异步 OCR 并写入 ocr_text；任何失败（无供应商 / 无视觉 / 网络 / 超限）均静默跳过，绝不阻塞剪贴板写入
export async function runOcrForClip(clipId, userId, dataUrl) {
  const providerRow = await getOcrProvider(userId)
  if (!providerRow) {
    logger.info('[OCR] skip: no vision-capable provider configured', { userId, clipId })
    return
  }
  const apiKey = decrypt(providerRow.api_key_encrypted)
  try {
    const text = await ocrImage({ providerRow, apiKey, dataUrl })
    if (text) {
      await pool.query(
        'UPDATE clipboard_items SET ocr_text = $1 WHERE id = $2 AND user_id = $3',
        [text, clipId, userId]
      )
      logger.info('[OCR] extracted text for clip', { clipId, length: text.length })
    }
  } catch (err) {
    logger.warn('[OCR] failed (graceful skip):', { clipId, error: err.message })
  }
}

// 供 AI 工具按需 OCR 某条图片剪贴板
export async function ocrClipById(clipId, userId) {
  const result = await pool.query(
    'SELECT id, content_type, content_encrypted FROM clipboard_items WHERE id = $1 AND user_id = $2',
    [clipId, userId]
  )
  if (result.rowCount === 0) return { error: 'Clip not found' }
  const item = result.rows[0]
  if (item.content_type !== 'image') return { error: '该条目不是图片' }

  const dataUrl = await resolveImageDataUrl(item.content_encrypted)
  if (!dataUrl) return { error: '无法解析图片字节（既非内联 base64 也找不到磁盘文件）' }

  const providerRow = await getOcrProvider(userId)
  if (!providerRow) {
    return { error: '未配置支持视觉的 AI 供应商，无法 OCR。请在设置里添加一个视觉模型（如 GPT-4o / Claude / Gemini / Qwen-VL）。' }
  }
  const apiKey = decrypt(providerRow.api_key_encrypted)
  const text = await ocrImage({ providerRow, apiKey, dataUrl })
  if (text) {
    await pool.query('UPDATE clipboard_items SET ocr_text = $1 WHERE id = $2 AND user_id = $3', [text, clipId, userId])
  }
  return { clip_id: clipId, ocr_text: text, extracted: Boolean(text) }
}
