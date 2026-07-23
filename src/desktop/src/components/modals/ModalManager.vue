<script setup lang="ts">
import { watch, reactive } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useTheme } from '@/composables/useTheme'
import { useNotifications } from '@/composables/useNotifications'
import { CircleCheck, QrCode } from 'lucide-vue-next'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import Switch from '@/components/ui/switch/Switch.vue'
import QrPairingModals from '@/components/modals/QrPairingModals.vue'
import SessionsModal from '@/components/modals/SessionsModal.vue'
import VersionHistoryModal from '@/components/modals/VersionHistoryModal.vue'
import BillingModal from '@/components/modals/BillingModal.vue'
import PricingPaymentModals from '@/components/modals/PricingPaymentModals.vue'
import ForgotPasswordModal from '@/components/modals/ForgotPasswordModal.vue'
import ImagePreviewModal from '@/components/modals/ImagePreviewModal.vue'
import DocPreviewModal from '@/components/modals/DocPreviewModal.vue'
import ShortcutsModal from '@/components/modals/ShortcutsModal.vue'
import FeedbackModal from '@/components/modals/FeedbackModal.vue'
import ExportModal from '@/components/modals/ExportModal.vue'
import './modal-shared.css'

const props = defineProps<{
  showModalType: string
  showForgotPwd?: boolean
  previewItem?: any
  previewType?: string
  confirmMessage?: string
  versionItemId?: string
}>()
const emit = defineEmits<{
  'close-modal': []
  'close-forgot-pwd': []
  'close-preview': []
  'confirm-action': []
  'switch-modal': [type: string]
  'show-pin-dialog': []
  'show-pin-setup': []
  'toggle-sensitive': [item: any]
}>()

const { t } = useI18n()
const toast = useSonner()
const { allThemes, setStyle, currentStyle } = useTheme()
const { savePreference, loadPreferencesInto, PREF_TYPE_BY_KEY } = useNotifications()

