<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { ChevronDown, Check } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

const props = defineProps<{
  modelValue?: string
  class?: string
  size?: 'sm' | 'default'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const open = ref(false)
const dropUp = ref(false)
const dropRight = ref(false)
const dropdownRef = ref<HTMLElement | null>(null)

// 向上找第一个会裁剪溢出内容的祖先（对话框滚动容器等），作为边界参考
function findClipAncestor(el: HTMLElement): HTMLElement | null {
  let p = el.parentElement
  while (p && p !== document.body) {
    const ov = getComputedStyle(p).overflowX
    if (ov === 'auto' || ov === 'scroll' || ov === 'hidden') return p
    p = p.parentElement
  }
  return null
}

// 展开前测一下上下方空间：下方放不下且上方更宽裕时朝上弹，
// 菜单右缘超出裁剪容器时改为右对齐，避免被对话框边缘截断
async function toggle() {
  open.value = !open.value
  if (open.value) {
    dropUp.value = false
    dropRight.value = false
    await nextTick()
    const anchor = dropdownRef.value
    const menu = anchor?.querySelector('.custom-select-dropdown') as HTMLElement | null
    if (!anchor || !menu) return
    const rect = anchor.getBoundingClientRect()
    const menuWidth = menu.offsetWidth
    const need = Math.min(menu.scrollHeight, 240) + 8
    const below = window.innerHeight - rect.bottom
    const above = rect.top
    dropUp.value = below < need && above > below
    const clip = findClipAncestor(anchor)
    const limit = clip ? clip.getBoundingClientRect().right - 8 : window.innerWidth - 8
    dropRight.value = rect.left + menuWidth > limit && rect.right - menuWidth >= (clip ? clip.getBoundingClientRect().left + 8 : 8)
  }
}
function select(value: string) {
  emit('update:modelValue', value)
  open.value = false
}

// Close dropdown when modelValue changes externally (e.g. from @select handler)
let lastModelValue: string | undefined
watch(
  () => props.modelValue,
  (val) => {
    if (open.value && val !== lastModelValue) {
      open.value = false
    }
    lastModelValue = val
  },
)

function handleClickOutside(e: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    open.value = false
  }
}

onMounted(() => document.addEventListener('mousedown', handleClickOutside))
onUnmounted(() => document.removeEventListener('mousedown', handleClickOutside))
</script>

<template>
  <div ref="dropdownRef" class="custom-select" :class="props.class">
    <button
      type="button"
      class="custom-select-trigger"
      :class="{ 'custom-select-trigger-sm': props.size === 'sm' }"
      :style="
        props.size === 'sm'
          ? 'height: 32px !important; min-height: 32px !important; padding: 0 12px !important; font-size: 13px !important;'
          : undefined
      "
      @click="toggle"
    >
      <span class="custom-select-trigger-text"><slot /></span>
      <ChevronDown class="custom-select-chevron" :class="{ open: open }" />
    </button>
    <div
      v-if="open"
      class="custom-select-dropdown"
      :class="{ 'custom-select-dropdown--up': dropUp, 'custom-select-dropdown--right': dropRight }"
    >
      <slot name="options" />
    </div>
  </div>
</template>

<style scoped>
.custom-select {
  position: relative;
  width: 160px;
  height: 32px;
  min-height: 32px;
}

.custom-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  min-height: 32px;
  padding: 0 14px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  outline: none;
}

.custom-select-trigger:hover {
  border-color: var(--border-focus);
}

.custom-select-trigger:focus {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px var(--accent-light);
}

.custom-select-trigger-sm {
  /* height/padding/font-size now controlled by inline CSS vars from :style binding */
}

.custom-select-chevron {
  width: 16px;
  height: 16px;
  color: var(--text-tertiary);
  transition: transform 0.2s;
  flex-shrink: 0;
}

.custom-select-chevron.open {
  transform: rotate(180deg);
}

.custom-select-trigger-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.custom-select-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 100%;
  width: max-content;
  max-width: min(420px, 80vw);
  /* 超高菜单内部滚动，绝不撑破宿主容器（否则对话框会被顶出滚动条） */
  max-height: 240px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-dropdown);
  z-index: var(--z-dropdown);
  overflow-x: hidden;
  overflow-y: auto;
  animation: selectSlideIn 0.15s ease;
}

/* 下方空间不足时朝上弹（toggle() 里测量后追加） */
.custom-select-dropdown--up {
  top: auto;
  bottom: calc(100% + 6px);
  animation: selectSlideInUp 0.15s ease;
}

/* 右缘会超出裁剪容器时改为右对齐（向左伸展） */
.custom-select-dropdown--right {
  left: auto;
  right: 0;
}

@keyframes selectSlideInUp {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes selectSlideIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
