<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ClipboardList, Search, Sparkles, Sun, Moon, Bell, Minus, Square, Copy, X, PanelLeftClose, PanelLeftOpen } from 'lucide-vue-next'
import { useI18n } from '@/composables/useI18n'
import { useTheme, resolvedMode } from '@/composables/useTheme'

/**
 * Clearline 自定义标题栏（tauri.conf.json decorations:false 时接管系统标题栏）。
 * - 整条 header 为拖拽区（data-tauri-drag-region），品牌/面包屑文字可直接拖动；
 *   注意 Tauri 拖拽判定的是「按下时命中的元素自身」带该属性，因此属性要
 *   同时落在 header 与需要拖拽的文字元素上，按钮一律不加。
 * - 窗口控制走 getCurrentWindow()；浏览器 dev（无 TaurI IPC）下隐藏窗口按钮。
 * - minimal 模式用于登录页：只保留品牌 + 明暗切换 + 窗口控制。
 */
const props = defineProps<{
  currentSub?: string
  aiEnabled?: boolean
  aiOpen?: boolean
  unreadCount?: number
  minimal?: boolean
  sidebarOpen?: boolean
}>()

const emit = defineEmits<{
  'open-search': []
  'toggle-ai': []
  'toggle-sidebar': []
  navigate: [sub: string]
}>()

const { t } = useI18n()
const { toggleMode } = useTheme()

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const isMaximized = ref(false)
let unResized: (() => void) | null = null

onMounted(async () => {
  if (!isTauri) return
  try {
    const win = getCurrentWindow()
    isMaximized.value = await win.isMaximized()
    unResized = await win.onResized(async () => {
      try {
        isMaximized.value = await win.isMaximized()
      } catch {
        /* window closing */
      }
    })
  } catch {
    /* non-tauri context */
  }
})
onUnmounted(() => {
  unResized?.()
  unResized = null
})

function winMinimize() {
  if (isTauri) getCurrentWindow().minimize().catch((e) => console.warn('[TitleBar] minimize rejected:', e))
}
function winToggleMaximize() {
  if (isTauri) getCurrentWindow().toggleMaximize().catch((e) => console.warn('[TitleBar] toggleMaximize rejected:', e))
}
function winClose() {
  if (isTauri) getCurrentWindow().close().catch((e) => console.warn('[TitleBar] close rejected:', e))
}

