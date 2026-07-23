<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useImageZoom } from '@/composables/useImageZoom'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import { Download, ZoomIn, ZoomOut, RotateCcw, RotateCw } from 'lucide-vue-next'
import './modal-shared.css'

const props = defineProps<{ previewItem?: any; previewType?: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const toast = useSonner()

const {
  imgZoom, imgPanX, imgPanY, imgRotate, IMG_ZOOM_MIN, IMG_ZOOM_MAX,
  resetImgZoom, rotateLeft, rotateRight, zoomIn, zoomOut,
  onImgWheel, onImgPointerDown, onImgPointerMove, onImgPointerUp, imgCursor,
} = useImageZoom()

async function downloadImage() {
  const src = props.previewItem?.preview || props.previewItem?.content
  if (!src) return
  // 尝试使用 File System Access API（支持选择保存位置）
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: `clipsync-image-${Date.now()}.png`,
        types: [{ description: 'Image', accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg'] } }],
      })
      const blob = await (await fetch(src)).blob()
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      toast.show(t('img_saved'), 'success')
      return
    } catch (e: any) {
      if (e.name === 'AbortError') return // 用户取消
    }
  }
  // Fallback: 直接下载
  const a = document.createElement('a')
  a.href = src
  a.download = `clipsync-image-${Date.now()}.png`
  a.click()
  toast.show(t('img_saved'), 'success')
}

function handleClose() {
  emit('close')
  resetImgZoom()
}
</script>

<template>
  <ModalDialog :open="previewType === 'image'" :title="t('img_preview_title')" max-width="640px" @close="handleClose">
    <div v-if="previewItem" class="img-preview-wrap">
      <div
        class="img-preview-viewport"
        @wheel.prevent.stop="onImgWheel"
        @pointerdown="onImgPointerDown"
        @pointermove="onImgPointerMove"
        @pointerup="onImgPointerUp"
        @pointercancel="onImgPointerUp"
        :style="{ cursor: imgCursor() }"
      >
        <img
          :src="previewItem.preview || previewItem.content"
          :style="{ transform: `translate(${imgPanX}px, ${imgPanY}px) scale(${imgZoom}) rotate(${imgRotate}deg)`, transition: imgZoom > 1 ? 'none' : 'transform 0.15s ease', maxWidth: '100%', maxHeight: '380px', objectFit: 'contain', pointerEvents: 'none' }"
          alt=""
          draggable="false"
        />
      </div>
      <div class="img-preview-bar">
        <span class="img-preview-label">Image</span>
        <div class="img-preview-zoom">
          <Button variant="outline" size="icon-sm" @click="zoomOut" :disabled="imgZoom <= IMG_ZOOM_MIN" title="缩小">
            <ZoomOut :size="15" />
          </Button>
          <span class="img-zoom-level">{{ Math.round(imgZoom * 100) }}%</span>
          <Button variant="outline" size="icon-sm" @click="zoomIn" :disabled="imgZoom >= IMG_ZOOM_MAX" title="放大">
            <ZoomIn :size="15" />
          </Button>
          <Button v-if="imgZoom !== 1 || imgRotate !== 0" variant="ghost" size="sm" class="ml-1" @click="resetImgZoom" title="重置">1:1</Button>
          <span class="img-preview-sep" />
          <Button variant="outline" size="icon-sm" @click="rotateLeft" title="左旋90度">
            <RotateCcw :size="15" />
          </Button>
          <Button variant="outline" size="icon-sm" @click="rotateRight" title="右旋90度">
            <RotateCw :size="15" />
          </Button>
        </div>
        <Button variant="outline" size="sm" @click="downloadImage" class="modal-action-btn">
          <Download :size="15" />
          <span>{{ t('img_download') }}</span>
        </Button>
      </div>
    </div>
  </ModalDialog>
</template>

<style scoped>
.img-preview-wrap { display:flex; flex-direction:column; gap:12px; }
.img-preview-viewport { position:relative; overflow:hidden; border-radius:var(--radius-md); background:var(--bg-hover); display:flex; align-items:center; justify-content:center; max-height:420px; cursor:grab; }
.img-preview-bar { display:flex; align-items:center; gap:12px; font-size:12px; color:var(--text-secondary); }
.img-preview-label { font-weight:500; color:var(--text-secondary); }
.img-preview-zoom { display:inline-flex; align-items:center; gap:6px; margin-left:auto; }
.img-zoom-level { min-width:40px; text-align:center; font-size:11px; font-weight:600; color:var(--text-tertiary); font-variant-numeric:tabular-nums; }
.img-preview-sep { width:1px; height:16px; background:var(--border-default); margin:0 4px; }
</style>
