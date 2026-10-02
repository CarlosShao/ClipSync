/**
 * 按模型配置 API（需求：模型不只有名字 —— 上下文窗口 / 最大输出 / 多模态能力
 * （文本·识图·视频·音频分开配置）/ 推理协议，全部按模型配置且可改）。
 *
 *    GET /api/ai/model-settings?providerId=<uuid>
 *      → 200 { items: [ { model, contextWindow, maxOutput, supportsText, supportsImage,
 *                         supportsVideo, supportsAudio, reasoningEnabled, reasoningProtocol,
 *                         isPreset, isOverridden } ] }
 *      模型集合 = ai_providers.model + ai_providers.models(刷新得到) + ai_settings.selected_models
 *                + 已有覆盖行（用户改过的不因刷新而消失）；
 *      每项 = 内置预设（utils/modelPresets.js）← 用户覆盖行（覆盖优先）；
 *      **无覆盖行时也返回预设值**（isPreset=true, isOverridden=false）。
 *      ⚠️ 契约 v2：**不再返回 reasoningLevels**（用户要求「不用管映射，把思考强度映射
 *      那个配置去掉」）。思考等级（low|medium|high|xhigh|max）经 /api/ai/settings 的
 *      thinkingStrength 全局原样下发，不再有按模型的等级映射。
 *
 *    PUT /api/ai/model-settings
 *      body { providerId, model, patch: { …上面各字段 } }
 *      → 200 { ok: true, item: {…同上} }
 *      写入策略：把「预设 ← 已有覆盖 ← patch」的**完整生效值**整体落库（见迁移 081 注释），
 *      避免只写单列时其余 NOT NULL 列吃到 DEFAULT（例如只想改 context_window 却把
 *      reasoning_enabled 静默变 FALSE，杀掉 claude 系思考强度）。
 *      patch 字段显式传 null = 「回退预设」：数值列写 NULL（读时回退预设），布尔/协议写预设值
 *      （列 NOT NULL，用预设值落地"恢复预设"语义）。桌面端「恢复预设」按钮提交的就是这样一份
 *      全 null 的 patch（src/desktop/src/api/modelSettings.ts RESTORE_PRESET_PATCH）——**不能 400**。
 *      ⚠️ 契约 v2：`reasoningLevels` 已废弃 ⇒ **收到即忽略（不报 400）**，让还在发该字段的
 *      旧客户端（含桌面端「恢复预设」的全 null patch）继续正常工作。DB 列
 *      ai_model_settings.reasoning_levels 保留不动（不做破坏性迁移），但不再读写、不再返回。
 *
 * 安全：
 *   · 归属校验落在 SQL 层（provider_id + user_id 同条件），他人/不存在的 provider 一律 404
 *     （不返回 403，避免泄漏资源存在性 —— 与 tests/ai-idor-and-tools.test.js 既有范式一致）。
 *   · 数值边界 + 枚举白名单服务端硬校验，越界/非法 → 400。
 *   · 响应不含任何密钥字段。
 */
import { Router } from 'express'
import { pool } from '../db/pool.js'
import { apiLimiter } from '../middleware/rateLimiter.js'
import { logger } from '../utils/logger.js'
import {
  REASONING_PROTOCOLS,
  resolveModelPreset,
} from '../utils/modelPresets.js'
import {
  fetchModelSettingsRow,
  fetchProviderOverrideRows,
  mergeModelSettings,
  collectModelCandidates,
} from '../utils/aiModelSettings.js'

const router = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODEL_MAX_LEN = 200
// 契约边界（与迁移 081 / 桌面端并行实现保持一致）
const CONTEXT_WINDOW_MIN = 1024
const CONTEXT_WINDOW_MAX = 2000000
const MAX_OUTPUT_MIN = 1
const MAX_OUTPUT_MAX = 200000

const BOOLEAN_FIELDS = ['supportsText', 'supportsImage', 'supportsVideo', 'supportsAudio', 'reasoningEnabled']

/** 生效值 → API 响应项（字段名与冻结契约 v2 一字不差；**不含已废弃的 reasoningLevels**） */
function toItem(eff) {
  return {
    model: eff.model,
    contextWindow: eff.contextWindow,
    maxOutput: eff.maxOutput,
    supportsText: eff.supportsText === true,
    supportsImage: eff.supportsImage === true,
    supportsVideo: eff.supportsVideo === true,
    supportsAudio: eff.supportsAudio === true,
    reasoningEnabled: eff.reasoningEnabled === true,
    reasoningProtocol: eff.reasoningProtocol,
    isPreset: eff.isPreset === true,
    isOverridden: eff.isOverridden === true,
  }
}

