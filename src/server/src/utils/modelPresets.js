/**
 * 按模型的默认参数预设（服务端常量，纯函数，不碰 DB / 网络）。
 *
 * 背景（用户需求）：AI 供应商里的模型此前只有一个名字，而模型的上下文窗口、最大输出、
 * 多模态能力（识图 / 文本 / 视频 / 音频，需**分开配置**）、推理参数形态各不相同，
 * 必须**按模型**给出默认值；用户可以覆盖（覆盖行见 ai_model_settings 迁移 081）。
 * 本文件的预设只负责「刷新出来的模型的默认参数」，配置入口在
 * GET/PUT /api/ai/model-settings（routes/aiModelSettings.js）。
 *
 * ⚠️ 数据来源纪律：拿不准的字段一律留 null / 保守 false，并在 note 里写明依据；
 *    **不编造**精确数字。所有非 null 的上下文窗口都能追溯到下面注释的官方文档或
 *    aiProviders.js 内置 MODEL_CONTEXT_WINDOWS（同一数字，避免两处互相矛盾）。
 *
 * 推理协议（reasoningProtocol）白名单与语义：
 *   - 'inherit'                  沿用既有行为。OpenAI 兼容族=不下发（既有行为就是不下发），
 *                                Anthropic 族=沿用原 thinking / output_config 逻辑。
 *                                **这是安全底线**：不支持的协议绝不塞未知字段（会 400）。
 *   - 'none'                     该模型明确不支持任何推理参数（如 step-explore）→ 一律不下发。
 *   - 'openai_reasoning_effort'  body.reasoning_effort = levels[strength]（OpenAI o 系 / gpt-5）
 *   - 'anthropic_thinking'       body.thinking = { type:'enabled', budget_tokens: levels[strength] }
 *   - 'output_config_effort'     body.output_config = { effort: levels[strength] }（Anthropic 兼容网关）
 *   - 'qwen_enable_thinking'     body.enable_thinking = true（+ 支持时一并下发 thinking_budget）
 */

/** 推理协议白名单（路由层校验 + DB 语义，必须与迁移 081 注释保持一致） */
export const REASONING_PROTOCOLS = [
  'inherit',
  'none',
  'openai_reasoning_effort',
  'anthropic_thinking',
  'output_config_effort',
  'qwen_enable_thinking',
]

/** 思考强度取值（与 ai_settings.thinking_strength 一致） */
export const THINKING_STRENGTHS = ['low', 'medium', 'high']

/** 字符串型等级映射（OpenAI reasoning_effort / output_config.effort 用） */
export const EFFORT_LEVELS = { low: 'low', medium: 'medium', high: 'high' }

/**
 * Anthropic budget_tokens 等级映射：沿用 routes/aiChatCore.js 原有口径
 * （low 1024 / medium 4096 / high 8192），保证改造前后同一开关得到同一预算，不产生行为漂移。
 */
export const BUDGET_LEVELS = { low: 1024, medium: 4096, high: 8192 }

/**
 * 预设规则表（**有序**，首个命中即返回；越具体越靠前）。
 * 每项字段：match 正则、上下文窗口、最大输出、四种模态能力、推理协议/开关/等级映射、依据 note。
 */
