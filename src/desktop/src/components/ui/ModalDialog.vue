<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { X } from 'lucide-vue-next'

const { t } = useI18n()
const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    maxWidth?: string
  }>(),
  { maxWidth: '480px' },
)
const emit = defineEmits<{ close: [] }>()

function onBackdropClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('modal-backdrop')) emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click="onBackdropClick">
      <div class="modal-panel" :style="{ maxWidth }">
        <div v-if="title" class="modal-header">
          <span class="modal-title-text">{{ title }}</span>
          <button class="btn-icon" @click="emit('close')">
            <X :size="16" />
          </button>
        </div>
        <div class="modal-body">
          <slot />
        </div>
        <div v-if="$slots.footer" class="modal-footer">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: var(--bg-modal-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn 0.12s ease;
}
@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.modal-panel {
  width: 90vw;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-modal);
  animation: slideUp 0.15s ease;
  max-height: 85vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
@keyframes slideUp {
  from {
    transform: translateY(10px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 24px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.modal-title-text {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.modal-body {
  padding: 24px;
  overflow-y: auto;
  flex: 1;
}
.modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 24px;
  border-top: 1px solid var(--border-default);
  flex-shrink: 0;
}
.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
