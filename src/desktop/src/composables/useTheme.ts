import { ref, computed, watch } from 'vue'
import type { ThemeStyle, ThemeMode } from '@/types'
import { setTitlebarMode } from '@/lib/tauri'

const THEME_STYLE_KEY = 'clipsync-theme-style'
const THEME_MODE_KEY = 'clipsync-theme-mode'
// Clearline 一次性迁移标记：老用户 localStorage 里存的是旧默认（vercel 等），
// 不迁移的话他们永远看不到新皮肤。迁移后用户在设置里重新选择的主题会被尊重。
const THEME_MIGRATED_KEY = 'clipsync-theme-migrated-clearline'

function initialStyle(): ThemeStyle {
  if (!localStorage.getItem(THEME_MIGRATED_KEY)) {
    localStorage.setItem(THEME_MIGRATED_KEY, '1')
    return 'clearline'
  }
  return (localStorage.getItem(THEME_STYLE_KEY) as ThemeStyle) || 'clearline'
}

// Live-tracked system color-scheme preference (used when mode === 'system')
const systemColorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
const systemPrefersDark = ref(systemColorSchemeQuery.matches)
systemColorSchemeQuery.addEventListener('change', (e) => {
  systemPrefersDark.value = e.matches
})

export const currentStyle = ref<ThemeStyle>(initialStyle())

// Persisted user preference: 'light' | 'dark' | 'system' (default 'light' keeps backward compat)
export const currentMode = ref<ThemeMode>((localStorage.getItem(THEME_MODE_KEY) as ThemeMode) || 'light')

// The mode actually applied to the DOM — 'system' resolves to the OS preference
export const resolvedMode = computed<'light' | 'dark'>(() =>
  currentMode.value === 'system' ? (systemPrefersDark.value ? 'dark' : 'light') : currentMode.value
)

const allThemes: { value: ThemeStyle; label: string; previewColor: string }[] = [
  { value: 'clearline', label: 'Clearline 澄明', previewColor: '#3A6BE0' },
  { value: 'vercel', label: 'Vercel', previewColor: '#FAFAFA' },
  { value: 'clipsync', label: 'ClipSync Fusion', previewColor: '#FBF8FF' },
  { value: 'notion', label: 'Notion', previewColor: '#FFFFFF' },
  { value: 'linear', label: 'Linear', previewColor: '#080808' },
  { value: 'apple', label: 'Apple HIG', previewColor: '#F5F5F7' },
  { value: 'raycast', label: 'Raycast', previewColor: '#07080a' },
  { value: 'arc', label: 'Arc', previewColor: '#FEFEFE' },
]

function applyTheme() {
  const html = document.documentElement

  // Remove all theme classes
  allThemes.forEach((t) => html.classList.remove(`theme-${t.value}`))
  html.classList.remove('light', 'dark')

  // Add new ones (mode class follows the resolved mode — system preference included)
  html.classList.add(`theme-${currentStyle.value}`, resolvedMode.value)

  // Save (persist the raw preference, 'system' included)
  localStorage.setItem(THEME_STYLE_KEY, currentStyle.value)
  localStorage.setItem(THEME_MODE_KEY, currentMode.value)

  // Sync Tauri title bar
  try {
    setTitlebarMode(resolvedMode.value === 'dark')
  } catch {
    /* desktop only */
  }
}

// Auto-apply when style or mode changes, or when the OS preference flips in 'system' mode
watch([currentStyle, currentMode, systemPrefersDark], applyTheme, { immediate: true })

export function useTheme() {
  return {
    currentStyle,
    currentMode,
    resolvedMode,
    allThemes,
    setStyle: (s: ThemeStyle) => {
      currentStyle.value = s
    },
    toggleMode: () => {
      // Explicit user choice — leaves 'system' mode with the opposite of the resolved mode
      currentMode.value = resolvedMode.value === 'dark' ? 'light' : 'dark'
    },
    setMode: (m: ThemeMode) => {
      currentMode.value = m
    },
  }
}
