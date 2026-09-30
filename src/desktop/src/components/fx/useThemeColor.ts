import { computed, ref } from 'vue'

// fx 公共：把主题里的 `--xxx-rgb: R G B` 解析成 canvas / WebGL 能直接吃的 rgb()/rgba() 字符串。
// canvas 与着色器都解析不了 `var()`，所以凡是走 <canvas> 的动效都需要这座桥（Waves 之前是在调用方手写 rgba）。
// 主题切换 = <html> 的 class 变化（主题预设 + 明暗），故用 MutationObserver 跟随，随应用生命周期存活。
const themeVersion = ref(0)
new MutationObserver(() => {
  themeVersion.value++
}).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

/**
 * @param rgbVar 形如 `--accent-rgb`（值必须是 `17 17 17` 这样的空格分隔三元组）
 * @param alpha 传 1 返回 rgb()，否则返回 rgba()
 * @returns 主题里取不到该变量时返回 null，调用方自行给兜底色
 */
export function useThemeColor(rgbVar: string, alpha = 1) {
  return computed<string | null>(() => {
    void themeVersion.value
    const raw = getComputedStyle(document.documentElement).getPropertyValue(rgbVar).trim()
    if (!raw) return null
    const parts = raw.replace(/\s+/g, ',').replace(/,+/g, ',').replace(/^,|,$/g, '')
    if (!/^[\d.,]+$/.test(parts)) return null
    return alpha >= 1 ? `rgb(${parts})` : `rgba(${parts},${alpha})`
  })
}
