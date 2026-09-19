<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { ChevronRight } from 'lucide-vue-next'

const { t, tf } = useI18n()
const emit = defineEmits<{ 'open-sub-page': [page: string] }>()

// 2026-09-19 裁定：套餐管理（升级/取消订阅/申请退款）只在「个人资料」页，
// 设置里不再放套餐与升级入口；发票下载功能砍掉（账单历史已列付款记录）。
// 因此本分组只剩一条账单历史入口，分组标题也从「订阅与账单」收窄为「账单」。
// 文案用新 key sg_bill_only：旧 key sg_sub_bill 词典值仍是「订阅与账单」。
</script>

<template>
  <div class="settings-group">
    <div class="sg-header">{{ tf('sg_bill_only', '账单') }}</div>
    <div class="sg-row sg-row--clickable" @click="emit('open-sub-page', 'billing')">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_billing') }}</div>
        <div class="sg-hint">{{ t('sg_billing_h') }}</div>
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
