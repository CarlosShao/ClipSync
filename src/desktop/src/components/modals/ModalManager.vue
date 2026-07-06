<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useToast } from '@/composables/useToast'
import { useTheme } from '@/composables/useTheme'
import { api } from '@/api/client'
import ModalDialog from '@/components/ui/ModalDialog.vue'

const props = defineProps<{
  showModalType: string
  showForgotPwd?: boolean
  previewItem?: any
  previewType?: string
  confirmMessage?: string
}>()
const emit = defineEmits<{
  'close-modal': []
  'close-forgot-pwd': []
  'close-preview': []
  'confirm-action': []
}>()

const { t } = useI18n()
const toast = useToast()
const { allThemes, setStyle, currentStyle } = useTheme()

// Forgot password state
const fpStep = ref(1)
const fpEmail = ref('')
const fpCode = ref('')
const fpNewPwd = ref('')
const fpConfirmPwd = ref('')
const fpSending = ref(false)

async function downloadImage() {
  if (!props.previewItem?.content) return
  const dataUrl = props.previewItem.content
  // 尝试使用 File System Access API（支持选择保存位置）
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: `clipsync-image-${Date.now()}.png`,
        types: [{ description: 'Image', accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg'] } }],
      })
      const blob = await (await fetch(dataUrl)).blob()
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return
    } catch (e: any) {
      if (e.name === 'AbortError') return // 用户取消
    }
  }
  // Fallback: 直接下载
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = `clipsync-image-${Date.now()}.png`
  a.click()
}

function handleCloseForgot() {
  fpStep.value = 1; fpEmail.value = ''; fpCode.value = ''; fpNewPwd.value = ''; fpConfirmPwd.value = ''
  emit('close-forgot-pwd')
}

async function handleForgotSend() {
  if (!fpEmail.value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fpEmail.value)) {
    toast.show(t('val_email_invalid'), 'error'); return
  }
  fpSending.value = true
  try {
    const res = await api('POST', '/api/auth/forgot-password', { email: fpEmail.value })
    if (res.ok) { fpStep.value = 2; toast.show(t('toast_pwd_reset'), 'success') }
    else { toast.show(res.error || '', 'error') }
  } catch (e: any) { toast.show(t('auth_failed_op') + String(e), 'error') }
  fpSending.value = false
}

async function handleForgotReset() {
  if (fpNewPwd.value !== fpConfirmPwd.value) { toast.show(t('sp_pwd_mismatch'), 'error'); return }
  fpSending.value = true
  try {
    const res = await api('POST', '/api/auth/reset-password', { email: fpEmail.value, code: fpCode.value, password: fpNewPwd.value })
    if (res.ok) { toast.show(t('toast_pwd_reset'), 'success'); handleCloseForgot() }
    else { toast.show(res.error || t('auth_code_invalid'), 'error') }
  } catch (e: any) { toast.show(t('auth_failed_op') + String(e), 'error') }
  fpSending.value = false
}

function toggleClass(e: Event) {
  (e.currentTarget as HTMLElement).classList.toggle('on')
}
</script>

