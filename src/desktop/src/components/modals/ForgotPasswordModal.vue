<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { api } from '@/api/client'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import './modal-shared.css'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const toast = useSonner()

// Forgot password state
const fpStep = ref(1)
const fpEmail = ref('')
const fpCode = ref('')
const fpNewPwd = ref('')
const fpConfirmPwd = ref('')
const fpSending = ref(false)

function handleCloseForgot() {
  fpStep.value = 1
  fpEmail.value = ''
  fpCode.value = ''
  fpNewPwd.value = ''
  fpConfirmPwd.value = ''
  emit('close')
}

async function handleForgotSend() {
  if (!fpEmail.value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fpEmail.value)) {
    toast.show(t('val_email_invalid'), 'error')
    return
  }
  fpSending.value = true
  try {
    const res = await api('POST', '/api/auth/forgot-password', { email: fpEmail.value })
    if (res.ok) {
      fpStep.value = 2
      toast.show(t('toast_pwd_reset'), 'success')
    } else {
      toast.show(res.error || '', 'error')
    }
  } catch (e: any) {
    toast.show(t('auth_failed_op') + String(e), 'error')
  }
  fpSending.value = false
}

async function handleForgotReset() {
  if (fpNewPwd.value !== fpConfirmPwd.value) {
    toast.show(t('sp_pwd_mismatch'), 'error')
    return
  }
  fpSending.value = true
  try {
    const res = await api('POST', '/api/auth/reset-password', {
      email: fpEmail.value,
      code: fpCode.value,
      password: fpNewPwd.value,
    })
    if (res.ok) {
      toast.show(t('toast_pwd_reset'), 'success')
      handleCloseForgot()
    } else {
      toast.show(res.error || t('auth_code_invalid'), 'error')
    }
  } catch (e: any) {
    toast.show(t('auth_failed_op') + String(e), 'error')
  }
  fpSending.value = false
}
</script>

<template>
  <ModalDialog :open="props.open" :title="t('fp_title')" max-width="420px" @close="handleCloseForgot">
    <div v-if="fpStep === 1">
      <div class="fp-field">
        <label class="field-label">{{ t('fp_email_label') }}</label
        ><Input v-model="fpEmail" type="email" class="field-input" :placeholder="t('fp_email_hint')" />
      </div>
      <Button class="w-full" :disabled="fpSending" @click="handleForgotSend"
        ><span v-if="fpSending" class="btn-spinner" /><span>{{ t('fp_send_code') }}</span></Button
      >
    </div>
    <div v-else>
      <div class="fp-field">
        <label class="field-label">{{ t('login_code') }}</label
        ><Input
          v-model="fpCode"
          type="text"
          maxlength="6"
          class="field-input"
          :placeholder="t('ph_code_placeholder')"
        />
      </div>
      <div class="fp-field">
        <label class="field-label">{{ t('sp_set_pwd_label') }}</label
        ><Input v-model="fpNewPwd" type="password" class="field-input" :placeholder="t('sp_pwd_hint')" />
      </div>
      <div class="fp-field fp-field--last">
        <label class="field-label">{{ t('sp_confirm_pwd') }}</label
        ><Input v-model="fpConfirmPwd" type="password" class="field-input" :placeholder="t('sp_confirm_hint')" />
      </div>
      <Button class="w-full" :disabled="fpSending" @click="handleForgotReset"
        ><span v-if="fpSending" class="btn-spinner" /><span>{{ t('fp_reset_btn') }}</span></Button
      >
    </div>
  </ModalDialog>
</template>

<style scoped>
.field-input {
  width: 100%;
  height: 38px;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-default);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  font-family: inherit;
  box-sizing: border-box;
}
.fp-field {
  margin-bottom: 12px;
}
.fp-field.fp-field--last {
  margin-bottom: 16px;
}
</style>
