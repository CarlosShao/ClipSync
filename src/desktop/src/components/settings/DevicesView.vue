<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useDevice } from '@/composables/useDevice'
import { useToast } from '@/composables/useToast'

const { t } = useI18n()
const device = useDevice()
const toast = useToast()
const emit = defineEmits<{ 'open-modal': [type: string] }>()
const deviceList = computed(() => device.devices.value)

async function handleDelete(id: string, name: string) {
  if (!confirm(t('confirm_msg') + ` (${name})`)) return
  const res = await device.removeDevice(id)
  if (res.ok) {
    toast.show(t('deleted'), 'success')
  } else {
    toast.show(t('del_fail') + (res.error || ''), 'error')
  }
}
</script>

<template>
  <div class="settings-view">
    <div class="sv-header">
      <h2 class="sv-title">{{ t('nav_devices') }}</h2>
      <button class="btn-add" @click="emit('open-modal', 'add-device')">+ {{ t('modal_add_device') }}</button>
    </div>
    <div class="devices-grid">
      <div v-for="d in deviceList" :key="d.id" class="dev-card">
        <div class="dev-card-header">
          <div class="dev-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect v-if="d.type==='desktop'" x="2" y="3" width="20" height="14" rx="2"/><line v-if="d.type==='desktop'" x1="8" y1="21" x2="16" y2="21"/><line v-if="d.type==='desktop'" x1="12" y1="17" x2="12" y2="21"/>
              <rect v-if="d.type==='mobile'" x="5" y="2" width="14" height="20" rx="2"/><line v-if="d.type==='mobile'" x1="12" y1="18" x2="12.01" y2="18"/>
              <rect v-if="d.type==='browser'" x="2" y="2" width="20" height="20" rx="2"/><line v-if="d.type==='browser'" x1="2" y1="6" x2="22" y2="6"/>
            </svg>
          </div>
          <div class="dev-actions">
            <div class="dev-status-dot" :class="{ on: d.online }" />
            <button class="dev-delete" @click="handleDelete(d.id, d.name)" :title="t('delete_btn')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="dev-card-body">
          <div class="dev-name">{{ d.name }}</div>
          <div class="dev-detail">{{ d.location || t('dev_desktop') }} · {{ d.online ? 'Online' : 'Offline' }}</div>
        </div>
      </div>
    </div>
    <div v-if="deviceList.length === 0" class="empty-state">
      <div class="empty-icon">📱</div>
      <div class="empty-text">{{ t('nav_devices') }} — No devices connected.</div>
    </div>
  </div>
</template>

<style scoped>
.settings-view { padding: 24px; max-width: 720px; overflow-y: auto; flex: 1; }
.sv-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
.sv-title { font-size: 22px; font-weight: 700; margin: 0; }
.btn-add { height: 34px; padding: 0 14px; border-radius: var(--radius-sm); border: 1px solid var(--border-default); background: var(--bg-surface); color: var(--text-secondary); font-size: 13px; font-weight: 500; cursor: pointer; transition: all 150ms; }
.btn-add:hover { background: var(--bg-hover); color: var(--text-primary); border-color: var(--accent); }
.devices-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.dev-card { background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); padding: 16px; transition: all 0.15s; }
.dev-card:hover { border-color: var(--accent); box-shadow: var(--shadow-elevated); transform: translateY(-1px); }
.dev-card-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; }
.dev-icon { width: 40px; height: 40px; border-radius: var(--radius-sm); background: var(--bg-hover); display: flex; align-items: center; justify-content: center; color: var(--text-secondary); }
.dev-actions { display: flex; align-items: center; gap: 8px; }
.dev-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary); }
.dev-status-dot.on { background: var(--success); box-shadow: 0 0 6px var(--success); }
.dev-delete { background: none; border: none; cursor: pointer; color: var(--text-tertiary); padding: 4px; border-radius: 4px; transition: all 150ms; }
.dev-delete:hover { color: var(--danger); background: var(--danger-bg); }
.dev-name { font-size: 14px; font-weight: 500; margin-bottom: 2px; }
.dev-detail { font-size: 12px; color: var(--text-tertiary); }
.empty-state { text-align: center; padding: 40px 0; }
.empty-icon { font-size: 32px; margin-bottom: 8px; }
.empty-text { font-size: 13px; color: var(--text-secondary); }
</style>