// ===== Security & Notification Preferences (persisted to localStorage) =====
// security 与 notifications 两个弹窗共享此状态，故保留在编排层
const SEC_NOTIF_KEY = 'clipsync-sec-notif'
interface SecNotifPrefs {
  twoFA: boolean
  loginNotification: boolean
  nfNewDevice: boolean
  nfSyncDone: boolean
  nfSecurity: boolean
  nfUpdates: boolean
}
const defaultSecNotif: SecNotifPrefs = {
  twoFA: false,
  loginNotification: true,
  nfNewDevice: true,
  nfSyncDone: true,
  nfSecurity: true,
  nfUpdates: true,
}
function loadSecNotif(): SecNotifPrefs {
  try {
    const raw = localStorage.getItem(SEC_NOTIF_KEY)
    if (raw) return { ...defaultSecNotif, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...defaultSecNotif }
}
function saveSecNotif(partial: Partial<SecNotifPrefs>) {
  Object.assign(secNotif, partial)
  localStorage.setItem(SEC_NOTIF_KEY, JSON.stringify({ ...secNotif }))
  // 通知类开关同步到后端（其余安全开关如 2FA 仅本地）
  Object.keys(partial).forEach((key) => {
    if (key in PREF_TYPE_BY_KEY) savePreference(key, (partial as any)[key])
  })
}
// Initialize from localStorage immediately (before any render)
const secNotif = reactive(loadSecNotif())

// 打开通知弹窗时从后端拉取最新偏好（其余弹窗的自动加载由各子组件 immediate watch 处理）
watch(() => props.showModalType, (type) => {
  if (type === 'notifications') loadPreferencesInto(secNotif)
}, { immediate: true })
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
  <ShortcutsModal :show-modal-type="showModalType" @close="emit('close-modal')" />

  <!-- Sessions -->
  <SessionsModal :show-modal-type="showModalType" @close="emit('close-modal')" />

  <!-- Security -->
  <ModalDialog :open="showModalType === 'security'" :title="t('modal_security')" max-width="480px" @close="emit('close-modal')">
    <div class="sec-list">
      <div class="sec-item"><div><div class="sec-label">{{ t('sec_2fa') }}</div><div class="sec-hint">{{ t('sec_2fa_h') }}</div></div><Switch :model-value="secNotif.twoFA" @update:model-value="(v: boolean) => saveSecNotif({ twoFA: v })" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('sec_login_notif') }}</div><div class="sec-hint">{{ t('sec_login_notif_h') }}</div></div><Switch :model-value="secNotif.loginNotification" @update:model-value="(v: boolean) => saveSecNotif({ loginNotification: v })" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('sec_e2ee') }}</div><div class="sec-hint">{{ t('sec_e2ee_pending') }}</div></div><Switch :model-value="false" disabled /></div>
    </div>
  </ModalDialog>

  <!-- Pricing / Payment / Result -->
  <PricingPaymentModals :show-modal-type="showModalType" @close="emit('close-modal')" @switch-modal="(type) => emit('switch-modal', type)" />

  <!-- Cancel Subscription -->
  <ModalDialog :open="showModalType === 'cancel-subscription'" :title="t('sub_cancel')" max-width="420px" @close="emit('close-modal')">
    <div class="modal-center-pad20">
      <p class="cancel-text">{{ t('sub_cancel_h') }}</p>
      <Button variant="destructive" class="w-full" @click="toast.show(t('toast_signup_soon'), 'info')">{{ t('sub_cancel') }}</Button>
    </div>
  </ModalDialog>

  <!-- Billing / Invoices -->
  <BillingModal :show-modal-type="showModalType" @close="emit('close-modal')" />

  <!-- Notifications -->
  <ModalDialog :open="showModalType === 'notifications'" :title="t('modal_notif')" max-width="480px" @close="emit('close-modal')">
    <div class="sec-list">
      <div class="sec-item"><div><div class="sec-label">{{ t('nf_new_device') }}</div><div class="sec-hint">{{ t('nf_new_device_h') }}</div></div><Switch :model-value="secNotif.nfNewDevice" @update:model-value="(v: boolean) => saveSecNotif({ nfNewDevice: v })" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('nf_sync_done') }}</div><div class="sec-hint">{{ t('nf_sync_done_h') }}</div></div><Switch :model-value="secNotif.nfSyncDone" @update:model-value="(v: boolean) => saveSecNotif({ nfSyncDone: v })" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('nf_security') }}</div><div class="sec-hint">{{ t('nf_security_h') }}</div></div><Switch :model-value="secNotif.nfSecurity" @update:model-value="(v: boolean) => saveSecNotif({ nfSecurity: v })" /></div>
      <div class="sec-item"><div><div class="sec-label">{{ t('nf_updates') }}</div><div class="sec-hint">{{ t('nf_updates_h') }}</div></div><Switch :model-value="secNotif.nfUpdates" @update:model-value="(v: boolean) => saveSecNotif({ nfUpdates: v })" /></div>
    </div>
  </ModalDialog>

  <!-- Updates -->
  <ModalDialog :open="showModalType === 'updates'" :title="t('upd_title')" max-width="420px" @close="emit('close-modal')">
    <div class="upd-box">
      <CircleCheck :size="48" class="upd-ico" />
      <h3 class="upd-title">{{ t('upd_uptodate') }}</h3>
      <p class="upd-version">{{ t('upd_version') }}: v2.4.1</p>
      <p class="upd-latest">{{ t('upd_latest') }}</p>
      <div class="upd-changelog">
        <div class="upd-changelog-h">{{ t('upd_whatsnew') }}</div>
        <div>• {{ t('upd_changelog_1') }}</div><div>• {{ t('upd_changelog_2') }}</div><div>• {{ t('upd_changelog_3') }}</div><div>• {{ t('upd_changelog_4') }}</div>
      </div>
    </div>
  </ModalDialog>

  <!-- Feedback -->
  <FeedbackModal :show-modal-type="showModalType" @close="emit('close-modal')" />

  <!-- Export -->
  <ExportModal :show-modal-type="showModalType" @close="emit('close-modal')" />

  <!-- Forgot Password -->
  <ForgotPasswordModal :open="!!showForgotPwd" @close="emit('close-forgot-pwd')" />

  <!-- Image Preview -->
  <ImagePreviewModal :preview-item="previewItem" :preview-type="previewType" @close="emit('close-preview')" />

  <!-- Text / Document / File Detail -->
  <DocPreviewModal
    :preview-item="previewItem"
    :preview-type="previewType"
    @close="emit('close-preview')"
    @show-pin-dialog="emit('show-pin-dialog')"
    @show-pin-setup="emit('show-pin-setup')"
    @toggle-sensitive="(item) => emit('toggle-sensitive', item)"
  />

  <!-- Add Device -->
  <ModalDialog :open="showModalType === 'add-device'" :title="t('modal_add_device')" max-width="420px" @close="emit('close-modal')">
    <div class="modal-center-pad20">
      <div class="add-device-qr">
        <QrCode :size="48" class="add-device-ico" />
      </div>
      <p class="modal-desc">{{ t('add_device_desc') }}</p>
    </div>
  </ModalDialog>

  <!-- QR Pairing: Generate + Scan -->
  <QrPairingModals :show-modal-type="showModalType" @close="emit('close-modal')" />

  <!-- Confirm -->
  <ModalDialog :open="showModalType === 'confirm'" :title="t('confirm_title')" max-width="380px" @close="emit('close-modal')">
    <p class="confirm-body">{{ confirmMessage }}</p>
    <template #footer>
      <Button variant="outline" @click="emit('close-modal')">{{ t('btn_cancel_text') }}</Button>
      <Button variant="default" @click="emit('confirm-action')">{{ t('confirm_t') }}</Button>
    </template>
  </ModalDialog>

  <!-- Version History -->
  <VersionHistoryModal :show-modal-type="showModalType" :version-item-id="versionItemId" @close="emit('close-modal')" />
