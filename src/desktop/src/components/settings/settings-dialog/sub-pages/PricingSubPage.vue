<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'

const { t } = useI18n()
const toast = useSonner()
const emit = defineEmits<{ back: [] }>()

// ===== Plan selection =====
function selectPlan(planId: string, planName: string, price: number) {
  if (price === 0) {
    toast.show(t('already_free'), 'info')
    return
  }
  // Placeholder: payment flow not yet implemented
  toast.show(t('fb_not_available'), 'info')
}
</script>

<template>
  <div>
    <h3 class="sp-title">{{ t('modal_pricing') }}</h3>
    <p class="sp-desc">{{ t('sg_current_plan_h_free') }}</p>

    <div class="pricing-grid">
      <!-- Free plan -->
      <div class="price-card" @click="selectPlan('free', t('price_free'), 0)">
        <div class="pc-name">{{ t('price_free') }}</div>
        <div class="pc-price">
          &yen;0<span class="pc-period">{{ t('price_per_mo') }}</span>
        </div>
        <div class="pc-feats">
          &#10003; {{ t('feat_3dev') }}<br />
          &#10003; {{ t('feat_100hist') }}<br />
          &#10003; {{ t('feat_community') }}
        </div>
      </div>

      <!-- Pro plan (popular) -->
      <div class="price-card popular" @click="selectPlan('pro', t('price_pro'), 9.9)">
        <div class="pc-tag">{{ t('price_popular') }}</div>
        <div class="pc-name">{{ t('price_pro') }}</div>
        <div class="pc-price">
          &yen;9.9<span class="pc-period">{{ t('price_per_mo') }}</span>
        </div>
        <div class="pc-feats">
          &#10003; {{ t('feat_unlimited_dev') }}<br />
          &#10003; {{ t('feat_unlimited_hist') }}<br />
          &#10003; {{ t('feat_priority') }}
        </div>
      </div>

      <!-- Enterprise plan -->
      <div class="price-card" @click="selectPlan('enterprise', t('price_enterprise'), 29)">
        <div class="pc-name">{{ t('price_enterprise') }}</div>
        <div class="pc-price">
          &yen;29<span class="pc-period">{{ t('price_per_mo') }}</span>
        </div>
        <div class="pc-feats">
          &#10003; {{ t('feat_team') }}<br />
          &#10003; {{ t('feat_api') }}<br />
          &#10003; {{ t('feat_priority') }}
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
