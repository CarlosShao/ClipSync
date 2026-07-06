<script setup lang="ts">
defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <button
    :class="['toggle', { on: modelValue }]"
    @click="emit('update:modelValue', !modelValue)"
    type="button"
    :aria-pressed="modelValue"
  />
</template>

<style scoped>
.toggle { position: relative; display: inline-block; width: 40px; height: 22px; cursor: pointer; border-radius: 11px; background: var(--border-default); border: none; padding: 0; flex-shrink: 0; transition: background 0.2s; }
.toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: white; transition: left 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,.15); }
.toggle.on { background: var(--accent); }
.toggle.on::after { left: 20px; }
</style>