<template>
  <!-- Theme -->
  <ModalDialog :open="showModalType === 'themes'" :title="t('modal_themes')" max-width="520px" @close="emit('close-modal')">
    <div class="theme-grid">
      <div v-for="th in allThemes" :key="th.value" :class="['theme-opt', { active: currentStyle === th.value }]" @click="setStyle(th.value as any); emit('close-modal')">
        <div class="theme-preview" :style="{
          background: th.value === 'vercel' ? 'linear-gradient(135deg,#FAFAFA 0%,#E5E5E5 100%)' : th.value === 'clipsync' ? 'linear-gradient(135deg,#6366F1 0%,#A78BFA 100%)' : th.value === 'notion' ? 'linear-gradient(135deg,#FFFFFF 0%,#EBF4FF 100%)' : th.value === 'linear' ? 'linear-gradient(135deg,#0A0A0A 0%,#1a162d 100%)' : th.value === 'apple' ? 'linear-gradient(135deg,#F5F5F7 0%,#E5F1FF 100%)' : th.value === 'raycast' ? 'linear-gradient(135deg,#07080a 0%,#1b1c1e 100%)' : 'linear-gradient(135deg,#FEFEFE 0%,#F3EEFF 100%)',
          color: ['notion','apple','vercel','arc'].includes(th.value) ? '#111' : '#fff',
          border: th.value === 'notion' ? '1px solid #E8E7E3' : 'none',
        }">{{ th.value === 'vercel' ? 'Vercel ★' : th.label }}</div>
        <div class="theme-name">{{ th.label }}</div>
      </div>
    </div>
  </ModalDialog>

  <!-- Shortcuts -->
  <ModalDialog :open="showModalType === 'shortcuts'" :title="t('modal_shortcuts')" max-width="400px" @close="emit('close-modal')">
    <div class="shortcut-list">
      <div class="sk-item"><span>{{ t('sk_quick_paste') }}</span><div class="sk-keys"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd></div></div>
      <div class="sk-item"><span>{{ t('sk_copy_clip') }}</span><div class="sk-keys"><kbd>↵</kbd></div></div>
      <div class="sk-item"><span>{{ t('sk_search') }}</span><div class="sk-keys"><kbd>Ctrl</kbd>+<kbd>F</kbd></div></div>
    </div>
  </ModalDialog>

  <!-- Sessions -->
  <ModalDialog :open="showModalType === 'sessions'" :title="t('modal_sessions')" max-width="480px" @close="emit('close-modal')">
    <div class="session-list">
      <div class="session-item"><div class="session-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><div class="session-info"><div class="session-name">MacBook Pro</div><div class="session-detail">Current session</div></div><span class="session-badge">{{ t('sess_current') }}</span></div>
      <div class="session-item"><div class="session-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></div><div class="session-info"><div class="session-name">iPhone 15 Pro</div><div class="session-detail">Active 15m ago</div></div><button class="btn btn-ghost btn-sm" style="color:var(--danger)">{{ t('sess_sign_out_btn') }}</button></div>
    </div>
  </ModalDialog>

  <!-- Security -->
  <ModalDialog :open="showModalType === 'security'" :title="t('modal_security')" max-width="480px" @close="emit('close-modal')">
    <div class="sec-list">
      <div class="sec-item"><div><div class="sec-label">{{ t('sec_2fa') }}</div><div class="sec-hint">{{ t('sec_2fa_h') }}</div></div><button class="toggle" @click="toggleClass" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('sec_login_notif') }}</div><div class="sec-hint">{{ t('sec_login_notif_h') }}</div></div><button class="toggle on" @click="toggleClass" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('sec_e2ee') }}</div><div class="sec-hint">{{ t('sec_e2ee_h') }}</div></div><button class="toggle on" disabled style="opacity:.5;cursor:not-allowed;" /></div>
    </div>
  </ModalDialog>

  <!-- Pricing -->
  <ModalDialog :open="showModalType === 'pricing'" :title="t('modal_pricing')" max-width="560px" @close="emit('close-modal')">
    <div class="pricing-grid">
      <div class="price-card"><div class="pc-name">{{ t('price_free') }}</div><div class="pc-price">¥0<span class="pc-period">{{ t('price_per_mo') }}</span></div><div class="pc-feats">✓ {{ t('feat_3dev') }}<br />✓ {{ t('feat_100hist') }}<br />✓ {{ t('feat_community') }}</div></div>
      <div class="price-card popular"><div class="pc-tag">{{ t('price_popular') }}</div><div class="pc-name">{{ t('price_pro') }}</div><div class="pc-price">¥9.9<span class="pc-period">{{ t('price_per_mo') }}</span></div><div class="pc-feats">✓ {{ t('feat_unlimited_dev') }}<br />✓ {{ t('feat_unlimited_hist') }}<br />✓ {{ t('feat_priority') }}</div></div>
      <div class="price-card"><div class="pc-name">{{ t('price_enterprise') }}</div><div class="pc-price">¥29<span class="pc-period">{{ t('price_per_mo') }}</span></div><div class="pc-feats">✓{{ t('feat_team') }}<br />✓ {{ t('feat_api') }}<br />✓ {{ t('feat_priority') }}</div></div>
    </div>
  </ModalDialog>

  <!-- Payment Method -->
  <ModalDialog :open="showModalType === 'payment'" :title="t('modal_payment')" max-width="420px" @close="emit('close-modal')">
    <div style="display:flex;flex-direction:column;gap:10px;">
      <button class="payment-option" @click="toast.show(t('toast_signup_soon'), 'info')">
        <span style="font-size:20px;">💚</span> <span>WeChat Pay</span>
      </button>
      <button class="payment-option" @click="toast.show(t('toast_signup_soon'), 'info')">
        <span style="font-size:20px;">🔵</span> <span>Alipay</span>
      </button>
    </div>
  </ModalDialog>

  <!-- Cancel Subscription -->
  <ModalDialog :open="showModalType === 'cancel-subscription'" :title="t('sub_cancel')" max-width="420px" @close="emit('close-modal')">
    <div style="text-align:center;padding:20px 0;">
      <p style="font-size:14px;color:var(--text-secondary);margin-bottom:20px;">{{ t('sub_cancel_h') }}</p>
      <button class="btn btn-danger btn-full" @click="toast.show(t('toast_signup_soon'), 'info')">{{ t('sub_cancel') }}</button>
    </div>
  </ModalDialog>

  <!-- Billing -->
  <ModalDialog :open="showModalType === 'billing'" :title="t('modal_billing')" max-width="480px" @close="emit('close-modal')">
    <div style="text-align:center;padding:40px 20px;">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--text-tertiary);margin-bottom:12px;"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/></svg>
      <h3 style="font-size:15px;font-weight:600;margin-bottom:4px;">{{ t('billing_empty') }}</h3>
      <p style="font-size:13px;color:var(--text-secondary);">{{ t('billing_empty_desc') }}</p>
    </div>
  </ModalDialog>

  <!-- Notifications -->
  <ModalDialog :open="showModalType === 'notifications'" :title="t('modal_notif')" max-width="480px" @close="emit('close-modal')">
    <div class="sec-list">
      <div v-for="n in [{k:'nf_new_device',h:'nf_new_device_h'},{k:'nf_sync_done',h:'nf_sync_done_h'},{k:'nf_security',h:'nf_security_h'},{k:'nf_updates',h:'nf_updates_h'}]" :key="n.k" class="sec-item">
        <div><div class="sec-label">{{ t(n.k) }}</div><div class="sec-hint">{{ t(n.h) }}</div></div>
        <button class="toggle on" @click="toggleClass" />
      </div>
    </div>
  </ModalDialog>

  <!-- Updates -->
  <ModalDialog :open="showModalType === 'updates'" :title="t('upd_title')" max-width="420px" @close="emit('close-modal')">
    <div style="text-align:center;padding:16px 0;">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="1.5" style="margin-bottom:12px;"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <h3 style="font-size:16px;font-weight:600;margin-bottom:4px;">{{ t('upd_uptodate') }}</h3>
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">{{ t('upd_version') }}: v2.4.1</p>
      <p style="font-size:13px;color:var(--text-tertiary);">{{ t('upd_latest') }}</p>
      <div style="margin-top:16px;text-align:left;font-size:12px;color:var(--text-secondary);line-height:1.8;padding:12px;background:var(--bg-hover);border-radius:var(--radius-sm);">
        <div style="font-weight:600;margin-bottom:4px;">{{ t('upd_whatsnew') }}</div>
        <div>• {{ t('upd_changelog_1') }}</div><div>• {{ t('upd_changelog_2') }}</div><div>• {{ t('upd_changelog_3') }}</div><div>• {{ t('upd_changelog_4') }}</div>
      </div>
    </div>
  </ModalDialog>

  <!-- Export -->
  <ModalDialog :open="showModalType === 'export'" :title="t('export_title')" max-width="460px" @close="emit('close-modal')">
    <div style="text-align:center;padding:8px 0;">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--accent);margin-bottom:12px;"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      <p style="font-size:13px;color:var(--text-secondary);line-height:1.7;" v-html="t('export_msg')" />
      <button class="btn btn-primary btn-full" style="margin-top:16px;">{{ t('export_request_btn') }}</button>
    </div>
  </ModalDialog>

  <!-- Forgot Password -->
  <ModalDialog :open="!!showForgotPwd" :title="t('fp_title')" max-width="420px" @close="handleCloseForgot">
    <div v-if="fpStep === 1">
      <div style="margin-bottom:12px;"><label class="field-label">{{ t('fp_email_label') }}</label><input v-model="fpEmail" type="email" class="field-input" :placeholder="t('fp_email_hint')" style="width:100%;" /></div>
      <button class="btn btn-primary btn-full" :disabled="fpSending" @click="handleForgotSend"><span v-if="fpSending" class="btn-spinner" /><span>{{ t('fp_send_code') }}</span></button>
    </div>
    <div v-else>
      <div style="margin-bottom:12px;"><label class="field-label">{{ t('login_code') }}</label><input v-model="fpCode" type="text" maxlength="6" class="field-input" :placeholder="t('ph_code_placeholder')" style="width:100%;" /></div>
      <div style="margin-bottom:12px;"><label class="field-label">{{ t('sp_set_pwd_label') }}</label><input v-model="fpNewPwd" type="password" class="field-input" :placeholder="t('sp_pwd_hint')" style="width:100%;" /></div>
      <div style="margin-bottom:16px;"><label class="field-label">{{ t('sp_confirm_pwd') }}</label><input v-model="fpConfirmPwd" type="password" class="field-input" :placeholder="t('sp_confirm_hint')" style="width:100%;" /></div>
      <button class="btn btn-primary btn-full" :disabled="fpSending" @click="handleForgotReset"><span v-if="fpSending" class="btn-spinner" /><span>{{ t('fp_reset_btn') }}</span></button>
    </div>
  </ModalDialog>

  <!-- Image Preview -->
  <ModalDialog :open="previewType === 'image'" :title="t('img_preview_title')" max-width="640px" @close="emit('close-preview')">
    <div v-if="previewItem" style="text-align:center;">
      <div style="width:100%;max-height:400px;overflow:hidden;border-radius:var(--radius-md);background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);display:flex;align-items:center;justify-content:center;margin-bottom:12px;">
        <img :src="previewItem.content" style="max-width:100%;max-height:380px;object-fit:contain;" alt="" />
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--text-secondary);">
        <span>Image</span>
        <button class="btn btn-sm btn-ghost" @click="downloadImage">{{ t('img_downloaded') }}</button>
      </div>
    </div>
  </ModalDialog>

  <!-- Text Detail -->
  <ModalDialog :open="previewType === 'text'" :title="t('text_detail_title')" max-width="640px" @close="emit('close-preview')">
    <div v-if="previewItem" style="font-size:13px;line-height:1.7;background:var(--bg-hover);padding:16px;border-radius:var(--radius-md);white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto;color:var(--text-primary);">{{ previewItem.content }}</div>
  </ModalDialog>

  <!-- Add Device -->
  <ModalDialog :open="showModalType === 'add-device'" :title="t('modal_add_device')" max-width="420px" @close="emit('close-modal')">
    <div style="text-align:center;padding:20px 0;">
      <div style="width:120px;height:120px;margin:0 auto 16px;background:var(--bg-hover);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--text-tertiary);">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
        </svg>
      </div>
      <p style="font-size:13px;color:var(--text-secondary);">Install ClipSync on another device and sign in with the same account to sync.</p>
    </div>
  </ModalDialog>

  <!-- Confirm -->
  <ModalDialog :open="showModalType === 'confirm'" :title="t('confirm_title')" max-width="380px" @close="emit('close-modal')">
    <p style="font-size:14px;line-height:1.6;">{{ confirmMessage }}</p>
    <template #footer>
      <button class="btn btn-ghost" @click="emit('close-modal')">{{ t('btn_cancel_text') }}</button>
      <button class="btn btn-primary" @click="emit('confirm-action')" style="background:var(--danger);color:#fff;">{{ t('confirm_t') }}</button>
    </template>
  </ModalDialog>
