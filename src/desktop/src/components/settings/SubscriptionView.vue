<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { api } from '@/api/client'
import Button from '@/components/ui/button/Button.vue'

const { t, tf } = useI18n()
const emit = defineEmits<{ 'open-modal': [type: string] }>()

// 订阅与套餐：接真实接口 GET /api/subscriptions/current。
// 后端暂无用量统计接口（同步条数 / 传输流量 / 分享链接数），
// 因此三项用量统计诚实显示"—"，禁止再用硬编码 0 / 0 MB 伪造数据（C7）。
const NO_DATA = '—'
const loading = ref(true)
const loadFailed = ref(false)
const planName = ref('')
const planPrice = ref<number | null>(null)
const planFeatures = ref<string[]>([])

/** features 可能是 JSON 字符串、字符串数组或 {label|name} 对象数组，统一归一为字符串数组 */
function normalizeFeatures(raw: any): string[] {
  let arr: any = raw
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr)
    } catch {
      return []
    }
  }
  if (!Array.isArray(arr)) return []
  return arr.map((f: any) => (typeof f === 'string' ? f : String(f?.label ?? f?.name ?? ''))).filter(Boolean)
}

async function loadSubscription() {
  loading.value = true
  loadFailed.value = false
  try {
    const res = await api('GET', '/api/subscriptions/current')
    if (res.ok && res.data) {
      const plan = (res.data as any).plan
      planName.value = plan?.name || ''
      planPrice.value = typeof plan?.price === 'number' ? plan.price : null
      planFeatures.value = normalizeFeatures(plan?.features)
    } else {
      loadFailed.value = true
    }
  } catch {
    loadFailed.value = true
  }
  loading.value = false
}

onMounted(loadSubscription)
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
        <div class="plan-name plan-loading">{{ tf('sub_loading', '加载中…') }}</div>
        <div class="plan-price plan-loading">{{ NO_DATA }}</div>
      </template>
      <template v-else-if="loadFailed">
        <div class="plan-name">{{ NO_DATA }}</div>
        <div class="plan-price">{{ NO_DATA }}</div>
        <Button variant="outline" class="w-full" style="margin-bottom: 12px" @click="loadSubscription">
          {{ tf('retry', '重试') }}
        </Button>
      </template>
      <template v-else>
        <div class="plan-name">{{ planName || NO_DATA }}</div>
        <div class="plan-price">
          <template v-if="planPrice !== null">
            ¥{{ planPrice }}<span class="plan-period">{{ t('price_per_mo') }}</span>
          </template>
          <template v-else>{{ NO_DATA }}</template>
        </div>
        <ul v-if="planFeatures.length > 0" class="plan-feats">
          <li v-for="(f, i) in planFeatures" :key="i">✓ {{ f }}</li>
        </ul>
      </template>

      <Button class="w-full" @click="emit('open-modal', 'pricing')">{{ t('sub_change_plan') }}</Button>
      <Button
        variant="outline"
        class="w-full"
        style="margin-top: 8px; color: var(--danger)"
        @click="emit('open-modal', 'cancel-subscription')"
        >{{ t('sub_cancel') }}</Button
      >
    </div>
  </div>
</template>

<style scoped>
.settings-view {
  padding: 24px;
  max-width: 720px;
  overflow-y: auto;
  flex: 1;
}
.sv-title {
  font-size: 22px;
  font-weight: 700;
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
.sub-stats {
  display: flex;
  gap: 12px;
  margin-top: 8px;
  margin-bottom: 24px;
}
.sub-stat-card {
  flex: 1;
  padding: 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  text-align: center;
}
.stat-value {
  font-size: 24px;
  font-weight: 700;
}
.stat-label {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 4px;
}
.plan-card {
  padding: 24px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  max-width: 320px;
}
.plan-name {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}
.plan-price {
  font-size: 32px;
  font-weight: 700;
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
</style>
