<template>
  <div class="settings-group">
    <div class="sg-header">{{ t('sg_appear') }}</div>
    <div class="sg-row sg-row--clickable" @click="emit('open-sub-page', 'themes')">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_theme') }}</div>
        <div class="sg-hint">{{ t('sg_theme_h') }}</div>
      </div>
      <ChevronRight class="sg-arrow" />
    </div>
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_mode') }}</div>
        <div class="sg-hint">{{ t('sg_mode_h') }}</div>
      </div>
      <div class="mode-seg-shadcn">
        <Button
          variant="ghost"
          size="sm"
          class="mode-seg-btn-shadcn"
          :class="{ active: currentMode === 'light' }"
          @click="setMode('light')"
        >
          <Sun :size="14" />
          <span>{{ t('mode_light') }}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class="mode-seg-btn-shadcn"
          :class="{ active: currentMode === 'dark' }"
          @click="setMode('dark')"
        >
          <Moon :size="14" />
          <span>{{ t('mode_dark') }}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class="mode-seg-btn-shadcn"
          :class="{ active: currentMode === 'system' }"
          @click="setMode('system')"
        >
          <Monitor :size="14" />
          <span>{{ tf('mode_system', '跟随系统') }}</span>
        </Button>
      </div>
    </div>

    <!-- 界面字号 -->
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('ap_font_size') }}</div>
        <div class="sg-hint">{{ t('ap_font_size_h') }}</div>
      </div>
      <div class="mode-seg-shadcn">
        <button
          v-for="opt in FONT_SIZES"
          :key="opt.v"
          type="button"
          class="mode-seg-btn-shadcn"
          :class="{ active: configStore.fontScale === opt.v }"
          @click="configStore.setFontScale(opt.v)"
        >
          {{ t(opt.key) }}
        </button>
      </div>
    </div>

    <!-- 界面字体 -->
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('ap_font_family') }}</div>
        <div class="sg-hint">{{ t('ap_font_family_h') }}</div>
      </div>
      <div class="mode-seg-shadcn">
        <button
          v-for="opt in FONT_FAMILIES"
          :key="opt.v"
          type="button"
          class="mode-seg-btn-shadcn"
          :class="{ active: configStore.fontFamily === opt.v }"
          :style="opt.preview"
          @click="configStore.setFontFamily(opt.v)"
        >
          {{ t(opt.key) }}
        </button>
      </div>
    </div>

    <!-- 毛玻璃效果 -->
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('ap_frosted') }}</div>
        <div class="sg-hint">{{ t('ap_frosted_h') }}</div>
      </div>
      <Switch :model-value="configStore.frosted" @update:model-value="configStore.setFrosted($event)" />
    </div>

    <!-- 表面不透明度（毛玻璃开启时可见） -->
    <div v-if="configStore.frosted" class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('ap_surface_opacity') }}</div>
        <div class="sg-hint">{{ t('ap_surface_opacity_h') }}</div>
      </div>
      <div class="ap-slider-wrap">
        <input
          type="range"
          class="ap-slider"
          min="40"
          max="100"
          step="5"
          :value="configStore.surfaceOpacity"
          @input="configStore.setSurfaceOpacity(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="ap-slider-val">{{ configStore.surfaceOpacity }}%</span>
      </div>
    </div>

    <!-- 自定义背景图片 -->
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('ap_bg_image') }}</div>
        <div class="sg-hint">{{ t('ap_bg_image_h') }}</div>
      </div>
      <div class="ap-bg-actions">
        <input ref="bgFileRef" type="file" accept="image/*" class="ap-file-hidden" @change="handleBgFile" />
        <Button variant="outline" size="sm" @click="bgFileRef?.click()">{{ t('ap_bg_choose') }}</Button>
        <Button v-if="configStore.bgImage" variant="ghost" size="sm" @click="configStore.setBgImage('')">
          {{ t('ap_bg_clear') }}
        </Button>
      </div>
    </div>

    <!-- 背景压暗（设置了背景图时可见） -->
    <div v-if="configStore.bgImage" class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('ap_bg_dim') }}</div>
        <div class="sg-hint">{{ t('ap_bg_dim_h') }}</div>
      </div>
      <div class="ap-slider-wrap">
        <input
          type="range"
          class="ap-slider"
          min="0"
          max="60"
          step="5"
          :value="configStore.bgDim"
          @input="configStore.setBgDim(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="ap-slider-val">{{ configStore.bgDim }}%</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useTheme, currentMode } from '@/composables/useTheme'
import { useConfigStore } from '@/stores/configStore'
import Button from '@/components/ui/button/Button.vue'
import Switch from '@/components/ui/switch/Switch.vue'
import { ChevronRight, Sun, Moon, Monitor } from 'lucide-vue-next'

const { t, tf } = useI18n()
const { setMode } = useTheme()
const configStore = useConfigStore()
const bgFileRef = ref<HTMLInputElement | null>(null)

const emit = defineEmits<{
  'open-sub-page': [page: string]
}>()

const FONT_SIZES = [
  { v: 0.9, key: 'font_s' },
  { v: 1, key: 'font_m' },
  { v: 1.1, key: 'font_l' },
  { v: 1.25, key: 'font_xl' },
]
const FONT_FAMILIES = [
  { v: 'default', key: 'font_default', preview: '' },
  { v: 'yahei', key: 'font_yahei', preview: 'font-family: "Microsoft YaHei", sans-serif' },
  { v: 'serif', key: 'font_serif', preview: 'font-family: Georgia, "Noto Serif SC", serif' },
  { v: 'kai', key: 'font_kai', preview: 'font-family: "KaiTi", "STKaiti", serif' },
]

/** 背景图降采样：长边 ≤1920、JPEG 0.85，控制 localStorage 占用 */
function handleBgFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !file.type.startsWith('image/')) return
  const reader = new FileReader()
  reader.onload = () => {
    const img = new Image()
    img.onload = () => {
      const MAX = 1920
      const scale = Math.min(1, MAX / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      configStore.setBgImage(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.src = reader.result as string
  }
  reader.readAsDataURL(file)
}
</script>

<style scoped>
/* settings-group & sg-* base classes (replicated from SettingsView) */
.settings-group {
  margin-bottom: 24px;
}
.sg-header {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  margin-bottom: 8px;
}
.sg-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  gap: 16px;
}
.sg-row:hover {
  background: var(--bg-hover);
}
.sg-row--clickable {
  cursor: pointer;
}
.sg-label {
  flex: 1;
  min-width: 0;
}
.sg-name {
  font-size: 14px;
  font-weight: 500;
}
.sg-name--hint {
  font-size: 12px;
}
.sg-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 1px;
}
.sg-arrow {
  width: 16px;
  height: 16px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

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
  box-shadow:
    0 0 0 2px var(--bg-surface),
    0 0 0 4px var(--ring);
}
.mode-seg-btn-shadcn:active {
  --tw-scale-x: 1;
  --tw-scale-y: 1;
}

/* 滑杆行 */
.ap-slider-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.ap-slider {
  width: 160px;
  accent-color: var(--accent);
  cursor: pointer;
}
.ap-slider-val {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 40px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* 背景图操作 */
.ap-bg-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.ap-file-hidden {
  display: none;
}
</style>
