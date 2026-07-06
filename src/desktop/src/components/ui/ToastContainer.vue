<script setup lang="ts">
import { useToast } from '@/composables/useToast'

const { toasts, dismiss } = useToast()

const typeStyles: Record<string, { bg: string; border: string; icon: string }> = {
  success: { bg: 'var(--success-bg)', border: 'var(--success)', icon: '✓' },
  error: { bg: 'var(--danger-bg)', border: 'var(--danger)', icon: '✕' },
  warning: { bg: 'var(--warning-bg)', border: 'var(--warning)', icon: '!' },
  info: { bg: 'var(--info-bg)', border: 'var(--info)', icon: 'i' },
}
</script>

<template>
  <Teleport to="body">
    <div class="toast-container">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="toast-item"
          :style="{
            background: typeStyles[toast.type].bg,
            borderLeft: `3px solid ${typeStyles[toast.type].border}`,
          }"
        >
          <span class="toast-icon" :style="{ color: typeStyles[toast.type].border }">
            {{ typeStyles[toast.type].icon }}
          </span>
          <span class="toast-message">{{ toast.message }}</span>
          <button class="toast-close" @click="dismiss(toast.id)">✕</button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-container {
  position: fixed; top: 16px; right: 16px; z-index: 99999;
  display: flex; flex-direction: column; gap: 8px;
  pointer-events: none;
}
.toast-item {
  pointer-events: auto;
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-radius: var(--radius-md);
  font-size: 13px; color: var(--text-primary);
  min-width: 260px; max-width: 400px;
  box-shadow: var(--shadow-elevated);
}
.toast-icon { font-weight: 700; font-size: 14px; flex-shrink: 0; width: 18px; text-align: center; }
.toast-message { flex: 1; }
.toast-close { background: none; border: none; cursor: pointer; opacity: 0.5; color: inherit; font-size: 12px; padding: 2px; }
.toast-close:hover { opacity: 1; }

/* Transition animations */
.toast-enter-active { animation: toastIn 0.2s ease; }
.toast-leave-active { animation: toastOut 0.3s ease; }
@keyframes toastIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes toastOut { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(100%); } }
</style>
