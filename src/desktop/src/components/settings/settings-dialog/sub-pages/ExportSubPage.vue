<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { api } from '@/api/client'
import Button from '@/components/ui/button/Button.vue'
import { Download } from 'lucide-vue-next'

const { t } = useI18n()
const toast = useSonner()
const emit = defineEmits<{ back: [] }>()

// ===== State =====
const exporting = ref(false)

// ===== Export handler =====
async function handleExportRequest() {
  exporting.value = true
  try {
    const res = await api('GET', '/api/auth/export-data')
    if (res.ok) {
      const jsonStr = JSON.stringify(res.data, null, 2)
      // Try File System Access API for save location picker
      if ('showSaveFilePicker' in window) {
        try {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: `clipsync-export-${new Date().toISOString().slice(0, 10)}.json`,
            types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
          })
          const writable = await handle.createWritable()
          await writable.write(jsonStr)
          await writable.close()
          toast.show(t('export_requested', { email: '' }), 'success')
          return
        } catch (e: any) {
          if (e.name === 'AbortError') return // User cancelled
        }
      }
      // Fallback: trigger browser download
      const blob = new Blob([jsonStr], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `clipsync-export-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.show(t('export_requested', { email: '' }), 'success')
    } else {
      toast.show(res.error || t('export_fail'), 'error')
    }
  } catch (e: any) {
    console.warn('Export failed:', e)
    toast.show(t('export_fail'), 'error')
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div>
    <h3 class="sp-title">{{ t('export_title') }}</h3>
    <p class="sp-desc">{{ t('sg_export_h') }}</p>

    <div class="export-box">
      <div class="export-row">
        <div class="export-ico-box">
          <Download :size="24" class="export-ico" />
        </div>
        <div>
          <p class="export-title">JSON 格式数据包</p>
          <p class="export-desc">{{ t('export_msg') }}</p>
        </div>
      </div>
      <div class="export-feats">
        <span>&#10003; 剪贴板记录</span>
        <span>&#10003; 设备信息</span>
        <span>&#10003; 账户资料</span>
      </div>
      <Button class="w-full export-request-btn" :disabled="exporting" @click="handleExportRequest">
        <Download :size="14" class="btn-ico-left" />
        {{ exporting ? '...' : t('export_request_btn') }}
      </Button>
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
.export-box {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 0;
}
.export-row {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.export-ico-box {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: var(--bg-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.export-ico {
  color: var(--accent);
}
.export-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.export-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.export-feats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}
.export-request-btn {
  margin-top: 4px;
}
.btn-ico-left {
  margin-right: 6px;
}
</style>
