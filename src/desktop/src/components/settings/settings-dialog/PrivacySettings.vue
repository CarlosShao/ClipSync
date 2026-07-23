<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useConfigStore } from '@/stores/configStore'
import { usePrivacy } from '@/composables/usePrivacy'
import { useSonner } from '@/composables/useSonner'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Switch from '@/components/ui/switch/Switch.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'
import { ChevronRight, ChevronDown } from 'lucide-vue-next'

const { t } = useI18n()
const configStore = useConfigStore()
const privacy = usePrivacy()
const toast = useSonner()

const emit = defineEmits<{ 'open-sub-page': [page: string] }>()

const pinSet = computed(() => privacy.pinSet.value)

// ── Password change form state ──
const showPwdChange = ref(false)
const pwdOld = ref('')
const pwdNew = ref('')
const pwdConfirm = ref('')
const pwdChanging = ref(false)
const pwdError = ref('')

// ── PIN setup form state ──
const showPinSetup = ref(false)
const pinNew = ref('')
const pinConfirm = ref('')
const pinSetting = ref(false)
const pinError = ref('')

// PIN timeout options (ms)
const PIN_TIMEOUT_OPTIONS = [
  { value: 30000, i18nKey: 'pin_timeout_30s' },
  { value: 60000, i18nKey: 'pin_timeout_1m' },
  { value: 120000, i18nKey: 'pin_timeout_2m' },
  { value: 300000, i18nKey: 'pin_timeout_5m' },
  { value: 600000, i18nKey: 'pin_timeout_10m' },
  { value: 1800000, i18nKey: 'pin_timeout_30m' },
]
const pinTimeout = ref(privacy.getPinTimeout())
const pinTimeoutModel = ref(String(pinTimeout.value))

watch(pinTimeoutModel, (v) => {
  pinTimeout.value = Number(v)
})
watch(pinTimeout, (v) => {
  pinTimeoutModel.value = String(v)
  privacy.setPinTimeout(v)
})

// ── PIN form handlers ──
function resetPinForm() {
  pinNew.value = ''
  pinConfirm.value = ''
  pinError.value = ''
}

function handleSetPin() {
  pinError.value = ''
  if (!/^\d{4,6}$/.test(pinNew.value)) {
    pinError.value = t('pin_format_error') || 'PIN 必须为4-6位数字'
    return
  }
  if (pinNew.value !== pinConfirm.value) {
    pinError.value = t('pin_mismatch') || '两次输入的PIN不一致'
    return
  }
  pinSetting.value = true
  setTimeout(() => {
    privacy.setPin(pinNew.value)
    pinSetting.value = false
    resetPinForm()
    showPinSetup.value = false
    toast.show(t('pin_set_success') || 'PIN 已设置', 'success')
  }, 300)
}

function handleResetPin() {
  privacy.resetPin()
  resetPinForm()
  showPinSetup.value = false
  toast.show(t('pin_reset_success') || 'PIN 已清除', 'info')
}

// ── Password change handlers ──
function resetPwdForm() {
  pwdOld.value = ''
  pwdNew.value = ''
  pwdConfirm.value = ''
}

async function handleChangePassword() {
  pwdError.value = ''
  if (!pwdOld.value) {
    pwdError.value = t('pwd_old_required') || '请输入当前密码'
    return
  }
  if (!pwdNew.value) {
    pwdError.value = t('pwd_new_required') || '请输入新密码'
    return
  }
  if (pwdNew.value.length < 8) {
    pwdError.value = t('pwd_min_length') || '新密码至少8位'
    return
  }
  if (pwdNew.value !== pwdConfirm.value) {
    pwdError.value = t('pwd_mismatch') || '两次输入的新密码不一致'
    return
  }

  pwdChanging.value = true
  const result = await configStore.changePassword(pwdOld.value, pwdNew.value)
  pwdChanging.value = false

  if (result.ok) {
    toast.show(t('pwd_changed_ok') || '密码修改成功', 'success')
    resetPwdForm()
    showPwdChange.value = false
  } else {
    const err = result.error || ''
    if (err.includes('Current password is incorrect')) {
      pwdError.value = t('pwd_old_incorrect') || '当前密码不正确'
    } else {
      pwdError.value = err || t('pwd_change_fail') || '密码修改失败'
    }
  }
}
</script>