const MODEL_PRESET_RULES = [
  // ==================== StepFun（阶跃星辰） ====================
  {
    id: 'step-explore',
    match: /^step-explore/i,
    // 1000000：aiProviders.js 内置 MODEL_CONTEXT_WINDOWS['step-explore']（Step Explore 申请制，最高 1M）
    contextWindow: 1000000,
    maxOutput: null,
    supportsImage: false,
    reasoningEnabled: false,
    // aiProviders.js:765-769 已明确：Step Explore 官方文档说明**不支持** thinking 参数，
    // 也不支持 output_config ⇒ 这里是真正拿证据钉死的 'none'。
    reasoningProtocol: 'none',
    note: 'Step Explore：官方文档不支持 thinking / output_config（见 aiProviders.js 既有注释）',
  },
  {
    id: 'step-1v',
    match: /^step-1v/i,
    contextWindow: 32768, // 内置表 step-1v
    supportsImage: true, // Step-1V 即视觉理解模型
    reasoningProtocol: 'inherit',
    note: 'Step-1V 为阶跃视觉理解模型（官方模型列表）',
  },
  {
    id: 'step-any',
    match: /^step[-_.]/i,
    contextWindow: 32768, // 内置表 step*
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: '阶跃 step-* 推理参数形态未知 → 保守 inherit（不下发，避免 400），待用户按模型确认',
  },

  // ==================== OpenAI / Azure OpenAI ====================
  {
    id: 'gpt-4o-audio',
    match: /^gpt-4o-audio/i,
    contextWindow: 128000, // 内置表 gpt-4o*
    supportsImage: true,
    supportsAudio: true,
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'gpt-4o-audio-* 官方支持音频输入（音频模态单独建模）',
  },
  {
    id: 'o1-mini-o1-preview',
    match: /^o1-mini|^o1-preview/i,
    contextWindow: 128000, // 内置表 o1-mini / o1-preview
    supportsImage: false, // o1-mini / o1-preview 不支持图片输入
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'o1-mini / o1-preview 不支持 reasoning_effort 参数（OpenAI 仅 o1/o3/o4 正式版支持）→ 保守不下发',
  },
  {
    id: 'o-series',
    match: /^o[134](?:-|$|mini)/i,
    contextWindow: 200000, // 内置表 o1 / o3 / o3-mini / o4-mini
    supportsImage: true, // o1 / o3 / o4-mini 官方支持图片输入
    reasoningProtocol: 'openai_reasoning_effort',
    reasoningEnabled: true,
    reasoningLevels: EFFORT_LEVELS,
    note: 'OpenAI o 系（o1/o3/o4-mini）官方支持 reasoning_effort=low|medium|high',
  },
  {
    id: 'gpt-5',
    match: /^gpt-5/i,
    contextWindow: 272000, // 内置表 gpt-5*
    supportsImage: true,
    reasoningProtocol: 'openai_reasoning_effort',
    reasoningEnabled: true,
    reasoningLevels: EFFORT_LEVELS,
    note: 'GPT-5 系支持 reasoning_effort（low/medium/high）',
  },
  {
    id: 'gpt-4.1',
    match: /^gpt-4\.1/i,
    contextWindow: 1047576, // 内置表 gpt-4.1*
    supportsImage: true,
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'GPT-4.1 支持图片输入；未支持 reasoning_effort（非推理模型）→ inherit 不下发',
  },
  {
    id: 'gpt-4o',
    match: /^gpt-4o/i,
    contextWindow: 128000, // 内置表 gpt-4o*
    maxOutput: 16384, // gpt-4o 官方 max output tokens
    supportsImage: true,
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note:
      'gpt-4o 支持图片输入；reasoning_effort 只对 o 系 / gpt-5 生效，' +
      '给 gpt-4o 传该字段会被 OpenAI 以 400 拒绝 ⇒ 保守 inherit（用户确知网关支持时可自行改协议）',
  },
  {
    id: 'chatgpt-4o-latest',
    match: /^chatgpt-4o/i,
    contextWindow: 128000, // 内置表 chatgpt-4o-latest
    supportsImage: true,
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'chatgpt-4o-latest 支持图片输入',
  },
  {
    id: 'gpt-4-turbo',
    match: /^gpt-4-turbo|^gpt-4-vision/i,
    contextWindow: 128000, // 内置表 gpt-4-turbo
    maxOutput: 4096,
    supportsImage: true,
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'gpt-4-turbo / gpt-4-vision 支持图片输入',
  },

  // ==================== Anthropic Claude ====================
  {
    id: 'claude-3-haiku',
    match: /^claude-3-haiku/i,
    contextWindow: 200000, // 内置表 claude-3-haiku*
    supportsImage: true, // Claude 3 系全系支持图片输入
    reasoningEnabled: false, // claude-3-haiku 不支持 extended thinking
    reasoningProtocol: 'anthropic_thinking',
    note: 'claude-3-haiku 不支持 extended thinking ⇒ 默认关闭（用户可显式开启，届时按 budget_tokens 下发）',
  },
  {
    id: 'claude-3-opus',
    match: /^claude-3-opus/i,
    contextWindow: 200000,
    supportsImage: true,
    reasoningEnabled: false, // claude-3-opus 不支持 extended thinking
    reasoningProtocol: 'anthropic_thinking',
    note: 'claude-3-opus 不支持 extended thinking ⇒ 默认关闭',
  },
  {
    id: 'claude',
    match: /^claude/i,
    contextWindow: 200000, // 内置表 claude-*
    supportsImage: true,
    reasoningProtocol: 'anthropic_thinking',
    reasoningEnabled: true,
    reasoningLevels: BUDGET_LEVELS,
    note: 'Claude 3.5/3.7/4 系支持 extended thinking（body.thinking.budget_tokens），等级沿用既有 1024/4096/8192',
  },

  // ==================== Google Gemini（OpenAI 兼容网关） ====================
  {
    id: 'gemini',
    match: /^gemini/i,
    contextWindow: 1000000, // 内置表 gemini-2.x / 2.5*
    supportsImage: true,
    supportsVideo: true, // Gemini 原生支持视频输入
    supportsAudio: true, // Gemini 原生支持音频输入
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'Gemini 原生支持图/视频/音频输入；其 OpenAI 兼容层推理参数形态随网关而异 → 保守 inherit',
  },

  // ==================== 阿里 Qwen / 通义 ====================
  {
    id: 'qwen-vl',
    match: /qwen[\w.-]*vl/i,
    contextWindow: 131072, // 内置表 qwen2.5*/qwen3*
    supportsImage: true, // qwen-vl / qwen2.5-vl 系列为视觉理解模型
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'Qwen-VL 系列支持图片输入',
  },
  {
    id: 'qwen3-qwq',
    match: /^qwen3|^qwq/i,
    // 留空交给内置表：qwen3* → 131072、qwq* → 32768（不在这里拔高 qwq 的窗口，避免上下文占用百分比失真）
    contextWindow: null,
    reasoningProtocol: 'qwen_enable_thinking',
    reasoningEnabled: true,
    reasoningLevels: BUDGET_LEVELS,
    note: 'qwen3 / qwq 系：DashScope OpenAI 兼容模式支持 enable_thinking（+thinking_budget）',
  },
  {
    id: 'qwen-max-longcontext',
    match: /^qwen-max-longcontext/i,
    contextWindow: 1000000, // 内置表
    reasoningProtocol: 'qwen_enable_thinking',
    reasoningEnabled: false,
    note: '非 qwen3 系：DashScope 未文档化 enable_thinking ⇒ 默认关闭，用户确知支持时可开启',
  },
  {
    id: 'qwen',
    match: /^qwen/i,
    contextWindow: null, // 交给内置表（qwen-plus/turbo/qwen2.5* 等）
    reasoningProtocol: 'qwen_enable_thinking',
    reasoningEnabled: false,
    note: '非 qwen3 系：协议名先暴露给用户，默认关闭避免给不支持该字段的模型塞参数（400）',
  },

  // ==================== DeepSeek ====================
  {
    id: 'deepseek-reasoner',
    match: /^deepseek-reasoner/i,
    contextWindow: 64000, // 内置表
    reasoningProtocol: 'inherit',
    reasoningEnabled: true, // 推理是模型内建行为，无需参数字段
    note: 'deepseek-reasoner 自带推理（reasoning_content），官方无 reasoning_effort/enable_thinking 参数 ⇒ inherit',
  },
  {
    id: 'deepseek',
    match: /^deepseek/i,
    contextWindow: 64000, // 内置表 deepseek-*
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'deepseek-chat / coder 为对话模型；官方无推理参数字段 ⇒ inherit',
  },

  // ==================== 其他常见国内模型 ====================
  {
    id: 'glm-4v',
    match: /^glm-[\d.]*v/i,
    contextWindow: 128000, // 内置表 glm-4*
    supportsImage: true, // GLM-4V 系为视觉模型
    reasoningProtocol: 'inherit',
    note: 'GLM-4V 系支持图片输入',
  },
  {
    id: 'glm',
    match: /^glm/i,
    contextWindow: 128000, // 内置表 glm-4*
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'GLM 的 thinking 参数形态不在白名单内 → inherit（不下发，避免 400）',
  },
  {
    id: 'longcat',
    match: /^longcat/i,
    contextWindow: null, // 内置表无 LongCat 条目且官方窗口未核实 → 留空待用户填
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'LongCat：上下文窗口与推理参数形态均未核实（不编造数字）→ 留空 + inherit，待用户按模型填',
  },
  {
    id: 'mimo',
    match: /^mimo/i,
    contextWindow: null,
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'MiMo（小米）：上下文窗口/推理参数未核实 → 留空 + inherit',
  },
  {
    id: 'agnes',
    match: /^agnes/i,
    contextWindow: null,
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'Agnes：上下文窗口/推理参数未核实 → 留空 + inherit',
  },
  {
    id: 'kimi-moonshot',
    match: /^kimi|^moonshot/i,
    contextWindow: null, // 交给内置表（kimi-* 256000 / moonshot-v1* 131072）
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'Kimi / Moonshot：推理参数形态未核实 → inherit',
  },
  {
    id: 'minimax',
    match: /^minimax|^abab/i,
    contextWindow: null, // 交给内置表
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: 'MiniMax / abab：推理参数形态未核实 → inherit',
  },
  {
    id: 'hunyuan',
    match: /^hunyuan/i,
    contextWindow: null,
    reasoningProtocol: 'inherit',
    reasoningEnabled: false,
    note: '腾讯混元：推理参数形态未核实 → inherit',
  },
]

