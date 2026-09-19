<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useConfigStore } from '@/stores/configStore'
import { ChevronRight } from 'lucide-vue-next'
import { formatExpiryDate, loadCurrentSubscription, resolveCurrentSubscription } from '@/composables/useSubscriptionAccess'

const { t, tf } = useI18n()
const configStore = useConfigStore()
const emit = defineEmits<{ 'open-sub-page': [page: string] }>()

// 2026-09-19：分组恢复为三行（当前套餐 / 账单历史 / 发票下载）。
// 「发票下载」不再是假按钮 —— 后端 GET /api/invoices/:id/download 已能真出 PDF，
// 与账单历史同页（BillingSubPage 每行一个下载按钮），故两行都指向 billing。
void loadCurrentSubscription()
const current = computed(() => resolveCurrentSubscription(configStore.user.plan))
const currentHint = computed(() => {
  const plan = tf(`role_${(current.value.planName || 'Free').toLowerCase()}`, current.value.planName || 'Free')
  const expiry = formatExpiryDate(current.value.periodEnd)
  return expiry
    ? tf('sub_current_plan_h_with_expiry', `当前：${plan} · 到期时间：{date}`, { plan, date: expiry })
    : tf('sub_current_plan_h_no_expiry', `当前：${plan}`, { plan })
})
</script>

<template>
  <div class="settings-group">
    <div class="sg-header">{{ tf('sg_sub_bill', '订阅与账单') }}</div>
    <div class="sg-row sg-row--clickable" @click="emit('open-sub-page', 'pricing')">
      <div class="sg-label">
        <div class="sg-name">{{ tf('sg_current_plan', '当前套餐') }}</div>
        <div class="sg-hint">{{ currentHint }}</div>
      </div>
      <ChevronRight class="sg-arrow" />
    </div>
    <div class="sg-row sg-row--clickable" @click="emit('open-sub-page', 'billing')">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_billing', '账单历史') }}</div>
        <div class="sg-hint">{{ t('sg_billing_h', '查看付款记录') }}</div>
      </div>
      <ChevronRight class="sg-arrow" />
    </div>
    <div class="sg-row sg-row--clickable" @click="emit('open-sub-page', 'billing')">
      <div class="sg-label">
        <div class="sg-name">{{ tf('sg_invoices', '发票下载') }}</div>
        <div class="sg-hint">{{ tf('sg_invoices_h', '查看并下载付款收据') }}</div>
      </div>
      <ChevronRight class="sg-arrow" />
    </div>
  </div>
</template>

<style scoped>
.settings-group {
  margin-bottom: 24px;
}
.sg-header {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  margin-bottom: 8px;
}
.sg-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  gap: 16px;
}
.sg-row--clickable {
  cursor: pointer;
}
.sg-label {
  flex: 1;
  min-width: 0;
}
.sg-name {
  font-size: 14px;
  font-weight: 500;
}
.sg-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 1px;
}
.sg-arrow {
  width: 16px;
  height: 16px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
</style>