<template>
  <div class="settings-group">
    <div class="sg-header">{{ t('sg_privacy') }}</div>

    <!-- 2FA security -->
    <div class="sg-row" style="cursor: pointer" @click="emit('open-sub-page', 'security')">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_2fa') }}</div>
        <div class="sg-hint">{{ t('sg_2fa_h') }}</div>
      </div>
      <ChevronRight class="sg-arrow" />
    </div>

    <!-- Sessions -->
    <div class="sg-row" style="cursor: pointer" @click="emit('open-sub-page', 'sessions')">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_sessions') }}</div>
        <div class="sg-hint">{{ t('sg_sessions_h') }}</div>
      </div>
      <ChevronRight class="sg-arrow" />
    </div>

    <!-- Notification preferences -->
    <div class="sg-row" style="cursor: pointer" @click="emit('open-sub-page', 'notifications')">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_notifp') }}</div>
        <div class="sg-hint">{{ t('sg_notifp_h') }}</div>
      </div>
      <ChevronRight class="sg-arrow" />
    </div>

    <!-- Privacy mode toggle -->
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_privacy_mask') }}</div>
        <div class="sg-hint">{{ t('sg_privacy_mask_h') }}</div>
      </div>
      <Switch
        :model-value="configStore.privacyMode"
        @update:model-value="(v: boolean) => configStore.togglePrivacyMode(v)"
      />
    </div>

    <!-- Auto blur toggle -->
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_privacy_autoblur') }}</div>
        <div class="sg-hint">{{ t('sg_privacy_autoblur_h') }}</div>
      </div>
      <Switch :model-value="configStore.autoBlur" @update:model-value="(v: boolean) => configStore.toggleAutoBlur(v)" />
    </div>

    <!-- PIN Protection (expandable) -->
    <div class="sg-row" style="cursor: pointer" @click="showPinSetup = !showPinSetup">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_privacy_pin') || 'PIN 保护' }}</div>
        <div class="sg-hint">
          {{
            pinSet
              ? t('sg_privacy_pin_set') || 'PIN 已设置，查看/复制敏感数据需验证'
              : t('sg_privacy_pin_unset') || '未设置，查看/复制敏感数据无需验证'
          }}
        </div>
      </div>
      <ChevronDown :class="['sg-arrow', { 'sg-arrow--rotated': showPinSetup }]" />
    </div>

    <!-- PIN setup form (inline expand) -->
    <div v-if="showPinSetup" class="pwd-change-form">
      <template v-if="!pinSet">
        <div class="pwd-field">
          <label class="pwd-label">{{ t('pin_new') || '设置 PIN（4-6位数字）' }}</label>
          <Input
            v-model="pinNew"
            type="password"
            inputmode="numeric"
            maxlength="6"
            class="sg-input--block"
            :placeholder="t('pin_new_ph') || '输入4-6位数字PIN'"
            @keyup.enter="handleSetPin"
          />
        </div>
        <div class="pwd-field">
          <label class="pwd-label">{{ t('pin_confirm') || '确认 PIN' }}</label>
          <Input
            v-model="pinConfirm"
            type="password"
            inputmode="numeric"
            maxlength="6"
            class="sg-input--block"
            :placeholder="t('pin_confirm_ph') || '再次输入PIN'"
            @keyup.enter="handleSetPin"
          />
        </div>
        <div class="pwd-actions">
          <Button class="pwd-btn" :disabled="pinSetting" @click="handleSetPin">
            {{ pinSetting ? t('saving') || '设置中...' : t('pin_set_btn') || '设置 PIN' }}
          </Button>
          <Button
            variant="outline"
            class="pwd-btn"
            @click="
              () => {
                showPinSetup = false
                resetPinForm()
              }
            "
          >
            {{ t('cancel_btn') }}
          </Button>
        </div>
      </template>

      <template v-else>
        <div class="pwd-field">
          <p class="pin-status-text">{{ t('sg_privacy_pin_set') || 'PIN 已设置' }}</p>
        </div>
        <div class="pwd-field">
          <label class="pwd-label">{{ t('pin_timeout_label') }}</label>
          <CustomSelect v-model="pinTimeoutModel" class="pin-timeout-select">
            {{ t(PIN_TIMEOUT_OPTIONS.find((o) => String(o.value) === pinTimeoutModel)?.i18nKey || 'pin_timeout_30s') }}
            <template #options>
              <CustomSelectOption
                v-for="opt in PIN_TIMEOUT_OPTIONS"
                :key="opt.value"
                :value="String(opt.value)"
                :selected="String(opt.value) === pinTimeoutModel"
                @select="(v: string) => (pinTimeoutModel = v)"
                >{{ t(opt.i18nKey) }}</CustomSelectOption
              >
            </template>
          </CustomSelect>
        </div>
        <div class="pwd-actions">
          <Button variant="destructive" class="pwd-btn" @click="handleResetPin">
            {{ t('pin_reset_btn') || '清除 PIN' }}
          </Button>
          <Button variant="outline" class="pwd-btn" @click="showPinSetup = false">
            {{ t('cancel_btn') }}
          </Button>
        </div>
      </template>

      <div v-if="pinError" class="pwd-error">{{ pinError }}</div>
    </div>

    <!-- Change Password (expandable) -->
    <div class="sg-row" style="cursor: pointer" @click="showPwdChange = !showPwdChange">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_chpwd') || '修改密码' }}</div>
        <div class="sg-hint">{{ t('sg_chpwd_h') || '输入旧密码和新密码以修改登录密码' }}</div>
      </div>
      <ChevronDown :class="['sg-arrow', { 'sg-arrow--rotated': showPwdChange }]" />
    </div>

    <!-- Password change form (inline expand) -->
    <div v-if="showPwdChange" class="pwd-change-form">
      <div class="pwd-field">
        <label class="pwd-label">{{ t('pwd_old') || '当前密码' }}</label>
        <Input
          v-model="pwdOld"
          type="password"
          class="sg-input--block"
          :placeholder="t('pwd_old_ph') || '输入当前密码'"
        />
      </div>
      <div class="pwd-field">
        <label class="pwd-label">{{ t('pwd_new') || '新密码' }}</label>
        <Input
          v-model="pwdNew"
          type="password"
          class="sg-input--block"
          :placeholder="t('pwd_new_ph') || '至少8位字符'"
          minlength="8"
        />
      </div>
      <div class="pwd-field">
        <label class="pwd-label">{{ t('pwd_confirm') || '确认新密码' }}</label>
        <Input
          v-model="pwdConfirm"
          type="password"
          class="sg-input--block"
          :placeholder="t('pwd_confirm_ph') || '再次输入新密码'"
          @keyup.enter="handleChangePassword"
        />
      </div>
      <div class="pwd-actions">
        <Button class="pwd-btn" :disabled="pwdChanging" @click="handleChangePassword">
          {{ pwdChanging ? t('saving') || '修改中...' : t('sg_chpwd_btn') || '确认修改' }}
        </Button>
        <Button
          variant="outline"
          class="pwd-btn"
          @click="
            () => {
              showPwdChange = false
              resetPwdForm()
            }
          "
        >
          {{ t('cancel_btn') }}
        </Button>
      </div>
      <div v-if="pwdError" class="pwd-error">{{ pwdError }}</div>
    </div>
  </div>
