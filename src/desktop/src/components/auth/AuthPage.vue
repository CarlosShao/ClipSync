<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
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
const showLoginPassword = ref(false)
const rememberMe = ref(true)
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
const regAgree = ref(true)
const isRegistering = ref(false)
const showRegPassword = ref(false)
const showRegConfirm = ref(false)

// ===== Set Password state =====
const setPwdPhone = ref('')
const setPwdCode = ref('')
const setPwdNew = ref('')
const setPwdConfirm = ref('')
const isSettingPwd = ref(false)
const showSetPwdPassword = ref(false)
const showSetPwdConfirm = ref(false)

// ===== Forgot Password state =====
const showForgotModal = ref(false)
const fpStep = ref<'email' | 'reset'>('email')
const fpEmail = ref('')
const fpCode = ref('')
const fpNewPwd = ref('')
const fpConfirmPwd = ref('')
const fpSending = ref(false)
const fpCodeSending = ref(false)
const fpCodeCountdown = ref(0)
let fpCountdownTimer: ReturnType<typeof setInterval> | null = null
const showFpNewPwd = ref(false)
const showFpConfirm = ref(false)
const fpPwdStrength = computed(() => checkPwdStrength(fpNewPwd.value))

// ===== Shake animation =====
function shake(el: HTMLElement | null) {
  if (!el) return
  el.classList.add('shake')
  setTimeout(() => el.classList.remove('shake'), 400)
}
function shakeById(id: string) {
  nextTick(() => shake(document.getElementById(id)))
}

// ===== Phone validation =====
const PHONE_RE = /^1[3-9]\d{9}$/

// 记住密码持久化
onMounted(() => {
  const saved = localStorage.getItem('clipsync-remember-me')
  if (saved !== null) rememberMe.value = saved === 'true'
})
watch(rememberMe, (val) => localStorage.setItem('clipsync-remember-me', String(val)))

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer)
  if (fpCountdownTimer) clearInterval(fpCountdownTimer)
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
const setPwdStrength = computed(() => checkPwdStrength(setPwdNew.value))
function strengthClass(score: number): string {
  if (score <= 1) return 'weak'
  if (score === 2) return 'fair'
  if (score === 3) return 'good'
  return 'strong'
}
const setPwdValid = computed(() =>
  setPwdNew.value.length >= 8 &&
  /\d/.test(setPwdNew.value) &&
  /[a-zA-Z]/.test(setPwdNew.value) &&
  setPwdNew.value === setPwdConfirm.value
)