/** 未命中任何规则时的保守默认值（全部「不下发」语义，绝不编造） */
const NEUTRAL_PRESET = {
  matched: false,
  ruleId: null,
  contextWindow: null,
  maxOutput: null,
  supportsText: true,
  supportsImage: false,
  supportsVideo: false,
  supportsAudio: false,
  reasoningEnabled: false,
  reasoningProtocol: 'inherit',
  reasoningLevels: { ...EFFORT_LEVELS },
  note: '未命中内置预设：上下文窗口回退内置表，推理参数沿用既有行为（inherit）',
}

/**
 * 按模型名解析内置预设。
 * @param {string} model 模型标识（大小写不敏感）
 * @returns {object} 完整预设对象（含 matched / ruleId / note），未命中返回保守默认值
 */
export function resolveModelPreset(model) {
  const m = String(model || '').trim().toLowerCase()
  if (!m) return { ...NEUTRAL_PRESET, reasoningLevels: { ...EFFORT_LEVELS } }
  const rule = MODEL_PRESET_RULES.find((r) => r.match.test(m))
  if (!rule) return { ...NEUTRAL_PRESET, reasoningLevels: { ...EFFORT_LEVELS } }
  return {
    ...NEUTRAL_PRESET,
    ...rule,
    matched: true,
    ruleId: rule.id,
    contextWindow: rule.contextWindow ?? null,
    maxOutput: rule.maxOutput ?? null,
    supportsText: rule.supportsText !== false,
    supportsImage: rule.supportsImage === true,
    supportsVideo: rule.supportsVideo === true,
    supportsAudio: rule.supportsAudio === true,
    reasoningEnabled: rule.reasoningEnabled === true,
    reasoningProtocol: REASONING_PROTOCOLS.includes(rule.reasoningProtocol) ? rule.reasoningProtocol : 'inherit',
    reasoningLevels: { ...(rule.reasoningLevels || EFFORT_LEVELS) },
  }
}

