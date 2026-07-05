<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useConfigStore } from '@/stores/configStore'
import { useI18n } from '@/composables/useI18n'
import { useToast } from '@/composables/useToast'
import { useTheme, currentMode } from '@/composables/useTheme'
import { api } from '@/api/client'
import * as tauri from '@/lib/tauri'

defineOptions({ name: 'AuthPage' })
const emit = defineEmits<{ (e: 'login-success'): void }>()

const configStore = useConfigStore()
const { t } = useI18n()
const toast = useToast()
const { toggleMode } = useTheme()

// ===== Auth state =====
const authView = ref<'login-phone' | 'login-password' | 'register' | 'set-password'>('login-phone')
const authTab = ref<'phone' | 'password'>('phone')
const authPhone = ref('')
const authCode = ref('')
const authAccount = ref('')
const authPassword = ref('')
const isSendingCode = ref(false)
const isLoggingIn = ref(false)
const codeCountdown = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null

// ===== Register state =====
const regPhone = ref('')
const regNickname = ref('')
const regEmail = ref('')
const regCode = ref('')
const regPassword = ref('')
const regConfirm = ref('')
const isRegistering = ref(false)

// ===== Set Password state =====
const setPwdPhone = ref('')
const setPwdCode = ref('')
const setPwdNew = ref('')
const setPwdConfirm = ref('')
const isSettingPwd = ref(false)

// ===== Shared UI state =====
const showRegPassword = ref(false)
const showRegConfirm = ref(false)
const showSetPwdPassword = ref(false)
const showSetPwdConfirm = ref(false)

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer)
})

// ===== Password strength =====
function checkPwdStrength(pwd: string): { score: number; label: string } {
  let score = 0
  if (pwd.length >= 8) score++
  if (pwd.length >= 12) score++
  if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score++
  if (/\d/.test(pwd)) score++
  if (/[^a-zA-Z0-9]/.test(pwd)) score++
  const labels = ['', t('pwd_weak') || 'Weak', t('pwd_fair') || 'Fair', t('pwd_good') || 'Good', t('pwd_strong') || 'Strong', t('pwd_very_strong') || 'Very Strong']
  return { score, label: labels[score] || '' }
}

const regPwdStrength = computed(() => checkPwdStrength(regPassword.value))

// ===== Send verification code =====
async function sendCode() {
  let phone = ''
  if (authView.value === 'register') {
    phone = regPhone.value
  } else if (authView.value === 'set-password') {
    phone = setPwdPhone.value
  } else {
    phone = authPhone.value
  }
  if (!phone || phone.length !== 11) {
    toast.show(t('val_phone_format'), 'error')
    return
  }
  isSendingCode.value = true
  try {
    await tauri.sendVerificationCode(phone)
    toast.show(t('auth_code_sent'), 'success')
    codeCountdown.value = 60
    countdownTimer = setInterval(() => {
      codeCountdown.value--
      if (codeCountdown.value <= 0 && countdownTimer) clearInterval(countdownTimer)
    }, 1000)
  } catch (e: any) {
    toast.show(t('auth_failed_op') + String(e), 'error')
  }
  isSendingCode.value = false
}

// ===== Login =====
async function handleLogin() {
  isLoggingIn.value = true
  try {
    if (authTab.value === 'phone') {
      const phone = authPhone.value.trim()
      if (!phone || phone.length !== 11) {
        toast.show(t('val_phone_format'), 'error'); isLoggingIn.value = false; return
      }
      if (!authCode.value || authCode.value.length !== 6) {
        toast.show(t('auth_need_code'), 'error'); isLoggingIn.value = false; return
      }
      try {
        console.log('[Auth] Phone login attempt:', phone)
        await configStore.login(phone, authCode.value)
        toast.show(t('login_success'), 'success')
        emit('login-success')
      } catch (e: any) {
        const msg = String(e)
        console.warn('[Auth] Phone login failed:', msg)
        if (msg.includes('new_user') || msg.includes('密码') || msg.includes('set password')) {
          setPwdPhone.value = phone
          setPwdCode.value = authCode.value
          authView.value = 'set-password'
          toast.show(t('sp_new_account_desc'), 'info')
        } else {
          toast.show(t('login_failed') + msg, 'error')
        }
      }
    } else {
      if (!authAccount.value || !authPassword.value) {
        toast.show(t('auth_need_both'), 'error'); isLoggingIn.value = false; return
      }
      const res = await api('POST', '/api/auth/password-login', { account: authAccount.value, password: authPassword.value })
      if (res.ok && res.data) {
        configStore.login(authAccount.value, '')
        toast.show(t('login_success'), 'success')
        emit('login-success')
      } else {
        toast.show(t('login_failed') + (res.error || ''), 'error')
      }
    }
  } catch (e: any) {
    console.warn('[Auth] Login error:', e)
    toast.show(t('login_failed') + String(e), 'error')
  }
  isLoggingIn.value = false
}

