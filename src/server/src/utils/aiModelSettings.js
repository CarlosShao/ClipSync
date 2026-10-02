/**
 * 按模型配置的「生效值」解析层（DB 覆盖 ← 内置预设 ← 内置上下文窗口表）。
 *
 * 单一事实来源分工：
 *   - utils/modelPresets.js        纯常量预设（按模型名正则）
 *   - 本文件                       读 ai_model_settings 覆盖行 + 合并 + 供路由/聊天链路复用
 *   - routes/aiModelSettings.js    暴露 GET/PUT 配置入口
 *   - utils/aiProviders.js         按协议把推理参数真正写进上游请求体
 *
 * 优先级（与迁移 081 注释一致）：
 *   contextWindow: 用户覆盖行 → 预设 → aiProviders 内置 MODEL_CONTEXT_WINDOWS → null
 *   maxOutput:     用户覆盖行 → 预设 → null（未知不编造）
 *   模态/推理:      用户覆盖行 → 预设
 *
 * 健壮性：迁移未跑 / 查库失败时全部按「无覆盖行」处理（fail-open 到预设），
 *   绝不让"读配置失败"把聊天主链路打断。
 */
import { pool } from '../db/pool.js'
import { logger } from './logger.js'
import { lookupBuiltinContextWindow } from './aiProviders.js'
import {
  resolveModelPreset,
  classifyApplicability,
  REASONING_PROTOCOLS,
} from './modelPresets.js'

/**
 * 读取某用户某供应商某模型的覆盖行（不存在/表不存在/查库失败 → null）
 * @param {object} [executor] pg Pool/PoolClient。**事务内必须传 client**：池连接看不到同事务里
 *   尚未提交的写入，批量 upsert 中重复模型的第二次合并会读到旧值（契约 v4 的 batch 依赖此参数）。
 */
export async function fetchModelSettingsRow(userId, providerId, model, executor = pool) {
  if (!userId || !providerId || !model) return null
  try {
    const { rows } = await executor.query(
      `SELECT * FROM ai_model_settings
        WHERE user_id = $1 AND provider_id = $2 AND model = $3
        LIMIT 1`,
      [userId, providerId, model],
    )
    return rows[0] || null
  } catch (err) {
    logger.warn('[aiModelSettings] read override row failed, fallback to preset:', err.message)
    return null
  }
}

/**
 * 读取某用户某供应商的全部覆盖行（表不存在/查库失败 → []）
 * @param {object} [executor] pg Pool/PoolClient（事务内请传 client，理由同上）
 */
export async function fetchProviderOverrideRows(userId, providerId, executor = pool) {
  if (!userId || !providerId) return []
  try {
    const { rows } = await executor.query(
      `SELECT * FROM ai_model_settings WHERE user_id = $1 AND provider_id = $2`,
      [userId, providerId],
    )
    return rows
  } catch (err) {
    logger.warn('[aiModelSettings] read override rows failed:', err.message)
    return []
  }
}

const hasValue = (v) => v !== null && v !== undefined

/**
 * 读取该用户的 `ai_settings.selected_models`（"聊天模型选择器"的事实来源）。
 * 缺表/缺行/查库失败一律返回 {}（fail-open：宁可判"没选中"，也不会把刷新出的模型误判成已启用）。
 * 供 GET /model-settings 与 POST /resolve 复用同一份读取口径（契约 v5）。
 * @param {string} userId 当前用户
 * @param {object} [executor] pg Pool/PoolClient
 * @returns {Promise<object>}
 */
export async function fetchSelectedModels(userId, executor = pool) {
  if (!userId) return {}
  try {
    const { rows } = await executor.query('SELECT selected_models FROM ai_settings WHERE user_id = $1', [userId])
    const sel = rows[0]?.selected_models
    return sel && typeof sel === 'object' && !Array.isArray(sel) ? sel : {}
  } catch (err) {
    logger.warn('[aiModelSettings] read selected_models failed, treat as empty:', err.message)
    return {}
  }
}

/**
 * 该模型是否在 `ai_settings.selected_models[providerId]` 里（契约 v5 的 enabled 事实来源之一）。
 * 形态兼容与 applySelectedModel 同族 —— 历史上三种都出现过：
 *   · 字符串（当前桌面端主形态 { providerId: model }）
 *   · 数组（多选客户端 { providerId: [m1, m2] }）
 *   · 对象（{ providerId: { model } / { modelId } }）
 * @param {object} selected ai_settings.selected_models
 * @param {string} providerId 供应商 id
 * @param {string} model 模型名
 * @returns {boolean}
 */
export function isModelSelected(selected, providerId, model) {
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) return false
  if (!providerId || !model) return false
  const cur = selected[providerId]
  if (cur === undefined || cur === null) return false
  if (typeof cur === 'string') return cur === model
  if (Array.isArray(cur)) {
    return cur.some((v) => (typeof v === 'string' ? v : v?.model ?? v?.modelId) === model)
  }
  if (typeof cur === 'object') return (cur.model ?? cur.modelId) === model
  return false
}

