<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'
const { t } = useI18n()
const emit = defineEmits<{ 'open-modal': [type: string] }>()
</script>

<template>
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
      <Button class="w-full" @click="emit('open-modal', 'pricing')">{{ t('sub_change_plan') }}</Button>
      <Button variant="outline" class="w-full" style="margin-top:8px;color:var(--danger);" @click="emit('open-modal', 'cancel-subscription')">{{ t('sub_cancel') }}</Button>
    </div>
  </div>
</template>

<style scoped>
.settings-view { padding: 24px; max-width: 720px; margin: 0 auto; overflow-y: auto; flex: 1; }
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
/* custom .btn/.btn-primary/.btn-ghost/.btn-full removed — dead, replaced by shadcn <Button> */
</style>
