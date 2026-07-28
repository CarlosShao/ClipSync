<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'
import type { AiProvider } from '@/api/ai'
import { Send, Square } from 'lucide-vue-next'

const props = defineProps<{
  disabled: boolean
  isStreaming: boolean
  providers: AiProvider[]
  selectedProviderId: string
}>()
const emit = defineEmits<{
  send: [text: string]
  stop: []
  'select-provider': [id: string]
}>()
const { t } = useI18n()

const text = ref('')

const providerLabel = computed(() => {
  const p = props.providers.find((x) => x.id === props.selectedProviderId)
  return p?.name || t('ai_select_provider')
})

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
    <div class="ai-input-row">
      <CustomSelect
        class="ai-provider-select"
        :model-value="selectedProviderId"
        @update:model-value="emit('select-provider', $event)"
      >
        {{ providerLabel }}
        <template #options>
          <CustomSelectOption
            v-for="p in providers"
            :key="p.id"
            :value="p.id"
            :selected="selectedProviderId === p.id"
            @select="emit('select-provider', $event)"
          >
            {{ p.name }}
          </CustomSelectOption>
        </template>
      </CustomSelect>

      <textarea
        v-model="text"
        class="ai-input-area"
        :placeholder="disabled ? t('ai_input_disabled') : t('ai_input_ph')"
        :disabled="disabled"
        rows="1"
        @keydown="onKeydown"
      />

      <Button
        v-if="!isStreaming"
        size="sm"
        class="ai-send-btn"
        :disabled="disabled || !text.trim()"
        @click="submit"
      >
        <Send :size="14" />
        {{ t('ai_send') }}
      </Button>
      <Button v-else size="sm" variant="outline" class="ai-send-btn" @click="emit('stop')">
        <Square :size="14" />
        {{ t('ai_stop') }}
      </Button>
    </div>
    <div class="ai-input-hint-row">
      <span class="ai-input-hint">{{ t('ai_input_hint') }}</span>
    </div>
  </div>
</template>

<style scoped>
.ai-input {
  border-top: 1px solid var(--border-default);
  padding: 12px 14px 14px;
  background: var(--bg-surface);
  flex-shrink: 0;
}
.ai-input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.ai-provider-select {
  width: 128px;
  flex-shrink: 0;
}
.ai-provider-select :deep(.cs-trigger) {
  height: 36px !important;
  min-height: 36px !important;
  padding: 0 10px !important;
  font-size: 13px !important;
}
.ai-input-area {
  flex: 1;
  min-width: 0;
  resize: none;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-input, var(--bg-hover));
  color: var(--text-primary);
  padding: 9px 12px;
  font-size: 13px;
  line-height: 1.5;
  outline: none;
  max-height: 120px;
  overflow-y: auto;
}
.ai-input-area:focus {
  border-color: var(--accent);
}
.ai-send-btn {
  width: 76px;
  flex-shrink: 0;
  height: 36px;
}
.ai-input-hint-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}
.ai-input-hint {
  font-size: 11px;
  color: var(--text-tertiary);
}
</style>
