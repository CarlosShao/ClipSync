/**
 * AI 生成内容的语言（契约 v6）：读取桌面端在每个 AI 请求上带的 `X-UI-Locale` 头，
 * 让**生成的自然语言内容**跟随界面语言（英文界面 ⇒ 英文内容），而不是"跟用户输入语言一致"。
 *
 * 背景（用户实测）：界面切到英文后，AI 功能生成的内容仍是中文（例如「Review settings」条目是中文）
 * ——因为服务端提示词里写的是「使用与用户相同的语言」，而用户输入/被审内容本身是中文。
 *
 * 归一化规则（normalizeLocale）：
 *   'zh' / 'zh-CN' / 'zh-Hans' / 'zh_Hans_CN' / 'zh-TW' … → 'zh'
 *   'en' / 'en-US' / 'en_GB' / 'en-GB' …                   → 'en'
 *   缺失 / 空 / 未知（'fr'、'de-DE'、'klingon'…）           → null（调用方用 DEFAULT_LOCALE）
 * 缺省：DEFAULT_LOCALE = 'zh' —— **不带该头时行为与改造前一致**（向后兼容，老客户端不受影响）。
 *
 * 设计约定：
 *   · **结构化字段保持稳定 code**（JSON 键名、枚举值 keep/archive/cleanup、degree high/medium…）
 *     两种语言下逐字不变 ⇒ 前端照旧解析 + 自行翻译；只有自由文本字段（reason/action_reason/
 *     suggested_tags/摘要正文…）随语言变化 —— 这类字段无法用 code 表达，只能靠提示词约束。
 *   · 每个功能一个"按语言取提示词"的构造器，便于单测（见 tests/ai-locale.test.js）。
 */

/** 受支持的界面语言 */
export const SUPPORTED_LOCALES = ['zh', 'en']
/** 缺省语言（不带 X-UI-Locale 时）——保持改造前的中文行为 */
export const DEFAULT_LOCALE = 'zh'
/** 桌面端统一的界面语言请求头（小写；Node 请求头不区分大小写） */
export const UI_LOCALE_HEADER = 'x-ui-locale'

/**
 * 归一化语言标签：能识别成中/英的返回 'zh'/'en'，否则 null（未知 ≠ 猜）。
 * @param {string} raw 原始值（如 'zh-Hans-CN' / 'en-US' / 'zh'）
 * @returns {'zh'|'en'|null}
 */
export function normalizeLocale(raw) {
  if (raw === null || raw === undefined) return null
  // 头可能是数组（极少见）：取第一个
  const value = Array.isArray(raw) ? raw[0] : raw
  const s = String(value ?? '').trim().toLowerCase()
  if (!s) return null
  // 取主语言子标签：'zh-hans-cn' → 'zh'、'zh_hans' → 'zh'、'en-us' → 'en'
  const m = /^([a-z]{2,3})(?:[-_]|$)/.exec(s)
  const base = m ? m[1] : s
  if (base === 'zh') return 'zh'
  if (base === 'en') return 'en'
  return null
}

/** 归一化 + 兜底到 DEFAULT_LOCALE（永不返回 null） */
export function resolveLocale(raw) {
  return normalizeLocale(raw) || DEFAULT_LOCALE
}

/**
 * 从请求里读界面语言（`X-UI-Locale`），归一化后兜底 DEFAULT_LOCALE。
 * 只认这一个头：不使用 Accept-Language（它描述的是用户期望的**响应**语言，
 * 与"界面语言"在产品语义上不是一回事，混用会带来不可预期的行为）。
 * @param {object} req Express 请求
 * @returns {'zh'|'en'}
 */
export function resolveRequestLocale(req) {
  const raw = req?.headers?.[UI_LOCALE_HEADER] ?? req?.get?.(UI_LOCALE_HEADER) ?? null
  return resolveLocale(raw)
}

/**
 * 解析"目标语言固定"的页内变体的显式语言覆盖（`/inline` 的 body 字段 `languageOverride`）。
 *
 * 用途（契约）：详情抽屉的 `drawerTranslate`（提取并翻译为**英文**）这类变体的目标语言与界面语言无关；
 * 若照界面语言在末尾追加「只允许用简体中文回答」，中文界面下会与功能直接冲突 ⇒ 该变体显式声明
 * `languageOverride: 'en'` 即可 opt-out。
 *
 * 返回值：能识别成中/英的语言标签（`'en'` / `'en-US'` / `'zh'` / `'zh-Hans'`…）→ 'en'/'zh'；
 *   `null` / 缺省 / 非法值（`'fr'`、数字、随机串…）→ **null**（调用方回落到 `X-UI-Locale`）。
 * ⚠️ 非法值**刻意不报 400**：它是可选字段，静默按界面语言处理更稳（老客户端、前端手滑、
 *    未来新增语言都不至于把功能打断）；真正需要强约束的地方是"别把冲突语言塞给模型"，而非参数校验。
 */
