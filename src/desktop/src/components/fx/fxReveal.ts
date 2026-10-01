/**
 * v-fx-reveal —— 列表/卡片条目的滚动入场（「Animated List」内核）。
 *
 * 来源：vue-bits Components/AnimatedList
 *   本地库：D:\work\AI\component library\vue-bits\src\content\Components\AnimatedList\AnimatedList.vue
 *   内核 = useInView(itemRef, { amount: 0.5, once: false }) + motion.div 在
 *   `initial { scale: .7, opacity: 0 } / animate { scale: 1, opacity: 1 }` 之间切换
 *   （duration .2 / delay .1）。
 *
 * 为什么不是直接搬那个组件：上游是"整装 demo"——自带固定 `w-[500px]`、`max-h-[400px]` 的滚动盒、
 * 深色 demo 皮肤（bg-[#222] / text-white / 深色渐变遮罩）、以及一个挂到 window 的 keydown
 * 方向键/Tab/Enter 导航。塞进我们的列表会：① 破坏既有 flex/grid 布局；② 配色与主题脱节；
 * ③ **全局键盘监听会抢占应用自己绑在方向键/Enter 上的快捷键**。
 * 因此只取入场内核，做成指令挂到现有行元素上：不动 DOM 结构、不动样式、不碰键盘。
 *
 * 本地化调整：
 *   ① 幅度收敛：scale .7→1 对"行"太夸张（demo 里是大卡片），改为 .96→1 + 轻微上移感
 *   ② 滚动离场不做完全淡出（once:false 的原始行为会让滚过去的条目整条消失），改为淡淡压暗到 .5
 *   ③ reduce-motion 走 fx/useReducedMotion 双通道：命中则完全不上动画，并且**用户中途打开
 *      「减少动效」时立刻拆掉观察器并还原样式**（只读一次的话，开关打开后已挂载的行还会继续演出）
 *   ④ 错峰延迟由元素在兄弟中的序号推导，调用方不必传参（剪贴板是分节嵌套 v-for，传 index 不便）
 */
import { watch, type Directive } from 'vue'
import { animate } from 'motion-v'
import { useReducedMotion } from './useReducedMotion'

interface RevealEl extends HTMLElement {
  __fxRevealIO?: IntersectionObserver
  __fxRevealStop?: () => void
}

const HIDDEN = { opacity: 0, scale: 0.96 }
const SHOWN = { opacity: 1, scale: 1 }
const DIMMED = { opacity: 0.5, scale: 0.99 }
const EASE = [0.22, 1, 0.36, 1] as const

export const vFxReveal: Directive<RevealEl, unknown> = {
  mounted(el) {
    const reduced = useReducedMotion()
    if (reduced.value) return

    // ④ 错峰：按元素在兄弟中的序号（前 8 个才有延迟，后面的立即入场）
    const siblings = el.parentElement ? Array.from(el.parentElement.children) : []
    const order = Math.max(0, siblings.indexOf(el))
    const delay = Math.min(order, 8) * 0.028

    el.style.willChange = 'opacity, transform'
    // 先置为隐藏态（duration 0 = 立即到位，不产生一次多余动画）
    animate(el, HIDDEN, { duration: 0 })

    // 动画结束后必须撤掉 will-change：它是"永久提升为合成图层"的提示，长列表里
    // 每行留一个图层会把 WebView2 合成层吃爆（桌面端用一会儿黑屏的元凶之一）。
    const releaseWillChange = () => {
      el.style.willChange = ''
    }

    let revealed = false
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const ctrl = animate(el, SHOWN, { duration: 0.3, delay: revealed ? 0 : delay, ease: EASE })
            // 入场动画收尾后释放图层提示（catch 兜住：动画被打断时 finished 会 reject）
            ctrl.finished?.then(releaseWillChange).catch(() => {})
            revealed = true
          } else if (revealed) {
            // ② 离场只压暗，不做整条消失
            animate(el, DIMMED, { duration: 0.28, ease: 'easeOut' })
          }
        }
      },
      { threshold: 0.5 },
    )
    io.observe(el)
    el.__fxRevealIO = io

    // ③ 用户中途打开「减少动效」→ 立刻停手并把样式还原成最终态
    el.__fxRevealStop = watch(reduced, (isReduced) => {
      if (!isReduced) return
      io.disconnect()
      el.style.willChange = ''
      el.style.opacity = ''
      el.style.transform = ''
    })
  },

  unmounted(el) {
    el.__fxRevealIO?.disconnect()
    el.__fxRevealStop?.()
    delete el.__fxRevealIO
    delete el.__fxRevealStop
  },
}