// ===== Register =====
async function handleRegister() {
  if (!regPhone.value || regPhone.value.length !== 11) { toast.show(t('val_phone_format'), 'error'); return }
  if (!regCode.value || regCode.value.length !== 6) { toast.show(t('auth_need_code'), 'error'); return }
  if (!regPassword.value || regPassword.value.length < 8) { toast.show(t('reg_pwd_min_8'), 'error'); return }
  if (regPassword.value !== regConfirm.value) { toast.show(t('sp_pwd_mismatch'), 'error'); return }
  isRegistering.value = true
  try {
    const res = await api('POST', '/api/auth/register', {
      phone: regPhone.value, code: regCode.value,
      password: regPassword.value, nickname: regNickname.value || undefined,
      email: regEmail.value || undefined,
    })
    if (res.ok) {
      toast.show(t('reg_success_welcome'), 'success')
      authView.value = 'login-phone'
    } else {
      const err = res.error || ''
      if (err.includes('phone')) toast.show(t('err_dup_phone'), 'error')
      else if (err.includes('email')) toast.show(t('err_dup_email'), 'error')
      else toast.show(t('reg_fail') + err, 'error')
    }
  } catch (e: any) { console.warn('[Auth] Register error:', e); toast.show(t('reg_fail') + String(e), 'error') }
  isRegistering.value = false
}

// ===== Set Password =====
async function handleSetPassword() {
  if (!setPwdNew.value || setPwdNew.value.length < 8) { toast.show(t('reg_pwd_min_8'), 'error'); return }
  if (setPwdNew.value !== setPwdConfirm.value) { toast.show(t('sp_pwd_mismatch'), 'error'); return }
  isSettingPwd.value = true
  try {
    const res = await api('POST', '/api/auth/set-password', {
      phone: setPwdPhone.value, code: setPwdCode.value, password: setPwdNew.value,
    })
    if (res.ok) {
      await configStore.login(setPwdPhone.value, setPwdCode.value)
      toast.show(t('login_success'), 'success')
      emit('login-success')
    } else {
      toast.show(t('sp_set_pwd_fail') + (res.error || ''), 'error')
    }
  } catch (e: any) { toast.show(t('sp_set_pwd_fail') + String(e), 'error') }
  isSettingPwd.value = false
}

// ===== View switching =====
function switchAuthView(view: 'login-phone' | 'login-password' | 'register') {
  authView.value = view
}
function goBackToLogin() {
  authView.value = 'login-phone'
}
</script>