// ===== Send verification code =====
async function sendCode() {
  let phone = ''
  if (authView.value === 'register') phone = regPhone.value
  else if (authView.value === 'set-password') phone = setPwdPhone.value
  else phone = authPhone.value
  if (!phone || !PHONE_RE.test(phone)) {
    toast.show(t('val_phone_format'), 'error')
    shakeById('send-code-btn')
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
      if (!phone || !PHONE_RE.test(phone)) {
        toast.show(t('val_phone_format'), 'error'); shakeById('lp-phone'); isLoggingIn.value = false; return
      }
      if (!authCode.value || authCode.value.length !== 6) {
        toast.show(t('auth_need_code'), 'error'); shakeById('lp-code'); isLoggingIn.value = false; return
      }
      try {
        await configStore.login(phone, authCode.value)
        toast.show(t('login_success'), 'success')
        emit('login-success')
      } catch (e: any) {
        const msg = String(e)
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
      if (!authAccount.value) { toast.show(t('auth_need_account'), 'error'); shakeById('lp-account'); isLoggingIn.value = false; return }
      if (!authPassword.value || authPassword.value.length < 6) { toast.show(t('auth_pwd_too_short'), 'error'); shakeById('lp-pwd'); isLoggingIn.value = false; return }
      // 自动识别账号类型
      const acct = authAccount.value.trim()
      let loginBody: any = { password: authPassword.value }
      if (/^1[3-9]\d{9}$/.test(acct)) loginBody.phone = acct
      else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acct)) loginBody.email = acct
      else loginBody.account = acct
      const res = await api('POST', '/api/auth/login', loginBody)
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
  if (!regPhone.value || !PHONE_RE.test(regPhone.value)) { toast.show(t('val_phone_format'), 'error'); shakeById('reg-phone'); return }
  if (!regCode.value || regCode.value.length !== 6) { toast.show(t('auth_need_code'), 'error'); shakeById('reg-code'); return }
  if (!regPassword.value || regPassword.value.length < 8) { toast.show(t('reg_pwd_min_8'), 'error'); shakeById('reg-pwd'); return }
  if (regPassword.value !== regConfirm.value) { toast.show(t('sp_pwd_mismatch'), 'error'); shakeById('reg-confirm'); return }
  if (!regAgree.value) { toast.show(t('reg_agree_required'), 'error'); return }
  isRegistering.value = true
  try {
    const res = await api('POST', '/api/auth/register', {
      phone: regPhone.value, code: regCode.value,
      password: regPassword.value,
      nickname: regNickname.value || undefined,
      email: regEmail.value || undefined,
      accept_tos: true, accept_privacy: true,
    })
    if (res.ok) {
      toast.show(t('reg_success_welcome'), 'success')
      // 注册成功后自动登录
      try {
        await configStore.login(regPhone.value, regCode.value)
        emit('login-success')
      } catch {
        authView.value = 'login-phone'
      }
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
  if (!setPwdNew.value || setPwdNew.value.length < 8) { toast.show(t('reg_pwd_min_8'), 'error'); shakeById('sp-pwd'); return }
  if (setPwdNew.value !== setPwdConfirm.value) { toast.show(t('sp_pwd_mismatch'), 'error'); shakeById('sp-confirm'); return }
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

// ===== Forgot Password =====
function openForgot() { showForgotModal.value = true; fpStep.value = 'email'; fpEmail.value = ''; fpCode.value = ''; fpNewPwd.value = ''; fpConfirmPwd.value = '' }
function closeForgot() { showForgotModal.value = false }
async function fpSendCode() {
  if (!fpEmail.value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fpEmail.value)) { toast.show(t('val_email_invalid'), 'error'); return }
  fpCodeSending.value = true
  try {
    await api('POST', '/api/auth/forgot-password', { email: fpEmail.value })
    toast.show(t('auth_code_sent'), 'success')
    fpCodeCountdown.value = 60
    fpCountdownTimer = setInterval(() => {
      fpCodeCountdown.value--
      if (fpCodeCountdown.value <= 0 && fpCountdownTimer) clearInterval(fpCountdownTimer)
    }, 1000)
    fpStep.value = 'reset'
  } catch (e: any) { toast.show(t('auth_failed_op') + String(e), 'error') }
  fpCodeSending.value = false
}
async function fpReset() {
  if (!fpCode.value || fpCode.value.length !== 6) { toast.show(t('auth_need_code'), 'error'); return }
  if (!fpNewPwd.value || fpNewPwd.value.length < 8) { toast.show(t('reg_pwd_min_8'), 'error'); return }
  if (fpNewPwd.value !== fpConfirmPwd.value) { toast.show(t('sp_pwd_mismatch'), 'error'); return }
  fpSending.value = true
  try {
    const res = await api('POST', '/api/auth/reset-password', { email: fpEmail.value, code: fpCode.value, password: fpNewPwd.value })
    if (res.ok) { toast.show(t('toast_pwd_reset'), 'success'); closeForgot() }
    else { toast.show(t('auth_code_invalid'), 'error') }
  } catch (e: any) { toast.show(t('auth_failed_op') + String(e), 'error') }
  fpSending.value = false
}

// ===== Field validation =====
const fieldErrors = ref<Record<string, string>>({})

function validateNickname(val: string) {
  if (!val) { fieldErrors.value.nickname = ''; return }
  if (val.length < 2) { fieldErrors.value.nickname = t('val_nickname_short'); return }
  if (val.length > 30) { fieldErrors.value.nickname = t('val_nickname_long'); return }
  if (!/^[\w\u4e00-\u9fa5]+$/.test(val)) { fieldErrors.value.nickname = t('val_nickname_invalid'); return }
  fieldErrors.value.nickname = ''
}

function validateEmail(val: string) {
  if (!val) { fieldErrors.value.email = ''; return }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { fieldErrors.value.email = t('val_email_invalid'); return }
  fieldErrors.value.email = ''
}

function validateRegPhone(val: string) {
  if (!val) { fieldErrors.value.regPhone = ''; return }
  if (!PHONE_RE.test(val)) { fieldErrors.value.regPhone = t('val_phone_format'); return }
  fieldErrors.value.regPhone = ''
}

function validateRegCode(val: string) {
  if (!val) { fieldErrors.value.regCode = ''; return }
  if (val.length !== 6) { fieldErrors.value.regCode = t('val_code_6digit'); return }
  fieldErrors.value.regCode = ''
}

function validateRegConfirm(val: string) {
  if (!val) { fieldErrors.value.regConfirm = ''; return }
  if (val !== regPassword.value) { fieldErrors.value.regConfirm = t('sp_pwd_mismatch'); return }
  fieldErrors.value.regConfirm = ''
}

// ===== View switching =====
function switchAuthView(view: 'login-phone' | 'login-password' | 'register') { authView.value = view }
function goBackToLogin() { authView.value = 'login-phone' }
</script>

<template>
  <div class="auth-page">
    <div class="auth-inner">
      <!-- Left: Form -->
      <div class="auth-left">
        <!-- Theme toggle: top-right corner -->
        <button class="theme-pill theme-pill-absolute" @click="toggleMode" :title="currentMode === 'dark' ? t('mode_light') : t('mode_dark')">
          <svg v-if="currentMode === 'dark'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
          <span>{{ currentMode === 'dark' ? t('mode_light') : t('mode_dark') }}</span>
        </button>
        <div class="auth-card">

          <!-- ===== LOGIN ===== -->
          <div v-if="authView === 'login-phone' || authView === 'login-password'" class="auth-view">
            <div class="auth-brand">
              <div class="auth-logo">C</div>
              <span class="auth-brand-name">ClipSync</span>
            </div>
            <h1 class="auth-heading">{{ t('login_welcome') }}</h1>
            <p class="auth-subtitle">{{ authTab === 'password' ? t('login_pwd_subtitle') : t('login_subtitle') }}</p>

            <div class="auth-tabs">
              <button :class="['auth-tab', { active: authTab === 'phone' }]" @click="authTab = 'phone'">{{ t('tab_phone_login') }}</button>
              <button :class="['auth-tab', { active: authTab === 'password' }]" @click="authTab = 'password'">{{ t('tab_password_login') }}</button>
            </div>

            <!-- Phone Code Login -->
            <div v-if="authTab === 'phone'" class="auth-form">
              <div class="form-group">
                <label class="form-label">{{ t('login_phone') }}</label>
                <input id="lp-phone" v-model="authPhone" type="tel" maxlength="11" class="form-input" :placeholder="t('ph_phone_placeholder')" />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('login_code') }}</label>
                <div class="form-row">
                  <input id="lp-code" v-model="authCode" type="text" maxlength="6" class="form-input" :placeholder="t('ph_code_placeholder')" />
                  <button id="send-code-btn" class="btn-code" :disabled="isSendingCode || codeCountdown > 0" @click="sendCode">
                    {{ codeCountdown > 0 ? t('code_resend', { s: codeCountdown }) : t('login_send_code') }}
                  </button>
                </div>
              </div>
              <div class="form-options">
                <label class="checkbox-label"><input type="checkbox" v-model="rememberMe" /> {{ t('login_remember') }}</label>
                <button class="link-btn" @click="toast.show(t('toast_code_resent'),'info')">{{ t('login_forgot_code') }}</button>
              </div>
              <button class="btn-primary btn-block" :disabled="isLoggingIn" @click="handleLogin">
                <span v-if="isLoggingIn" class="spinner" /> {{ t('login_signin') }}
              </button>
            </div>

            <!-- Password Login -->
            <div v-else class="auth-form">
              <div class="form-group">
                <label class="form-label">{{ t('login_account') }}</label>
                <input id="lp-account" v-model="authAccount" type="text" class="form-input" :placeholder="t('ph_account_placeholder')" @keydown.enter="handleLogin" />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('login_password') }}</label>
                <div class="pwd-wrap">
                  <input id="lp-pwd" v-model="authPassword" :type="showLoginPassword ? 'text' : 'password'" class="form-input" :placeholder="t('ph_password_placeholder')" @keydown.enter="handleLogin" />
                  <button class="pwd-toggle" @click="showLoginPassword = !showLoginPassword" type="button">
                    <svg v-if="showLoginPassword" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
                  </button>
                </div>
              </div>
              <div class="form-options">
                <label class="checkbox-label"><input type="checkbox" v-model="rememberMe" /> {{ t('login_remember') }}</label>
                <button class="link-btn" @click="openForgot">{{ t('login_forgot') }}</button>
              </div>
              <button class="btn-primary btn-block" :disabled="isLoggingIn" @click="handleLogin">
                <span v-if="isLoggingIn" class="spinner" /> {{ t('login_signin') }}
              </button>
            </div>

            <div class="auth-switch">
              {{ t('login_no_account') }}
              <button class="link-btn" @click="switchAuthView('register')">{{ t('login_create_free') }}</button>
            </div>
            <div class="auth-divider"><span>{{ t('login_or_continue') }}</span></div>
            <div class="auth-social">
              <button class="social-btn" @click="toast.show(t('toast_signup_soon'),'info')" title="WeChat">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8.5 12c.8 0 1.5-.7 1.5-1.5S9.3 9 8.5 9 7 9.7 7 10.5 7.7 12 8.5 12zM15 12c.8 0 1.5-.7 1.5-1.5S15.8 9 15 9s-1.5.7-1.5 1.5.7 1.5 1.5 1.5z"/><path d="M19.5 10.2c0-3.4-3.6-6.2-8-6.2s-8 2.8-8 6.2c0 3.1 2.8 5.7 6.6 6.2.3.1.7.2.8.5l.3 1.2c.1.3.3.5.6.5s.5-.2.6-.5l.3-1.2c.1-.3.5-.4.8-.5C16.7 15.9 19.5 13.3 19.5 10.2z"/></svg>
              </button>
              <button class="social-btn" @click="toast.show(t('toast_signup_soon'),'info')" title="Apple">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
              </button>
              <button class="social-btn" @click="toast.show(t('toast_signup_soon'),'info')" title="GitHub">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
              </button>
              <button class="social-btn" @click="toast.show(t('toast_signup_soon'),'info')" title="WeCom">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
              </button>
            </div>
          </div>

          <!-- ===== REGISTER ===== -->
          <div v-else-if="authView === 'register'" class="auth-view">
            <button class="back-btn" @click="switchAuthView('login-phone')">← {{ t('btn_back_login') }}</button>
            <h1 class="auth-heading">{{ t('reg_title') }}</h1>
            <p class="auth-subtitle">{{ t('reg_subtitle') }}</p>
            <div class="auth-form">
              <div class="form-group">
                <label class="form-label">{{ t('reg_label_phone') }} <span class="required">*</span></label>
                <input id="reg-phone" v-model="regPhone" type="tel" maxlength="11" class="form-input" :class="{ error: fieldErrors.regPhone }" :placeholder="t('reg_phone_hint')" @blur="validateRegPhone(regPhone)" @input="fieldErrors.regPhone = ''" />
                <div v-if="fieldErrors.regPhone" class="field-error">{{ fieldErrors.regPhone }}</div>
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('reg_label_nickname') }}</label>
                <input v-model="regNickname" type="text" maxlength="30" class="form-input" :class="{ error: fieldErrors.nickname }" :placeholder="t('reg_nickname_hint')" @blur="validateNickname(regNickname)" @input="fieldErrors.nickname = ''" />
                <div v-if="fieldErrors.nickname" class="field-error">{{ fieldErrors.nickname }}</div>
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('reg_label_email') }}</label>
                <input v-model="regEmail" type="email" maxlength="100" class="form-input" :class="{ error: fieldErrors.email }" :placeholder="t('reg_email_hint')" @blur="validateEmail(regEmail)" @input="fieldErrors.email = ''" />
                <div v-if="fieldErrors.email" class="field-error">{{ fieldErrors.email }}</div>
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('login_code') }} <span class="required">*</span></label>
                <div class="form-row">
                  <input id="reg-code" v-model="regCode" type="text" maxlength="6" class="form-input" :class="{ error: fieldErrors.regCode }" :placeholder="t('ph_code_placeholder')" @blur="validateRegCode(regCode)" @input="fieldErrors.regCode = ''" />
                  <button class="btn-code" :disabled="isSendingCode || codeCountdown > 0" @click="sendCode">
                    {{ codeCountdown > 0 ? t('code_resend', { s: codeCountdown }) : t('login_send_code') }}
                  </button>
                </div>
                <div v-if="fieldErrors.regCode" class="field-error">{{ fieldErrors.regCode }}</div>
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('sp_set_pwd_label') }} <span class="required">*</span></label>
                <div class="pwd-wrap">
                  <input id="reg-pwd" v-model="regPassword" :type="showRegPassword ? 'text' : 'password'" class="form-input" :placeholder="t('sp_pwd_hint')" />
                  <button class="pwd-toggle" @click="showRegPassword = !showRegPassword" type="button">
                    <svg v-if="showRegPassword" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
                  </button>
                </div>
                <div v-if="regPassword.length > 0" class="pwd-strength">
                  <div class="strength-bar" :class="strengthClass(regPwdStrength.score)" :style="{ width: (regPwdStrength.score * 25) + '%' }"></div>
                  <span class="strength-label">{{ regPwdStrength.label }}</span>
                </div>
                <div v-if="regPassword.length > 0" class="pwd-rules">
                  <span :class="regPassword.length >= 8 ? 'valid' : 'invalid'">{{ t('sp_rule_length') }}</span>
                  <span :class="/\d/.test(regPassword) ? 'valid' : 'invalid'">{{ t('sp_rule_number') }}</span>
                  <span :class="/[a-zA-Z]/.test(regPassword) ? 'valid' : 'invalid'">{{ t('sp_rule_letter') }}</span>
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('sp_confirm_pwd') }} <span class="required">*</span></label>
                <div class="pwd-wrap">
                  <input id="reg-confirm" v-model="regConfirm" :type="showRegConfirm ? 'text' : 'password'" class="form-input" :class="{ error: fieldErrors.regConfirm }" :placeholder="t('sp_confirm_hint')" @blur="validateRegConfirm(regConfirm)" @input="fieldErrors.regConfirm = ''" />
                  <button class="pwd-toggle" @click="showRegConfirm = !showRegConfirm" type="button">
                    <svg v-if="showRegConfirm" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
                  </button>
                </div>
                <div v-if="fieldErrors.regConfirm" class="field-error">{{ fieldErrors.regConfirm }}</div>
              </div>
              <label class="checkbox-label" style="margin-top:-4px;">
                <input type="checkbox" v-model="regAgree" /> {{ t('reg_agree_text') }}<a href="javascript:void(0)" class="link-btn" @click="toast.show(t('toast_tos_soon'),'info')">{{ t('reg_tos') }}</a>{{ t('reg_and') }}<a href="javascript:void(0)" class="link-btn" @click="toast.show(t('toast_privacy_soon'),'info')">{{ t('reg_privacy') }}</a>
              </label>
              <button class="btn-primary btn-block" :disabled="isRegistering" @click="handleRegister">
                <span v-if="isRegistering" class="spinner" /> {{ t('reg_submit') }}
              </button>
            </div>
            <div class="auth-divider"><span>{{ t('reg_or_social') }}</span></div>
            <div class="auth-social">
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
            <div class="auth-switch">
              {{ t('reg_has_account') }}
              <button class="link-btn" @click="switchAuthView('login-phone')">{{ t('reg_sign_in_now') }}</button>
            </div>
          </div>

          <!-- ===== SET PASSWORD ===== -->
          <div v-else-if="authView === 'set-password'" class="auth-view">
            <button class="back-btn" @click="goBackToLogin()">← {{ t('btn_back_login') }}</button>
            <!-- Step indicator -->
            <div class="sp-steps">
              <div class="sp-step completed"><div class="sp-step-num">✓</div><span>{{ t('sp_verify_identity') }}</span></div>
              <div class="sp-step-line completed"></div>
              <div class="sp-step active"><div class="sp-step-num">2</div><span>{{ t('sp_set_password') }}</span></div>
            </div>
            <h1 class="auth-heading" style="font-size:20px;">{{ t('sp_new_account') }}</h1>
            <p class="auth-subtitle">{{ t('sp_new_account_desc') }}</p>
            <div class="auth-form">
              <div class="form-group">
                <label class="form-label">{{ t('sp_set_pwd_label') }}</label>
                <div class="pwd-wrap">
                  <input id="sp-pwd" v-model="setPwdNew" :type="showSetPwdPassword ? 'text' : 'password'" class="form-input" :placeholder="t('sp_pwd_hint')" />
                  <button class="pwd-toggle" @click="showSetPwdPassword = !showSetPwdPassword" type="button">
                    <svg v-if="showSetPwdPassword" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
                  </button>
                </div>
                <div v-if="setPwdNew.length > 0" class="pwd-strength">
                  <div class="strength-bar" :class="strengthClass(setPwdStrength.score)" :style="{ width: (setPwdStrength.score * 25) + '%' }"></div>
                  <span class="strength-label">{{ setPwdStrength.label }}</span>
                </div>
                <div v-if="setPwdNew.length > 0" class="pwd-rules">
                  <span :class="setPwdNew.length >= 8 ? 'valid' : 'invalid'">{{ t('sp_rule_length') }}</span>
                  <span :class="/\d/.test(setPwdNew) ? 'valid' : 'invalid'">{{ t('sp_rule_number') }}</span>
                  <span :class="/[a-zA-Z]/.test(setPwdNew) ? 'valid' : 'invalid'">{{ t('sp_rule_letter') }}</span>
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('sp_confirm_pwd') }}</label>
                <div class="pwd-wrap">
                  <input id="sp-confirm" v-model="setPwdConfirm" :type="showSetPwdConfirm ? 'text' : 'password'" class="form-input" :placeholder="t('sp_confirm_hint')" />
                  <button class="pwd-toggle" @click="showSetPwdConfirm = !showSetPwdConfirm" type="button">
                    <svg v-if="showSetPwdConfirm" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
                  </button>
                </div>
              </div>
              <button class="btn-primary btn-block" :disabled="isSettingPwd || !setPwdValid" @click="handleSetPassword">
                <span v-if="isSettingPwd" class="spinner" /> {{ t('sp_complete_register') }}
              </button>
            </div>
          </div>

        </div>
      </div>

      <!-- Right: Decorative panel -->
      <div class="auth-right">
        <div class="auth-right-bg"></div>
        <div class="auth-right-content">
          <p class="quote-text">{{ t('login_quote') || 'The best way to sync your clipboard across devices.' }}</p>
          <p class="quote-author">— Carlos Shao, Founder</p>
        </div>
      </div>
    </div>

    <!-- ===== FORGOT PASSWORD MODAL ===== -->
    <Teleport to="body">
      <div v-if="showForgotModal" class="modal-overlay" @click.self="closeForgot">
        <div class="modal-box">
          <button class="modal-close" @click="closeForgot">&times;</button>
          <h2 class="modal-title">{{ t('fp_title') }}</h2>
          <!-- Step 1: Email -->
          <div v-if="fpStep === 'email'" class="modal-form">
            <div class="form-group">
              <label class="form-label">{{ t('fp_email_label') }}</label>
              <input v-model="fpEmail" type="email" class="form-input" :placeholder="t('fp_email_hint')" @keydown.enter="fpSendCode" />
            </div>
            <button class="btn-primary btn-block" :disabled="fpCodeSending" @click="fpSendCode">
              <span v-if="fpCodeSending" class="spinner" /> {{ t('fp_send_code') }}
            </button>
          </div>
          <!-- Step 2: Reset -->
          <div v-else class="modal-form">
            <div class="form-group">
              <label class="form-label">{{ t('login_code') }}</label>
              <input v-model="fpCode" type="text" maxlength="6" class="form-input" :placeholder="t('ph_code_placeholder')" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('sp_set_pwd_label') }}</label>
              <div class="pwd-wrap">
                <input v-model="fpNewPwd" :type="showFpNewPwd ? 'text' : 'password'" class="form-input" :placeholder="t('sp_pwd_hint')" />
                <button class="pwd-toggle" @click="showFpNewPwd = !showFpNewPwd" type="button">
                  <svg v-if="showFpNewPwd" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
              <div v-if="fpNewPwd.length > 0" class="pwd-strength">
                <div class="strength-bar" :class="strengthClass(fpPwdStrength.score)" :style="{ width: (fpPwdStrength.score * 25) + '%' }"></div>
                <span class="strength-label">{{ fpPwdStrength.label }}</span>
              </div>
              <div v-if="fpNewPwd.length > 0" class="pwd-rules">
                <span :class="fpNewPwd.length >= 8 ? 'valid' : 'invalid'">{{ t('sp_rule_length') }}</span>
                <span :class="/\d/.test(fpNewPwd) ? 'valid' : 'invalid'">{{ t('sp_rule_number') }}</span>
                <span :class="/[a-zA-Z]/.test(fpNewPwd) ? 'valid' : 'invalid'">{{ t('sp_rule_letter') }}</span>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('sp_confirm_pwd') }}</label>
              <div class="pwd-wrap">
                <input v-model="fpConfirmPwd" :type="showFpConfirm ? 'text' : 'password'" class="form-input" :placeholder="t('sp_confirm_hint')" />
                <button class="pwd-toggle" @click="showFpConfirm = !showFpConfirm" type="button">
                  <svg v-if="showFpConfirm" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
            </div>
            <button class="btn-primary btn-block" :disabled="fpSending" @click="fpReset">
              <span v-if="fpSending" class="spinner" /> {{ t('fp_reset_btn') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ===== Page layout ===== */
.auth-page { min-height: 100vh; min-height: 100dvh; background: var(--bg-base); }
.auth-inner { display: grid; grid-template-columns: 3fr 2fr; min-height: 100vh; min-height: 100dvh; }
@media (max-width: 900px) { .auth-inner { grid-template-columns: 1fr; } .auth-right { display: none; } }

/* ===== Left column ===== */
.auth-left { position: relative; display: flex; align-items: center; justify-content: center; padding: 48px 40px; overflow-y: auto; }
.auth-card { width: 100%; max-width: 420px; }

/* ===== Auth view transition ===== */
.auth-view { animation: authViewIn 0.3s ease; }
@keyframes authViewIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ===== Brand ===== */
.auth-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 32px; }
.auth-logo { width: 36px; height: 36px; border-radius: 10px; background: var(--accent); color: var(--text-inverse); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px; }
.auth-brand-name { font-size: 17px; font-weight: 700; color: var(--text-primary); }

/* ===== Heading ===== */
.auth-heading { font-size: 24px; font-weight: 700; color: var(--text-primary); margin: 0 0 8px; line-height: 1.2; }
.auth-subtitle { font-size: 14px; color: var(--text-secondary); margin: 0 0 28px; line-height: 1.5; }

/* ===== Tabs ===== */
.auth-tabs { display: flex; gap: 4px; padding: 4px; background: var(--bg-hover); border-radius: 10px; margin-bottom: 24px; }
.auth-tab { flex: 1; padding: 8px 12px; border-radius: 8px; font-size: 13px; font-weight: 500; border: none; background: transparent; color: var(--text-tertiary); cursor: pointer; transition: all 150ms; }
.auth-tab.active { background: var(--bg-surface); color: var(--text-primary); box-shadow: 0 1px 3px rgba(0,0,0,0.08); }

/* ===== Form ===== */
.auth-form { display: flex; flex-direction: column; gap: 16px; }
.form-group { display: flex; flex-direction: column; gap: 6px; }
.form-label { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
.required { color: var(--danger); font-weight: 600; }
.form-input { height: 42px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--border-default); background: var(--bg-base); color: var(--text-primary); font-size: 14px; outline: none; transition: border-color 150ms; width: 100%; box-sizing: border-box; }
.form-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
.form-row { display: flex; gap: 10px; }
.form-row .form-input { flex: 1; }
.form-options { display: flex; align-items: center; justify-content: space-between; font-size: 13px; }
.checkbox-label { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); cursor: pointer; font-size: 13px; }
.checkbox-label input[type="checkbox"] { accent-color: var(--accent); }

