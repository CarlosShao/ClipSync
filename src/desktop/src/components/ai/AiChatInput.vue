<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'
import { Send, Square } from 'lucide-vue-next'

const props = defineProps<{ disabled: boolean; isStreaming: boolean }>()
const emit = defineEmits<{ send: [text: string]; stop: [] }>()
const { t } = useI18n()

const text = ref('')

function submit() {
  const value = text.value.trim()
  if (!value || props.disabled) return
  emit('send', value)
  text.value = ''
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}
</script>

<template>
  <div class="ai-input">
    <textarea
      v-model="text"
      class="ai-input-area"
      :placeholder="disabled ? t('ai_input_disabled') : t('ai_input_ph')"
      :disabled="disabled"
      rows="2"
      @keydown="onKeydown"
    />
    <div class="ai-input-actions">
      <span class="ai-input-hint">{{ t('ai_input_hint') }}</span>
      <Button v-if="!isStreaming" size="sm" class="min-w-[80px]" :disabled="disabled || !text.trim()" @click="submit">
        <Send :size="14" />
        {{ t('ai_send') }}
      </Button>
      <Button v-else size="sm" variant="outline" class="min-w-[80px]" @click="emit('stop')">
        <Square :size="14" />
        {{ t('ai_stop') }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.ai-input {
  border-top: 1px solid var(--border-default);
  padding: 10px 12px;
  background: var(--bg-surface);
}
.ai-input-area {
  width: 100%;
  resize: none;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-input, var(--bg-hover));
  color: var(--text-primary);
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.5;
  outline: none;
}
.ai-input-area:focus {
  border-color: var(--accent);
}
.ai-input-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
.ai-input-hint {
  font-size: 11px;
  color: var(--text-tertiary);
}
</style>
