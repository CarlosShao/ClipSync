<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useTheme, currentMode } from '@/composables/useTheme'
import { useConfigStore } from '@/stores/configStore'
import { useToast } from '@/composables/useToast'
import { ChevronRight, ChevronDown, Github } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Switch from '@/components/ui/switch/Switch.vue'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const { t, currentLang, setLang } = useI18n()
const { setMode } = useTheme()
const configStore = useConfigStore()
const toast = useToast()
const emit = defineEmits<{ 'open-modal': [type: string] }>()
const langModel = ref(currentLang.value)
const syncIntervalModel = ref(String(configStore.syncInterval))
const maxHistoryModel = ref(String(configStore.maxHistory))
const appVersion = '0.1.0'

// Password change form state
const showPwdChange = ref(false)
const pwdOld = ref('')
const pwdNew = ref('')
const pwdConfirm = ref('')
const pwdChanging = ref(false)
const pwdError = ref('')
const pwdSuccess = ref('')

function onMaxHistoryChange() {
  const val = Number(maxHistoryModel.value)
  if (val === 999999 && configStore.user.plan !== 'Pro' && configStore.user.plan !== 'Enterprise') {
    toast.show(t('hist_unl_locked'), 'warning')
    maxHistoryModel.value = String(configStore.maxHistory || 500)
    return
  }
  configStore.maxHistory = val
  configStore.savePrefs()
}

// reka Select emits update:modelValue; re-sync side effects
watch(langModel, (v) => setLang(v))
watch(syncIntervalModel, (v) => {
  configStore.syncInterval = Number(v)
  configStore.savePrefs()
})
watch(maxHistoryModel, () => onMaxHistoryChange())

async function handleChangePassword() {
  pwdError.value = ''
  pwdSuccess.value = ''
  if (!pwdOld.value) { pwdError.value = t('pwd_old_required') || '请输入当前密码'; return }
  if (!pwdNew.value) { pwdError.value = t('pwd_new_required') || '请输入新密码'; return }
  if (pwdNew.value.length < 8) { pwdError.value = t('pwd_min_length') || '新密码至少8位'; return }
  if (pwdNew.value !== pwdConfirm.value) { pwdError.value = t('pwd_mismatch') || '两次输入的新密码不一致'; return }

  pwdChanging.value = true
  const result = await configStore.changePassword(pwdOld.value, pwdNew.value)
  pwdChanging.value = false

  if (result.ok) {
    pwdSuccess.value = t('pwd_changed_ok') || '密码修改成功'
    resetPwdForm()
    showPwdChange.value = false
  } else {
    pwdError.value = result.error || (t('pwd_change_fail') || '密码修改失败')
  }
}

function resetPwdForm() {
  pwdOld.value = ''
  pwdNew.value = ''
  pwdConfirm.value = ''
}
</script>

