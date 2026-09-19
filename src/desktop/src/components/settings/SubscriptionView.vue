<script setup lang="ts">
/**
 * /app/subscription 订阅页。
 *
 * 两件事与旧版不同，都源于「本产品没有自动续费」这一事实（个体户资质开不了
 * 支付宝商家扣款，已实测被拒）：
 *  ① 「变更套餐」→「升级套餐」，并按只升不降渲染套餐卡（当前档置灰、低档已包含）；
 *  ② 「取消订阅」→「到期时间 + 关闭到期提醒」——没有周期扣款，就没有可取消的订阅，
 *     旧按钮点下去只会 toast「功能建设中」，属误导性 UI。
 *
 * 数据源 GET /api/subscriptions/current 收敛到 useSubscriptionAccess 的 60s 快照
 * （与套餐卡、侧栏档位判定同一份），不再本页单独请求。
 * 后端暂无用量统计接口（同步条数/流量/分享数），三项诚实显示「—」，
 * 禁止硬编码 0 / 0 MB 伪造（C7）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useConfigStore } from '@/stores/configStore'
import { useMenuAccess } from '@/composables/useMenuAccess'
import PlanCards from '@/components/pricing/PlanCards.vue'
import Button from '@/components/ui/button/Button.vue'
import {
  formatExpiryDate,
  hasUpgradeHeadroom,
  loadCurrentSubscription,
  resolveCurrentSubscription,
} from '@/composables/useSubscriptionAccess'

const emit = defineEmits<{ 'open-modal': [type: string] }>()

const { t } = useI18n()
const configStore = useConfigStore()
const { can } = useMenuAccess()

const NO_DATA = '—'
const loading = ref(true)
const loadFailed = ref(false)

async function loadSubscription(force = false) {
  loading.value = true
  loadFailed.value = false
  const snap = await loadCurrentSubscription(force)
  // null = 从未成功拿到快照：如实报错给重试入口，不拿 fallback 冒充已加载
  loadFailed.value = !snap
  loading.value = false
}

/** 支付成功后弹窗广播订阅变更：本页与套餐卡立即重算档位（不等 60s TTL） */
function onSubscriptionChanged() {
  void loadSubscription(true)
  planCardsRef.value?.refresh()
}

const planCardsRef = ref<{ refresh: () => void } | null>(null)

onMounted(() => {
  void loadSubscription()
  window.addEventListener('clipsync:subscription-changed', onSubscriptionChanged)
})
onUnmounted(() => window.removeEventListener('clipsync:subscription-changed', onSubscriptionChanged))

const current = computed(() => resolveCurrentSubscription(configStore.user.plan))
const expiryText = computed(() => formatExpiryDate(current.value.periodEnd))
const canBuy = computed(() => can('nav.subscription'))
const upgradable = computed(() => canBuy.value && hasUpgradeHeadroom(current.value.planName))

/**
 * 页面内套餐卡的 CTA 不直接起单：统一进弹窗流的 pricing 步。
 * 支付状态机（selectedPlan / 下单 / 轮询）只有 PricingPaymentModals 一份，
 * 在页面里另接一套 create-order 等于把刚联调通过的链路复制一遍。
 */
function onPlanSelect() {
  emit('open-modal', 'pricing')
}

/** 当前档月付：/current 的 plan.price 即 price_monthly，Free 为 0 不显示价格行 */
const currentPriceText = computed(() => {
  const p = current.value.priceMonthly
  return p > 0 ? `¥${p}` : ''
})
</script>

