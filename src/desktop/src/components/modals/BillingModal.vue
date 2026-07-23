<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { api } from '@/api/client'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import { FileText, Download } from 'lucide-vue-next'
import './modal-shared.css'

const props = defineProps<{ showModalType: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const toast = useSonner()

// Invoice list
const invoices = ref<any[]>([])
const loadingInvoices = ref(false)

// Load invoices from server
async function loadInvoices() {
  loadingInvoices.value = true
  try {
    const res = await api('GET', '/api/invoices')
    if (res.ok && Array.isArray(res.data?.invoices)) {
      invoices.value = res.data.invoices
    }
  } catch {
    /* ignore */
  }
  loadingInvoices.value = false
}

watch(
  () => props.showModalType,
  (type) => {
    if (type === 'billing') loadInvoices()
  },
  { immediate: true },
)
</script>

<template>
  <ModalDialog :open="showModalType === 'billing'" :title="t('modal_billing')" max-width="480px" @close="emit('close')">
    <div v-if="loadingInvoices" class="modal-state">{{ t('ver_loading') }}</div>
    <div v-else-if="invoices.length === 0" class="billing-empty-box">
      <FileText :size="48" class="billing-ico" />
      <h3 class="billing-title">{{ t('billing_empty') }}</h3>
      <p class="modal-desc">{{ t('billing_empty_desc') }}</p>
    </div>
    <div v-else class="invoice-list">
      <div v-for="inv in invoices" :key="inv.id" class="invoice-item">
        <div class="invoice-info">
          <div class="invoice-no">{{ inv.invoice_no || inv.id }}</div>
          <div class="invoice-date">{{ inv.created_at ? new Date(inv.created_at).toLocaleDateString() : '' }}</div>
        </div>
        <div class="invoice-right">
          <span class="invoice-amount">¥{{ inv.amount || 0 }}</span>
          <Button variant="ghost" size="sm" @click="toast.show(t('fb_not_available'), 'info')">
            <Download :size="14" />
          </Button>
        </div>
      </div>
    </div>
  </ModalDialog>
</template>

<style scoped>
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
.invoice-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.invoice-amount {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
</style>
