<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'primary' | 'ghost' | 'outline' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
  disabled?: boolean
  full?: boolean
}>(), { variant: 'primary', size: 'md', loading: false, disabled: false, full: false })
</script>

<template>
  <button
    class="btn"
    :class="[`btn-${variant}`, `btn-${size}`, { 'btn-full': full, 'btn-loading': loading }]"
    :disabled="disabled || loading"
  >
    <span v-if="loading" class="btn-spinner" />
    <slot />
  </button>
</template>

<style scoped>
.btn { display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-sm); font-weight: 500; cursor: pointer; border: 1px solid transparent; transition: all 150ms; white-space: nowrap; font-family: inherit; }
.btn-primary { background: var(--accent); color: var(--text-inverse); }
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-ghost { background: transparent; color: var(--text-secondary); border: none; }
.btn-ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.btn-outline { background: transparent; border-color: var(--border-default); color: var(--text-secondary); }
.btn-outline:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.btn-danger { background: var(--danger); color: #fff; }
.btn-danger:hover:not(:disabled) { opacity: 0.9; }
.btn-sm { height: 28px; padding: 0 10px; font-size: 12px; }
.btn-md { height: 34px; padding: 0 14px; font-size: 13px; }
.btn-full { width: 100%; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 6px; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
