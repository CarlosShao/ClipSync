<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { useTheme } from '@/composables/useTheme'
import type { ThemeStyle } from '@/types'
import { Check } from 'lucide-vue-next'

const { t } = useI18n()
const { currentStyle, allThemes, setStyle } = useTheme()
const emit = defineEmits<{ back: [] }>()

const gradients: Record<ThemeStyle, { bg: string; text: string; border?: string }> = {
  vercel: { bg: 'linear-gradient(135deg,#FAFAFA 0%,#E5E5E5 100%)', text: '#111', border: '1px solid #E5E5E5' },
  clipsync: { bg: 'linear-gradient(135deg,#6366F1 0%,#A78BFA 100%)', text: '#fff' },
  notion: { bg: 'linear-gradient(135deg,#FFFFFF 0%,#EBF4FF 100%)', text: '#37352F', border: '1px solid #E8E7E3' },
  linear: { bg: 'linear-gradient(135deg,#0A0A0A 0%,#1a162d 100%)', text: '#fff' },
  apple: { bg: 'linear-gradient(135deg,#F5F5F7 0%,#E5F1FF 100%)', text: '#1D1D1F' },
  raycast: { bg: 'linear-gradient(135deg,#07080a 0%,#1b1c1e 100%)', text: '#fff' },
  arc: { bg: 'linear-gradient(135deg,#FEFEFE 0%,#F3EEFF 100%)', text: '#1A1A2E' },
}
</script>

<template>
  <div>
    <h3 class="sp-title">{{ t('sg_theme') }}</h3>
    <p class="sp-desc">{{ t('sg_theme_h') }}</p>
    <div class="theme-grid">
      <div
        v-for="theme in allThemes"
        :key="theme.value"
        class="theme-card"
        :class="{ active: currentStyle === theme.value }"
        @click="setStyle(theme.value as ThemeStyle)"
      >
        <div
          class="theme-preview"
          :style="{
            background: gradients[theme.value]?.bg,
            color: gradients[theme.value]?.text,
            border: gradients[theme.value]?.border || 'none',
          }"
        >
          {{ theme.value === 'vercel' ? 'Vercel ★' : theme.label }}
        </div>
        <div class="theme-name">
          {{ theme.label }}
          <Check v-if="currentStyle === theme.value" :size="14" class="theme-check" />
        </div>
      </div>
    </div>
    <p class="sp-hint">Linear 和 Raycast 是固定暗色系主题，不支持亮色模式。</p>
  </div>
</template>

<style scoped>
.sp-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
}
.sp-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 16px;
}
.sp-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 12px;
}
.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}
.theme-card {
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  overflow: hidden;
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
  background: var(--bg-surface);
}
.theme-card:hover {
  border-color: var(--border-focus);
}
.theme-card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.theme-preview {
  height: 56px;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
}
.theme-name {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}
.theme-check {
  color: var(--accent);
  flex-shrink: 0;
}
</style>