/* ===== Buttons ===== */
.btn-primary { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 42px; padding: 0 20px; border-radius: 10px; font-size: 14px; font-weight: 500; border: none; background: var(--accent); color: var(--text-inverse); cursor: pointer; transition: all 150ms; }
.btn-primary:hover { opacity: 0.9; transform: translateY(-0.5px); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-block { width: 100%; }
.btn-code { height: 42px; padding: 0 14px; border-radius: 10px; font-size: 13px; font-weight: 500; white-space: nowrap; border: 1px solid var(--border-default); background: var(--bg-surface); color: var(--text-secondary); cursor: pointer; transition: all 150ms; }
.btn-code:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-code:disabled { opacity: 0.5; cursor: not-allowed; }

/* ===== Spinner ===== */
.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--accent-light); border-top-color: var(--text-inverse); border-radius: 50%; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ===== Shake animation ===== */
@keyframes shake { 0%,100% { transform: translateX(0); } 20%,60% { transform: translateX(-4px); } 40%,80% { transform: translateX(4px); } }
:global(.shake) { animation: shake 0.4s ease; }

/* ===== Password field ===== */
.pwd-wrap { position: relative; }
.pwd-wrap .form-input { padding-right: 42px; }
.pwd-toggle { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; color: var(--text-tertiary); display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 6px; transition: all 150ms; }
.pwd-toggle:hover { background: var(--bg-hover); color: var(--text-secondary); }