</template>

<style scoped>
.settings-group {
  margin-bottom: 24px;
}
.sg-header {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  margin-bottom: 8px;
}
.sg-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  gap: 16px;
}
.sg-row:hover {
  background: var(--bg-hover);
}
.sg-label {
  flex: 1;
  min-width: 0;
}
.sg-name {
  font-size: 14px;
  font-weight: 500;
}
.sg-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 1px;
}
.sg-arrow {
  width: 16px;
  height: 16px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.sg-arrow--rotated {
  transform: rotate(180deg);
}

/* Password / PIN change inline form */
.pwd-change-form {
  margin: 4px 0 8px;
  padding: 20px 24px !important;
  background: var(--bg-hover);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}
.pwd-field {
  margin-bottom: 14px;
  padding-left: 4px;
}
.pwd-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 6px;
  padding-left: 4px;
}
.sg-input--block {
  width: 100%;
  padding-left: 16px !important;
}
.pwd-actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  padding-left: 4px;
}
.pwd-btn {
  padding: 10px 28px;
}
.pwd-error {
  color: var(--danger, #ef4444);
  font-size: 12px;
  margin-top: 6px;
}
.pin-timeout-select {
  width: 100% !important;
}
.pin-timeout-select :deep(.custom-select-trigger) {
  height: 36px;
}
.pin-status-text {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}
</style>