<template>
  <div class="auth-page">
    <div class="auth-inner">
      <div class="auth-left-col">
        <div class="auth-card">

          <!-- ===== LOGIN: Phone + Password ===== -->
          <div v-if="authView === 'login-phone' || authView === 'login-password'">
            <div class="auth-brand">
              <div class="auth-logo-mark">C</div>
              <span class="auth-brand-name">ClipSync</span>
            </div>
            <h2 class="auth-heading">{{ t('login_welcome') }}</h2>
            <p class="auth-subtitle">{{ t('login_subtitle') }}</p>

            <!-- Tab: Phone / Password -->
            <div class="auth-tab-row">
              <button :class="['auth-tab-btn', { active: authTab === 'phone' }]" @click="authTab = 'phone'">{{ t('tab_phone_login') }}</button>
              <button :class="['auth-tab-btn', { active: authTab === 'password' }]" @click="authTab = 'password'">{{ t('tab_password_login') }}</button>
            </div>

            <!-- Phone Code Login -->
            <div v-if="authTab === 'phone'" class="auth-form">
              <div class="field-group">
                <label class="field-label">{{ t('login_phone') }}</label>
                <input v-model="authPhone" type="tel" maxlength="11" class="field-input" :placeholder="t('ph_phone_placeholder')" />
              </div>
              <div class="field-group">
                <label class="field-label">{{ t('login_code') }}</label>
                <div class="field-row">
                  <input v-model="authCode" type="text" maxlength="6" class="field-input flex-1" :placeholder="t('ph_code_placeholder')" />
                  <button class="btn btn-sm btn-outline" :disabled="isSendingCode || codeCountdown > 0" @click="sendCode" style="white-space:nowrap;">
                    {{ codeCountdown > 0 ? t('code_resend', { s: codeCountdown }) : t('login_send_code') }}
                  </button>
                </div>
              </div>
              <button class="btn btn-primary btn-full" :disabled="isLoggingIn" @click="handleLogin">
                <span v-if="isLoggingIn" class="btn-spinner" />
                <span>{{ t('login_signin') }}</span>
              </button>
            </div>

            <!-- Password Login -->
            <div v-else class="auth-form">
              <div class="field-group">
                <label class="field-label">{{ t('login_account') }}</label>
                <input v-model="authAccount" type="text" class="field-input" :placeholder="t('ph_account_placeholder')" @keydown.enter="handleLogin" />
              </div>
              <div class="field-group">
                <label class="field-label">{{ t('login_password') }}</label>
                <input v-model="authPassword" type="password" class="field-input" :placeholder="t('ph_password_placeholder')" @keydown.enter="handleLogin" />
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-top:-6px;">
                <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary);cursor:pointer;">
                  <input type="checkbox" checked style="accent-color:var(--accent);" /> {{ t('login_remember') }}
                </label>
                <button class="btn-text-link" style="font-size:12px;" @click="toast.show(t('toast_pwd_reset'),'info')">{{ t('login_forgot') }}</button>
              </div>
              <button class="btn btn-primary btn-full" :disabled="isLoggingIn" @click="handleLogin">
                <span v-if="isLoggingIn" class="btn-spinner" />
                <span>{{ t('login_signin') }}</span>
              </button>
            </div>

            <div class="auth-footer-links">
              <span>{{ t('login_no_account') }}</span>
              <button class="btn-text-link" @click="switchAuthView('register')">{{ t('login_create_free') }}</button>
            </div>
            <div class="auth-divider"><span>{{ t('login_or_continue') }}</span></div>
            <div class="auth-socials">
              <button class="social-btn" @click="toast.show(t('toast_signup_soon'),'info')" title="WeChat">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8.5 12c.8 0 1.5-.7 1.5-1.5S9.3 9 8.5 9 7 9.7 7 10.5 7.7 12 8.5 12zM15 12c.8 0 1.5-.7 1.5-1.5S15.8 9 15 9s-1.5.7-1.5 1.5.7 1.5 1.5 1.5z"/><path d="M19.5 10.2c0-3.4-3.6-6.2-8-6.2s-8 2.8-8 6.2c0 3.1 2.8 5.7 6.6 6.2.3.1.7.2.8.5l.3 1.2c.1.3.3.5.6.5s.5-.2.6-.5l.3-1.2c.1-.3.5-.4.8-.5C16.7 15.9 19.5 13.3 19.5 10.2z"/></svg>
              </button>
              <button class="social-btn" @click="toast.show(t('toast_signup_soon'),'info')" title="Apple">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
              </button>
              <button class="social-btn" @click="toast.show(t('toast_signup_soon'),'info')" title="GitHub">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
              </button>
            </div>
            <div class="auth-mode-toggle">
              <button class="theme-toggle-pill" @click="toggleMode" :title="currentMode === 'dark' ? t('mode_light') : t('mode_dark')">
                <svg v-if="currentMode === 'dark'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
                <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
              </button>
            </div>
          </div>

          <!-- ===== REGISTER ===== -->
          <div v-else-if="authView === 'register'">
            <button class="btn-text-link mb-4" @click="switchAuthView('login-phone')">← {{ t('btn_back_login') }}</button>
            <h2 class="auth-heading">{{ t('reg_title') }}</h2>
            <p class="auth-subtitle">{{ t('reg_subtitle') }}</p>
            <div class="auth-form">
              <div class="field-group">
                <label class="field-label">{{ t('login_phone') }}</label>
                <input v-model="regPhone" type="tel" maxlength="11" class="field-input" :placeholder="t('ph_phone_placeholder')" />
              </div>
              <div class="field-group">
                <label class="field-label">{{ t('login_code') }}</label>
                <div class="field-row">
                  <input v-model="regCode" type="text" maxlength="6" class="field-input flex-1" :placeholder="t('ph_code_placeholder')" />
                  <button class="btn btn-sm btn-outline" :disabled="isSendingCode || codeCountdown > 0" @click="sendCode" style="white-space:nowrap;">
                    {{ codeCountdown > 0 ? t('code_resend', { s: codeCountdown }) : t('login_send_code') }}
                  </button>
                </div>
              </div>
              <div class="field-group">
                <label class="field-label">{{ t('sp_set_pwd_label') }}</label>
                <div class="pwd-field-wrap">
                  <input v-model="regPassword" :type="showRegPassword ? 'text' : 'password'" class="field-input" :placeholder="t('sp_pwd_hint')" style="width:100%;" />
                  <button class="pwd-toggle" @click="showRegPassword = !showRegPassword" type="button">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path v-if="showRegPassword" d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path v-if="showRegPassword" d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line v-if="showRegPassword" x1="1" y1="1" x2="23" y2="23"/>
                      <template v-else><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></template>
                    </svg>
                  </button>
                </div>
                <!-- Password strength -->
                <div v-if="regPassword.length > 0" class="pwd-strength" style="margin-top:4px;">
                  <div class="ps-bar" :class="{ weak: regPwdStrength.score <= 1, fair: regPwdStrength.score === 2, good: regPwdStrength.score === 3, strong: regPwdStrength.score >= 4 }" :style="{ width: (regPwdStrength.score * 20) + '%' }"></div>
                  <span class="ps-label" style="font-size:11px;color:var(--text-tertiary);margin-left:6px;">{{ regPwdStrength.label }}</span>
                </div>
                <div class="sp-hint" v-if="regPassword.length > 0">
                  <span :class="regPassword.length >= 8 ? 'valid' : 'invalid'">· {{ t('sp_rule_length') }}</span>
                  <span :class="/\d/.test(regPassword) ? 'valid' : 'invalid'" style="margin-left:8px;">· {{ t('sp_rule_number') }}</span>
                  <span :class="/[a-zA-Z]/.test(regPassword) ? 'valid' : 'invalid'" style="margin-left:8px;">· {{ t('sp_rule_letter') }}</span>
                </div>
              </div>
              <div class="field-group">
                <label class="field-label">{{ t('sp_confirm_pwd') }}</label>
                <div class="pwd-field-wrap">
                  <input v-model="regConfirm" :type="showRegConfirm ? 'text' : 'password'" class="field-input" :placeholder="t('sp_confirm_hint')" style="width:100%;" />
                  <button class="pwd-toggle" @click="showRegConfirm = !showRegConfirm" type="button">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path v-if="showRegConfirm" d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path v-if="showRegConfirm" d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line v-if="showRegConfirm" x1="1" y1="1" x2="23" y2="23"/>
                      <template v-else><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></template>
                    </svg>
                  </button>
                </div>
              </div>
              <button class="btn btn-primary btn-full" :disabled="isRegistering" @click="handleRegister">
                <span v-if="isRegistering" class="btn-spinner" />
                <span>{{ t('reg_submit') }}</span>
              </button>
            </div>
          </div>

          <!-- ===== SET PASSWORD ===== -->
          <div v-else-if="authView === 'set-password'">
            <button class="btn-text-link mb-4" @click="goBackToLogin()">← {{ t('btn_back_login') }}</button>
            <h2 class="auth-heading">{{ t('sp_set_password') }}</h2>
            <p class="auth-subtitle">{{ t('sp_new_account_desc') }}</p>
            <div class="auth-form">
              <div class="field-group">
                <label class="field-label">{{ t('sp_set_pwd_label') }}</label>
                <div class="pwd-field-wrap">
                  <input v-model="setPwdNew" :type="showSetPwdPassword ? 'text' : 'password'" class="field-input" :placeholder="t('sp_pwd_hint')" style="width:100%;" />
                  <button class="pwd-toggle" @click="showSetPwdPassword = !showSetPwdPassword" type="button">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path v-if="showSetPwdPassword" d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path v-if="showSetPwdPassword" d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line v-if="showSetPwdPassword" x1="1" y1="1" x2="23" y2="23"/>
                      <template v-else><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></template>
                    </svg>
                  </button>
                </div>
              </div>
              <div class="field-group">
                <label class="field-label">{{ t('sp_confirm_pwd') }}</label>
                <div class="pwd-field-wrap">
                  <input v-model="setPwdConfirm" :type="showSetPwdConfirm ? 'text' : 'password'" class="field-input" :placeholder="t('sp_confirm_hint')" style="width:100%;" />
                  <button class="pwd-toggle" @click="showSetPwdConfirm = !showSetPwdConfirm" type="button">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path v-if="showSetPwdConfirm" d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path v-if="showSetPwdConfirm" d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line v-if="showSetPwdConfirm" x1="1" y1="1" x2="23" y2="23"/>
                      <template v-else><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></template>
                    </svg>
                  </button>
                </div>
              </div>
              <button class="btn btn-primary btn-full" :disabled="isSettingPwd" @click="handleSetPassword">
                <span v-if="isSettingPwd" class="btn-spinner" />
                <span>{{ t('sp_complete_register') }}</span>
              </button>
            </div>
          </div>

        </div>
      </div>

      <!-- Right quote panel -->
      <div class="auth-right-col">
        <div class="auth-right-bg"></div>
        <div class="auth-right-content">
          <div class="auth-quote">"The best way to sync your<br />clipboard across devices."</div>
          <div class="auth-quote-author">— Carlos Shao, Founder</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== AUTH PAGE ===== */
