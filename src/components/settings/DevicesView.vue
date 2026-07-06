<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { useDevice } from '@/composables/useDevice'

const { t } = useI18n()
const device = useDevice()
</script>

<template>
  <div class="devices-grid">
    <div v-for="d in device.devices.value" :key="d.id" class="dev-card">
      <div class="dev-card-header">
        <div class="dev-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect v-if="d.type==='desktop'" x="2" y="3" width="20" height="14" rx="2"/><line v-if="d.type==='desktop'" x1="8" y1="21" x2="16" y2="21"/><line v-if="d.type==='desktop'" x1="12" y1="17" x2="12" y2="21"/>
            <rect v-if="d.type==='mobile'" x="5" y="2" width="14" height="20" rx="2"/><line v-if="d.type==='mobile'" x1="12" y1="18" x2="12.01" y2="18"/>
            <rect v-if="d.type==='browser'" x="2" y="2" width="20" height="20" rx="2"/><line v-if="d.type==='browser'" x1="2" y1="6" x2="22" y2="6"/>
          </svg>
        </div>
        <div class="dev-status-dot" :class="{ on: d.online }" />
      </div>
      <div class="dev-card-body">
        <div class="dev-name">{{ d.name }}</div>
        <div class="dev-detail">{{ d.location || t('dev_desktop') }} · {{ d.online ? 'Online' : 'Offline' }}</div>
      </div>
    </div>
    <div v-if="device.devices.value.length === 0" class="text-secondary" style="font-size:13px;padding:20px 0;">No devices connected yet.</div>
  </div>
</template>

<style scoped>
.devices-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin-top: 8px; }
.dev-card { background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); padding: 16px; transition: all 0.15s; }
.dev-card:hover { border-color: var(--accent); box-shadow: var(--shadow-elevated); transform: translateY(-1px); }
.dev-card-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; }
.dev-icon { width: 40px; height: 40px; border-radius: var(--radius-sm); background: var(--bg-hover); display: flex; align-items: center; justify-content: center; color: var(--text-secondary); }
.dev-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary); margin-top: 6px; }
.dev-status-dot.on { background: var(--success); box-shadow: 0 0 6px var(--success); }
.dev-card-body { }
.dev-name { font-size: 14px; font-weight: 500; margin-bottom: 2px; }
.dev-detail { font-size: 12px; color: var(--text-tertiary); }
</style>
