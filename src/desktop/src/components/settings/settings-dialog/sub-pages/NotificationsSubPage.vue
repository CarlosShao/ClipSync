<script setup lang="ts">
import { reactive, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useNotifications } from '@/composables/useNotifications'
import Switch from '@/components/ui/switch/Switch.vue'

const { t } = useI18n()
const emit = defineEmits<{ back: [] }>()

const { loadPreferencesInto, savePreference, PREF_TYPE_BY_KEY } = useNotifications()

// ===== State =====
interface NotifPrefs {
  nfNewDevice: boolean
  nfSyncDone: boolean
  nfSecurity: boolean
  nfUpdates: boolean
}

const notifPrefs = reactive<NotifPrefs>({
  nfNewDevice: true,
  nfSyncDone: true,
  nfSecurity: true,
  nfUpdates: true,
})

// ===== Save handler =====
function handleToggle(key: keyof NotifPrefs, value: boolean) {
  ;(notifPrefs as any)[key] = value
  // Persist to localStorage as fallback
  const raw = localStorage.getItem('clipsync-sec-notif')
  let existing: any = {}
  try {
    if (raw) existing = JSON.parse(raw)
  } catch {
    /* ignore */
  }
  existing[key] = value
  localStorage.setItem('clipsync-sec-notif', JSON.stringify(existing))
  // Sync to backend
  savePreference(key, value)
}

// ===== Data loading =====
onMounted(async () => {
  // Load from backend via composable
  await loadPreferencesInto(notifPrefs as Record<string, boolean>)
})
</script>

<template>
  <div>
    <h3 class="sp-title">{{ t('modal_notif') }}</h3>
    <p class="sp-desc">{{ t('sg_notifp_h') }}</p>
    <div class="sec-list">
      <div class="sec-item">
        <div>
          <div class="sec-label">{{ t('nf_new_device') }}</div>
          <div class="sec-hint">{{ t('nf_new_device_h') }}</div>
        </div>
        <Switch
          :model-value="notifPrefs.nfNewDevice"
          @update:model-value="(v: boolean) => handleToggle('nfNewDevice', v)"
        />
      </div>
      <div class="sec-item">
        <div>
          <div class="sec-label">{{ t('nf_sync_done') }}</div>
          <div class="sec-hint">{{ t('nf_sync_done_h') }}</div>
        </div>
        <Switch
          :model-value="notifPrefs.nfSyncDone"
          @update:model-value="(v: boolean) => handleToggle('nfSyncDone', v)"
        />
      </div>
      <div class="sec-item">
        <div>
          <div class="sec-label">{{ t('nf_security') }}</div>
          <div class="sec-hint">{{ t('nf_security_h') }}</div>
        </div>
        <Switch
          :model-value="notifPrefs.nfSecurity"
          @update:model-value="(v: boolean) => handleToggle('nfSecurity', v)"
        />
      </div>
      <div class="sec-item">
        <div>
          <div class="sec-label">{{ t('nf_updates') }}</div>
          <div class="sec-hint">{{ t('nf_updates_h') }}</div>
        </div>
        <Switch
          :model-value="notifPrefs.nfUpdates"
          @update:model-value="(v: boolean) => handleToggle('nfUpdates', v)"
        />
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