/** 暴露规则清单（仅调试/测试用；不含密钥） */
export function listModelPresetRules() {
  return MODEL_PRESET_RULES.map((r) => ({
    id: r.id,
    pattern: r.match.source,
    contextWindow: r.contextWindow ?? null,
    maxOutput: r.maxOutput ?? null,
    supportsImage: r.supportsImage === true,
    supportsVideo: r.supportsVideo === true,
    supportsAudio: r.supportsAudio === true,
    reasoningEnabled: r.reasoningEnabled === true,
    reasoningProtocol: REASONING_PROTOCOLS.includes(r.reasoningProtocol) ? r.reasoningProtocol : 'inherit',
    note: r.note || '',
  }))
}

/** 归一化等级映射：只保留 low/medium/high，值为非空字符串或有限数字 */
export function normalizeReasoningLevels(input) {
  const out = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  for (const key of THINKING_STRENGTHS) {
    const v = input[key]
    if (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 64) out[key] = v.trim()
    else if (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 1000000) out[key] = Math.floor(v)
  }
  return out
}

/**
 * 解析「该模型在本次请求里到底该下发什么推理字段」。
 *
 * 契约（安全底线）：protocol 为 'inherit' / 'none'、或 reasoningEnabled 不为 true 时**返回 null**
 * ——调用方据此一个字都不下发。这是「不支持的模型塞未知字段导致 400」的硬闸门。
 *
 * @param {object} p
 * @param {object} p.settings 生效配置（mergeModelSettings 的产物）
 * @param {string} [p.strength] 'low'|'medium'|'high'
 * @returns {{protocol:string,strength:string,value:(string|number)}|null}
 */
