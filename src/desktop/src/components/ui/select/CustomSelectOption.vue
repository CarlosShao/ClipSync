<script setup lang="ts">
import { Check } from 'lucide-vue-next'

defineProps<{
  value: string
  selected?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  select: [value: string]
}>()
</script>

<template>
  <div class="custom-select-option" :class="{ selected, disabled }" @click.stop="!disabled && emit('select', value)">
    <span class="option-text"><slot /></span>
    <Check v-if="selected" class="option-check" />
  </div>
</template>

<style scoped>
.custom-select-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.1s;
}

.custom-select-option:hover:not(.disabled) {
  background: var(--bg-hover);
}

.custom-select-option.selected {
  background: var(--accent-light);
  color: var(--accent);
  font-weight: 500;
}

.custom-select-option.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.option-text {
  flex: 1;
}

.option-check {
  width: 16px;
  height: 16px;
  color: var(--accent);
  flex-shrink: 0;
}
</style>
