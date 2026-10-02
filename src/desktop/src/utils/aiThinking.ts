// === 思考强度（reasoning effort）===
// 契约 v2（与服务端冻结、字段名以此为准）：枚举 5 档 low | medium | high | xhigh | max，
// **原样透传给上游**——前端不再持有"档位 → 上游取值"的映射表（三档映射编辑已按用户要求下线）。
//
// 文案策略：用户明确要求这些档位直接显示英文、不要翻译成"低/中/高"。因此中英 locale 里
// 同名 key 的取值都写成同一份英文（locales/{zh,en}.json），这里的常量同时作为词典缺 key 时的
// 兜底，保证无论当前语言是什么，渲染出来的一定是英文。
//
// 持久化的白名单就是本文件的 THINKING_STRENGTHS：xhigh / max 是合法档位，
// 读取（localStorage / GET /api/ai/settings）与提交（PUT /api/ai/settings）都不许把它们拦掉。

/** 5 档思考强度，顺序即界面展示顺序 */
export const THINKING_STRENGTHS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type ThinkingStrength = (typeof THINKING_STRENGTHS)[number]

/** 界面展示文案（英文，不翻译），也是 i18n 词典缺 key 时的兜底 */
export const THINKING_STRENGTH_LABELS: Record<ThinkingStrength, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Xhigh',
  max: 'Max',
}

/** 默认档位（旧数据没有该字段时用它，与既有行为一致） */
export const DEFAULT_THINKING_STRENGTH: ThinkingStrength = 'medium'

/** localStorage 瞬时回退键（DB 为准，键名沿用历史值，避免升级后用户选择丢失） */
export const THINKING_STRENGTH_STORAGE_KEY = 'ai-thinking-strength'

export function isThinkingStrength(v: unknown): v is ThinkingStrength {
  return typeof v === 'string' && (THINKING_STRENGTHS as readonly string[]).includes(v)
}

/** 未知/空值兜底 medium；xhigh / max 是合法档位，原样返回（不被白名单拦掉） */
export function normalizeThinkingStrength(v?: string | null): ThinkingStrength {
  return isThinkingStrength(v) ? v : DEFAULT_THINKING_STRENGTH
}

/** 读 localStorage 里的瞬时回退值（无 window / 脏数据一律兜底默认档） */
export function readStoredThinkingStrength(): ThinkingStrength {
  if (typeof localStorage === 'undefined') return DEFAULT_THINKING_STRENGTH
  return normalizeThinkingStrength(localStorage.getItem(THINKING_STRENGTH_STORAGE_KEY))
}

/** 写 localStorage 瞬时回退值（AI 侧栏与设置页共享同一键） */
export function writeStoredThinkingStrength(v: ThinkingStrength): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(THINKING_STRENGTH_STORAGE_KEY, v)
}
