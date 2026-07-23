<script setup lang="ts">
import { reactive, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import Switch from '@/components/ui/switch/Switch.vue'

const { t } = useI18n()
const toast = useSonner()
const emit = defineEmits<{ back: [] }>()

const STORAGE_KEY = 'clipsync-sec-notif'

// ===== State =====
interface SecNotifPrefs {
  twoFA: boolean
  loginNotification: boolean
}

const secNotif = reactive<SecNotifPrefs>({
  twoFA: false,
  loginNotification: true,
})

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (typeof parsed.twoFA === 'boolean') secNotif.twoFA = parsed.twoFA
      if (typeof parsed.loginNotification === 'boolean') secNotif.loginNotification = parsed.loginNotification
    }
  } catch {
    /* ignore */
  }
}

function saveSecNotif(partial: Partial<SecNotifPrefs>) {
  Object.assign(secNotif, partial)
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...secNotif }))
  // 后端暂无 /api/user/security-notifications，本地持久化即可
  toast.show(t('settings_saved'), 'success')
}

onMounted(() => {
  loadFromStorage()
})
</script>

<template>
  <div>
    <h3 class="sp-title">{{ t('modal_security') }}</h3>
    <p class="sp-desc">{{ t('sg_2fa_h') }}</p>
    <div class="sec-list">
      <div class="sec-item">
        <div>
          <div class="sec-label">{{ t('sec_2fa') }}</div>
          <div class="sec-hint">{{ t('sec_2fa_h') }}</div>
        </div>
        <Switch :model-value="secNotif.twoFA" @update:model-value="(v: boolean) => saveSecNotif({ twoFA: v })" />
      </div>
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
      <div class="sec-item">
        <div>
          <div class="sec-label">{{ t('sec_e2ee') }}</div>
          <div class="sec-hint">{{ t('sec_e2ee_pending') }}</div>
        </div>
        <Switch :model-value="false" disabled />
      </div>
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
}
.sec-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}
</style>