export function normalizeLanguageOverride(raw) {
  return normalizeLocale(raw)
}

/**
 * 生效语言 = 显式覆盖优先，否则界面语言（**二者只选一个**）。
 * 为什么要统一成一个值（而不是"末尾用覆盖、最前仍用界面语言"）：
 *   提示词里"最前说中文、末尾说英文"会自相矛盾，模型容易两头摇摆（甚至把冲突原样吐给用户）。
 *   因此 /inline 在最前 system 段、上下文段标签、末尾强化、以及 runChatLoop 的 locale 上
 *   **统一使用生效语言**；未声明覆盖时它就等于界面语言（既有行为不变）。
 * @param {'zh'|'en'|string} uiLocale X-UI-Locale 归一化结果
 * @param {*} override body 里的 languageOverride（可能是任意脏值）
 * @returns {'zh'|'en'}
 */
export function resolveEffectiveLocale(uiLocale, override) {
  return normalizeLanguageOverride(override) || resolveLocale(uiLocale)
}

/**
 * 语言强制指令（system 段；放在系统提示词末尾）。
 *
 * ⚠️ 措辞刻意**强硬**：用户实测「英文界面下页内小功能仍输出中文」——弱措辞（"Always respond in
 * English"）面对后面大段中文 prompt 会失效，所以这里明确"只允许/无论上文用什么语言"。
 */
export function languageDirective(locale) {
  return resolveLocale(locale) === 'en'
    ? '\n\n## Response language (REQUIRED)\nRespond ONLY in English. Your entire answer must be in English, regardless of the language of the instructions or context above.'
    : '\n\n## 回答语言（强制）\n只允许用简体中文回答。无论上文指令或上下文使用什么语言，你的回答必须全部是简体中文。'
}

/** 末尾强化用的**单句**要求（与 languageDirective 同一措辞，可单独追加到最后一条消息末尾） */
export function trailingLanguageRequirement(locale) {
  return resolveLocale(locale) === 'en'
    ? 'Respond ONLY in English. Your entire answer must be in English, regardless of the language of the instructions or context above.'
    : '只允许用简体中文回答。无论上文指令或上下文使用什么语言，你的回答必须全部是简体中文。'
}

/**
 * 「末尾强化」：把语言要求追加到**最后一条消息的末尾**（位置最权威）。
 *
 * 为什么必须放到最后（本次修正的根因）：
 *   页内小功能的 prompt 本体是中文且很长，语言指令之前被放在 messages **最前** ⇒ 被后面的中文压住 ⇒
 *   英文界面下模型依旧用中文作答。位置越靠后越权威：要求出现在模型即将开始生成的位置才有效。
 *
 * 为什么追加到"最后一条 user 内容"而不是"再加一条 system 段"：
 *   · OpenAI 兼容族：末尾 system 段可以；
 *   · **Anthropic 族：buildUpstreamChat 会把所有 system 消息抽取合并进 top-level `system` 字段**
 *     ⇒ 末尾 system 段最终仍排在对话最前面，起不到"最后"的作用；
 *   · Responses 协议：system 走 `instructions`（同样在最前）。
 *   只有"追加到最后一条 user 消息内容末尾"对三种协议**都**真正位于最后。
 *
 * 就地修改（与路由里既有的 messages 变更风格一致）并返回同一数组；不改变消息条数（除非最后一条
 * 不是 user 消息，此时退化为追加一条末尾 system 段）。
 * @param {Array} messages OpenAI 风格消息数组
 * @param {'zh'|'en'|string} locale 界面语言
 */
export function appendTrailingLanguageRequirement(messages, locale) {
  const req = trailingLanguageRequirement(locale)
  if (!Array.isArray(messages) || messages.length === 0) return messages
  const last = messages[messages.length - 1]
  if (last && last.role === 'user') {
    if (typeof last.content === 'string') {
      last.content = `${last.content}\n\n${req}`
      return messages
    }
    if (Array.isArray(last.content)) {
      // 多模态（vision）内容数组：把要求作为最后一段 text 块追加（openai/anthropic 转换都支持）
      last.content.push({ type: 'text', text: req })
      return messages
    }
  }
  messages.push({ role: 'system', content: req })
  return messages
}

