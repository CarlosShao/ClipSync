<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
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
const dropdownRef = ref<HTMLElement | null>(null)

function toggle() {
  open.value = !open.value
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
      <slot />
      <ChevronDown class="custom-select-chevron" :class="{ open: open }" />
    </button>
    <div v-if="open" class="custom-select-dropdown">
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

.custom-select-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-dropdown);
  z-index: 50;
  overflow: hidden;
  animation: selectSlideIn 0.15s ease;
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