/* ===== Password strength ===== */
.pwd-strength { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.strength-bar { height: 3px; border-radius: 2px; background: var(--border-default); transition: all 0.2s; }
.strength-bar.weak { background: var(--danger); width: 25% !important; }
.strength-bar.fair { background: var(--warning); width: 50% !important; }
.strength-bar.good { background: var(--info); width: 75% !important; }
.strength-bar.strong { background: var(--success); width: 100% !important; }
.strength-label { font-size: 11px; color: var(--text-tertiary); }

/* ===== Password rules ===== */
.pwd-rules { display: flex; gap: 12px; margin-top: 6px; font-size: 11px; color: var(--text-tertiary); flex-wrap: wrap; }
.pwd-rules span.valid { color: var(--success); }
.pwd-rules span.invalid { color: var(--danger); }

/* ===== Field validation errors ===== */
.field-error { font-size: 11.5px; color: var(--danger); margin-top: 4px; }
.form-input.error { border-color: var(--danger); }
.form-input.error:focus { box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.1); }

/* ===== Links ===== */
.auth-switch { text-align: center; margin-top: 20px; font-size: 13px; color: var(--text-secondary); }
.link-btn { background: none; border: none; color: var(--accent); font-size: 13px; cursor: pointer; padding: 0; }
.link-btn:hover { text-decoration: underline; }