<template>
  <div class="settings-view">
    <h2 class="sv-title">{{ t('nav_subscription') }}</h2>

    <div class="sg-header">{{ t('sub_usage') }}</div>
    <div class="sub-stats">
      <!-- 后端暂无用量统计接口：诚实占位"—"，不用 0 伪造 -->
      <div class="sub-stat-card">
        <div class="stat-value">{{ NO_DATA }}</div>
        <div class="stat-label">{{ t('sub_clips_synced') }}</div>
      </div>
      <div class="sub-stat-card">
        <div class="stat-value">{{ NO_DATA }}</div>
        <div class="stat-label">{{ t('sub_data_transferred') }}</div>
      </div>
      <div class="sub-stat-card">
        <div class="stat-value">{{ NO_DATA }}</div>
        <div class="stat-label">{{ t('sub_shared_links') }}</div>
      </div>
    </div>

    <div class="sg-header" style="margin-top: 24px">{{ t('sg_current_plan') }}</div>
    <div class="plan-card">
      <template v-if="loading">
        <div class="plan-name plan-loading">{{ t('sub_loading') }}</div>
        <div class="plan-price plan-loading">{{ NO_DATA }}</div>
      </template>
      <template v-else-if="loadFailed">
        <div class="plan-name">{{ NO_DATA }}</div>
        <div class="plan-price">{{ NO_DATA }}</div>
        <Button variant="outline" class="w-full" style="margin-bottom: 12px" @click="loadSubscription(true)">
          {{ t('retry') }}
        </Button>
      </template>
      <template v-else>
        <div class="plan-name">{{ t('role_' + (current.planName || 'Free').toLowerCase()) }}</div>
        <div v-if="currentPriceText" class="plan-price">
          {{ currentPriceText }}<span class="plan-period">{{ t('price_per_mo') }}</span>
        </div>
        <ul v-if="current.features.length > 0" class="plan-feats">
          <li v-for="(f, i) in current.features" :key="i">✓ {{ f }}</li>
        </ul>
        <!-- 无自动续费：到期时间是本屏最重要的事实，不是「续费」 -->
        <div class="plan-expiry">
          <template v-if="expiryText">{{ t('sub_expiry_date', { date: expiryText }) }}</template>
          <template v-else>{{ t('sub_expiry_none') }}</template>
        </div>
        <div class="plan-expiry-hint">{{ t('cycle_once_note') }}</div>

        <Button v-if="upgradable" class="w-full" style="margin-top: 12px" @click="emit('open-modal', 'pricing')">
          {{ t('sub_upgrade_plan') }}
        </Button>
        <!--
          「关闭到期提醒」= 纯占位，disabled：
          服务端 notification_preferences 通用可写（PUT /api/notifications/preferences
          type=subscription_expiring），但**没有任何任务会产生到期提醒**（全仓无
          subscription_expiring 发送点、无到期扫描 cron）。现在就给可点开关 =
          用户"关掉了本不存在的东西"，属假成功，故仅占位。
          后端补齐发送端后：改为 Switch + savePreference('subscription_expiring', v)。
          外层 span 承载 title（disabled 按钮自身不吃 hover，tooltip 不会显示），
          并让按钮 pointer-events:none —— 既点不动，又能看到「即将上线」。
        -->
        <span class="reminder-slot" :title="t('soon_coming')">
          <Button variant="outline" class="w-full reminder-btn" disabled>
            {{ t('sub_close_expiry_reminder') }}
          </Button>
        </span>
      </template>
    </div>

    <!-- ===== 升级套餐（只升不降；当前档置灰「当前套餐」、低档「已包含」）===== -->
    <template v-if="upgradable">
      <div class="sg-header" style="margin-top: 28px">{{ t('sub_upgrade_plan') }}</div>
      <PlanCards ref="planCardsRef" @select="onPlanSelect" />
    </template>
  </div>
</template>

<style scoped>
.settings-view {
  padding: 20px 28px 48px;
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  box-sizing: border-box;
  overflow-y: auto;
  flex: 1;
}
.sv-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 18px;
  letter-spacing: 0.2px;
}
.sg-header {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  margin-bottom: 8px;
}
.sub-stats {
  display: flex;
  gap: 12px;
  margin-top: 8px;
  margin-bottom: 24px;
}
.sub-stat-card {
  flex: 1;
  padding: 18px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  text-align: center;
  transition:
    transform 0.18s var(--ease),
    box-shadow 0.18s var(--ease),
    border-color 0.18s;
}
.sub-stat-card:hover {
  transform: translateY(-1px);
  border-color: var(--border-default);
  box-shadow: var(--shadow-elevated);
}
.stat-value {
  font-family: var(--font-content);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.stat-label {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 4px;
}
.plan-card {
  padding: 24px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  max-width: 340px;
}
.plan-name {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}
.plan-price {
  font-family: var(--font-content);
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 16px;
}
.plan-loading {
  color: var(--text-tertiary);
}
.plan-period {
  font-size: 14px;
  font-weight: 400;
  color: var(--text-tertiary);
}
.plan-feats {
  list-style: none;
  padding: 0;
  margin-bottom: 20px;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 2;
}
.plan-expiry {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.plan-expiry-hint {
  margin-top: 2px;
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--text-tertiary);
}
/* 到期提醒占位：disabled 按钮不响应 hover，tooltip 挂在外层 span 上，
   故按钮必须 pointer-events:none，鼠标才能落到 span 触发 title。 */
.reminder-slot {
  display: block;
  margin-top: 8px;
}
.reminder-slot :deep(.reminder-btn) {
  pointer-events: none;
  color: var(--text-tertiary);
  border-color: var(--border-subtle);
}
</style>