/**
 * 合并「预设 ← 覆盖行」为生效值（纯函数，便于单测）。
 * isPreset：命中了内置预设规则；isOverridden：存在用户覆盖行。
 *
 * ⚠️ `enabled` 的唯一事实来源（**契约 v5**，纠正 v3 的"无行默认 true"错误设计）：
 *   1) 有 ai_model_settings 行            → row.enabled（显式覆盖优先，行是用户真实意图的落点）；
 *   2) 无行 + 在 selected_models[providerId] 里 → true （用户真勾选过）；
 *   3) 无行 + 不在 selected_models 里        → **false**（刷新出来的模型天生没有行 ⇒ 默认未选中）。
 * v3 老口径让"上游刷新出的 169 个模型全部 enabled=true"，用户刷新后胶囊全变选中 —— 本次修正。
 *
 * ⚠️ 该解析**只在调用方显式提供 `selectedModels` 上下文时生效**：
 *   · 读路径（GET / resolve）必须传（见 routes/aiModelSettings.js resolveItems）；
 *   · 写入路径（PUT / batch 的 materialize 基线）**不传** ⇒ 新建行的 enabled 仍取列默认
 *     （NOT NULL DEFAULT TRUE），保持写入语义一字不变（契约 v5 明确要求"不要动写路径"）。
 *
 * @param {string} model 模型名
 * @param {object} [preset] 预设（缺省按名字解析）
 * @param {object|null} [row] ai_model_settings 覆盖行
 * @param {object} [opts] { selectedModels, providerId } —— 提供 selectedModels（含空对象）才启用 v5 规则
 */
export function mergeModelSettings(model, preset, row, opts = {}) {
  const p = preset || resolveModelPreset(model)
  const hasSelectionContext = opts && opts.selectedModels !== undefined && opts.selectedModels !== null
  const contextWindowFromRow = hasValue(row?.context_window) && Number.isFinite(Number(row.context_window))
  const presetContextWindow = hasValue(p.contextWindow) ? Number(p.contextWindow) : null
  const builtinContextWindow = lookupBuiltinContextWindow(model)
  const contextWindow = contextWindowFromRow
    ? Math.floor(Number(row.context_window))
    : (presetContextWindow ?? (hasValue(builtinContextWindow) ? builtinContextWindow : null))

  const maxOutputFromRow = hasValue(row?.max_output) && Number.isFinite(Number(row.max_output))
  const maxOutput = maxOutputFromRow
    ? Math.floor(Number(row.max_output))
    : (hasValue(p.maxOutput) ? Number(p.maxOutput) : null)

  // 推理协议：覆盖行 ← 预设（白名单之外的脏值一律回退 inherit）
  const protocol = REASONING_PROTOCOLS.includes(row?.reasoning_protocol)
    ? row.reasoning_protocol
    : (REASONING_PROTOCOLS.includes(p.reasoningProtocol) ? p.reasoningProtocol : 'inherit')

  // enabled：行优先 → selected_models 推断（契约 v5，见上方注释）
  let enabled
  if (row) enabled = row.enabled !== false
  else if (hasSelectionContext) enabled = isModelSelected(opts.selectedModels, opts.providerId, model)
  else enabled = true // 无行且未提供选择上下文（写入路径基线）：保持列默认语义，不动写路径

  return {
    model,
    contextWindow,
    contextWindowFromRow,
    maxOutput,
    maxOutputFromRow,
    supportsText: row ? row.supports_text === true : p.supportsText === true,
    supportsImage: row ? row.supports_image === true : p.supportsImage === true,
    supportsVideo: row ? row.supports_video === true : p.supportsVideo === true,
    supportsAudio: row ? row.supports_audio === true : p.supportsAudio === true,
    reasoningEnabled: row ? row.reasoning_enabled === true : p.reasoningEnabled === true,
    reasoningProtocol: protocol,
    enabled,
    alias: row && typeof row.alias === 'string' && row.alias.trim() ? row.alias.trim() : null,
    // ⚠️ 必须先判 null/undefined 再 Number()：Number(null) === 0 会把"未排序"写成 0（踩过）
    sortOrder:
      row && row.sort_order !== null && row.sort_order !== undefined && Number.isFinite(Number(row.sort_order))
        ? Math.floor(Number(row.sort_order))
        : null,
    // 适用性由模型名推导（不落库）：只是给前端「默认不勾选/折叠」的依据，
    // 服务端**不**据此强制禁用（契约 v3 明确要求）。
    applicability: classifyApplicability(model),
    // ⚠️ 已废弃：ai_model_settings.reasoning_levels（等级映射表）不再读取、不再对外暴露。
    // 契约 v2 起思考等级原样透传（见 utils/modelPresets.js 头部说明）；
    // 列本身保留在库里但不参与任何计算（不删列 = 不做破坏性迁移）。
    isPreset: p.matched === true,
    isOverridden: !!row,
    presetRuleId: p.ruleId || null,
    note: p.note || '',
  }
}

