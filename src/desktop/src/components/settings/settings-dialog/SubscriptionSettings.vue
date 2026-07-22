<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { ChevronRight } from 'lucide-vue-next'

const { t } = useI18n()
const toast = useSonner()
const emit = defineEmits<{ 'open-sub-page': [page: string] }>()
</script>

<template>
  <div class="settings-group">
    <div class="sg-header">{{ t('sg_sub_bill') }}</div>
    <div class="sg-row sg-row--clickable" @click="emit('open-sub-page', 'pricing')">
      <div class="sg-label"><div class="sg-name">{{ t('sg_current_plan') }}</div><div class="sg-hint">{{ t('sg_current_plan_h_free') }}</div></div>
      <ChevronRight class="sg-arrow" />
    </div>
    <div class="sg-row sg-row--clickable" @click="emit('open-sub-page', 'billing')">
      <div class="sg-label"><div class="sg-name">{{ t('sg_billing') }}</div><div class="sg-hint">{{ t('sg_billing_h') }}</div></div>
      <ChevronRight class="sg-arrow" />
    </div>
    <div class="sg-row sg-row--clickable" @click="toast.show(t('fb_not_available'), 'info')">
      <div class="sg-label"><div class="sg-name">{{ t('sg_invoices') }}</div><div class="sg-hint">{{ t('sg_invoices_h') }}</div></div>
      <ChevronRight class="sg-arrow" />
    </div>
  </div>
</template>

<style scoped>
.settings-group { margin-bottom: 24px; }
.sg-header { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--text-tertiary); margin-bottom: 8px; }
.sg-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: var(--radius-md); gap: 16px; }
.sg-row--clickable { cursor: pointer; }
.sg-row--clickable:hover { background: var(--bg-hover); }
.sg-label { flex: 1; min-width: 0; }
.sg-name { font-size: 14px; font-weight: 500; }
.sg-hint { font-size: 12px; color: var(--text-secondary); margin-top: 1px; }
.sg-arrow { width: 16px; height: 16px; color: var(--text-tertiary); flex-shrink: 0; }
</style>
