import { ref, watch } from 'vue'
import type { ThemeStyle, ThemeMode } from '@/types'
import { setTitlebarMode } from '@/lib/tauri'

const THEME_STYLE_KEY = 'clipsync-theme-style'
const THEME_MODE_KEY = 'clipsync-theme-mode'

export const currentStyle = ref<ThemeStyle>((localStorage.getItem(THEME_STYLE_KEY) as ThemeStyle) || 'vercel')

export const currentMode = ref<ThemeMode>((localStorage.getItem(THEME_MODE_KEY) as ThemeMode) || 'light')

const allThemes: { value: ThemeStyle; label: string; previewColor: string }[] = [
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

  // Add new ones
  html.classList.add(`theme-${currentStyle.value}`, currentMode.value)

  // Save
  localStorage.setItem(THEME_STYLE_KEY, currentStyle.value)
  localStorage.setItem(THEME_MODE_KEY, currentMode.value)

  // Sync Tauri title bar
  try {
    setTitlebarMode(currentMode.value === 'dark')
  } catch {
    /* desktop only */
  }
}

// Auto-apply when style or mode changes
watch([currentStyle, currentMode], applyTheme, { immediate: true })

export function useTheme() {
  return {
    currentStyle,
    currentMode,
    allThemes,
    setStyle: (s: ThemeStyle) => {
      currentStyle.value = s
    },
    toggleMode: () => {
      currentMode.value = currentMode.value === 'dark' ? 'light' : 'dark'
    },
    setMode: (m: ThemeMode) => {
      currentMode.value = m
    },
  }
}
