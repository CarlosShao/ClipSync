<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/composables/useI18n'

type BtnVariant = 'default' | 'outline' | 'destructive'

interface Props {
  open: boolean
  title?: string
  message?: string
  confirmText?: string
  cancelText?: string
  confirmVariant?: BtnVariant
  secondaryText?: string
  secondaryVariant?: BtnVariant
}

const props = withDefaults(defineProps<Props>(), {
  title: '',
  message: '',
  confirmText: '',
  cancelText: '',
  confirmVariant: 'destructive',
  secondaryText: '',
  secondaryVariant: 'outline',
})

const { t } = useI18n()
// 未显式传文案时走词典（修复英文界面弹出「取消」的硬编码问题）
const confirmLabel = computed(() => props.confirmText || t('confirm', '确认'))
const cancelLabel = computed(() => props.cancelText || t('cancel', '取消'))

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: []
  cancel: []
  secondary: []
}>()

function onConfirm() {
  emit('confirm')
  emit('update:open', false)
}

function onCancel() {
  emit('cancel')
  emit('update:open', false)
}

function onSecondary() {
  emit('secondary')
  emit('update:open', false)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) {
    onCancel()
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="open" class="confirm-dialog-overlay" @click.self="onCancel">
    <div class="confirm-dialog" role="dialog" aria-modal="true">
      <h3 v-if="title" class="confirm-dialog-title">{{ title }}</h3>
      <p v-if="message" class="confirm-dialog-message">{{ message }}</p>
      <div class="confirm-dialog-actions">
        <Button variant="outline" size="default" class="min-w-[100px] rounded-md" @click="onCancel">{{
          cancelLabel
        }}</Button>
        <Button
          v-if="secondaryText"
          :variant="secondaryVariant"
          size="default"
          class="min-w-[100px] rounded-md"
          @click="onSecondary"
          >{{ secondaryText }}</Button
        >
        <Button :variant="confirmVariant" size="default" class="min-w-[100px] rounded-md" @click="onConfirm">{{
          confirmLabel
        }}</Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-modal-overlay);
  animation: fadeIn 0.15s ease;
}

.confirm-dialog {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  padding: 28px;
  max-width: 420px;
  width: 100%;
  box-shadow: var(--shadow-modal);
  animation: slideUp 0.2s ease;
}

.confirm-dialog-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.confirm-dialog-message {
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.6;
  margin-bottom: 28px;
  white-space: pre-line;
}

.confirm-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
