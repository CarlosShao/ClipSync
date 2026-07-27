<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import Switch from '@/components/ui/switch/Switch.vue'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import { X, ShieldCheck, Copy } from 'lucide-vue-next'
import QRCode from 'qrcode'
import {
  get2FAStatus,
  setup2FA,
  enable2FA,
  disable2FA,
} from '@/api/auth'

const { t } = useI18n()
const toast = useSonner()
const emit = defineEmits<{ back: [] }>()

const STORAGE_KEY = 'clipsync-sec-notif'

// ===== 登录通知（本地持久化，后端暂无对应接口） =====
interface SecNotifPrefs {
  loginNotification: boolean
}
const secNotif = reactive<SecNotifPrefs>({
  loginNotification: true,
})
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (typeof parsed.loginNotification === 'boolean') secNotif.loginNotification = parsed.loginNotification
    }
  } catch {
    /* ignore */
  }
}
function saveSecNotif(partial: Partial<SecNotifPrefs>) {
  Object.assign(secNotif, partial)
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...secNotif }))
  toast.show(t('settings_saved'), 'success')
}

// ===== 2FA 状态（来自后端，非本地） =====
const twoFAEnabled = ref(false)
const twoFALoading = ref(false)

// 开启流程弹窗
const showSetupModal = ref(false)
const setupSecret = ref('')
const setupUri = ref('')
const setupQr = ref('') // data URL
const setupCode = ref('')
const setupLoading = ref(false)

// 备份码弹窗
const showBackupModal = ref(false)
const backupCodes = ref<string[]>([])

// 关闭流程弹窗
const showDisableModal = ref(false)
const disableCode = ref('')
const disableLoading = ref(false)

async function load2FAStatus() {
  twoFALoading.value = true
  try {
    const res = await get2FAStatus()
    if (res.ok && res.data) twoFAEnabled.value = !!res.data.enabled
  } catch (e) {
    console.warn('[2FA] load status failed:', e)
  } finally {
    twoFALoading.value = false
  }
}

// 用户拨动 Switch：true=开启(进入设置流程) / false=关闭(进入关闭确认)
async function onToggle2FA(next: boolean) {
  console.log('[2FA] toggle clicked, next=', next, 'current=', twoFAEnabled.value)
  // 立即让 UI 切换，不要等后端请求
  twoFAEnabled.value = next
  if (next) {
    await startSetup()
    // 请求失败时 startSetup 不会打开弹框，需把开关回滚
    if (!showSetupModal.value) twoFAEnabled.value = false
  } else {
    openDisable()
  }
}

function cancelSetup() {
  // 只有尚未完成启用流程（备份码未展示）时才回滚
  if (!showBackupModal.value) {
    twoFAEnabled.value = false
    setupSecret.value = ''
    setupUri.value = ''
    setupQr.value = ''
    setupCode.value = ''
  }
}

function cancelDisable() {
  // 关闭弹框但未真正关闭 2FA 时把开关回滚
  if (!twoFAEnabled.value) twoFAEnabled.value = true
}

const twoFAEnabledModel = computed({
  get: () => twoFAEnabled.value,
  set: (v: boolean) => onToggle2FA(v),
})

async function startSetup() {
  setupLoading.value = true
  try {
    const res = await setup2FA()
    if (!res.ok || !res.data?.secret) {
      toast.show(t('sec_2fa_setup_fail'), 'error')
      return
    }
    setupSecret.value = res.data.secret
    setupUri.value = res.data.otpauthUri || ''
    // 生成二维码（data URL），失败则退化为手动密钥展示
    try {
      setupQr.value = await QRCode.toDataURL(setupUri.value || `otpauth://totp/ClipSync?secret=${res.data.secret}`)
    } catch {
      setupQr.value = ''
    }
    setupCode.value = ''
    showSetupModal.value = true
  } catch (e) {
    console.warn('[2FA] setup failed:', e)
    toast.show(t('sec_2fa_setup_fail'), 'error')
  } finally {
    setupLoading.value = false
  }
}