/* ===== Divider ===== */
.auth-divider { display: flex; align-items: center; gap: 12px; margin: 20px 0 16px; font-size: 12px; color: var(--text-tertiary); }
.auth-divider::before, .auth-divider::after { content: ''; flex: 1; height: 1px; background: var(--border-default); }
.auth-divider span { white-space: nowrap; }

/* ===== Social buttons ===== */
.auth-social { display: flex; justify-content: center; gap: 12px; }
.social-btn { width: 42px; height: 42px; border-radius: 10px; border: 1px solid var(--border-default); background: var(--bg-surface); display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text-secondary); transition: all 150ms; }
.social-btn:hover { background: var(--bg-hover); border-color: var(--accent); color: var(--accent); }

/* ===== Theme toggle ===== */
.theme-pill-absolute { position: absolute; top: 20px; right: 20px; z-index: 10; }
.theme-pill { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 17px; border: 1px solid var(--border-default); background: var(--bg-surface); color: var(--text-secondary); font-size: 12px; font-weight: 500; cursor: pointer; transition: all 150ms; }
.theme-pill:hover { background: var(--bg-hover); border-color: var(--accent); color: var(--accent); }

/* ===== Back button ===== */
.back-btn { background: none; border: none; color: var(--text-secondary); font-size: 13px; cursor: pointer; padding: 0; margin-bottom: 16px; display: inline-flex; align-items: center; gap: 4px; }
.back-btn:hover { color: var(--text-primary); }

