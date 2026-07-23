<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { api } from '@/api/client'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import { Download } from 'lucide-vue-next'
import './modal-shared.css'

defineProps<{ showModalType: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const toast = useSonner()

async function handleExportRequest() {
  try {
    const res = await api('GET', '/api/auth/export-data')
    if (res.ok) {
      const jsonStr = JSON.stringify(res.data, null, 2)
      // 使用 File System Access API 让用户选择保存位置
      if ('showSaveFilePicker' in window) {
        try {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: `clipsync-export-${new Date().toISOString().slice(0,10)}.json`,
            types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
          })
          const writable = await handle.createWritable()
          await writable.write(jsonStr)
          await writable.close()
          toast.show(t('export_requested', { email: '' }), 'success')
          emit('close')
          return
        } catch (e: any) {
          if (e.name === 'AbortError') return // 用户取消
        }
      }
      // Fallback: 触发浏览器下载（Tauri webview 中会走系统默认下载目录）
      const blob = new Blob([jsonStr], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `clipsync-export-${new Date().toISOString().slice(0,10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.show(t('export_requested', { email: '' }), 'success')
      emit('close')
    } else {
      toast.show(res.error || t('export_fail'), 'error')
    }
  } catch (e: any) {
    console.warn('Export failed:', e)
    toast.show(t('export_fail'), 'error')
  }
}
</script>

<template>
  <ModalDialog :open="showModalType === 'export'" :title="t('export_title')" max-width="480px" @close="emit('close')">
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
        <span>✓ 剪贴板记录</span><span>✓ 设备信息</span><span>✓ 账户资料</span>
      </div>
      <Button class="w-full export-request-btn" @click="handleExportRequest">
        <Download :size="14" class="btn-ico-left" />
        {{ t('export_request_btn') }}
      </Button>
    </div>
  </ModalDialog>
</template>

<style scoped>
.export-box { display:flex; flex-direction:column; gap:16px; padding:4px 0; }
.export-row { display:flex; gap:16px; align-items:flex-start; }
.export-ico-box { width:48px; height:48px; border-radius:12px; background:var(--bg-hover); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.export-ico { color: var(--accent); }
.export-title { font-size:13px; font-weight:600; color:var(--text-primary); margin-bottom:4px; }
.export-desc { font-size:12px; color:var(--text-secondary); line-height:1.6; }
.export-feats { display:flex; gap:8px; font-size:11px; color:var(--text-tertiary); }
.export-request-btn { margin-top:4px; }
.btn-ico-left { margin-right:6px; }
</style>