/** 角色系统提示词里那一句"语言"要求（aiSystemPrompt.buildRoleSystemPrompt） */
export function roleLanguageLine(locale) {
  return resolveLocale(locale) === 'en'
    ? 'Keep answers concise, accurate and helpful, and respond ONLY in English (the UI language) — your entire answer must be in English.'
    : '你的回答应简洁、准确、有帮助，且只允许用简体中文（界面语言）回答——整段回答都必须是简体中文。'
}

// ==================== 各功能的按语言提示词 ====================
// 约定：每个"整段 system 提示词"的构造器都**自带语言强制指令**（languageDirective 追加在末尾），
// 这样任何调用点都不可能"忘了加语言要求"（本轮 bug 的教训：只在角色提示词里加一句远远不够）。
// 例外：纯片段（收藏夹提示 / 已收藏标记）与"上下文段"（inlineContextSystemPrompt，由调用方单独加指令）。
function withLanguageDirective(text, locale) {
  return `${text}${languageDirective(locale)}`
}

/** /summarize（剪贴板内容摘要） */
export function summarizeSystemPrompt(locale) {
  const text = resolveLocale(locale) === 'en'
    ? 'You are a clipboard content summarizer. Summarize the text provided by the user in a single sentence (at most 25 words). Return only the summary text — no explanation, no prefix, no markdown.'
    : '你是一位剪贴板内容摘要助手。请用一句话（不超过 80 字）总结用户提供的文本。只返回摘要文本，不要解释、不要前缀、不要 markdown。'
  return withLanguageDirective(text, locale)
}

/**
 * /similarity（语义重复检测）
 * ⚠️ JSON 结构（键名 + degree 枚举）**两种语言完全一致**，只有 reason 是自然语言。
 */
export function similaritySystemPrompt(locale, candidateLines) {
  const tail = Array.isArray(candidateLines) ? candidateLines.join('\n') : String(candidateLines || '')
  if (resolveLocale(locale) === 'en') {
    return withLanguageDirective(
      'You are a clipboard management assistant. Decide whether the newly copied content is a semantic duplicate of existing clipboard entries. ' +
      'Output a JSON array (no markdown code fences, no extra text):\n' +
      '[{"id": "<candidate id>", "reason": "<one sentence explaining why it is a duplicate>", "degree": "high"|"medium"}]\n' +
      'Rules:\n' +
      '- Semantic duplicate: same or highly similar meaning (paraphrase, synonym, translation, large overlap), even if the wording differs\n' +
      '- Only output candidates that really are duplicates; omit the others\n' +
      "- degree: high (essentially the same content) / medium (partially overlapping or related)\n" +
      'Candidates (id: text):\n' +
      tail,
      locale,
    )
  }
  return withLanguageDirective(
    '你是剪贴板管理助手，负责判断新复制的内容是否与已有剪贴板条目"语义重复"。' +
    '请以 JSON 数组输出（不要 markdown 代码块、不要多余文字）：\n' +
    '[{"id": "<候选id>", "reason": "<一句话说明为什么重复>", "degree": "high"|"medium"}]\n' +
    '判断规则：\n' +
    '- 语义重复：意思相同或高度相近（包括改写、同义、翻译、内容大段重合），即使文字不完全一样\n' +
    '- 只输出确实重复的候选；不重复则不输出该条\n' +
    '- degree: high(基本同一内容) / medium(部分重叠或相关)' +
    '\n候选条目如下（id: 文本）：\n' +
    tail,
    locale,
  )
}

/** /refactor-prompt（提示词改写） */
export function refactorSystemPrompt(locale) {
  const text = resolveLocale(locale) === 'en'
    ? 'You are a "prompt rewriting assistant". Polish and structure the user\'s draft so the intent is clearer and the tone more professional. ' +
        'Constraints: (1) never invent facts the user did not state; (2) do not answer the question itself, only rewrite the prompt; ' +
        '(3) write in the UI language — English; (4) if the draft is very short (<8 characters) you may return it as is; ' +
        '(5) return only the rewritten prompt text — no prefix (such as "Rewritten:"), no explanation, no markdown code fences.'
    : '你是一名「提示词改写助手」。请对用户的草稿做语义化润色与结构化表达，让意图更清晰、语气更专业。' +
        '约束：①不要凭空新增用户没说过的事实；②不要回答问题本身，只改写提示词；' +
        '③输出语言与界面语言一致（简体中文）；④若草稿很短（<8 字），可以原样返回；' +
        '⑤只返回改写后的提示词文本，不要任何前缀（"改写后："/"优化后："之类）、不要任何解释、不要包裹 markdown 代码块。'
  return withLanguageDirective(text, locale)
}