/* ===== Set Password Steps ===== */
.sp-steps { display: flex; align-items: center; gap: 0; margin-bottom: 24px; }
.sp-step { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-tertiary); }
.sp-step.active, .sp-step.completed { color: var(--text-primary); }
.sp-step-num { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; border: 2px solid var(--border-default); background: var(--bg-surface); }
.sp-step.active .sp-step-num { border-color: var(--accent); background: var(--accent); color: var(--text-inverse); }
.sp-step.completed .sp-step-num { border-color: var(--success); background: var(--success); color: #fff; }
.sp-step-line { width: 32px; height: 2px; background: var(--border-default); margin: 0 8px; }
.sp-step-line.completed { background: var(--success); }

/* ===== Right panel ===== */
.auth-right { position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #0f172a; }
.auth-right-bg { position: absolute; inset: 0; background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%); }
.auth-right-bg::after { content: ''; position: absolute; inset: 0; background-image: radial-gradient(circle at 2px 2px, rgba(255,255,255,0.04) 1px, transparent 0); background-size: 24px 24px; }
:global(html.dark) .auth-right { background: #1e1b4b; }
:global(html.dark) .auth-right-bg { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 30%, #4c1d95 60%, #6d28d9 100%); }
:global(html.dark) .auth-right-bg::after { background-image: radial-gradient(circle at 2px 2px, rgba(255,255,255,0.06) 1px, transparent 0); }
.auth-right-content { position: relative; z-index: 1; text-align: center; padding: 48px 40px; color: #fff; max-width: 380px; }
.quote-text { font-size: 20px; font-weight: 500; line-height: 1.6; margin: 0 0 20px; color: rgba(255,255,255,0.92); }
.quote-author { font-size: 13px; color: rgba(255,255,255,0.5); margin: 0; }

/* ===== Forgot Password Modal ===== */
.modal-overlay { position: fixed; inset: 0; background: var(--bg-modal-overlay); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal-box { position: relative; background: var(--bg-surface); border-radius: var(--radius-lg); padding: 32px; width: 100%; max-width: 400px; box-shadow: var(--shadow-modal); }
.modal-close { position: absolute; top: 12px; right: 16px; background: none; border: none; font-size: 20px; color: var(--text-tertiary); cursor: pointer; }
.modal-close:hover { color: var(--text-primary); }
.modal-title { font-size: 18px; font-weight: 700; color: var(--text-primary); margin: 0 0 24px; }
.modal-form { display: flex; flex-direction: column; gap: 16px; }
</style>
