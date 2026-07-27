<script setup lang="ts">
import { useImageZoom } from '@/composables/useImageZoom'
import Button from '@/components/ui/button/Button.vue'
import { ZoomIn, ZoomOut, RotateCcw, RotateCw } from 'lucide-vue-next'

defineProps<{
  src: string
  alt?: string
}>()

const {
  imgZoom,
  imgPanX,
  imgPanY,
  imgRotate,
  IMG_ZOOM_MIN,
  IMG_ZOOM_MAX,
  resetImgZoom,
  rotateLeft,
  rotateRight,
  zoomIn,
  zoomOut,
  onImgWheel,
  onImgPointerDown,
  onImgPointerMove,
  onImgPointerUp,
} = useImageZoom()
</script>

<template>
  <div class="image-preview">
    <div class="image-zoom-toolbar">
      <Button variant="ghost" size="icon-sm" :disabled="imgZoom <= IMG_ZOOM_MIN" title="缩小" @click="zoomOut">
        <ZoomOut :size="15" />
      </Button>
      <span class="image-zoom-label">{{ Math.round(imgZoom * 100) }}%</span>
      <Button variant="ghost" size="icon-sm" :disabled="imgZoom >= IMG_ZOOM_MAX" title="放大" @click="zoomIn">
        <ZoomIn :size="15" />
      </Button>
      <span class="image-sep" />
      <Button variant="ghost" size="icon-sm" title="左旋90度" @click="rotateLeft">
        <RotateCcw :size="15" />
      </Button>
      <Button variant="ghost" size="icon-sm" title="右旋90度" @click="rotateRight">
        <RotateCw :size="15" />
      </Button>
      <Button
        v-if="imgZoom !== 1 || imgRotate !== 0"
        variant="ghost"
        size="sm"
        class="ml-1"
        title="重置"
        @click="resetImgZoom"
      >1:1</Button>
    </div>
    <div
      class="image-zoom-area"
      @wheel.prevent="onImgWheel"
      @pointerdown="onImgPointerDown"
      @pointermove="onImgPointerMove"
      @pointerup="onImgPointerUp"
    >
      <img
        :src="src"
        :alt="alt"
        class="image-zoom-img"
        :style="{ transform: `scale(${imgZoom}) rotate(${imgRotate}deg) translate(${imgPanX}px, ${imgPanY}px)` }"
      />
    </div>
  </div>
</template>

<style scoped>
.image-preview {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.image-zoom-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  flex-shrink: 0;
}
.image-zoom-label {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 40px;
  text-align: center;
}
.image-sep {
  width: 1px;
  height: 16px;
  background: var(--border-default);
  margin: 0 4px;
}
.image-zoom-area {
  position: relative;
  overflow: auto;
  cursor: grab;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  max-height: 500px;
  background: var(--bg-hover);
}
.image-zoom-area:active {
  cursor: grabbing;
}
.image-zoom-img {
  max-width: 100%;
  transform-origin: center center;
  transition: transform 0.1s ease;
  user-select: none;
}
</style>
