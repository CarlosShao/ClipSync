<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { api } from '@/api/client'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import { MessageCircle, Landmark, CircleCheck } from 'lucide-vue-next'
import './modal-shared.css'

defineProps<{ showModalType: string }>()
const emit = defineEmits<{ close: []; 'switch-modal': [type: string] }>()

const { t } = useI18n()
const toast = useSonner()

// Plan selection state (for pricing → payment flow)
const selectedPlan = ref<{ id: string; name: string; price: number } | null>(null)
const paymentSending = ref(false)
const paymentResult = ref<{ success: boolean; message: string } | null>(null)

// ===== Plan Selection → Payment Flow =====
function selectPlan(planId: string, planName: string, price: number) {
  if (price === 0) { toast.show(t('already_free'), 'info'); return }
  selectedPlan.value = { id: planId, name: planName, price }
  emit('switch-modal', 'payment')
}

async function selectPaymentMethod(method: string) {
  const p = selectedPlan.value
  if (!p) return
  paymentSending.value = true
  try {
    const res = await api('POST', '/api/subscriptions/subscribe', { planId: p.id, billingCycle: 'monthly' })
    if (res.ok) {
      paymentResult.value = { success: true, message: t('sub_success', { n: p.name }) }
      emit('switch-modal', 'payment-result')
    } else {
      paymentResult.value = { success: false, message: res.error || t('sub_fail') }
      emit('switch-modal', 'payment-result')
    }
  } catch (e: any) {
    paymentResult.value = { success: false, message: String(e) }
    emit('switch-modal', 'payment-result')
  } finally {
    paymentSending.value = false
  }
}
</script>

<template>
  <!-- Pricing -->
  <ModalDialog :open="showModalType === 'pricing'" :title="t('modal_pricing')" max-width="560px" @close="emit('close')">
    <div class="pricing-grid">
      <div class="price-card" @click="selectPlan('free', t('price_free'), 0)"><div class="pc-name">{{ t('price_free') }}</div><div class="pc-price">¥0<span class="pc-period">{{ t('price_per_mo') }}</span></div><div class="pc-feats">✓ {{ t('feat_3dev') }}<br />✓ {{ t('feat_100hist') }}<br />✓ {{ t('feat_community') }}</div></div>
      <div class="price-card popular" @click="selectPlan('pro', t('price_pro'), 9.9)"><div class="pc-tag">{{ t('price_popular') }}</div><div class="pc-name">{{ t('price_pro') }}</div><div class="pc-price">¥9.9<span class="pc-period">{{ t('price_per_mo') }}</span></div><div class="pc-feats">✓ {{ t('feat_unlimited_dev') }}<br />✓ {{ t('feat_unlimited_hist') }}<br />✓ {{ t('feat_priority') }}</div></div>
      <div class="price-card" @click="selectPlan('enterprise', t('price_enterprise'), 29)"><div class="pc-name">{{ t('price_enterprise') }}</div><div class="pc-price">¥29<span class="pc-period">{{ t('price_per_mo') }}</span></div><div class="pc-feats">✓{{ t('feat_team') }}<br />✓ {{ t('feat_api') }}<br />✓ {{ t('feat_priority') }}</div></div>
    </div>
  </ModalDialog>

  <!-- Payment Method -->
  <ModalDialog :open="showModalType === 'payment'" :title="t('modal_payment')" max-width="420px" @close="emit('close')">
    <div v-if="selectedPlan" class="pay-summary">
      <div class="pay-summary-name">{{ selectedPlan.name }}</div>
      <div class="pay-summary-price">¥{{ selectedPlan.price }}<span class="pay-summary-period">{{ t('price_per_mo') }}</span></div>
    </div>
    <div class="pay-methods">
      <Button variant="outline" class="w-full justify-start payment-option" :disabled="paymentSending" @click="selectPaymentMethod('wechat')">
        <MessageCircle class="pay-icon pay-icon--wechat" /> <span>{{ t('pay_wechat') }}</span>
      </Button>
      <Button variant="outline" class="w-full justify-start payment-option" :disabled="paymentSending" @click="selectPaymentMethod('alipay')">
        <Landmark class="pay-icon pay-icon--alipay" /> <span>{{ t('pay_alipay') }}</span>
      </Button>
    </div>
  </ModalDialog>

  <!-- Payment Result -->
  <ModalDialog :open="showModalType === 'payment-result'" :title="paymentResult?.success ? t('sub_result_success') : t('sub_result_fail')" max-width="400px" @close="emit('close')">
    <div v-if="paymentResult" class="pay-result">
      <div class="pay-result-icon" :class="paymentResult.success ? 'success' : 'fail'">
        <CircleCheck v-if="paymentResult.success" :size="48" />
        <span v-else style="font-size:48px">!</span>
      </div>
      <p class="pay-result-msg">{{ paymentResult.message }}</p>
      <Button class="w-full" @click="emit('close')">{{ t('confirm_t') }}</Button>
    </div>
  </ModalDialog>
</template>

<style scoped>
.pricing-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.payment-option { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-surface); cursor: pointer; font-size: 14px; color: var(--text-primary); transition: all 150ms; }
.payment-option:hover { border-color: var(--accent); background: var(--bg-hover); }
.pay-icon { width: 22px; height: 22px; flex-shrink: 0; }
.pay-icon--wechat { color: #07C160; }
.pay-icon--alipay { color: #1677FF; }
.price-card { padding: 20px; border: 1px solid var(--border-default); border-radius: var(--radius-md); cursor: pointer; position: relative; }
.price-card:hover { border-color: var(--accent); }
.price-card.popular { border-color: var(--accent); background: var(--accent-light); }
.pc-tag { position: absolute; top: -8px; left: 50%; transform: translateX(-50%); font-size: 10px; font-weight: 600; color: var(--text-inverse); background: var(--accent); padding: 2px 10px; border-radius: 8px; }
.pc-name { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.pc-price { font-size: 24px; font-weight: 700; margin-bottom: 12px; }
.pc-period { font-size: 12px; font-weight: 400; color: var(--text-tertiary); }
.pc-feats { font-size: 12px; color: var(--text-secondary); line-height: 1.8; }

.pay-summary { margin-bottom:16px; padding:12px; background:var(--bg-hover); border-radius:var(--radius-sm); }
.pay-summary-name { font-size:13px; font-weight:600; color:var(--text-primary); }
.pay-summary-price { font-size:20px; font-weight:700; color:var(--text-primary); margin-top:4px; }
.pay-summary-period { font-size:13px; font-weight:400; color:var(--text-tertiary); }
.pay-methods { display:flex; flex-direction:column; gap:10px; }

.pay-result { text-align:center; padding:16px 0; }
.pay-result-icon { margin-bottom:16px; }
.pay-result-icon.success { color:var(--success); }
.pay-result-icon.fail { color:var(--danger); }
.pay-result-msg { font-size:14px; color:var(--text-secondary); margin-bottom:20px; line-height:1.5; }
</style>
