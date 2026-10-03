/**
 * 页内 AI 小功能的提示词（**zh / en 双份，一处维护**）。
 *
 * 背景（用户实测）：界面切 English 后，`Review settings` 等页内小功能的**生成条目**仍是中文。
 * 根因：服务端虽按 `X-UI-Locale` 注入了语言指令，但**提示词本体是前端拼的中文**（写死在组件里），
 * 一大段中文 prompt 把前置的英文指令压住了。
 * 修法：① 提示词按界面语言取文案（本文件，双语同处维护）；② 在**提示词末尾**再写一句语言要求
 * （位置越靠后越权威）。
 *
 * 语言来源复用 `useI18n()` 的 `uiLocaleHeader()`（与 `X-UI-Locale` 请求头同一个来源，不新增第二套），
 * 且**每次调用实时取值** ⇒ 用户切语言后下一个请求立刻生效。
 *
 * ⚠️ 边界：只服务**页内小功能**（/api/ai/inline 与收藏摘要）。侧栏聊天 / Agent **不经过这里**——
 * 那里保持现状（服务端给语言指令 + 跟随用户输入语言）。
 */
import { uiLocaleHeader } from '@/composables/useI18n'

export type InlinePromptVariant =
  | 'diagnose' // AI 诊断同步（DevicesView）
  | 'review' // 审查设置（SettingsView）
  | 'summarizeToday' // 总结今日动态（ClipboardView）
  | 'organizeFavorites' // AI 整理收藏（FavOrganizeFlow）
  | 'generateTemplate' // AI 生成模板（TemplateGenerateDialog）
  | 'summarizeCollection' // 收藏摘要（FavoritesView）
  | 'drawerSummary' // 详情抽屉：总结
  | 'drawerExtract' // 详情抽屉：提取关键信息
  | 'drawerTranslate' // 详情抽屉：翻译为英文（目标语言固定英文，与界面语言无关）

/** 末尾的语言要求（最后一段最权威）：模型据此用对应语言作答 */
export const INLINE_LANG_TAIL: Record<'zh' | 'en', string> = {
  zh: '（重要）请用简体中文回答。',
  en: '(Important) Answer in English.',
}

type PromptPair = { zh: string[]; en: string[] }