</template>

<style scoped>
/* Override button style for inline btns */
.btn { display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-sm); font-weight: 500; cursor: pointer; border: 1px solid transparent; white-space: nowrap; font-family: inherit; }
.btn-primary { background: var(--accent); color: var(--text-inverse); }
.btn-ghost { background: transparent; color: var(--text-secondary); border: none; }
.btn-ghost:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-sm { height: 28px; padding: 0 10px; font-size: 12px; }
.btn-full { width: 100%; }
.btn-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 6px; }
@keyframes spin { to { transform: rotate(360deg); } }

.theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
.theme-opt { cursor: pointer; text-align: center; }
.theme-preview { height: 80px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.theme-name { font-size: 12px; color: var(--text-secondary); }
.theme-opt.active .theme-name { color: var(--accent); font-weight: 500; }

.shortcut-list { display: flex; flex-direction: column; gap: 8px; }
.sk-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border-subtle); font-size: 13px; }
.sk-item:last-child { border-bottom: none; }
.sk-keys kbd { font-size: 11px; background: var(--bg-hover); border: 1px solid var(--border-default); border-radius: 3px; padding: 2px 6px; font-family: monospace; }

.session-list { display: flex; flex-direction: column; gap: 8px; }
.session-item { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border-subtle); }
.session-item:last-child { border-bottom: none; }
.session-icon { flex-shrink: 0; color: var(--text-secondary); }
.session-info { flex: 1; }
.session-name { font-size: 13px; font-weight: 500; }
.session-detail { font-size: 11px; color: var(--text-tertiary); margin-top: 2px; }
.session-badge { font-size: 10px; font-weight: 600; text-transform: uppercase; color: var(--accent); background: var(--accent-light); padding: 2px 8px; border-radius: 8px; }