export function buildReasoningRequest({ settings, strength } = {}) {
  if (!settings) return null
  const protocol = settings.reasoningProtocol || 'inherit'
  if (protocol === 'inherit' || protocol === 'none') return null
  if (settings.reasoningEnabled !== true) return null
  if (!REASONING_PROTOCOLS.includes(protocol)) return null
  const s = THINKING_STRENGTHS.includes(strength) ? strength : 'medium'
  const levels = settings.reasoningLevels && typeof settings.reasoningLevels === 'object' ? settings.reasoningLevels : {}
  const mapped = Object.prototype.hasOwnProperty.call(levels, s) ? levels[s] : s
  return { protocol, strength: s, value: mapped }
}

/**
 * 由「用户思考开关 + 该模型生效配置」推导出要合并进 buildUpstreamChat options 的片段。
 * 调用方（routes/aiChatCore.js runChatLoop / routes/aiOrchestrator.js runCoordinator）统一走这里，
 * 保证「协调器轮次」与「子代理轮次」对同一模型下发完全一致的推理参数。
 *
 * 返回语义（安全底线写在类型上）：
 *   A. 用户没开思考                  → 只有 thinkingStrength/thinkingBudget（不下发任何字段）
 *   B. 开了思考 + 显式协议 + enabled  → 追加 reasoning（buildUpstreamChat 按协议写对应字段）
 *   C. 开了思考 + 显式协议 + 未启用/none → **不追加任何东西**，且刻意不置 thinking（连 Anthropic 的
 *                                        legacy 路径也关掉，尊重"该模型不支持/未开启"的声明）
 *   D. 开了思考 + 协议 inherit        → 置 thinking:true = 完全沿用既有行为
 *                                        （Anthropic 族照旧 thinking/output_config；OpenAI 兼容族本就不下发）
 */
export function buildThinkingOptions({ settings, enabled, strength } = {}) {
  const s = THINKING_STRENGTHS.includes(strength) ? strength : 'medium'
  const base = {
    thinkingStrength: s,
    thinkingBudget: s === 'low' ? 1024 : s === 'high' ? 8192 : 4096,
  }
  if (enabled !== true) return base
  const reasoning = buildReasoningRequest({ settings, strength: s })
  if (reasoning) return { ...base, reasoning }
  const protocol = settings?.reasoningProtocol || 'inherit'
  if (protocol === 'inherit') return { ...base, thinking: true }
  return base
}

/** budget_tokens / thinking_budget 必须是合法整数（否则退回默认预算），防止把字符串塞进数字字段 */
export function resolveNumericBudget(value, fallback = 4096) {
  // 等级名（'low'/'medium'/'high'）也接受：万一把字符串等级配到数值协议上，按既有预算表兜底，
  // 而不是把 "high" 这种字符串塞进 budget_tokens 数字字段（上游会 400）
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(BUDGET_LEVELS, value.trim())) {
    return BUDGET_LEVELS[value.trim()]
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1024) return Math.floor(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = parseInt(value.trim(), 10)
    if (n >= 1024) return n
  }
  return fallback
}

/** effort 字段（reasoning_effort / output_config.effort）只接受非空字符串，否则退回 strength 本身 */
export function resolveEffortString(value, fallback = 'medium') {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return fallback
}

export default {
  REASONING_PROTOCOLS,
  THINKING_STRENGTHS,
  EFFORT_LEVELS,
  BUDGET_LEVELS,
  resolveModelPreset,
  listModelPresetRules,
  normalizeReasoningLevels,
  buildReasoningRequest,
  buildThinkingOptions,
  resolveNumericBudget,
  resolveEffortString,
}