const CRUMB_KEYS: Record<string, string> = {
  clipboard: 'nav_clipboard',
  archive: 'nav_archive',
  favorites: 'nav_favorites',
  templates: 'nav_templates',
  devices: 'nav_devices',
  profile: 'nav_profile',
  notifications: 'nav_notifications',
  subscription: 'nav_subscription',
}
const crumbLabel = computed(() => {
  const key = props.currentSub ? CRUMB_KEYS[props.currentSub] : ''
  return (key && t(key)) || t('app_name')
})
const isDark = computed(() => resolvedMode.value === 'dark')
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <div class="tb-left" data-tauri-drag-region>
      <span class="brand-mark" data-tauri-drag-region><ClipboardList :size="14" :stroke-width="2" /></span>
      <span class="brand-word" data-tauri-drag-region>ClipSync</span>
      <span class="tb-sep" data-tauri-drag-region />
      <span class="tb-crumb" data-tauri-drag-region>{{ crumbLabel }}</span>
      <button
        v-if="!minimal"
        type="button"
        class="tb-btn tb-sidebar-toggle"
        :title="sidebarOpen ? t('nav_collapse', '收起侧边栏') : t('nav_expand', '展开侧边栏')"
        @click="emit('toggle-sidebar')"
      >
        <component :is="sidebarOpen ? PanelLeftClose : PanelLeftOpen" :size="14" :stroke-width="2" />
      </button>
    </div>

    <button v-if="!minimal" class="cmdk-btn" :title="t('titlebar_search', '搜索或命令…')" @click="emit('open-search')">
      <Search :size="13" :stroke-width="2" />
      <span class="cmdk-text">{{ t('titlebar_search', '搜索或命令…') }}</span>
      <kbd class="cmdk-kbd">Ctrl K</kbd>
    </button>

    <div class="tb-right">
      <button
        v-if="!minimal && aiEnabled"
        class="tb-btn tb-btn--ai"
        :class="{ 'tb-btn--open': aiOpen }"
        :title="`${t('nav_ai')} · Ctrl+Shift+A`"
        @click="emit('toggle-ai')"
      >
        <Sparkles :size="15" :stroke-width="1.8" />
        <span>AI</span>
      </button>
      <button
        class="tb-btn"
        :title="isDark ? t('mode_light', '切换为浅色') : t('mode_dark', '切换为深色')"
        @click="toggleMode()"
      >
        <Sun v-if="isDark" :size="15" :stroke-width="1.8" />
        <Moon v-else :size="15" :stroke-width="1.8" />
      </button>
      <button v-if="!minimal" class="tb-btn tb-bell" :title="t('nav_notifications')" @click="emit('navigate', 'notifications')">
        <Bell :size="15" :stroke-width="1.8" />
        <i v-if="unreadCount && unreadCount > 0" class="tb-dot" />
      </button>
      <template v-if="isTauri">
        <span class="tb-sep tb-sep--gap" />
        <button class="tb-btn tb-win" :title="t('win_minimize', '最小化')" @click="winMinimize">
          <Minus :size="14" :stroke-width="2" />
        </button>
        <button class="tb-btn tb-win" :title="isMaximized ? t('win_restore', '还原') : t('win_maximize', '最大化')" @click="winToggleMaximize">
          <Copy v-if="isMaximized" :size="11" :stroke-width="2" />
          <Square v-else :size="11" :stroke-width="2" />
        </button>
        <button class="tb-btn tb-win tb-win--close" :title="t('win_close', '关闭')" @click="winClose">
          <X :size="14" :stroke-width="2" />
        </button>
      </template>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 42px;
  flex-shrink: 0;
  padding: 0 10px 0 14px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-default);
  user-select: none;
  position: relative;
  z-index: var(--z-dropdown);
}
.tb-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.brand-mark {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  background: var(--accent-bg);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.brand-word {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text-primary);
  white-space: nowrap;
}
.tb-sep {
  width: 1px;
  height: 14px;
  background: var(--border-default);
  flex-shrink: 0;
}
.tb-sep--gap {
  margin-left: 6px;
}
.tb-crumb {
  font-size: 12.5px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 中部命令栏按钮（v2 cmdk）：整条可点，打开 Ctrl+K 面板 */
.cmdk-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  width: min(340px, 36vw);
  /* 原型：命令栏相对窗口恒定居中，不随左右两侧按钮宽度偏移 */
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  padding: 0 8px 0 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-full, 999px);
  background: var(--bg-base);
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 160ms var(--ease),
    background 160ms var(--ease),
    color 160ms var(--ease);
}
.cmdk-btn:hover {
  border-color: var(--border-focus);
  color: var(--text-secondary);
  background: var(--bg-surface);
}
.cmdk-text {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmdk-kbd {
  font-family: var(--font-content);
  font-size: 10px;
  line-height: 1;
  padding: 3px 5px;
  border: 1px solid var(--border-default);
  border-bottom-width: 2px;
  border-radius: 5px;
  background: var(--bg-surface);
  color: var(--text-tertiary);
  white-space: nowrap;
}

.tb-right {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  flex-shrink: 0;
}
.tb-sidebar-toggle {
  margin-left: 2px;
  color: var(--text-tertiary);
}
.tb-sidebar-toggle:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.tb-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  min-width: 28px;
  padding: 0 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition:
    background 160ms var(--ease),
    color 160ms var(--ease);
}
.tb-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.tb-btn--ai {
  gap: 4px;
  font-weight: 600;
}
.tb-btn--ai:hover,
.tb-btn--open {
  background: var(--accent-light);
  color: var(--accent);
}
.tb-bell .tb-dot {
  position: absolute;
  top: 5px;
  right: 4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
  border: 1.5px solid var(--bg-surface);
}

/* 窗口控制：Windows 原生习惯——关闭键 hover 变红 */
.tb-win {
  border-radius: var(--radius-sm);
}
.tb-win--close:hover {
  background: var(--danger);
  color: #fff;
}
</style>
