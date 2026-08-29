import { ref, computed } from 'vue'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'

type Lang = 'en' | 'zh'
type I18nDict = Record<string, string>

const _dicts: Record<Lang, I18nDict> = { en, zh }

const SAVED_LANG_KEY = 'clipsync-lang'

/** 首次启动（无本地偏好）时按浏览器/系统语言选择：zh* → 中文，其余一律英文 */
function detectInitialLang(): Lang {
  const saved = localStorage.getItem(SAVED_LANG_KEY) as Lang | null
  if (saved === 'en' || saved === 'zh') return saved
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : ''
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

const _lang = ref<Lang>(detectInitialLang())

function applyDocumentLang(lang: Lang) {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }
}
applyDocumentLang(_lang.value)

export function useI18n() {
  const currentLang = computed(() => _lang.value)
  const dict = computed(() => _dicts[_lang.value])

  function t(key: string, fallbackOrParams?: string | Record<string, string | number>): string {
    let val = dict.value[key]
    if (!val) val = _dicts.en[key] || ''
    if (typeof fallbackOrParams === 'string') {
      if (!val) val = fallbackOrParams
    } else if (fallbackOrParams) {
      Object.entries(fallbackOrParams).forEach(([k, v]) => {
        val = (val || '').replace(`{${k}}`, String(v))
      })
    }
    return val || key
  }

  /**
   * Fallback-first variant: returns `fallback` instead of the raw key literal when missing。
   * 可选第三参 params 用于 `{name}` 占位符替换（仅在命中词典时替换）。
   */
  function tf(key: string, fallback: string, params?: Record<string, string | number>): string {
    let val = dict.value[key] || _dicts.en[key]
    if (!val) return fallback
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        val = val.replace(`{${k}}`, String(v))
      })
    }
    return val
  }

  /** key 是否存在于当前语言或英文兜底词典 */
  function te(key: string): boolean {
    return Boolean(dict.value[key] || _dicts.en[key])
  }

  /**
   * 翻译"可能本身就是 i18n key 的动态文本"（后端回传的错误码 / 错误消息）。
   * - 命中词典 → 返回译文；
   * - 未命中 → 原样返回（说明它就是普通句子，不是 key）。
   * 用于杜绝界面上直接渲染裸 key（如 `ai_approve_failed`）。
   */
  function tMsg(value?: string | null, fallback = ''): string {
    const s = (value ?? '').toString().trim()
    if (!s) return fallback
    if (!/^[a-z][a-z0-9_]{2,60}$/.test(s)) return s
    if (!te(s)) return s
    return t(s)
  }

  function setLang(lang: Lang) {
    _lang.value = lang
    localStorage.setItem(SAVED_LANG_KEY, lang)
    applyDocumentLang(lang)
  }

  return { currentLang, t, tf, te, tMsg, setLang }
}