async function confirmEnable() {
  if (!setupCode.value || setupCode.value.length !== 6) {
    toast.show(t('sec_2fa_verify_fail'), 'error')
    return
  }
  setupLoading.value = true
  try {
    const res = await enable2FA(setupCode.value)
    if (res.ok && res.data?.success) {
      twoFAEnabled.value = true
      backupCodes.value = res.data.backupCodes || []
      showSetupModal.value = false
      showBackupModal.value = true
      toast.show(t('sec_2fa_enabled_toast'), 'success')
    } else {
      toast.show(t('sec_2fa_verify_fail'), 'error')
    }
  } catch (e) {
    console.warn('[2FA] enable failed:', e)
    toast.show(t('sec_2fa_setup_fail'), 'error')
  } finally {
    setupLoading.value = false
  }
}

function openDisable() {
  disableCode.value = ''
  showDisableModal.value = true
}

async function confirmDisable() {
  if (!disableCode.value || disableCode.value.length < 6) {
    toast.show(t('sec_2fa_verify_fail'), 'error')
    return
  }
  disableLoading.value = true
  try {
    const res = await disable2FA(disableCode.value)
    if (res.ok && res.data?.success) {
      twoFAEnabled.value = false
      showDisableModal.value = false
      toast.show(t('sec_2fa_disabled_toast'), 'success')
    } else {
      // 关闭失败，开关回滚为开启
      twoFAEnabled.value = true
      toast.show(t('sec_2fa_verify_fail'), 'error')
    }
  } catch (e) {
    console.warn('[2FA] disable failed:', e)
    twoFAEnabled.value = true
    toast.show(t('sec_2fa_setup_fail'), 'error')
  } finally {
    disableLoading.value = false
  }
}

async function copyBackupCodes() {
  const text = backupCodes.value.join('\n')
  try {
    await navigator.clipboard.writeText(text)
    toast.show(t('sec_2fa_copy_codes'), 'success')
  } catch {
    toast.show(t('sec_2fa_copy_codes'), 'info')
  }
}

onMounted(() => {
  loadFromStorage()
  load2FAStatus()
})
</script>