.sec-list { display: flex; flex-direction: column; gap: 12px; }
.sec-item { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--border-subtle); }
.sec-item:last-child { border-bottom: none; }
.sec-label { font-size: 13px; font-weight: 500; }
.sec-hint { font-size: 11px; color: var(--text-tertiary); margin-top: 2px; }

.pricing-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.payment-option { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-surface); cursor: pointer; font-size: 14px; color: var(--text-primary); transition: all 150ms; }
.payment-option:hover { border-color: var(--accent); background: var(--bg-hover); }
.btn { display: inline-flex; align-items: center; justify-content: center; height: 38px; padding: 0 16px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid transparent; }
.btn-danger { background: var(--danger); color: #fff; }
.btn-danger:hover { opacity: 0.9; }
.btn-full { width: 100%; }
.price-card { padding: 20px; border: 1px solid var(--border-default); border-radius: var(--radius-md); cursor: pointer; position: relative; }
.price-card:hover { border-color: var(--accent); }
.price-card.popular { border-color: var(--accent); background: var(--accent-light); }
.pc-tag { position: absolute; top: -8px; left: 50%; transform: translateX(-50%); font-size: 10px; font-weight: 600; color: var(--text-inverse); background: var(--accent); padding: 2px 10px; border-radius: 8px; }
.pc-name { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.pc-price { font-size: 24px; font-weight: 700; margin-bottom: 12px; }
.pc-period { font-size: 12px; font-weight: 400; color: var(--text-tertiary); }
.pc-feats { font-size: 12px; color: var(--text-secondary); line-height: 1.8; }

.toggle { position: relative; display: inline-block; width: 40px; height: 22px; cursor: pointer; border-radius: 11px; background: var(--border-default); border: none; padding: 0; flex-shrink: 0; transition: background 0.2s; }
.toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: white; transition: left 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,.15); }
.toggle.on { background: var(--accent); }
.toggle.on::after { left: 20px; }
.field-label { font-size: 13px; font-weight: 500; color: var(--text-secondary); margin-bottom: 6px; display:block; }
.field-input { height: 38px; padding: 0 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-default); background: var(--bg-base); color: var(--text-primary); font-size: 14px; outline: none; font-family: inherit; box-sizing:border-box; }
</style>
