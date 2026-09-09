<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { getPricingPlans, type PricingPlan } from '@/composables/usePlanLimits'

const { t } = useI18n()
const toast = useSonner()
const emit = defineEmits<{ back: [] }>()

// ===== 真实套餐价格（管理台 subscription_plans 实时数据）=====
// 此前此处硬编码 ¥9.9/¥29，与管理台改价脱节（用户验收实测打回），
// 统一改走 GET /api/subscriptions/plans；加载失败显示「—」而非虚构价格。
const plans = ref<PricingPlan[]>([])
const loaded = ref(false)

const FEATURE_KEYS: Record<string, string[]> = {
  free: ['feat_3dev', 'feat_100hist', 'feat_community'],
  pro: ['feat_unlimited_dev', 'feat_unlimited_hist', 'feat_priority'],
  enterprise: ['feat_team', 'feat_api', 'feat_priority'],
}

const PLAN_NAME_KEYS: Record<string, string> = {
  free: 'price_free',
  pro: 'price_pro',
  enterprise: 'price_enterprise',
}

const orderedPlans = ref<{ key: string; plan: PricingPlan | null }[]>([])

function buildOrdered() {
  const byKey = new Map(plans.value.map((p) => [p.name.toLowerCase(), p]))
  orderedPlans.value = ['free', 'pro', 'enterprise'].map((key) => ({
    key,
    plan: byKey.get(key) ?? null,
  }))
}

onMounted(async () => {
  plans.value = await getPricingPlans()
  loaded.value = true
  buildOrdered()
})

function planName(key: string): string {
  return t(PLAN_NAME_KEYS[key] ?? key)
}

function planPrice(plan: PricingPlan | null): string {
  return plan ? `¥${plan.priceMonthly}` : '—'
}

// ===== Plan selection =====
function selectPlan(plan: PricingPlan | null) {
  if (!plan) {
    toast.show(t('ft_building'), 'info')
    return
  }
  if (plan.name.toLowerCase() === 'free' || plan.priceMonthly === 0) {
    toast.show(t('already_free'), 'info')
    return
  }
  // Placeholder: payment flow not yet implemented
  toast.show(t('ft_building'), 'info')
}
</script>

<template>
  <div>
    <h3 class="sp-title">{{ t('modal_pricing') }}</h3>
    <p class="sp-desc">{{ t('sg_current_plan_h_free') }}</p>

    <div class="pricing-grid">
      <div
        v-for="entry in orderedPlans"
        :key="entry.key"
        class="price-card"
        :class="{ popular: entry.key === 'pro' }"
        @click="selectPlan(entry.plan)"
      >
        <div v-if="entry.key === 'pro'" class="pc-tag">{{ t('price_popular') }}</div>
        <div class="pc-name">{{ planName(entry.key) }}</div>
        <div class="pc-price">
          {{ planPrice(entry.plan) }}<span class="pc-period">{{ t('price_per_mo') }}</span>
        </div>
        <div class="pc-feats">
          <template v-for="feat in FEATURE_KEYS[entry.key]" :key="feat">
            &#10003; {{ t(feat) }}<br />
          </template>
        </div>
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
.pricing-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.price-card {
  padding: 20px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  cursor: pointer;
  position: relative;
  transition: border-color 0.15s;
}
.price-card:hover {
  border-color: var(--accent);
}
.price-card.popular {
  border-color: var(--accent);
  background: var(--accent-light);
}
.pc-tag {
  position: absolute;
  top: -8px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 10px;
  font-weight: 600;
  color: var(--text-inverse);
  background: var(--accent);
  padding: 2px 10px;
  border-radius: 8px;
  white-space: nowrap;
}
.pc-name {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.pc-price {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 12px;
}
.pc-period {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-tertiary);
}
.pc-feats {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.8;
}
</style>
