<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { api } from '@/api/client'
import { FileText } from 'lucide-vue-next'

const { t } = useI18n()
const emit = defineEmits<{ back: [] }>()

// ===== State =====
// 字段对齐后端 GET /api/invoices（routes/invoices.js，camelCase）：
// { id, invoiceNo, amount, tax, status, invoiceUrl, orderNo, paymentMethod, planName, createdAt }
interface Invoice {
  id: string
  invoiceNo?: string
  amount?: number
  createdAt?: string
  status?: string
}

const invoices = ref<Invoice[]>([])
const loadingInvoices = ref(false)

// ===== Data loading =====
async function loadInvoices() {
  loadingInvoices.value = true
  try {
    // 端点统一：后端实际挂载为 /api/invoices（routes/invoices.js），
    // 此前使用的 /api/user/invoices 并不存在，账单页永远为空且静默失败（C7）。
    const res = await api('GET', '/api/invoices')
    if (res.ok && Array.isArray(res.data?.invoices)) {
      invoices.value = res.data.invoices
    }
  } catch {
    /* ignore */
  }
  loadingInvoices.value = false
}

onMounted(() => {
  loadInvoices()
})
</script>

<template>
  <div>
    <h3 class="sp-title">{{ t('modal_billing') }}</h3>
    <p class="sp-desc">{{ t('sg_billing_h') }}</p>

    <!-- Loading -->
    <div v-if="loadingInvoices" class="modal-state">{{ t('ver_loading') }}</div>

    <!-- Empty -->
    <div v-else-if="invoices.length === 0" class="billing-empty-box">
      <FileText :size="48" class="billing-ico" />
      <h3 class="billing-title">{{ t('billing_empty') }}</h3>
      <p class="modal-desc">{{ t('billing_empty_desc') }}</p>
    </div>

    <!-- Invoice list -->
    <!-- 行右侧的「下载发票」按钮已砍（2026-09-19 裁定）：后端未接入，点击只弹「功能建设中」，
         属假按钮；账单列表本身（单号 / 日期 / 金额）保留。 -->
    <div v-else class="invoice-list">
      <div v-for="inv in invoices" :key="inv.id" class="invoice-item">
        <div class="invoice-info">
          <div class="invoice-no">{{ inv.invoiceNo || inv.id }}</div>
          <div class="invoice-date">
            {{ inv.createdAt ? new Date(inv.createdAt).toLocaleDateString() : '' }}
          </div>
        </div>
        <span class="invoice-amount">&yen;{{ inv.amount ?? 0 }}</span>
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
.modal-state {
  text-align: center;
  padding: 24px;
  color: var(--text-tertiary);
}
.modal-desc {
  font-size: 13px;
  color: var(--text-secondary);
}
.billing-empty-box {
  text-align: center;
  padding: 40px 20px;
}
.billing-ico {
  display: block;
  margin: 0 auto 12px;
  color: var(--text-tertiary);
}
.billing-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
}
.invoice-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 300px;
  overflow-y: auto;
}
.invoice-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--bg-hover);
  border: 1px solid var(--border-subtle);
}
.invoice-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.invoice-no {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}
.invoice-date {
  font-size: 11px;
  color: var(--text-tertiary);
}
.invoice-amount {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
</style>
