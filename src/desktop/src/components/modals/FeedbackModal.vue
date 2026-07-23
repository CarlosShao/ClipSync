<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import './modal-shared.css'

defineProps<{ showModalType: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const toast = useSonner()

// ===== Feedback =====
const fbForm = reactive({ type: 'bug', description: '', contact: '' })
const fbSending = ref(false)
const fbSent = ref(false)
const fbTypes = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: t('fb_type_feature') },
  { value: 'improvement', label: t('fb_type_improvement') },
  { value: 'other', label: t('fb_type_other') },
]
async function handleFeedbackSubmit() {
  if (!fbForm.description.trim()) return
  fbSending.value = true
  try {
    // TODO: POST /api/feedback — requires backend endpoint + email notification service
    // For now, show a message that the feature is not yet connected
    toast.show(t('fb_not_available') || 'Feedback service not yet connected. Please email us directly.', 'info')
    emit('close')
  } finally {
    fbSending.value = false
  }
}
</script>

<template>
  <ModalDialog :open="showModalType === 'feedback'" :title="t('fb_title')" max-width="480px" @close="emit('close')">
    <div class="fb-form">
      <div class="fb-field">
        <label class="fb-label">{{ t('fb_type') }}</label>
        <div class="fb-type-row">
          <button
            v-for="ft in fbTypes"
            :key="ft.value"
            class="fb-type-btn"
            :class="{ active: fbForm.type === ft.value }"
            @click="fbForm.type = ft.value"
          >
            {{ ft.label }}
          </button>
        </div>
      </div>
      <div class="fb-field">
        <label class="fb-label">{{ t('fb_desc') }}</label>
        <textarea
          v-model="fbForm.description"
          class="fb-textarea"
          rows="4"
          :placeholder="t('fb_desc_ph')"
          maxlength="1000"
        ></textarea>
        <div class="fb-char-count">{{ fbForm.description.length }}/1000</div>
      </div>
      <div class="fb-field">
        <label class="fb-label"
          >{{ t('fb_contact') }} <span class="fb-optional">({{ t('fb_optional') }})</span></label
        >
        <Input v-model="fbForm.contact" type="text" class="fb-input" :placeholder="t('fb_contact_ph')" />
      </div>
      <Button class="w-full" :disabled="!fbForm.description.trim() || fbSending" @click="handleFeedbackSubmit">
        {{ fbSending ? '...' : t('fb_submit') }}
      </Button>
      <div v-if="fbSent" class="fb-success">{{ t('fb_sent') }}</div>
    </div>
  </ModalDialog>
</template>

<style scoped>
.fb-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.fb-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fb-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}
.fb-optional {
  font-size: 11px;
  color: var(--text-tertiary);
  font-weight: 400;
}
.fb-type-row {
  display: flex;
  gap: 8px;
}
.fb-type-btn {
  font-size: 12px;
  padding: 6px 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.fb-type-btn:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}
.fb-type-btn.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.fb-textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  font-size: 13px;
  resize: vertical;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-family: inherit;
}
.fb-textarea:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px var(--accent-light);
}
.fb-char-count {
  font-size: 11px;
  color: var(--text-tertiary);
  text-align: right;
}
.fb-input {
  width: 100%;
  padding-left: 12px !important;
}
.fb-success {
  font-size: 13px;
  color: var(--success);
  text-align: center;
  margin-top: 8px;
}
</style>