.auth-page { min-height: 100vh; min-height: 100dvh; display: flex; background: var(--bg-base); }
.auth-inner { display: flex; width: 100%; min-height: 100vh; }
.auth-left-col { flex: 1; display: flex; align-items: center; justify-content: center; padding: 32px; }
.auth-card { width: 400px; }
.auth-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
.auth-logo-mark { width: 36px; height: 36px; border-radius: var(--radius-md); background: var(--accent-bg); color: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 18px; }
.auth-brand-name { font-size: 18px; font-weight: 700; }
.auth-heading { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
.auth-subtitle { font-size: 13px; color: var(--text-secondary); margin-bottom: 24px; line-height: 1.5; }
.auth-tab-row { display: flex; gap: 4px; background: var(--bg-hover); padding: 3px; border-radius: var(--radius-md); margin-bottom: 20px; }
.auth-tab-btn { flex: 1; padding: 6px 12px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; border: none; background: transparent; color: var(--text-tertiary); cursor: pointer; }
.auth-tab-btn.active { background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--shadow-card); }
.auth-form { display: flex; flex-direction: column; gap: 14px; }
.field-group { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
.field-input { height: 38px; padding: 0 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-default); background: var(--bg-base); color: var(--text-primary); font-size: 14px; outline: none; }
.field-input:focus { border-color: var(--border-focus); }
.field-row { display: flex; gap: 8px; align-items: center; }
.flex-1 { flex: 1; }
.auth-footer-links { text-align: center; margin-top: 20px; font-size: 13px; color: var(--text-secondary); }
.auth-mode-toggle { text-align: center; margin-top: 12px; }
.auth-divider { display: flex; align-items: center; gap: 12px; margin-top: 20px; margin-bottom: 16px; font-size: 12px; color: var(--text-tertiary); }
.auth-divider::before, .auth-divider::after { content: ''; flex: 1; height: 1px; background: var(--border-default); }
.auth-socials { display: flex; justify-content: center; gap: 12px; }
.social-btn { width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--border-default); background: var(--bg-surface); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.15s; color: var(--text-secondary); }
.social-btn:hover { background: var(--bg-hover); border-color: var(--accent); color: var(--accent); }
.auth-right-col { width: 400px; display: flex; flex-direction: column; justify-content: center; align-items: center; position: relative; overflow: hidden; }
.auth-right-bg { position: absolute; inset: 0; background: var(--gradient-accent); }
.auth-right-bg::after { content: ''; position: absolute; inset: 0; background-image: radial-gradient(circle at 2px 2px, rgba(255,255,255,0.15) 1px, transparent 0); background-size: 24px 24px; }
.auth-right-content { position: relative; z-index: 1; text-align: center; padding: 40px; color: #fff; }
.auth-quote { font-size: 22px; font-weight: 600; line-height: 1.5; margin-bottom: 16px; }
.auth-quote-author { font-size: 13px; opacity: .7; }
@media (max-width: 900px) { .auth-right-col { display: none; } }

/* ===== PASSWORD STRENGTH ===== */
.pwd-strength { display: flex; align-items: center; }
.ps-bar { height: 4px; border-radius: 2px; background: var(--border-default); transition: all 0.2s; max-width: 100px; }
.ps-bar.weak { background: var(--danger); }
.ps-bar.fair { background: var(--warning); }
.ps-bar.good { background: var(--info); }
.ps-bar.strong { background: var(--success); }
.sp-hint { font-size: 11px; color: var(--text-tertiary); margin-top: 4px; line-height: 1.6; }
.sp-hint span.valid { color: var(--success); }
.sp-hint span.invalid { color: var(--danger); }

/* ===== PASSWORD FIELD WRAP ===== */
.pwd-field-wrap { position: relative; }
.pwd-field-wrap .field-input { padding-right: 36px; }
.pwd-toggle {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  background: none; border: none; cursor: pointer; color: var(--text-tertiary);
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: var(--radius-sm);
}
.pwd-toggle:hover { background: var(--bg-hover); color: var(--text-secondary); }

/* ===== BUTTONS ===== */
.btn { display: inline-flex; align-items: center; justify-content: center; height: 34px; padding: 0 14px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid transparent; transition: all 150ms; white-space: nowrap; }
.btn-primary { background: var(--accent); color: var(--text-inverse); }
.btn-primary:hover { background: var(--accent-hover); }
.btn-ghost { background: transparent; color: var(--text-secondary); border: none; }
.btn-ghost:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-outline { background: transparent; border-color: var(--border-default); color: var(--text-secondary); }
.btn-outline:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-sm { height: 28px; padding: 0 10px; font-size: 12px; }
.btn-full { width: 100%; }
.btn-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--radius-sm); background: transparent; border: none; color: var(--text-secondary); cursor: pointer; }
.btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-icon.active { color: var(--accent); background: var(--accent-light); }
.btn-text-link { background: none; border: none; color: var(--accent); font-size: 13px; cursor: pointer; padding: 0; }
.btn-text-link:hover { text-decoration: underline; }
.mb-4 { margin-bottom: 16px; }

/* ===== SPINNER ===== */
.btn-spinner {
  display: inline-block; width: 14px; height: 14px;
  border: 2px solid var(--text-inverse); border-top-color: transparent;
  border-radius: 50%; animation: spin 0.6s linear infinite;
  margin-right: 6px;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ===== THEME TOGGLE PILL ===== */
.auth-mode-toggle { display: flex; justify-content: center; margin-top: 16px; }
.theme-toggle-pill {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 6px; height: 32px; padding: 0 14px;
  border-radius: 16px; border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary); font-size: 12px; font-weight: 500;
  cursor: pointer; transition: all 150ms;
  box-shadow: var(--shadow-card);
}
.theme-toggle-pill:hover { background: var(--bg-hover); border-color: var(--accent); color: var(--accent); }
.theme-toggle-pill svg { flex-shrink: 0; }
</style>
