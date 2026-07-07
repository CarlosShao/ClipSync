<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useDevice } from '@/composables/useDevice'
import { useToast } from '@/composables/useToast'
import { Monitor, Smartphone, Globe, Trash2, QrCode } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'

const { t } = useI18n()
const device = useDevice()
const toast = useToast()
const emit = defineEmits<{ 'open-modal': [type: string] }>()
const deviceList = computed(() => device.devices.value)

function getDeviceIcon(type: string) {
  switch (type) {
    case 'mobile': return Smartphone
    case 'browser': return Globe
    default: return Monitor
  }
}

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
      <div class="sv-actions">
        <Button @click="emit('open-modal', 'pair-generate')">+ {{ t('pair_generate') }}</Button>
        <Button variant="outline" @click="emit('open-modal', 'pair-scan')">
          <QrCode :size="14" /> {{ t('pair_scan') }}
        </Button>
      </div>
    </div>
    <div class="devices-grid">
      <div v-for="d in deviceList" :key="d.id" class="dev-card">
        <div class="dev-card-header">
          <div class="dev-icon">
            <component :is="getDeviceIcon(d.type)" :size="22" />
          </div>
          <div class="dev-actions">
            <div class="dev-status-dot" :class="{ on: d.online }" />
            <Button variant="ghost" size="icon" class="text-destructive" @click="handleDelete(d.id, d.name)" :title="t('delete_btn')">
              <Trash2 :size="14" />
            </Button>
          </div>
        </div>
        <div class="dev-card-body">
          <div class="dev-name">{{ d.name }}</div>
          <div class="dev-detail">{{ d.location || t('dev_desktop') }} · {{ d.online ? t('dev_online') : t('dev_offline') }}</div>
        </div>
      </div>
    </div>
    <div v-if="deviceList.length === 0" class="empty-state">
      <div class="empty-icon"><Smartphone :size="32" /></div>
      <div class="empty-text">{{ t('nav_devices') }} — {{ t('dev_empty') }}</div>
    </div>
  </div>
</template>

<style scoped>
.settings-view { padding: 24px; max-width: 720px; overflow-y: auto; flex: 1; }
.sv-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
.sv-actions { display: flex; gap: 8px; }
.btn-add-secondary { display: inline-flex; align-items: center; gap: 5px; }
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
.dev-delete { background: none; border: none; cursor: pointer; color: var(--text-tertiary); padding: 4px; border-radius: 4px; display: flex; align-items: center; justify-content: center; transition: all 150ms; }
.dev-delete:hover { color: var(--danger); background: var(--danger-bg); }
.dev-name { font-size: 14px; font-weight: 500; margin-bottom: 2px; }
.dev-detail { font-size: 12px; color: var(--text-tertiary); }
.empty-state { text-align: center; padding: 40px 0; }
.empty-icon { color: var(--text-tertiary); margin-bottom: 8px; display: flex; justify-content: center; }
.empty-text { font-size: 13px; color: var(--text-secondary); }
</style>