<template>
  <div class="settings-view">
    <div class="settings-content">
    <h2 class="sv-title">{{ t('settings_t') }}</h2>

    <div class="settings-group">
      <div class="sg-header">{{ t('sg_gen') }}</div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_autosync') }}</div><div class="sg-hint">{{ t('sg_autosync_h') }}</div></div>
        <Switch :checked="configStore.autoSync" @update:checked="(v: boolean) => configStore.toggleAutoSync(v)" />
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_imgcomp') }}</div><div class="sg-hint">{{ t('sg_imgcomp_h') }}</div></div>
        <Switch :checked="configStore.imageCompress" @update:checked="(v: boolean) => configStore.toggleImageCompress(v)" />
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_startup') }}</div><div class="sg-hint">{{ t('sg_startup_h') }}</div></div>
        <Switch :checked="configStore.autostart" @update:checked="(v: boolean) => configStore.toggleAutostart(v)" />
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_lang') }}</div><div class="sg-hint">{{ t('sg_lang_h') }}</div></div>
        <Select v-model="langModel">
          <SelectTrigger class="sg-select"><SelectValue :placeholder="t('sg_lang')" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="zh">{{ t('lang_zh') }}</SelectItem>
            <SelectItem value="en">{{ t('lang_en') }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_interval') }}</div><div class="sg-hint">{{ t('sg_interval_h') }}</div></div>
        <Select v-model="syncIntervalModel">
          <SelectTrigger class="sg-select"><SelectValue :placeholder="t('sg_interval')" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="0">{{ t('int_rt') }}</SelectItem>
            <SelectItem value="5">{{ t('int_5m') }}</SelectItem>
            <SelectItem value="15">{{ t('int_15m') }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_maxhist') }}</div><div class="sg-hint">{{ t('sg_maxhist_h') }}</div></div>
        <Select v-model="maxHistoryModel">
          <SelectTrigger class="sg-select"><SelectValue :placeholder="t('sg_maxhist')" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="100">{{ t('hist_100') }}</SelectItem>
            <SelectItem value="500">{{ t('hist_500') }}</SelectItem>
            <SelectItem value="1000">{{ t('hist_1k') }}</SelectItem>
            <SelectItem value="999999" :disabled="configStore.user.plan !== 'Pro' && configStore.user.plan !== 'Enterprise'">{{ t('hist_unl') }}{{ configStore.user.plan !== 'Pro' && configStore.user.plan !== 'Enterprise' ? ` (${t('upgrade_required')})` : '' }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <div class="settings-group">
      <div class="sg-header">{{ t('sg_appear') }}</div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'themes')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_theme') }}</div><div class="sg-hint">{{ t('sg_theme_h') }}</div></div>
        <ChevronRight class="sg-arrow" />
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_mode') }}</div><div class="sg-hint">{{ t('sg_mode_h') }}</div></div>
        <div class="mode-seg">
          <button :class="['mode-btn', { active: currentMode === 'light' }]" @click="setMode('light')">{{ t('mode_light') }}</button>
          <button :class="['mode-btn', { active: currentMode === 'dark' }]" @click="setMode('dark')">{{ t('mode_dark') }}</button>
        </div>
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name" style="font-size:12px;">{{ t('sg_theme_hint') }}</div></div>
      </div>
    </div>

    <div class="settings-group">
      <div class="sg-header">{{ t('sg_shortcuts') }}</div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'shortcuts')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_kb_shortcuts') }}</div><div class="sg-hint">{{ t('sg_kb_shortcuts_h') }}</div></div>
        <ChevronRight class="sg-arrow" />
      </div>
    </div>

    <div class="settings-group">
      <div class="sg-header">{{ t('sg_privacy') }}</div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'security')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_2fa') }}</div><div class="sg-hint">{{ t('sg_2fa_h') }}</div></div>
        <ChevronRight class="sg-arrow" />
      </div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'sessions')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_sessions') }}</div><div class="sg-hint">{{ t('sg_sessions_h') }}</div></div>
        <ChevronRight class="sg-arrow" />
      </div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'notifications')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_notifp') }}</div><div class="sg-hint">{{ t('sg_notifp_h') }}</div></div>
        <ChevronRight class="sg-arrow" />
      </div>
      <!-- Change Password -->
      <div class="sg-row" style="cursor:pointer;" @click="showPwdChange = !showPwdChange">
        <div class="sg-label"><div class="sg-name">{{ t('sg_chpwd') || '修改密码' }}</div><div class="sg-hint">{{ t('sg_chpwd_h') || '输入旧密码和新密码以修改登录密码' }}</div></div>
        <ChevronDown :class="['sg-arrow', { 'sg-arrow--rotated': showPwdChange }]" />
      </div>
      <!-- Password change form (inline expand) -->
      <div v-if="showPwdChange" class="pwd-change-form">
        <div class="pwd-field">
          <label>{{ t('pwd_old') || '当前密码' }}</label>
          <Input v-model="pwdOld" type="password" class="sg-input--block" :placeholder="t('pwd_old_ph') || '输入当前密码'" />
        </div>
        <div class="pwd-field">
          <label>{{ t('pwd_new') || '新密码' }}</label>
          <Input v-model="pwdNew" type="password" class="sg-input--block" :placeholder="t('pwd_new_ph') || '至少8位字符'" minlength="8" />
        </div>
        <div class="pwd-field">
          <label>{{ t('pwd_confirm') || '确认新密码' }}</label>
          <Input v-model="pwdConfirm" type="password" class="sg-input--block" :placeholder="t('pwd_confirm_ph') || '再次输入新密码'" @keyup.enter="handleChangePassword" />
        </div>
        <div class="pwd-actions">
          <Button size="sm" @click="handleChangePassword" :disabled="pwdChanging">{{ pwdChanging ? (t('saving') || '修改中...') : (t('sg_chpwd_btn') || '确认修改') }}</Button>
          <Button size="sm" variant="ghost" @click="showPwdChange = false; resetPwdForm()">{{ t('cancel_btn') }}</Button>
        </div>
        <div v-if="pwdError" class="pwd-error">{{ pwdError }}</div>
        <div v-if="pwdSuccess" class="pwd-success">{{ pwdSuccess }}</div>
      </div>
    </div>

    <div class="settings-group">
      <div class="sg-header">{{ t('sg_data') }}</div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_motion') }}</div><div class="sg-hint">{{ t('sg_motion_h') }}</div></div>
        <Switch :checked="configStore.reduceMotion" @update:checked="(v: boolean) => configStore.toggleReduceMotion(v)" />
      </div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'export')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_export') }}</div><div class="sg-hint">{{ t('sg_export_h') }}</div></div>
        <ChevronRight class="sg-arrow" />
      </div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'updates')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_update') }}</div><div class="sg-hint">{{ t('sg_update_h') }}</div></div>
        <Button size="sm" variant="outline" @click.stop="emit('open-modal', 'updates')">{{ t('btn_check') }}</Button>
      </div>
    </div>

    <div class="settings-group">
      <div class="sg-header">{{ t('sg_sub_bill') }}</div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'pricing')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_current_plan') }}</div><div class="sg-hint">{{ t('sg_current_plan_h_free') }}</div></div>
        <ChevronRight class="sg-arrow" />
      </div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'billing')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_billing') }}</div><div class="sg-hint">{{ t('sg_billing_h') }}</div></div>
        <ChevronRight class="sg-arrow" />
      </div>
      </div>
    </div>

    <!-- About / Version -->
    <div class="about-section">
      <div class="about-card">
        <div class="about-logo">C</div>
        <div class="about-info">
          <div class="about-name">{{ t('app_name') }}</div>
          <div class="about-version">{{ t('app_version').replace('{v}', appVersion) }}</div>
          <div class="about-desc">{{ t('app_desc') }}</div>
        </div>
      </div>
      <div class="about-links">
        <a href="https://github.com/CarlosShao/ClipSync" target="_blank" rel="noopener" class="about-link">
          <Github :size="14" />
          {{ t('app_github') }}
        </a>
        <span class="about-link about-link-disabled">{{ t('app_docs') }}</span>
      </div>
    </div>
    </div>
