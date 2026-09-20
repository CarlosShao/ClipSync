<script setup lang="ts">
/**
 * 套餐卡网格（升级弹窗 / 设置内 pricing 子页 / 订阅页 三处共用）。
 *
 * 为什么要有这个共享组件：三处此前各自渲染一份「点了就买」的卡片，
 * 既没有当前档位概念（Pro 用户能点到 Free/Pro），文案也各说各话。
 * 现在档位判定全部下沉到 useSubscriptionAccess.resolvePlanChoice，
 * 三处只剩「挂载组件 + 接 select」。
 *
 * 只升不降：
 *  - 低于当前档 → 显示「已包含」并置灰不可点（**选择置灰而非隐藏**：
 *    保留三档对比是转化页的核心信息，隐藏会让用户以为套餐只有两档）；
 *  - 等于当前档 → 置灰「当前套餐」；本产品无自动续费，同套餐不提供重复购买入口，
 *    到期后 /current 回落 Free，届时这张卡自然重新变成「订阅」可点；
 *  - 高于当前档 → 「升级」（当前为付费档）/「订阅」（当前为 Free）。
 *
 * select 事件把 (plan, cycle) 一起抛给父组件，由父组件决定进支付弹窗流还是本地展示。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useConfigStore } from '@/stores/configStore'
import { getPricingPlans, type PricingPlan } from '@/composables/usePlanLimits'
import {
  PLAN_FEATURE_KEYS,
  PLAN_NAME_KEYS,
  PLAN_ORDER_KEYS,
  choiceCtaKey,
  currentMonthlyPrice,
  cycleLabelKey,
  isChoiceActionable,
  loadCurrentSubscription,
  priceForCycle,
  resolveCurrentSubscription,
  resolvePlanChoice,
  yearlySavingPct,
  type BillingCycle,
  type PlanChoice,
} from '@/composables/useSubscriptionAccess'
import BillingCycleToggle from './BillingCycleToggle.vue'
import Button from '@/components/ui/button/Button.vue'

const props = withDefaults(
  defineProps<{
    /** 顶部月付/年付分段控件（三处升级界面默认都要） */
    showCycleToggle?: boolean
    /** 高亮档（营销「热门」角标），与既有弹窗/设置页保持一致 = pro */
    popularKey?: string
    /** 卡片特性列表是否展示（弹窗空间小可关掉） */
    showFeatures?: boolean
  }>(),
  { showCycleToggle: true, popularKey: 'pro', showFeatures: true },
)

const emit = defineEmits<{ select: [plan: PricingPlan, cycle: BillingCycle] }>()

const { t } = useI18n()
const toast = useSonner()
const configStore = useConfigStore()

const cycle = ref<BillingCycle>('monthly')
const plans = ref<PricingPlan[]>([])
const loading = ref(true)

async function refresh(force = false) {
  loading.value = true
  // 价格目录与当前订阅并行取：档位判定要同时依赖两者。
  // 默认走 60s 快照/单飞（订阅页会同时有 PlanCards 与页面自身在读），
  // 只有支付成功后的显式 refresh(true) 才强制重拉。
  const [list] = await Promise.all([getPricingPlans(), loadCurrentSubscription(force)])
  plans.value = list
  loading.value = false
}
onMounted(() => void refresh())
// 支付成功后父组件需要立刻重算档位（刚买的那一档应立刻变「当前套餐」）
defineExpose({ refresh: () => refresh(true) })

const current = computed(() => resolveCurrentSubscription(configStore.user.plan))
const curMonthly = computed(() => currentMonthlyPrice(plans.value, current.value))

interface Row {
  key: string
  plan: PricingPlan | null
  choice: PlanChoice
  price: number
  saving: number
  actionable: boolean
}

const rows = computed<Row[]>(() =>
  PLAN_ORDER_KEYS.map((key) => {
    const plan = plans.value.find((p) => String(p.name).toLowerCase() === key) ?? null
    const choice = resolvePlanChoice(plan, current.value, curMonthly.value)
    return {
      key,
      plan,
      choice,
      price: priceForCycle(plan, cycle.value),
      saving: plan ? yearlySavingPct(plan.priceMonthly, plan.priceYearly) : 0,
      actionable: isChoiceActionable(choice),
    }
  }),
)

/** 分段控件角标：目录里最大的那个折扣（正常即年付档的 17%） */
const toggleSaving = computed(() => rows.value.reduce((max, r) => Math.max(max, r.saving), 0))

/** 升级语境（有生效中的付费订阅）才提折抵；Free 用户首次订阅无残值可折 */
const showProrationHint = computed(
  () => Boolean(current.value.paidActive) && rows.value.some((r) => r.actionable),
)

function onCta(row: Row) {
  if (!row.plan) {
    toast.show(t('ft_building'), 'info')
    return
  }
  if (!row.actionable) return
  emit('select', row.plan, cycle.value)
}

function cardClass(row: Row) {
  return {
    popular: row.key === props.popularKey && row.actionable,
    'is-current': row.choice === 'current',
    'is-muted': row.choice === 'included' || row.choice === 'unavailable',
  }
}
</script>

<template>
  <div class="plan-cards">
    <BillingCycleToggle
      v-if="showCycleToggle"
      v-model="cycle"
      :savings-pct="toggleSaving"
      :disabled="loading"
    />
    <div class="pc-grid">
      <div v-for="row in rows" :key="row.key" class="pc-card" :class="cardClass(row)">
        <div v-if="row.key === popularKey && row.actionable" class="pc-tag">{{ t('price_popular') }}</div>
        <div class="pc-name">{{ t(PLAN_NAME_KEYS[row.key] ?? row.key) }}</div>
        <div class="pc-price">
          <template v-if="loading">—</template>
          <template v-else>
            ¥{{ row.price }}<span class="pc-period">{{ t(cycleLabelKey(cycle)) }}</span>
            <span v-if="cycle === 'yearly' && row.saving > 0 && row.price > 0" class="pc-save">
              {{ t('price_save_pct', { pct: row.saving }) }}
            </span>
          </template>
        </div>
        <div v-if="showFeatures" class="pc-feats">
          <template v-for="feat in PLAN_FEATURE_KEYS[row.key]" :key="feat">
            ✓ {{ t(feat) }}<br />
          </template>
        </div>
        <Button
          class="pc-cta"
          :variant="row.actionable ? 'default' : 'outline'"
          :disabled="!row.actionable || loading"
          @click="onCta(row)"
        >
          {{ t(choiceCtaKey(row.choice)) }}
        </Button>
      </div>
    </div>
    <p v-if="showProrationHint" class="pc-proration">{{ t('plan_proration_hint') }}</p>
  </div>
</template>

<style scoped>
.plan-cards {
  width: 100%;
}
.pc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}
.pc-card {
  position: relative;
  padding: 18px 16px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s;
}
.pc-card.popular {
  border-color: var(--accent);
  background: var(--accent-light);
}
.pc-card.is-current {
  border-color: var(--border-default);
  background: var(--bg-hover);
}
.pc-card.is-muted {
  opacity: 0.62;
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
  color: var(--text-primary);
}
.pc-price {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px;
  font-family: var(--font-content);
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 12px;
}
.pc-period {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-tertiary);
}
.pc-save {
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 999px;
  color: var(--accent);
  background: var(--accent-light);
}
.pc-feats {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.8;
  margin-bottom: 14px;
  flex: 1;
}
.pc-cta {
  width: 100%;
}
.pc-proration {
  margin: 12px 0 0;
  font-size: 11.5px;
  color: var(--text-tertiary);
}
</style>
