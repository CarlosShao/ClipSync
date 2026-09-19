<script setup lang="ts">
/**
 * 月付 / 年付分段控件（ZCode 式：胶囊容器 + 选中段浮起）。
 * 年付段带「省 N%」角标 —— 数值由 yearlySavingPct 从真实目录价算出，
 * 数据缺失或折扣低于原价 1/3 时 pct=0，角标不渲染（定价红线：不写不可能兑现的折扣）。
 * 底部小字固定说明「一次性购买、到期手动续」：本产品无自动扣款，
 * 这行字的存在就是为了不让「年付」被误读成自动续费。
 */
import { useI18n } from '@/composables/useI18n'
import type { BillingCycle } from '@/composables/useSubscriptionAccess'

const props = withDefaults(
  defineProps<{
    modelValue: BillingCycle
    /** 年付相对 12×月付的折扣百分比，0 = 不展示角标 */
    savingsPct?: number
    disabled?: boolean
  }>(),
  { savingsPct: 0, disabled: false },
)
const emit = defineEmits<{ 'update:modelValue': [cycle: BillingCycle] }>()

const { t } = useI18n()

function pick(cycle: BillingCycle) {
  if (props.disabled || props.modelValue === cycle) return
  emit('update:modelValue', cycle)
}

const OPTIONS: { value: BillingCycle; labelKey: string }[] = [
  { value: 'monthly', labelKey: 'cycle_monthly' },
  { value: 'yearly', labelKey: 'cycle_yearly' },
]
</script>

<template>
  <div class="bct">
    <div class="bct-seg" role="tablist" :aria-label="t('billing_cycle')">
      <button
        v-for="opt in OPTIONS"
        :key="opt.value"
        type="button"
        role="tab"
        class="bct-item"
        :class="{ 'is-active': modelValue === opt.value }"
        :aria-selected="modelValue === opt.value"
        :disabled="disabled"
        @click="pick(opt.value)"
      >
        <span>{{ t(opt.labelKey) }}</span>
        <span v-if="opt.value === 'yearly' && savingsPct > 0" class="bct-save">
          {{ t('price_save_pct', { pct: savingsPct }) }}
        </span>
      </button>
    </div>
    <div class="bct-note">{{ t('cycle_once_note') }}</div>
  </div>
</template>

<style scoped>
.bct {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.bct-seg {
  display: inline-flex;
  align-self: flex-start;
  gap: 2px;
  padding: 3px;
  background: var(--bg-hover);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full, 999px);
}
.bct-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border: none;
  border-radius: var(--radius-full, 999px);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background 150ms var(--ease),
    color 150ms var(--ease),
    box-shadow 150ms var(--ease);
}
.bct-item:hover:not(.is-active):not(:disabled) {
  color: var(--text-primary);
}
.bct-item.is-active {
  background: var(--bg-surface);
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: var(--shadow-card);
}
.bct-item:disabled {
  cursor: default;
  opacity: 0.6;
}
.bct-item:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
.bct-save {
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 999px;
  color: var(--accent);
  background: var(--accent-light);
}
.bct-note {
  font-size: 11px;
  color: var(--text-tertiary);
}
</style>
