<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { api } from '@/api/client'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'

const { t } = useI18n()
const toast = useSonner()
const emit = defineEmits<{ back: [] }>()

// ===== State =====
const fbForm = reactive({ type: 'bug', description: '', contact: '' })
const fbSending = ref(false)
const fbSent = ref(false)

const fbTypes = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: t('fb_type_feature') },
  { value: 'improvement', label: t('fb_type_improvement') },
  { value: 'other', label: t('fb_type_other') },
]

// ===== Submit handler =====
async function handleFeedbackSubmit() {
  if (!fbForm.description.trim()) return
  fbSending.value = true
  try {
    const res = await api('POST', '/api/feedback', {
      type: fbForm.type,
      description: fbForm.description,
      contact: fbForm.contact || undefined,
    })
    if (res.ok) {
      fbSent.value = true
      toast.show(t('fb_sent') || 'Thank you for your feedback!', 'success')
    } else {
      toast.show(res.error || t('fb_not_available'), 'info')
    }
  } catch {
    toast.show(t('fb_not_available') || 'Feedback service not yet connected.', 'info')
  } finally {
    fbSending.value = false
  }
}
</script>

<template>
  <div>
    <h3 class="sp-title">{{ t('fb_title') }}</h3>
    <p class="sp-desc">{{ t('sg_export_h') }}</p>

    <div v-if="fbSent" class="fb-success-box">
      <p class="fb-success">{{ t('fb_sent') || 'Thank you for your feedback!' }}</p>
    </div>

    <div v-else class="fb-form">
      <!-- Feedback type selector -->
      <div class="fb-field">
        <label class="fb-label">{{ t('fb_type') }}</label>
        <div class="fb-type-row">
          <Button
            v-for="ft in fbTypes"
            :key="ft.value"
            :variant="fbForm.type === ft.value ? 'default' : 'outline'"
            size="sm"
            class="fb-type-btn"
            @click="fbForm.type = ft.value"
          >
            {{ ft.label }}
          </Button>
        </div>
      </div>

      <!-- Description textarea -->
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

      <!-- Contact (optional) -->
      <div class="fb-field">
        <label class="fb-label">
          {{ t('fb_contact') }}
          <span class="fb-optional">({{ t('fb_optional') }})</span>
        </label>
        <Input v-model="fbForm.contact" type="text" class="fb-input" :placeholder="t('fb_contact_ph')" />
      </div>

      <!-- Submit -->
      <Button class="w-full" :disabled="!fbForm.description.trim() || fbSending" @click="handleFeedbackSubmit">
        {{ fbSending ? '...' : t('fb_submit') }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.sp-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
}
.sp-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 16px;
}
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
  font-size: 12px;
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
.fb-success-box {
  text-align: center;
  padding: 32px 0;
}
.fb-success {
  font-size: 14px;
  color: var(--success);
}
</style>
