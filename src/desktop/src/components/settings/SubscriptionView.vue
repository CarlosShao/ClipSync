<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
const { t } = useI18n()
const emit = defineEmits<{ 'open-modal': [type: string] }>()
</script>

<template>
  <div class="toolbar">
    <div class="toolbar-left"><span class="toolbar-title">{{ t('nav_subscription') }}</span></div>
  </div>
  <div class="settings-view">
    <h2 class="sv-title">{{ t('nav_subscription') }}</h2>
    <div class="sg-header">{{ t('sub_usage') }}</div>
    <div class="sub-stats">
      <div class="sub-stat-card"><div class="stat-value">0</div><div class="stat-label">{{ t('sub_clips_synced') }}</div></div>
      <div class="sub-stat-card"><div class="stat-value">0 MB</div><div class="stat-label">{{ t('sub_data_transferred') }}</div></div>
      <div class="sub-stat-card"><div class="stat-value">0</div><div class="stat-label">{{ t('sub_shared_links') }}</div></div>
    </div>
    <div class="sg-header" style="margin-top:24px;">{{ t('sg_current_plan') }}</div>
    <div class="plan-card">
      <div class="plan-name">{{ t('pf_free') }}</div>
      <div class="plan-price">¥0<span class="plan-period">{{ t('price_per_mo') }}</span></div>
      <ul class="plan-feats">
        <li>✓ {{ t('feat_3dev') }}</li>
        <li>✓ {{ t('feat_100hist') }}</li>
        <li>✓ {{ t('feat_community') }}</li>
      </ul>
      <button class="btn btn-primary btn-full" @click="emit('open-modal', 'pricing')">{{ t('sub_change_plan') }}</button>
      <button class="btn btn-ghost btn-full" style="margin-top:8px;color:var(--danger);" @click="emit('open-modal', 'cancel-subscription')">{{ t('sub_cancel') }}</button>
    </div>
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 8px; height: 48px; padding: 0 16px; border-bottom: 1px solid var(--border-default); background: var(--bg-surface); flex-shrink: 0; }
.toolbar-left { display: flex; align-items: center; gap: 8px; }
.toolbar-title { font-weight: 600; font-size: 14px; }
.settings-view { padding: 24px; max-width: 720px; overflow-y: auto; flex: 1; }
.sv-title { font-size: 22px; font-weight: 700; margin-bottom: 24px; }
.sg-header { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--text-tertiary); margin-bottom: 8px; }
.sub-stats { display: flex; gap: 12px; margin-top: 8px; margin-bottom: 24px; }
.sub-stat-card { flex: 1; padding: 16px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); text-align: center; }
.stat-value { font-size: 24px; font-weight: 700; }
.stat-label { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }
.plan-card { padding: 24px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg); max-width: 320px; }
.plan-name { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
.plan-price { font-size: 32px; font-weight: 700; margin-bottom: 16px; }
.plan-period { font-size: 14px; font-weight: 400; color: var(--text-tertiary); }
.plan-feats { list-style: none; padding: 0; margin-bottom: 20px; font-size: 13px; color: var(--text-secondary); line-height: 2; }
.btn { display: inline-flex; align-items: center; justify-content: center; height: 34px; padding: 0 14px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid transparent; white-space: nowrap; }
.btn-primary { background: var(--accent); color: var(--text-inverse); }
.btn-primary:hover { background: var(--accent-hover); }
.btn-ghost { background: transparent; border-color: var(--border-default); color: var(--text-secondary); }
.btn-ghost:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-full { width: 100%; }
</style>