/**
 * 一步到位：读覆盖行 → 合并 → 生效值（聊天链路/能力自检共用）。
 *
 * ⚠️ 这里**不传 selected_models 上下文**：本函数的消费方（runChatLoop / probe）只用
 * reasoningProtocol / reasoningEnabled / contextWindow，从不读 `enabled`；而 enabled 的
 * v5 口径需要额外一次 ai_settings 查询。若将来有调用方需要 v5 的 `enabled`，
 * 请改用 mergeModelSettings(..., { selectedModels: await fetchSelectedModels(userId), providerId })。
 */
export async function loadEffectiveModelSettings({ userId, providerId, model }) {
  const preset = resolveModelPreset(model)
  const row = await fetchModelSettingsRow(userId, providerId, model)
  return mergeModelSettings(model, preset, row)
}

/**
 * 解析某 provider 的「模型集合」= 当前 model + models(jsonb，刷新得到) + 用户选中模型
 * （ai_settings.selected_models[providerId]）+ 已有覆盖行的模型（保证用户改过的不丢）。
 * @returns {string[]} 去重后的模型名（保持稳定顺序）
 */
export function collectModelCandidates(providerRow, selectedModels, overrideRows = []) {
  const out = []
  const seen = new Set()
  const push = (v) => {
    if (typeof v !== 'string') return
    const s = v.trim()
    if (!s || s.length > 200 || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }

  push(providerRow?.model)
  const list = providerRow?.models
  if (Array.isArray(list)) list.forEach(push)
  else if (list && typeof list === 'object') {
    // 兼容 { id: true } / { 0: 'model' } 等历史形态
    Object.values(list).forEach((v) => push(typeof v === 'string' ? v : v?.id))
  }

  // selected_models: { [providerId]: model | model[] | { model } }
  const sel = selectedModels && typeof selectedModels === 'object' ? selectedModels[providerRow?.id] : null
  if (typeof sel === 'string') push(sel)
  else if (Array.isArray(sel)) sel.forEach((v) => push(typeof v === 'string' ? v : v?.id))
  else if (sel && typeof sel === 'object') {
    push(sel.model)
    push(sel.modelId)
  }

  for (const r of overrideRows || []) push(r?.model)

  return out
}

/**
 * 上下文窗口覆盖值优先级：**模型级用户覆盖行 → provider 级 context_window（031）→ 预设/内置**。
 * 返回 null 时 getContextWindow 会走内置表 + DEFAULT_CONTEXT_WINDOW 兜底（保持旧行为）。
 */
export function resolveContextWindowOverride(providerOverride, settings) {
  if (settings && settings.contextWindowFromRow && hasValue(settings.contextWindow)) {
    return Math.floor(Number(settings.contextWindow))
  }
  if (typeof providerOverride === 'number' && providerOverride > 0) return Math.floor(providerOverride)
  return hasValue(settings?.contextWindow) ? Math.floor(Number(settings.contextWindow)) : null
}

/**
 * 停用/启用某个模型时同步维护 `ai_settings.selected_models[providerId]`（纯函数，便于单测）。
 *
 * 为什么要有这个联动（契约 v3）：桌面端的「聊天模型选择器」读的就是 selected_models
 * （`useAiChat` → settings.selectedModels[providerId]），把 enabled 的副作用落到同一份数据上，
 * **既有选择器不用改前端就能跟着停用/启用变化**。
 *
 * 形态兼容（历史数据三种都存在）：
 *   · 字符串（当前桌面端主形态：{ providerId: model }）→ 启用=写入该模型；停用=若正是该模型则删键
 *   · 数组（某些客户端多选）                          → 启用=加入；停用=移除（空数组则删键）
 *   · 对象（{ model } / { modelId }）                 → 同字符串口径
 * 返回值是**新对象**（不改动入参），且顺序稳定；调用方用 JSON 比较决定是否落库。
 *
 * @param {object} selected 现有 ai_settings.selected_models
 * @param {string} providerId 供应商 id
 * @param {string} model 模型名
 * @param {boolean} enabled true=启用（加入）/ false=停用（移除）
 * @returns {object} 新的 selected_models
 */
export function applySelectedModel(selected, providerId, model, enabled) {
  const base = selected && typeof selected === 'object' && !Array.isArray(selected) ? { ...selected } : {}
  if (!providerId || !model) return base
  const cur = base[providerId]

  if (Array.isArray(cur)) {
    const set = new Set(cur.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))
    if (enabled) set.add(model)
    else set.delete(model)
    const arr = [...set]
    if (arr.length === 0) delete base[providerId]
    else base[providerId] = arr
    return base
  }

  if (enabled) {
    base[providerId] = model
    return base
  }

  const curModel = typeof cur === 'string' ? cur : (cur && typeof cur === 'object' ? (cur.model ?? cur.modelId) : null)
  if (curModel === model) delete base[providerId]
  return base
}

export default {
  fetchModelSettingsRow,
  fetchProviderOverrideRows,
  fetchSelectedModels,
  mergeModelSettings,
  loadEffectiveModelSettings,
  collectModelCandidates,
  resolveContextWindowOverride,
  applySelectedModel,
  isModelSelected,
}