export const INLINE_PROMPTS: Record<InlinePromptVariant, PromptPair> = {
  diagnose: {
    zh: [
      '你是剪贴板同步链路的诊断助手。请根据以下设备与同步流水信息，判断当前同步链路是否健康（设备在线情况、最近收发是否正常、有无长期未同步的迹象），输出：1) 健康度结论；2) 异常点（如有）；3) 排查与改进建议清单。',
    ],
    en: [
      'You are a clipboard-sync diagnostics assistant. Using the device and sync-log information below, judge whether the sync pipeline is healthy (which devices are online, whether recent sends/receives look normal, any signs of long-term no-sync), and output: 1) a health verdict; 2) anomalies (if any); 3) a troubleshooting and improvement checklist.',
    ],
  },
  review: {
    zh: [
      '你是桌面端设置审查助手。以下是客户端设置快照，每行格式为「- [分节key] 设置名: 值」。',
      '请逐项检查是否存在风险或不合理之处（例如历史上限过小、隐私模式未开启但剪贴板常含敏感信息、同步间隔过长等）。',
      '只输出 JSON，不要任何解释文字或代码围栏，格式：',
      '{"items":[{"key":"分节key","level":"ok|warn|risk","advice":"一句话建议"}]}',
      'items 必须覆盖快照每一行；key 只能取行首方括号中的分节key；advice 为一句话建议，ok 项也给维持现状的肯定建议。',
    ],
    en: [
      'You are a desktop-settings review assistant. Below is a snapshot of the client settings, one per line as "- [sectionKey] setting name: value".',
      'Review every item for risks or unreasonable values (for example a tiny history limit, privacy mode disabled while the clipboard often holds sensitive content, an overly long sync interval).',
      'Output JSON only — no explanatory text, no code fences — in this shape:',
      '{"items":[{"key":"sectionKey","level":"ok|warn|risk","advice":"one-sentence advice"}]}',
      'items must cover every line of the snapshot; key must be the sectionKey from the square brackets at the start of the line; advice is one sentence, and ok items should still get an affirmative keep-as-is advice.',
    ],
  },
  summarizeToday: {
    zh: ['请根据以下今日剪贴板条目摘要，总结今天的工作动态：按主题归类列出要点，最后给一句整体小结。简明扼要。'],
    en: [
      "Based on today's clipboard item summaries below, summarize today's activity: group the highlights by topic and close with one overall sentence. Keep it concise.",
    ],
  },
  organizeFavorites: {
    zh: [
      '你是剪贴板收藏整理助手。参考上下文是收藏条目的索引清单，每行格式为「#序号 [类型] 内容摘要」（序号从 0 开始）。',
      '请把这批收藏整理为「分组（合集）」与「标签」两类建议。',
      '',
      '只输出一个 JSON 对象（不要 markdown 代码围栏、不要任何解释文字），结构如下：',
      '{"groups":[{"name":"分组名","icon":"folder","itemRefs":[0,1]}],"tags":[{"name":"标签名","color":"#RRGGBB","itemRefs":[2,3]}]}',
      '',
      '要求：',
      '- groups：2~6 个，每组名称 2~10 个字；itemRefs 是该组应包含的条目序号数组；每组至少 2 条，不要为单条建组；icon 可省略',
      '- tags：2~8 个，每个名称 2~6 个字；itemRefs 是适合打该标签的条目序号数组；color 可省略',
      '- 同一条目可同时出现在多个组/多个标签中；无法归类的条目不要强行列入',
      '- itemRefs 只能引用清单中出现过的序号，不要编造',
      '- 只输出 JSON 对象本身，不要输出其它内容',
    ],
    en: [
      'You are a clipboard-favorites organizer. The reference context is an index list of favorite items, one per line as "#index [type] content preview" (index starts at 0).',
      'Organize these favorites into two kinds of suggestions: "groups (collections)" and "tags".',
      '',
      'Output a single JSON object only (no markdown code fences, no explanatory text), shaped like:',
      '{"groups":[{"name":"group name","icon":"folder","itemRefs":[0,1]}],"tags":[{"name":"tag name","color":"#RRGGBB","itemRefs":[2,3]}]}',
      '',
      'Requirements:',
      '- groups: 2~6 of them, each name 2~10 words; itemRefs is the array of item indexes in that group; at least 2 items per group, never create a group for a single item; icon is optional',
      '- tags: 2~8 of them, each name 2~6 words; itemRefs is the array of item indexes that fit the tag; color is optional',
      '- an item may appear in several groups/tags at once; do not force items that do not fit',
      '- itemRefs may only reference indexes that appear in the list; never invent any',
      '- output the JSON object itself and nothing else',
    ],
  },
  generateTemplate: {
    zh: [
      '你是剪贴板文本模板生成助手。参考上下文是用户对模板的需求描述（一句话或要点）。',
      '请据此起草一个可直接复用的文本模板：正文是骨架文本，需要用户填写的动态内容用 {{变量名}} 占位符表示，变量名只用英文字母/数字/下划线。',
      '',
      '只输出一个 JSON 对象（不要 markdown 代码围栏、不要任何解释文字），结构如下：',
      '{"name":"模板名","content":"模板正文，占位符写成 {{变量名}}","variables":["变量名1","变量名2"]}',
      '',
      '要求：',
      '- name：2~30 个字，概括模板用途',
      '- content：多行文本骨架；同一变量可出现多次；正文里不要出现 JSON 转义痕迹',
      '- variables：与 content 中出现的占位符一一对应（去重、按出现顺序排列）',
      '- 只输出 JSON 对象本身，不要输出其它内容',
    ],
    en: [
      'You are a clipboard text-template generator. The reference context is the user’s description of what the template should do (a sentence or a few bullet points).',
      'Draft a directly reusable text template: the body is skeleton text, and dynamic parts the user must fill in use {{variable_name}} placeholders; variable names may contain letters, digits and underscores only.',
      '',
      'Output a single JSON object only (no markdown code fences, no explanatory text), shaped like:',
      '{"name":"template name","content":"template body with {{variable_name}} placeholders","variables":["variable_name_1","variable_name_2"]}',
      '',
      'Requirements:',
      '- name: 2~30 words summarizing the purpose',
      '- content: a multi-line skeleton; the same variable may appear several times; no JSON escaping artifacts in the body',
      '- variables: one entry per placeholder used in content (de-duplicated, in order of appearance)',
      '- output the JSON object itself and nothing else',
    ],
  },
  summarizeCollection: {
    zh: [
      '总结这个合集：以下是当前收藏条目清单（每行 #序号 [类型] id=条目ID 内容前80字）。',
      '请总结这批收藏的主题分布与要点：',
      '- 先用 2~3 句话概括整体构成；',
      '- 再按主题/类型分布列出要点（每条一行，简短）；',
      '- 如有明显的整理建议（某类内容偏多、可归档等）可附一句。',
      '不要逐条复述清单。',
    ],
    en: [
      'Summarize this collection. Below is the list of favorite items (each line: #index [type] id=itemID first 80 chars of content).',
      'Summarize the topic distribution and highlights of these favorites:',
      '- start with 2~3 sentences describing the overall make-up;',
      '- then list highlights grouped by topic/type (one short line each);',
      '- add one line of organizing advice if there is something obvious (e.g. one category dominates, some items can be archived).',
      'Do not repeat the list item by item.',
    ],
  },
  drawerSummary: {
    zh: ['请总结以下内容：提炼核心要点与主题，简明扼要。'],
    en: ['Summarize the following content: extract the key points and main themes, and keep it concise.'],
  },
  drawerExtract: {
    zh: ['请从以下内容中提取关键信息（要点、链接、数字、代码要点等），以简洁列表输出。'],
    en: [
      'Extract the key information from the following content (points, links, numbers, code highlights, …) and output a concise list.',
    ],
  },
  drawerTranslate: {
    // 目标语言固定英文（动作本身就是"翻译为英文"），与界面语言无关
    zh: ['请将以下内容完整翻译为英文，只输出译文，不要附加解释。'],
    en: [
      'Translate the following content into English completely; output the translation only, with no extra explanation.',
    ],
  },
}

/** 当前界面语言（与 X-UI-Locale 同源） */
export function inlinePromptLocale(): 'zh' | 'en' {
  return uiLocaleHeader()
}

/**
 * 取某个页内小功能的提示词：正文按当前界面语言，**末尾**再补一句语言要求。
 * 每次调用实时取语言 ⇒ 切语言后下一个请求立刻生效。
 */
export function inlinePromptFor(variant: InlinePromptVariant): string {
  const lang = inlinePromptLocale()
  const body = INLINE_PROMPTS[variant][lang].join('\n')
  return `${body}\n\n${INLINE_LANG_TAIL[lang]}`
}