</template>

<style scoped>
.settings-view { overflow-y: auto; flex: 1; max-width: 100%; }
.settings-content { padding: 24px; max-width: 720px; }
.sv-title { font-size: 22px; font-weight: 700; margin-bottom: 24px; }
.settings-group { margin-bottom: 24px; }
.sg-header { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--text-tertiary); margin-bottom: 8px; }
.sg-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: var(--radius-md); gap: 16px; }
.sg-row:hover { background: var(--bg-hover); }
.sg-label { flex: 1; min-width: 0; }
.sg-name { font-size: 14px; font-weight: 500; }
.sg-hint { font-size: 12px; color: var(--text-secondary); margin-top: 1px; }
.sg-arrow { width: 16px; height: 16px; color: var(--text-tertiary); flex-shrink: 0; }
.sg-arrow--rotated { transform: rotate(180deg); }

/* Password change inline form */
.pwd-change-form {
  margin: 4px 0 8px;
  padding: 14px;
  background: var(--bg-hover);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}
.pwd-field { margin-bottom: 10px; }
.pwd-field label { display: block; font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 4px; }
.pwd-actions { display: flex; gap: 6px; margin-top: 8px; }
.pwd-error { color: var(--danger, #ef4444); font-size: 12px; margin-top: 6px; }
.pwd-success { color: #22c55e; font-size: 12px; margin-top: 6px; }

.sg-select { width: 160px; }
.mode-seg { display: inline-flex; background: var(--bg-hover); border-radius: 8px; padding: 2px; border: 1px solid var(--border-default); }
.mode-btn { border: none; background: transparent; padding: 3px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; color: var(--text-secondary); }
.mode-btn.active { background: var(--bg-surface); color: var(--text-primary); font-weight: 500; box-shadow: 0 1px 3px rgba(0,0,0,.08); }

/* About / Version section */
.about-section { margin-top: 8px; padding: 20px; border-radius: var(--radius-lg); border: 1px solid var(--border-subtle); background: linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-hover) 100%); }
.about-card { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.about-logo { width: 48px; height: 48px; border-radius: 14px; background: linear-gradient(135deg, #6366F1 0%, #A78BFA 100%); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 700; flex-shrink: 0; box-shadow: 0 4px 12px rgba(99,102,241,.25); }
.about-info { flex: 1; min-width: 0; }
.about-name { font-size: 17px; font-weight: 700; color: var(--text-primary); }
.about-version { font-size: 13px; color: var(--accent); font-weight: 500; margin-top: 2px; }
.about-desc { font-size: 12px; color: var(--text-tertiary); margin-top: 3px; line-height: 1.5; }
.about-links { display: flex; gap: 20px; padding-top: 14px; border-top: 1px solid var(--border-subtle); }
.about-link { display: flex; align-items: center; gap: 5px; font-size: 13px; color: var(--accent); text-decoration: none; cursor: pointer; transition: opacity .15s; font-weight: 500; }
.about-link:hover { opacity: .75; text-decoration: underline; }
.about-link-disabled { color: var(--text-tertiary); cursor: not-allowed; opacity: .45; font-size: 13px; }
</style>