/** /suggest 的收藏夹提示片段 */
export function suggestCollectionHint(locale, collectionNames) {
  const names = Array.isArray(collectionNames) ? collectionNames : []
  if (names.length === 0) return ''
  return resolveLocale(locale) === 'en'
    ? `\nExisting collections: ${names.join(', ')} (if you suggest a collection, pick the best match from these)`
    : `\n现有收藏夹：${names.join('、')}（若建议分类，请从这些中选择最匹配的）`
}

/** /suggest 批量：system 提示词（JSON 键名与枚举两种语言一致） */
export function suggestBatchSystemPrompt(locale, count, collectionHint = '') {
  if (resolveLocale(locale) === 'en') {
    return withLanguageDirective(
      'You are a clipboard management assistant. Give management suggestions for each item in this batch of clipboard entries. ' +
      `This batch has ${count} items, numbered 0-${count - 1}. ` +
      'Output strictly as a JSON array (no markdown code fences, no extra text), in the same order as the input:\n' +
      '[{"index": 0, "worth_favorite": boolean, "reason": string, "suggested_collection": string|null, "action": "keep"|"archive"|"cleanup", "action_reason": string, "suggested_tags": string[]}, ...]\n' +
      'Field notes:\n' +
      '- index: the input index\n' +
      '- worth_favorite: whether the content is worth favoriting (important, frequently used, reusable, valuable). **Items already marked [favorited] MUST return false.**\n' +
      '- reason: one sentence explaining the decision\n' +
      '- suggested_collection: if worth favoriting, which collection to file it into (pick from the provided collection list; null if none fits)\n' +
      '- action: keep / archive / cleanup (temporary, one-off, sensitive or expired content)\n' +
      '- action_reason: one sentence explaining the suggested action\n' +
      '- suggested_tags: **only when worth_favorite=true, suggest 2-5 concise tags**; return [] when worth_favorite=false.\n' +
      'You may return null for an item when you cannot give a suggestion, but the array length must equal the number of input items.' +
      collectionHint,
      locale,
    )
  }
  return withLanguageDirective(
    '你是剪贴板管理助手，负责给用户剪贴板中的多条内容分别给出管理建议。' +
    `本批共 ${count} 条，编号 0-${count - 1}。` +
    '请严格以 JSON 数组输出（不要 markdown 代码块、不要多余文字），顺序与输入对应：\n' +
    '[{"index": 0, "worth_favorite": boolean, "reason": string, "suggested_collection": string|null, "action": "keep"|"archive"|"cleanup", "action_reason": string, "suggested_tags": string[]}, ...]\n' +
    '字段说明：\n' +
    '- index: 对应输入的编号\n' +
    '- worth_favorite: 内容是否值得收藏（重要、常用、可复用、有价值）。**已被标记为 [已收藏] 的条目必须返回 false**。\n' +
    '- reason: 一句话说明收藏/不收藏的理由\n' +
    '- suggested_collection: 若值得收藏，建议归入哪个收藏夹（从提供的收藏夹列表选，没有合适则 null）\n' +
    '- action: 建议动作 keep(保留) / archive(归档) / cleanup(清理——临时性、一次性、敏感或过期内容）\n' +
    '- action_reason: 建议动作的一句话理由\n' +
    '- suggested_tags: **仅在 worth_favorite=true 时推荐 2-5 个简洁标签**；worth_favorite=false 时返回空数组 []。\n' +
    '允许某条返回 null（表示对该条无法给出建议），但数组长度必须等于输入条数。' +
    collectionHint,
    locale,
  )
}

