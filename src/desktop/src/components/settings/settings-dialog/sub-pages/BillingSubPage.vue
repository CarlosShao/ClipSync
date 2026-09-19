<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { api, apiBlob } from '@/api/client'
import { FileText, Download, Loader2 } from 'lucide-vue-next'

const { t, tf } = useI18n()
const toast = useSonner()
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
  invoiceUrl?: string | null
}

const invoices = ref<Invoice[]>([])
const loadingInvoices = ref(false)
/** 正在下载的发票 id —— 只允许一行在转，防连点重复出文件 */
const downloadingId = ref('')

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

/**
 * 落盘：优先 File System Access API（弹「另存为」），不支持/被拒时退回 <a download>。
 * 与 ExportSubPage / ImagePreviewModal 同一套做法（本仓没有装 tauri plugin-dialog/fs，
 * Tauri 的 WebView 里 <a download> 由原生下载处理接管，能真存盘）。
 * @returns 'saved' 已保存 | 'cancelled' 用户在保存框里取消 | 'downloaded' 走了浏览器下载
 */
async function saveBlob(blob: Blob, filename: string): Promise<'saved' | 'cancelled' | 'downloaded'> {
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return 'saved'
    } catch (e: any) {
      if (e?.name === 'AbortError') return 'cancelled' // 用户取消，不是错误
      // 其它异常（WebView 不支持写盘等）→ 退回下面的下载
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // revoke 延后一拍：立刻回收会让部分 WebView 取消还没起步的下载
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  return 'downloaded'
}

/** 金额展示：后端给的是 number（可能 9.9），统一两位小数，和 PDF 收据一致 */
function formatAmount(amount?: number | null): string {
  const n = Number(amount)
  return Number.isFinite(n) ? `¥${n.toFixed(2)}` : '¥0.00'
}

/**
 * 下载电子发票 PDF。
 * 后端 GET /api/invoices/:id/download：本人无 URL 的票 → 200 现生成 PDF；
 * 出错（404/500）→ **纯 JSON**（不带附件头），所以这里 res.ok 为假时能安心读 json。
 */
async function downloadInvoice(inv: Invoice) {
  if (downloadingId.value) return

  // 有真实第三方开票地址（将来接税务服务）→ 交给浏览器原生下载，
  // 不去 fetch 跨源 blob（必被 CORS 拦，反倒报成「网络失败」）。
  if (inv.invoiceUrl) {
    const a = document.createElement('a')
    a.href = inv.invoiceUrl
    a.target = '_blank'
    a.rel = 'noopener'
    a.click()
    return
  }

  downloadingId.value = inv.id
  try {
    const res = await apiBlob('GET', `/api/invoices/${inv.id}/download`)
    if (!res) throw new Error(tf('billing_dl_net', '网络连接失败，请稍后重试'))
    if (!res.ok) {
      if (res.status === 404) throw new Error(tf('billing_dl_404', '该发票不存在或无权访问'))
      let detail = ''
      try {
        const body = await res.json()
        detail = String(body?.error || body?.message || '')
      } catch {
        /* 非 JSON 错误体，忽略 */
      }
      throw new Error(detail || tf('billing_dl_http', `下载失败（HTTP ${res.status}）`))
    }
    // 双保险：万一中间件把响应改成了非 PDF（例如反代塞了登录页），也别存个假收据
    if (!/application\/pdf/i.test(res.headers.get('content-type') || '')) {
      throw new Error(tf('billing_dl_type', '服务端返回的不是 PDF，已放弃保存'))
    }

    const blob = await res.blob()
    const filename = `invoice_${inv.invoiceNo || inv.id}.pdf`
    const outcome = await saveBlob(blob, filename)
    if (outcome === 'cancelled') return
    toast.show(tf('billing_dl_ok', '收据已保存'), 'success')
  } catch (e: any) {
    toast.show(String(e?.message || e) || tf('billing_dl_fail', '发票下载失败'), 'error')
  } finally {
    downloadingId.value = ''
  }
}
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
    <!-- 每行一个真下载按钮（2026-09-19 做真发票）：调 /api/invoices/:id/download
         拿后端现生成的 PDF 收据，落盘见 saveBlob()。此前这里是「点了弹功能建设中」
         的假按钮，再往前是被砍掉——现在链路是通的，不再有任何占位提示。 -->
    <div v-else class="invoice-list">
      <div v-for="inv in invoices" :key="inv.id" class="invoice-item">
        <div class="invoice-info">
          <div class="invoice-no">{{ inv.invoiceNo || inv.id }}</div>
          <div class="invoice-date">
            {{ inv.createdAt ? new Date(inv.createdAt).toLocaleDateString() : '' }}
          </div>
        </div>
        <div class="invoice-right">
          <span class="invoice-amount">{{ formatAmount(inv.amount) }}</span>
          <button
            type="button"
            class="invoice-dl"
            :class="{ 'invoice-dl--busy': downloadingId === inv.id }"
            :disabled="Boolean(downloadingId)"
            :title="tf('billing_dl_tip', '下载 PDF 收据')"
            @click="downloadInvoice(inv)"
          >
            <Loader2 v-if="downloadingId === inv.id" :size="15" class="invoice-dl-spin" />
            <Download v-else :size="15" />
            <span>{{ tf('billing_dl_btn', '下载') }}</span>
          </button>
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
.invoice-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.invoice-amount {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.invoice-dl {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  transition:
    color 0.15s ease,
    border-color 0.15s ease;
}
.invoice-dl:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--text-tertiary);
}
.invoice-dl:disabled {
  opacity: 0.6;
  cursor: default;
}
.invoice-dl--busy {
  color: var(--text-primary);
}
.invoice-dl-spin {
  animation: invoice-dl-rotate 0.9s linear infinite;
}
@keyframes invoice-dl-rotate {
  to {
    transform: rotate(360deg);
  }
}
</style>
