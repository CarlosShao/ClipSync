<script setup lang="ts">
defineProps<{
  modelValue: string
  placeholder?: string
  type?: string
  maxlength?: number
  error?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <div class="field-group">
    <slot name="label" />
    <input
      :value="modelValue"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      :type="type || 'text'"
      :placeholder="placeholder"
      :maxlength="maxlength"
      class="field-input"
      :class="{ 'field-error': error }"
    />
    <div v-if="error" class="field-err-text">{{ error }}</div>
  </div>
</template>

<style scoped>
.field-group { display: flex; flex-direction: column; gap: 6px; }
.field-input { height: 38px; padding: 0 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-default); background: var(--bg-base); color: var(--text-primary); font-size: 14px; outline: none; font-family: inherit; }
.field-input:focus { border-color: var(--border-focus); }
.field-error { border-color: var(--danger) !important; }
.field-err-text { font-size: 11.5px; color: var(--danger); margin-top: 2px; }
</style>
