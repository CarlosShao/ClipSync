<template>
  <div class="settings-group">
    <div class="sg-header">{{ t('sg_appear') }}</div>
    <div class="sg-row sg-row--clickable" @click="emit('open-sub-page', 'themes')">
      <div class="sg-label"><div class="sg-name">{{ t('sg_theme') }}</div><div class="sg-hint">{{ t('sg_theme_h') }}</div></div>
      <ChevronRight class="sg-arrow" />
    </div>
    <div class="sg-row">
      <div class="sg-label"><div class="sg-name">{{ t('sg_mode') }}</div><div class="sg-hint">{{ t('sg_mode_h') }}</div></div>
      <div class="mode-seg-shadcn">
        <Button variant="ghost" size="sm" class="mode-seg-btn-shadcn" :class="{ active: currentMode === 'light' }" @click="setMode('light')">
          <Sun :size="14" />
          <span>{{ t('mode_light') }}</span>
        </Button>
        <Button variant="ghost" size="sm" class="mode-seg-btn-shadcn" :class="{ active: currentMode === 'dark' }" @click="setMode('dark')">
          <Moon :size="14" />
          <span>{{ t('mode_dark') }}</span>
        </Button>
      </div>
    </div>
    <div class="sg-row">
      <div class="sg-label"><div class="sg-name sg-name--hint">{{ t('sg_theme_hint') }}</div></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { useTheme, currentMode } from '@/composables/useTheme'
import Button from '@/components/ui/button/Button.vue'
import { ChevronRight, Sun, Moon } from 'lucide-vue-next'

const { t } = useI18n()
const { setMode } = useTheme()

const emit = defineEmits<{
  'open-sub-page': [page: string]
}>()
</script>

<style scoped>
/* settings-group & sg-* base classes (replicated from SettingsView) */
.settings-group { margin-bottom: 24px; }
.sg-header { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--text-tertiary); margin-bottom: 8px; }
.sg-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: var(--radius-md); gap: 16px; }
.sg-row:hover { background: var(--bg-hover); }
.sg-row--clickable { cursor: pointer; }
.sg-label { flex: 1; min-width: 0; }
.sg-name { font-size: 14px; font-weight: 500; }
.sg-name--hint { font-size: 12px; }
.sg-hint { font-size: 12px; color: var(--text-secondary); margin-top: 1px; }
.sg-arrow { width: 16px; height: 16px; color: var(--text-tertiary); flex-shrink: 0; }

/* mode-seg: shadcn Button based segmented control */
.mode-seg-shadcn {
  display: inline-flex;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--bg-hover);
  flex-shrink: 0;
}
.mode-seg-btn-shadcn {
  /* Override shadcn ghost: transparent bg by default, no scale on active */
  background: transparent !important;
  border: none;
  border-radius: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
  /* Kill shadcn base active:scale-[0.98] */
  --tw-scale-x: 1;
  --tw-scale-y: 1;
}
.mode-seg-btn-shadcn:hover {
  color: var(--text-primary);
  background: var(--bg-active) !important;
}
.mode-seg-btn-shadcn.active {
  background: var(--bg-surface) !important;
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: var(--shadow-card);
}
.mode-seg-btn-shadcn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--bg-surface), 0 0 0 4px var(--ring);
}
.mode-seg-btn-shadcn:active {
  --tw-scale-x: 1;
  --tw-scale-y: 1;
}
</style>
