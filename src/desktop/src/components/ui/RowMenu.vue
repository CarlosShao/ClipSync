<script setup lang="ts">
/**
 * 行内「⋯」溢出菜单（模型库行操作收敛用）。
 *
 * 设计约束（与项目既有 CustomSelect 同一套做法/皮肤）：
 *   · **常驻可发现**：⋯ 按钮永远显示（不靠 hover），键盘可达（Enter/Space 打开、Esc 关闭、方向键导航）；
 *   · 点外部关闭（document mousedown）；关闭后焦点**归位**到 ⋯ 按钮；
 *   · 弹层沿用 .aim-row-menu / 主题 token，≤160ms 淡入 + 少量位移，尊重减少动效；
 *   · 菜单项由调用方通过默认插槽渲染（自己给 role="menuitem" 与点击处理），
 *     插槽作用域提供 close()，点击任意菜单项后组件也会自动关闭。
 */
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { MoreHorizontal } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    /** 整体禁用（如草稿态无 providerId 时不该出现菜单） */
    disabled?: boolean
    /** ⋯ 按钮的 tooltip */
    title?: string
    /** 右对齐（靠近右边缘的行用） */
    alignEnd?: boolean
  }>(),
  { disabled: false, title: '', alignEnd: true },
)

const open = ref(false)
const dropUp = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)

function items(): HTMLButtonElement[] {
  const all = menuRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
  return all ? Array.from(all).filter((el) => !el.disabled) : []
}

async function toggle() {
  if (props.disabled) return
  open.value = !open.value
  if (!open.value) return
  dropUp.value = false
  await nextTick()
  const menu = menuRef.value
  if (!menu || !triggerRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  const need = Math.min(menu.scrollHeight, 240) + 8
  const below = window.innerHeight - rect.bottom
  dropUp.value = below < need && rect.top > below
}

function close(restoreFocus = false) {
  if (!open.value) return
  open.value = false
  if (restoreFocus) nextTick(() => triggerRef.value?.focus())
}

function onTriggerKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    if (!open.value) void toggle()
    nextTick(() => items()[0]?.focus())
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (!open.value) void toggle()
    nextTick(() => {
      const list = items()
      list[list.length - 1]?.focus()
    })
  }
}

function onMenuKeydown(e: KeyboardEvent) {
  const list = items()
  const idx = list.indexOf(document.activeElement as HTMLButtonElement)
  if (e.key === 'Escape') {
    e.preventDefault()
    close(true)
  } else if (e.key === 'Tab') {
    close(false)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    list[(idx + 1 + list.length) % list.length]?.focus()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    list[(idx - 1 + list.length) % list.length]?.focus()
  } else if (e.key === 'Home') {
    e.preventDefault()
    list[0]?.focus()
  } else if (e.key === 'End') {
    e.preventDefault()
    list[list.length - 1]?.focus()
  }
}

function onDocumentMouseDown(e: MouseEvent) {
  if (!open.value) return
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) close(false)
}

onMounted(() => document.addEventListener('mousedown', onDocumentMouseDown))
onUnmounted(() => document.removeEventListener('mousedown', onDocumentMouseDown))
</script>

<template>
  <div ref="rootRef" class="aim-row-more">
    <button
      ref="triggerRef"
      type="button"
      class="aim-icon aim-row-more-trigger"
      data-action="row-more"
      :class="{ on: open }"
      :disabled="disabled"
      :title="title"
      :aria-haspopup="'menu'"
      :aria-expanded="open"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <MoreHorizontal :size="14" />
    </button>
    <div
      v-if="open"
      ref="menuRef"
      class="aim-row-menu"
      :class="{ 'aim-row-menu--up': dropUp, 'aim-row-menu--end': alignEnd }"
      role="menu"
      data-action="row-menu"
      @keydown="onMenuKeydown"
      @click="close(true)"
    >
      <slot :close="() => close(true)" />
    </div>
  </div>
</template>

<style scoped>
.aim-row-more {
  position: relative;
  display: inline-flex;
}
/* 自带样式（不依赖宿主 scoped CSS 的 .aim-icon，保证任何宿主里外观一致） */
.aim-row-more-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.aim-row-more-trigger:hover:not(:disabled),
.aim-row-more-trigger.on {
  background: var(--bg-hover);
  border-color: var(--border-default);
  color: var(--text-primary);
}
.aim-row-more-trigger:focus-visible {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: 0 0 0 2px var(--accent-light);
  color: var(--text-primary);
}
.aim-row-more-trigger:disabled {
  opacity: 0.4;
  cursor: default;
}
.aim-row-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: var(--z-dropdown);
  min-width: 148px;
  padding: 4px 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  box-shadow: var(--shadow-dropdown);
  animation: aim-row-menu-in 140ms ease-out;
}
.aim-row-menu--up {
  top: auto;
  bottom: calc(100% + 6px);
}
.aim-row-menu--end {
  left: auto;
  right: 0;
}
@keyframes aim-row-menu-in {
  from {
    opacity: 0;
    transform: translateY(-2px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
html.reduce-motion .aim-row-menu {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  .aim-row-menu {
    animation: none;
  }
}
</style>