/** /suggest 单条：system 提示词 */
export function suggestSingleSystemPrompt(locale, collectionHint = '') {
  if (resolveLocale(locale) === 'en') {
    return withLanguageDirective(
      'You are a clipboard management assistant. Give a management suggestion for one piece of clipboard content. ' +
      'Output a JSON object (no markdown code fences, no extra text) in this format:\n' +
      '{"worth_favorite": boolean, "reason": string, "suggested_collection": string|null, "action": "keep"|"archive"|"cleanup", "action_reason": string, "suggested_tags": string[]}\n' +
      'Field notes:\n' +
      '- worth_favorite: whether the content is worth favoriting (important, frequently used, reusable, valuable)\n' +
      '- reason: one sentence explaining the decision\n' +
      '- suggested_collection: if worth favoriting, which collection to file it into (pick from the provided collection list; null if none fits)\n' +
      '- action: keep / archive / cleanup (temporary, one-off, sensitive or expired content)\n' +
      '- action_reason: one sentence explaining the suggested action\n' +
      '- suggested_tags: suggest 2-5 concise English tags for this item (e.g. work / code / url / password / idea; avoid long sentences that repeat the content)' +
      collectionHint,
      locale,
    )
  }
  return withLanguageDirective(
    '你是剪贴板管理助手，负责给用户剪贴板中的一段内容给出管理建议。' +
    '请以 JSON 对象输出（不要 markdown 代码块、不要多余文字），格式如下：\n' +
    '{"worth_favorite": boolean, "reason": string, "suggested_collection": string|null, "action": "keep"|"archive"|"cleanup", "action_reason": string, "suggested_tags": string[]}\n' +
    '字段说明：\n' +
    '- worth_favorite: 内容是否值得收藏（重要、常用、可复用、有价值）\n' +
    '- reason: 一句话说明收藏/不收藏的理由\n' +
    '- suggested_collection: 若值得收藏，建议归入哪个收藏夹（从提供的收藏夹列表选，没有合适则 null）\n' +
    '- action: 建议动作 keep(保留) / archive(归档) / cleanup(清理——临时性、一次性、敏感或过期内容）\n' +
    '- action_reason: 建议动作的一句话理由\n' +
    '- suggested_tags: 推荐 2-5 个简洁中文标签（用于给该内容打标签，如 工作/代码/网址/密码/灵感 等，避免与内容本身重复的长句）' +
    collectionHint,
    locale,
  )
}

/** /suggest 批量的 user 消息 */
export function suggestBatchUserPrompt(locale, count, itemList) {
  return resolveLocale(locale) === 'en'
    ? `Give a suggestion for each of the following ${count} clipboard items (output in index order):\n${itemList}`
    : `请对以下 ${count} 条剪贴板内容分别给出建议（按编号顺序输出）：\n${itemList}`
}

/** 批量建议里"已收藏"标记（与提示词里的 [favorited]/[已收藏] 必须同语言） */
export function favoriteMarker(locale) {
  return resolveLocale(locale) === 'en' ? ' [favorited]' : ' [已收藏]'
}

/**
 * /refactor-prompt 的 user 内容：用定界符把"待改写草稿"包起来。
 * 原因：末尾强化指令会追加到最后一条 user 内容末尾；若不包裹，模型可能把它当成草稿的一部分一起改写。
 */
export function refactorUserContent(locale, draft) {
  const isEn = resolveLocale(locale) === 'en'
  const open = isEn ? '<<<DRAFT>>>' : '<<<草稿>>>'
  const close = isEn ? '<<<END DRAFT>>>' : '<<<草稿结束>>>'
  const hint = isEn ? 'Rewrite ONLY the text between the markers.' : '只改写两个标记之间的文本。'
  return `${hint}\n${open}\n${draft}\n${close}`
}

/** /inline 的参考上下文 system 段（客户端 prompt 体不归服务端管，这里只统一上下文与语言指令） */export function inlineContextSystemPrompt(locale, context) {
  return resolveLocale(locale) === 'en'
    ? `Reference context for this task:\n${context}`
    : `以下是本次任务的参考上下文：\n${context}`
}

/** 对话历史压缩（aiChatCore 内部生成的自然语言摘要，避免中文摘要污染英文界面） */
export function compressSummarySystemPrompt(locale) {
  const text = resolveLocale(locale) === 'en'
    ? 'You are a conversation history compressor. Compress the given older conversation transcript into a minimal structured **English** summary: keep only key facts, user intent, completed actions, important conclusions and pending items; drop pleasantries and redundancy. Output a bullet list, at most 500 words. Output only the summary body — no prefix, no explanation.'
    : '你是一个对话历史压缩器。请把给定的较早对话记录压缩为一份极简的中文结构化摘要，只保留关键事实、用户意图、已完成的操作、重要结论与待办，删除寒暄与冗余。用要点列表输出，不超过 500 字。只输出摘要正文，不要任何前缀或解释。'
  return withLanguageDirective(text, locale)
}

export default {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  UI_LOCALE_HEADER,
  normalizeLocale,
  resolveLocale,
  resolveRequestLocale,
  normalizeLanguageOverride,
  resolveEffectiveLocale,
  languageDirective,
  trailingLanguageRequirement,
  appendTrailingLanguageRequirement,
  roleLanguageLine,
  summarizeSystemPrompt,
  similaritySystemPrompt,
  refactorSystemPrompt,
  suggestCollectionHint,
  suggestBatchSystemPrompt,
  suggestSingleSystemPrompt,
  suggestBatchUserPrompt,
  favoriteMarker,
  refactorUserContent,
  inlineContextSystemPrompt,
  compressSummarySystemPrompt,
}