/** 校验 patch：返回 null 表示通过，否则返回 400 响应体 */
function validatePatch(patch) {
  if (patch === null || patch === undefined) return null
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: 'INVALID_PATCH', message: 'patch 必须是对象' }
  }
  // 布尔字段允许 null —— 语义是「回退到内置预设值」（桌面端「恢复预设」提交的就是全 null，
  // 见 src/desktop/src/api/modelSettings.ts RESTORE_PRESET_PATCH）。NOT NULL 列无法表达"未设置"，
  // 因此这里在落库时把 null 物化为该模型的预设值，而不是报 400。
  for (const f of BOOLEAN_FIELDS) {
    if (patch[f] !== undefined && patch[f] !== null && typeof patch[f] !== 'boolean') {
      return { error: 'INVALID_FIELD', field: f, message: `${f} 必须是布尔值或 null` }
    }
  }
  for (const [field, min, max] of [
    ['contextWindow', CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX],
    ['maxOutput', MAX_OUTPUT_MIN, MAX_OUTPUT_MAX],
  ]) {
    if (patch[field] === undefined) continue
    const v = patch[field]
    if (v === null) continue // null = 清空覆盖，回退预设/内置
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      return { error: 'INVALID_FIELD', field, message: `${field} 必须是整数或 null` }
    }
    if (v < min || v > max) {
      return { error: 'OUT_OF_RANGE', field, message: `${field} 必须在 ${min}..${max} 之间` }
    }
  }
  if (patch.reasoningProtocol !== undefined && patch.reasoningProtocol !== null) {
    if (typeof patch.reasoningProtocol !== 'string' || !REASONING_PROTOCOLS.includes(patch.reasoningProtocol)) {
      return {
        error: 'INVALID_FIELD',
        field: 'reasoningProtocol',
        message: `reasoningProtocol 必须是 ${REASONING_PROTOCOLS.join(' | ')} 之一或 null`,
      }
    }
  }
  // ⚠️ 契约 v2：reasoningLevels 已废弃（用户要求「把思考强度映射那个配置去掉」）——
  // 这里**刻意不做任何校验**（既不接受也不 400）：收到即忽略，保证还在发该字段的
  // 旧客户端（含桌面端「恢复预设」的全 null patch）继续工作。详见文件头注释。
  return null
}

/**
 * 把 patch 合到生效值上，产出「整行落库」的完整值。
 * - 未在 patch 里出现的字段：沿用生效值（含预设派生值）→ 落库后该行即完整快照，
 *   不会因为 NOT NULL DEFAULT 把其它字段静默改掉。
 * - patch 里显式 null：数值列写 NULL（= 未覆盖，读时回退预设）；布尔/协议写**预设值**
 *   （列 NOT NULL，这是"恢复预设"语义的落地方式）。
 * - patch 里的 reasoningLevels：契约 v2 起忽略（不进返回值，也不写库），见文件头注释。
 */
function materialize(current, patch, preset) {
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k)
  const presetBool = (k) => preset?.[k] === true
  const bool = (k) => (has(k) ? (patch[k] === null ? presetBool(k) : patch[k]) : current[k] === true)

  return {
    contextWindow: has('contextWindow') ? patch.contextWindow : current.contextWindow,
    maxOutput: has('maxOutput') ? patch.maxOutput : current.maxOutput,
    supportsText: bool('supportsText'),
    supportsImage: bool('supportsImage'),
    supportsVideo: bool('supportsVideo'),
    supportsAudio: bool('supportsAudio'),
    reasoningEnabled: bool('reasoningEnabled'),
    reasoningProtocol: has('reasoningProtocol')
      ? (patch.reasoningProtocol === null ? 'inherit' : patch.reasoningProtocol)
      : current.reasoningProtocol,
  }
}

/** 归属校验：provider 必须属于当前用户；不存在/不属于一律 null（调用方回 404） */
async function loadOwnedProvider(userId, providerId) {
  const { rows } = await pool.query(
    'SELECT id, model, models FROM ai_providers WHERE id = $1 AND user_id = $2',
    [providerId, userId],
  )
  return rows[0] || null
}

