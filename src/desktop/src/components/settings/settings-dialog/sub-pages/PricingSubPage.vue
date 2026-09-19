<script setup lang="ts">
/**
 * 设置 →「订阅与账单」→ 当前套餐子页。
 * 卡片渲染与「只升不降」判定统一交给 PlanCards（与升级弹窗、订阅页同一套规则）。
 * 价格此前在此处硬编码 ¥9.9/¥29，与管理台套餐表脱节被验收打回，现全部走
 * GET /api/subscriptions/plans；档位判定依赖 GET /api/subscriptions/current。
 */
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useConfigStore } from '@/stores/configStore'
import { useMenuAccess } from '@/composables/useMenuAccess'
import PlanCards from '@/components/pricing/PlanCards.vue'
import {
  formatExpiryDate,
  hasUpgradeHeadroom,
  resolveCurrentSubscription,
} from '@/composables/useSubscriptionAccess'
import type { PricingPlan } from '@/composables/usePlanLimits'
import type { BillingCycle } from '@/composables/useSubscriptionAccess'

const emit = defineEmits<{ back: []; 'open-modal': [type: string] }>()

const { t } = useI18n()
const configStore = useConfigStore()
const { can } = useMenuAccess()

const current = computed(() => resolveCurrentSubscription(configStore.user.plan))
/** 当前档位展示名（role_pro / role_free … 与左下角账号区同一批键） */
const currentPlanLabel = computed(() => t('role_' + (current.value.planName || 'Free').toLowerCase()))
const expiryText = computed(() => formatExpiryDate(current.value.periodEnd))
/** Enterprise 已无升级空间：只显当前档，不给购买入口 */
const upgradable = computed(() => can('nav.subscription') && hasUpgradeHeadroom(current.value.planName))

function onSelect(_plan: PricingPlan, _cycle: BillingCycle) {
  // 打开真实的「套餐→支付→扫码」弹窗流（PricingPaymentModals）
  emit('open-modal', 'pricing')
}
</script>

<template>
  <div>
    <h3 class="sp-title">{{ t('modal_pricing') }}</h3>
    <p class="sp-desc">
      {{ t('sub_current_plan_is', { plan: currentPlanLabel }) }}
      <template v-if="expiryText"> · {{ t('sub_expiry_date', { date: expiryText }) }}</template>
    </p>

    <!-- enable_subscription 关闭：套餐卡与升级入口整体不渲染（服务端 403 仍是权威兜底） -->
    <PlanCards v-if="upgradable" @select="onSelect" />
    <p v-else class="sp-desc sp-desc--muted">{{ t('plan_no_upgrade_headroom') }}</p>
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
.sp-desc--muted {
  color: var(--text-tertiary);
  font-size: 12px;
}
</style>
