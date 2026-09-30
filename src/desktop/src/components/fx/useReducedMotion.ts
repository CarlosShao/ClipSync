import { computed, ref } from 'vue'

// fx 动效统一开关：系统 prefers-reduced-motion 与设置页写入的 html.reduce-motion 开关，
// 任一命中即视为"要求减少动效"。fx/ 下所有动效组件必须消费它（上游组件自身不处理）。
// 模块级单例：监听器与 MutationObserver 只建一次，随应用生命周期存活，不随组件卸载。
const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
const mediaReduced = ref(mediaQuery.matches)
mediaQuery.addEventListener('change', (e) => {
  mediaReduced.value = e.matches
})

const classReduced = ref(document.documentElement.classList.contains('reduce-motion'))
new MutationObserver(() => {
  classReduced.value = document.documentElement.classList.contains('reduce-motion')
}).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

export function useReducedMotion() {
  return computed(() => mediaReduced.value || classReduced.value)
}