// GET /api/ai/model-settings?providerId=<uuid>
router.get('/', apiLimiter, async (req, res) => {
  try {
    const providerId = String(req.query.providerId || '')
    if (!UUID_RE.test(providerId)) {
      return res.status(404).json({ error: 'PROVIDER_NOT_FOUND', message: '供应商不存在' })
    }
    const providerRow = await loadOwnedProvider(req.userId, providerId)
    if (!providerRow) {
      return res.status(404).json({ error: 'PROVIDER_NOT_FOUND', message: '供应商不存在' })
    }

    const overrideRows = await fetchProviderOverrideRows(req.userId, providerId)

    // 用户选中的模型快照（ai_settings.selected_models[providerId]），缺表/缺行按未配置处理
    let selectedModels = {}
    try {
      const { rows } = await pool.query('SELECT selected_models FROM ai_settings WHERE user_id = $1', [req.userId])
      selectedModels = rows[0]?.selected_models || {}
    } catch (e) {
      logger.warn('[aiModelSettings] read selected_models failed:', e.message)
    }

    const models = collectModelCandidates(providerRow, selectedModels, overrideRows)
    const items = models.map((model) => {
      const row = overrideRows.find((r) => r.model === model) || null
      return toItem(mergeModelSettings(model, resolveModelPreset(model), row))
    })
    res.json({ items })
  } catch (err) {
    logger.error('List AI model settings error:', err)
    res.status(500).json({ error: 'Failed to list AI model settings' })
  }
})

// PUT /api/ai/model-settings  body { providerId, model, patch }
router.put('/', apiLimiter, async (req, res) => {
  try {
    const { providerId, model, patch } = req.body || {}

    // 非法/他人/不存在的 providerId 一律 404（不泄漏资源存在性）
    if (typeof providerId !== 'string' || !UUID_RE.test(providerId)) {
      return res.status(404).json({ error: 'PROVIDER_NOT_FOUND', message: '供应商不存在' })
    }
    if (typeof model !== 'string' || model.trim().length === 0 || model.trim().length > MODEL_MAX_LEN) {
      return res.status(400).json({ error: 'INVALID_MODEL', message: `model 必填，长度 1..${MODEL_MAX_LEN}` })
    }
    const modelName = model.trim()

    const providerRow = await loadOwnedProvider(req.userId, providerId)
    if (!providerRow) {
      return res.status(404).json({ error: 'PROVIDER_NOT_FOUND', message: '供应商不存在' })
    }

    const patchObj = patch === undefined || patch === null ? {} : patch
    const invalid = validatePatch(patchObj)
    if (invalid) return res.status(400).json(invalid)

    const preset = resolveModelPreset(modelName)
    const existingRow = await fetchModelSettingsRow(req.userId, providerId, modelName)
    const current = mergeModelSettings(modelName, preset, existingRow)
    const next = materialize(current, patchObj, preset)

    const { rows } = await pool.query(
      // ⚠️ 契约 v2：不再写 reasoning_levels（已废弃的等级映射表），该列保留在库中但不再读写。
      // 新建行吃列 DEFAULT('{}'::jsonb)，已有行的历史值原样留着（不删列 = 不做破坏性迁移）。
      `INSERT INTO ai_model_settings (
         user_id, provider_id, model, context_window, max_output,
         supports_text, supports_image, supports_video, supports_audio,
         reasoning_enabled, reasoning_protocol,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
       ON CONFLICT (user_id, provider_id, model) DO UPDATE SET
         context_window = EXCLUDED.context_window,
         max_output = EXCLUDED.max_output,
         supports_text = EXCLUDED.supports_text,
         supports_image = EXCLUDED.supports_image,
         supports_video = EXCLUDED.supports_video,
         supports_audio = EXCLUDED.supports_audio,
         reasoning_enabled = EXCLUDED.reasoning_enabled,
         reasoning_protocol = EXCLUDED.reasoning_protocol,
         updated_at = NOW()
       RETURNING *`,
      [
        req.userId,
        providerId,
        modelName,
        next.contextWindow,
        next.maxOutput,
        next.supportsText,
        next.supportsImage,
        next.supportsVideo,
        next.supportsAudio,
        next.reasoningEnabled,
        next.reasoningProtocol,
      ],
    )

    res.json({ ok: true, item: toItem(mergeModelSettings(modelName, preset, rows[0])) })
  } catch (err) {
    logger.error('Put AI model settings error:', err)
    res.status(500).json({ error: 'Failed to save AI model settings' })
  }
})

export default router
