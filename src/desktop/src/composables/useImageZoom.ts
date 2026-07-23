import { ref } from 'vue'

/**
 * 图片预览缩放/平移/旋转状态与事件处理。
 * ImagePreviewModal 与 DocPreviewModal（文件内图片预览）共用，
 * 消除两处完全重复的实现。
 */
export function useImageZoom() {
  const imgZoom = ref(1)
  const imgPanX = ref(0)
  const imgPanY = ref(0)
  const imgRotate = ref(0)
  const IMG_ZOOM_MIN = 0.5
  const IMG_ZOOM_MAX = 4
  const IMG_ZOOM_STEP = 0.3

  // Drag state for panning when zoomed in
  let isImgDragging = false
  let imgDragStartX = 0
  let imgDragStartY = 0
  let imgPanStartX = 0
  let imgPanStartY = 0

  function resetImgZoom() { imgZoom.value = 1; imgPanX.value = 0; imgPanY.value = 0; imgRotate.value = 0 }
  function rotateLeft() { imgRotate.value = (imgRotate.value - 90) % 360 }
  function rotateRight() { imgRotate.value = (imgRotate.value + 90) % 360 }
  function zoomIn() {
    const next = Math.min(IMG_ZOOM_MAX, imgZoom.value + IMG_ZOOM_STEP)
    if (Math.abs(next - imgZoom.value) > 0.01) imgZoom.value = next
  }
  function zoomOut() {
    const next = Math.max(IMG_ZOOM_MIN, imgZoom.value - IMG_ZOOM_STEP)
    if (Math.abs(next - imgZoom.value) > 0.01) imgZoom.value = next
    // Zoom out to 1x also resets pan
    if (imgZoom.value <= 1) { imgPanX.value = 0; imgPanY.value = 0 }
  }
  function onImgWheel(e: WheelEvent) {
    e.preventDefault()
    e.stopPropagation()
    const delta = e.deltaY < 0 ? IMG_ZOOM_STEP : -IMG_ZOOM_STEP
    const next = Math.max(IMG_ZOOM_MIN, Math.min(IMG_ZOOM_MAX, imgZoom.value + delta))
    if (Math.abs(next - imgZoom.value) > 0.01) imgZoom.value = next
  }
  function onImgPointerDown(e: PointerEvent) {
    // Only enable drag when zoomed in beyond 100%
    if (imgZoom.value <= 1) return
    isImgDragging = true
    imgDragStartX = e.clientX
    imgDragStartY = e.clientY
    imgPanStartX = imgPanX.value
    imgPanStartY = imgPanY.value
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onImgPointerMove(e: PointerEvent) {
    if (!isImgDragging) return
    const dx = e.clientX - imgDragStartX
    const dy = e.clientY - imgDragStartY
    imgPanX.value = imgPanStartX + dx
    imgPanY.value = imgPanStartY + dy
  }
  function onImgPointerUp() {
    isImgDragging = false
  }

  /** 模板光标样式（拖拽中/可拖拽/可放大） */
  function imgCursor() {
    return isImgDragging ? 'grabbing' : (imgZoom.value > 1 ? 'grab' : 'zoom-in')
  }

  return {
    imgZoom, imgPanX, imgPanY, imgRotate,
    IMG_ZOOM_MIN, IMG_ZOOM_MAX,
    resetImgZoom, rotateLeft, rotateRight, zoomIn, zoomOut,
    onImgWheel, onImgPointerDown, onImgPointerMove, onImgPointerUp,
    imgCursor,
  }
}