<template>
  <div>
    <h3 class="sp-title">{{ t('modal_security') }}</h3>
    <p class="sp-desc">{{ t('sg_2fa_h') }}</p>
    <div class="sec-list">
      <!-- 两步验证：真实后端流程 -->
      <div class="sec-item">
        <div>
          <div class="sec-label">
            {{ t('sec_2fa') }}
            <span v-if="twoFALoading" class="sec-badge">{{ t('sec_2fa_processing') }}</span>
            <span v-else-if="twoFAEnabled" class="sec-badge on">{{ t('sec_2fa_status_on') }}</span>
            <span v-else class="sec-badge off">{{ t('sec_2fa_status_off') }}</span>
          </div>
          <div class="sec-hint">{{ t('sec_2fa_h') }}</div>
        </div>
        <Switch v-model="twoFAEnabledModel" :disabled="twoFALoading || setupLoading" />
      </div>

      <!-- 登录通知：本地持久化 -->
      <div class="sec-item">
        <div>
          <div class="sec-label">{{ t('sec_login_notif') }}</div>
          <div class="sec-hint">{{ t('sec_login_notif_h') }}</div>
        </div>
        <Switch
          :model-value="secNotif.loginNotification"
          @update:model-value="(v: boolean) => saveSecNotif({ loginNotification: v })"
        />
      </div>

      <!-- 端到端加密：待上线 -->
      <div class="sec-item">
        <div>
          <div class="sec-label">{{ t('sec_e2ee') }}</div>
          <div class="sec-hint">{{ t('sec_e2ee_pending') }}</div>
        </div>
        <Switch :model-value="false" disabled />
      </div>
    </div>

    <!-- ===== 开启设置弹窗（扫码 + 输入验证码） ===== -->
    <Teleport to="body">
      <div v-if="showSetupModal" class="modal-overlay" @click.self="cancelSetup">
        <div class="modal-box setup-box">
          <Button variant="ghost" size="icon" class="modal-close" @click="cancelSetup"><X :size="18" /></Button>
          <h2 class="modal-title">{{ t('sec_2fa_setup_title') }}</h2>
          <p class="modal-desc">{{ t('sec_2fa_setup_desc') }}</p>

          <div class="qr-wrap">
            <img v-if="setupQr" :src="setupQr" alt="2FA QR" class="qr-img" />
            <div v-else class="qr-fallback"><ShieldCheck :size="32" /></div>
          </div>

          <div class="secret-row">
            <span class="secret-label">{{ t('sec_2fa_secret_label') }}</span>
            <code class="secret-code">{{ setupSecret }}</code>
          </div>

          <div class="form-group">
            <Input
              v-model="setupCode"
              type="text"
              maxlength="6"
              class="form-input"
              :placeholder="t('sec_2fa_code_ph')"
              @keydown.enter="confirmEnable"
            />
          </div>
          <Button class="w-full" :disabled="setupLoading || setupCode.length !== 6" @click="confirmEnable">
            <span v-if="setupLoading" class="spinner" /> {{ t('sec_2fa_verify_enable') }}
          </Button>
        </div>
      </div>
    </Teleport>

    <!-- ===== 备份码弹窗 ===== -->
    <Teleport to="body">
      <div v-if="showBackupModal" class="modal-overlay" @click.self="showBackupModal = false">
        <div class="modal-box">
          <Button variant="ghost" size="icon" class="modal-close" @click="showBackupModal = false"><X :size="18" /></Button>
          <h2 class="modal-title">{{ t('sec_2fa_backup_title') }}</h2>
          <p class="modal-desc">{{ t('sec_2fa_backup_desc') }}</p>

          <div class="backup-grid">
            <code v-for="(c, i) in backupCodes" :key="i" class="backup-code">{{ c }}</code>
          </div>

          <Button variant="outline" class="w-full" @click="copyBackupCodes">
            <Copy :size="14" /> {{ t('sec_2fa_copy_codes') }}
          </Button>
          <Button class="w-full" @click="showBackupModal = false">{{ t('btn_done') || 'Done' }}</Button>
        </div>
      </div>
    </Teleport>

    <!-- ===== 关闭确认弹窗 ===== -->
    <Teleport to="body">
      <div v-if="showDisableModal" class="modal-overlay" @click.self="cancelDisable">
        <div class="modal-box">
          <Button variant="ghost" size="icon" class="modal-close" @click="cancelDisable"><X :size="18" /></Button>
          <h2 class="modal-title">{{ t('sec_2fa_disable_title') }}</h2>
          <p class="modal-desc">{{ t('sec_2fa_disable_desc') }}</p>

          <div class="form-group">
            <Input
              v-model="disableCode"
              type="text"
              maxlength="8"
              class="form-input"
              :placeholder="t('sec_2fa_code_ph')"
              @keydown.enter="confirmDisable"
            />
          </div>
          <Button class="w-full" :disabled="disableLoading || disableCode.length < 6" @click="confirmDisable">
            <span v-if="disableLoading" class="spinner" /> {{ t('sec_2fa_disable_btn') }}
          </Button>
        </div>
      </div>
    </Teleport>
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
.sec-list {
  display: flex;
  flex-direction: column;
}
.sec-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.sec-item:last-child {
  border-bottom: none;
}
.sec-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.sec-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}
.sec-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 10px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
}
.sec-badge.on {
  background: var(--success-light, #dcfce7);
  color: var(--success, #16a34a);
}
.sec-badge.off {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}

/* ===== Modals ===== */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-modal-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}
.modal-box {
  position: relative;
  background: var(--bg-surface);
  border-radius: var(--radius-lg);
  padding: 28px;
  width: 100%;
  max-width: 400px;
  box-shadow: var(--shadow-modal);
}
.setup-box {
  max-width: 360px;
}
.modal-close {
  position: absolute;
  top: 12px;
  right: 16px;
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
}
.modal-close:hover {
  color: var(--text-primary);
}
.modal-title {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 8px;
}
.modal-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 18px;
  line-height: 1.5;
}
.qr-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  background: #fff;
  border-radius: var(--radius-md);
  margin-bottom: 14px;
}
.qr-img {
  width: 180px;
  height: 180px;
  display: block;
}
.qr-fallback {
  width: 180px;
  height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}
.secret-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 16px;
}
.secret-label {
  font-size: 12px;
  color: var(--text-secondary);
}
.secret-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  letter-spacing: 1px;
  color: var(--text-primary);
  background: var(--bg-hover);
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  word-break: break-all;
  user-select: all;
}
.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.form-input {
  height: 42px;
  padding: 0 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  transition: border-color 150ms;
  width: 100%;
  box-sizing: border-box;
}
.form-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-light);
}
.backup-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-bottom: 16px;
}
.backup-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-hover);
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  text-align: center;
  letter-spacing: 1px;
}
.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--accent-light);
  border-top-color: var(--text-inverse);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
:global(.modal-box .w-full) {
  width: 100%;
}
:global(.modal-box .w-full + .w-full) {
  margin-top: 10px;
}
</style>
