import { ref, onUnmounted } from 'vue'

interface ResizableOptions {
  storageKey: string
  min: number
  max: number
  default: number
}

/**
 * 可拖拽面板的宽度控制（#215）。
 * 面板固定在右侧，拖拽其左边缘调整宽度：鼠标左移 → 变宽，右移 → 变窄。
 * 宽度持久化到 localStorage，下次打开保持。
 */
export function useResizablePanel(opts: ResizableOptions) {
  const width = ref<number>(Number(localStorage.getItem(opts.storageKey)) || opts.default)

  let dragging = false
  let startX = 0
  let startW = 0

  function onMove(e: MouseEvent) {
    if (!dragging) return
    const delta = startX - e.clientX // 左移 clientX 减小 → delta 正 → 变宽
    let w = startW + delta
    w = Math.max(opts.min, Math.min(opts.max, w))
    width.value = w
  }

  function onUp() {
    if (!dragging) return
    dragging = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    localStorage.setItem(opts.storageKey, String(width.value))
  }

  function startDrag(e: MouseEvent) {
    e.preventDefault()
    dragging = true
    startX = e.clientX
    startW = width.value
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  onUnmounted(() => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  })

  return { width, startDrag }
}
