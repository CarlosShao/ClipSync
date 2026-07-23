import { ref, computed } from 'vue'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'

type Lang = 'en' | 'zh'
type I18nDict = Record<string, string>

const _lang = ref<Lang>('zh')
const _dicts: Record<Lang, I18nDict> = { en, zh }

const SAVED_LANG_KEY = 'clipsync-lang'

export function useI18n() {
  const saved = localStorage.getItem(SAVED_LANG_KEY) as Lang | null
  if (saved === 'en' || saved === 'zh') _lang.value = saved

  const currentLang = computed(() => _lang.value)
  const dict = computed(() => _dicts[_lang.value])

  function t(key: string, fallbackOrParams?: string | Record<string, string | number>): string {
    let val = dict.value[key]
    if (!val) val = _dicts.en[key] ?? key
    if (typeof fallbackOrParams === 'string') {
      if (val === key) val = fallbackOrParams
    } else if (fallbackOrParams) {
      Object.entries(fallbackOrParams).forEach(([k, v]) => {
        val = val.replace(`{${k}}`, String(v))
      })
    }
    return val
  }

  function setLang(lang: Lang) {
    _lang.value = lang
    localStorage.setItem(SAVED_LANG_KEY, lang)
  }

  return { currentLang, t, setLang }
}
