<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { ClipboardList, Star, LayoutTemplate, Laptop, Settings2, Sparkles, PanelTop, SunMoon, Search } from 'lucide-vue-next'

/**
 * 原型 cmdk 弹窗：全局搜索/命令入口（Ctrl K / 顶栏搜索框）。
 - 分组：前往（各业务页）、动作（AI 面板 / 快速粘贴模板 / 明暗主题）。
 - ↑↓ 选择、Enter 执行、Esc 关闭；输入即时过滤。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  close: []
  navigate: [sub: string]
  'toggle-ai': []
  'open-quick-paste': []
  'toggle-theme': []
}>()

const { t, tf } = useI18n()
const q = ref('')
const activeIdx = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLDivElement | null>(null)

interface Cmd {
  key: string
  group: string
  label: string
  hint?: string
  icon: any
  run: () => void
}

const cmds = computed<Cmd[]>(() => [
  { key: 'nav-clipboard', group: tf('cmd_group_nav', '前往'), label: t('nav_clipboard'), icon: ClipboardList, run: () => emit('navigate', 'clipboard') },
  { key: 'nav-favorites', group: tf('cmd_group_nav', '前往'), label: t('nav_favorites'), icon: Star, run: () => emit('navigate', 'favorites') },
  { key: 'nav-templates', group: tf('cmd_group_nav', '前往'), label: t('nav_templates'), icon: LayoutTemplate, run: () => emit('navigate', 'templates') },
  { key: 'nav-devices', group: tf('cmd_group_nav', '前往'), label: t('nav_devices'), icon: Laptop, run: () => emit('navigate', 'devices') },
  { key: 'nav-settings', group: tf('cmd_group_nav', '前往'), label: t('sg_title', '设置'), icon: Settings2, run: () => emit('navigate', 'settings') },
  { key: 'act-ai', group: tf('cmd_group_act', '动作'), label: tf('cmd_ai_panel', '呼出 AI 面板'), hint: 'Ctrl J', icon: Sparkles, run: () => emit('toggle-ai') },
  { key: 'act-qp', group: tf('cmd_group_act', '动作'), label: tf('cmd_quick_paste', '预览 快速粘贴模板'), hint: 'Ctrl Shift V', icon: PanelTop, run: () => emit('open-quick-paste') },
  { key: 'act-theme', group: tf('cmd_group_act', '动作'), label: tf('cmd_toggle_theme', '切换 明暗主题'), icon: SunMoon, run: () => emit('toggle-theme') },
])

const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase()
  if (!kw) return cmds.value
  return cmds.value.filter((c) => (c.label + c.group).toLowerCase().includes(kw))
})

const groups = computed(() => {
  const g = new Map<string, Cmd[]>()
  for (const c of filtered.value) {
    if (!g.has(c.group)) g.set(c.group, [])
    g.get(c.group)!.push(c)
  }
  return Array.from(g.entries()).map(([name, items]) => ({ name, items }))
})

const flat = computed(() => groups.value.flatMap((g) => g.items))

watch(
  () => props.open,
  async (open) => {
    if (open) {
      q.value = ''
      activeIdx.value = 0
      await nextTick()
      inputRef.value?.focus()
    }
  },
)

watch(filtered, () => (activeIdx.value = 0))

function move(dir: 1 | -1) {
  const n = flat.value.length
  if (!n) return
  activeIdx.value = (activeIdx.value + dir + n) % n
  nextTick(() => {
    const el = listRef.value?.querySelector('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function runCmd(cmd?: Cmd) {
  const c = cmd || flat.value[activeIdx.value]
  if (!c) return
  emit('close')
  c.run()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    runCmd()
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="cmdk-pop">
      <div v-if="open" class="cmdk-mask" @click.self="emit('close')">
        <div class="cmdk-panel" role="dialog" :aria-label="t('titlebar_search', '搜索或命令…')" @keydown="onKeydown">
          <div class="cmdk-input-row">
            <Search :size="14" />
            <input
              ref="inputRef"
              v-model="q"
              class="cmdk-input"
              :placeholder="tf('cmd_placeholder', '输入命令或搜索…')"
              :aria-label="t('titlebar_search', '搜索或命令…')"
            />
            <kbd class="cmdk-esc">Esc</kbd>
          </div>
          <div ref="listRef" class="cmdk-list">
            <template v-for="g in groups" :key="g.name">
              <div class="cmdk-group">{{ g.name }}</div>
              <button
                v-for="c in g.items"
                :key="c.key"
                class="cmdk-item"
                :data-active="flat[activeIdx]?.key === c.key"
                :data-idx="flat.indexOf(c)"
                @mousemove="activeIdx = flat.indexOf(c)"
                @click="runCmd(c)"
              >
                <component :is="c.icon" :size="14" />
                <span class="cmdk-label">{{ c.label }}</span>
                <kbd v-if="c.hint" class="cmdk-hint">{{ c.hint }}</kbd>
              </button>
            </template>
            <div v-if="filtered.length === 0" class="cmdk-empty">{{ t('no_results', '无匹配结果') }}</div>
          </div>
          <div class="cmdk-foot">
            <span><kbd>↑</kbd><kbd>↓</kbd> {{ tf('cmd_nav', '导航') }}</span>
            <span><kbd>Enter</kbd> {{ tf('cmd_run', '执行') }}</span>
            <span><kbd>Esc</kbd> {{ tf('cmd_close', '关闭') }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cmdk-mask {
  position: fixed;
  inset: 0;
  top: 44px;
  z-index: 8500;
  background: transparent;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 9vh;
}
.cmdk-panel {
  width: min(480px, 92vw);
  max-height: 62vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}
.cmdk-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-tertiary);
  flex: none;
}
.cmdk-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13.5px;
  color: var(--text-primary);
}
.cmdk-esc {
  font-family: var(--font-content);
  font-size: 10px;
  padding: 2px 6px;
  border: 1px solid var(--border-subtle);
  border-radius: 5px;
  color: var(--text-tertiary);
}
.cmdk-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}
.cmdk-group {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-tertiary);
  padding: 8px 8px 4px;
}
.cmdk-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.cmdk-item svg {
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.cmdk-item[data-active='true'] {
  background: var(--bg-active);
}
.cmdk-item[data-active='true'] svg {
  color: var(--accent);
}
.cmdk-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmdk-hint {
  font-family: var(--font-content);
  font-size: 10px;
  padding: 2px 6px;
  border: 1px solid var(--border-subtle);
  border-radius: 5px;
  color: var(--text-tertiary);
}
.cmdk-empty {
  padding: 28px 0;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 12.5px;
}
.cmdk-foot {
  display: flex;
  gap: 14px;
  padding: 8px 14px;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-tertiary);
  font-size: 10.5px;
  flex: none;
}
.cmdk-foot kbd {
  font-family: var(--font-content);
  font-size: 9.5px;
  padding: 1px 4px;
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  margin-right: 2px;
}
.cmdk-pop-enter-active,
.cmdk-pop-leave-active {
  transition: opacity 140ms var(--ease);
}
.cmdk-pop-enter-active .cmdk-panel,
.cmdk-pop-leave-active .cmdk-panel {
  transition: transform 140ms var(--ease);
}
.cmdk-pop-enter-from,
.cmdk-pop-leave-to {
  opacity: 0;
}
.cmdk-pop-enter-from .cmdk-panel,
.cmdk-pop-leave-to .cmdk-panel {
  transform: translateY(-6px);
}
</style>