</template>

<style scoped>
.theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
.theme-opt { cursor: pointer; text-align: center; }
.theme-preview { height: 80px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.theme-name { font-size: 12px; color: var(--text-secondary); }
.theme-opt.active .theme-name { color: var(--accent); font-weight: 500; }

.sec-list { display: flex; flex-direction: column; gap: 12px; }
.sec-item { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--border-subtle); }
.sec-item:last-child { border-bottom: none; }
.sec-label { font-size: 13px; font-weight: 500; }
.sec-hint { font-size: 11px; color: var(--text-tertiary); margin-top: 2px; }

/* Cancel subscription */
.cancel-text { font-size:14px; color:var(--text-secondary); margin-bottom:20px; }

/* Updates */
.upd-box { text-align:center; padding:16px 0; }
.upd-ico { display: block; margin: 0 auto 12px; color: var(--success); }
.upd-title { font-size:16px; font-weight:600; margin-bottom:4px; }
.upd-version { font-size:13px; color:var(--text-secondary); margin-bottom:8px; }
.upd-latest { font-size:13px; color:var(--text-tertiary); }
.upd-changelog { margin-top:16px; text-align:left; font-size:12px; color:var(--text-secondary); line-height:1.8; padding:12px; background:var(--bg-hover); border-radius:var(--radius-sm); }
.upd-changelog-h { font-weight:600; margin-bottom:4px; }

/* Add device */
.add-device-qr { width:120px; height:120px; margin:0 auto 16px; background:var(--bg-hover); border-radius:var(--radius-md); display:flex; align-items:center; justify-content:center; }
.add-device-ico { color: var(--text-tertiary); }

/* Confirm */
.confirm-body { font-size:14px; line-height:1.6; }
</style>
