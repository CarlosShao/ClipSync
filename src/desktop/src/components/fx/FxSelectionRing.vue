<!-- 通用「滑动选中环」——把列表的选中态从「跳过去」变成「滑过去」。
     提炼自 ClipboardView 里的焦点环（那版已被视觉验收确认），给全站列表类复用。

     用法：放进任意 position:relative 的列表容器里当**子元素**，传入选中的 key：

       <div class="my-list">                       // 需要 position: relative
         <FxSelectionRing :active="selectedId" :revision="rows.length" />
         <div v-for="r in rows" :key="r.id" :data-ring-key="r.id" class="my-row">…</div>
       </div>

     两种形态都压在行**上面**，所以对 DOM 顺序没有要求，也不怕行自带不透明底色：
       ring —— 空心 accent 边框 + 外发光 + 透明底（用于自带卡片底/边框的行）
       fill —— accent 16% 填充 + 1px accent 34% 边框（用于扁平导航/树节点/分段控件）

     容器 = 环的 parentElement（所以 offsetTop/offsetLeft 与环的定位原点天然一致）。
     「谁是选中项」由宿主决定：路由选中、点击选中、或 hover 跟随都行——组件不关心语义。

     几个刻意的设计：
       · 始终渲染、用 visibility 控制显隐：v-if 会让 ref 变 null，就拿不到 parentElement 了，
         等于自己把自己的定位基准删掉。绝对定位元素不占布局，常驻成本可忽略。
       · 位置/尺寸没变就不写 style：ResizeObserver 在行高过渡期间会逐帧回调，
         每帧都写 style 会让 180ms 过渡被反复重定向，末端出现"蹭"的感觉。
       · 过渡属性按 axis 分档（y/x/both），一套属性打天下必然会漏掉另一个维度：
         横向控件用 y 时 left/width 不参与过渡 → 环"跳"而不是"滑"；网格用 y 同理（同行左右移动会瞬移）。
       · 首次定位用 is-instant 屏蔽过渡：否则环会从上一次的位置一路滑进来（页面加载时
         表现为"从列表顶端滑下"这种没人想要的入场动画）。
       · 减少动画双通道都压掉：html.reduce-motion 由 globals.css 全局压 duration，
         prefers-reduced-motion 在本组件非 scoped 样式里单独兜。命中时环退化为瞬移。 -->
<template>
  <span
    ref="ringRef"
    class="fx-selection-ring"
    :class="[
      `fx-selection-ring--${variant}`,
      `fx-selection-ring--axis-${axis}`,
      { 'is-on': visible, 'is-instant': !ready || instantOnce, 'fx-selection-ring--bar': bar },
    ]"
    :style="ringStyle"
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'

interface Props {
  /** 选中项的 key；null / 空串 / undefined → 不显示环 */
  active?: string | number | null
  /** 行元素上承载 key 的属性名 */
  keyAttr?: string
  /**
   * ring：空心 accent 边框 + 外发光 —— 用于自带卡片底/边框的行（剪贴板、模板、设备、通知…）
   * fill：实心 accent-soft 填充 —— 用于扁平无边框的导航/列表项（左侧边栏、收藏夹树…）
   */
  variant?: 'ring' | 'fill'
  /** fill 变体的左侧 accent 竖条（Clearline 选中语言），随胶囊一起滑动 */
  bar?: boolean
  /**
   * 位移轴。**必须按宿主的布局维度显式选**，选错会表现为"跳"而不是"滑"：
   * y（默认）：纵向列表/导航（侧边栏、剪贴板、树、通知…）—— 只过渡 transform + height
   * x：横向分段控件（视图切换、时间流分段、标签栏）—— 只过渡 left + width
   * both：二维网格（卡片墙）—— 四个属性都过渡
   */
  axis?: 'y' | 'x' | 'both'
  /** 圆角。ring 默认走 --radius-md（对齐卡片），fill 默认走 --radius-sm（对齐导航项） */
  radius?: string
  /** 环相对行的内缩量（px），行高内缩一圈用；默认 0 = 与行等高 */
  inset?: number
  /** 额外的重测触发器：传任何"列表结构会变"的响应式值（长度、筛选条件…） */
  revision?: unknown
}

const props = withDefaults(defineProps<Props>(), {
  active: null,
  keyAttr: 'data-ring-key',
  variant: 'ring',
  bar: false,
  axis: 'y',
  radius: '',
  inset: 0,
  revision: undefined,
})

const ringRef = useTemplateRef<HTMLSpanElement>('ringRef')
const visible = ref(false)
// 过渡能力是否已就绪：首次落位后置 true，之后**永不回退**（回退会让下一次落位变成瞬移）
const ready = ref(false)
// 一次性抑制：从隐藏恢复落位时不播过渡，避免从陈旧位置滑进来。用完立刻收回，
// 所以它只影响"恢复"的那一帧，不会像 ready 那样把后续移动一起打成瞬移。
const instantOnce = ref(false)
const top = ref(0)
const height = ref(0)
const left = ref(0)
const width = ref(0)

const ringStyle = computed(() => ({
  transform: `translateY(${top.value}px)`,
  height: `${height.value}px`,
  left: `${left.value}px`,
  width: `${width.value}px`,
  ...(props.radius ? { borderRadius: props.radius } : {}),
}))

// 环是列表容器的子元素 ⇒ 容器就是它的 parentElement；两者共用同一套 offset 坐标系
function container(): HTMLElement | null {
  return ringRef.value?.parentElement ?? null
}

function targetSelector(): string | null {
  if (props.active == null || props.active === '') return null
  return `[${props.keyAttr}="${CSS.escape(String(props.active))}"]`
}

let observedTarget: HTMLElement | null = null
let roContainer: ResizeObserver | null = null
let roTarget: ResizeObserver | null = null
// 定位基准自检的去重表（见 sync()）：逐帧重建的告警没有诊断价值，只会淹掉真问题
const warned = new WeakSet<HTMLElement>()
// 「找不到选中项」告警的去重表（按容器去重：一个容器只喊一次）
const warnedMissing = new WeakSet<HTMLElement>()

function sync() {
  const box = container()
  const sel = targetSelector()
  if (!box || !sel) {
    hide()
    return
  }
  const target = box.querySelector<HTMLElement>(sel)
  if (!target) {
    // 静默失败点：active 有值但容器里没有任何元素带这个 key（键名写错 / 属性没挂上 /
    // 该行还没渲染）。不报的话表现为"这个列表的动效没生效"，很难查。
    if (import.meta.env.DEV && !warnedMissing.has(box)) {
      warnedMissing.add(box)
      console.warn(
        `[FxSelectionRing] 容器内找不到选中项 ${sel}：环会保持隐藏。` +
          `请检查行元素是否挂了 ${props.keyAttr}，以及 active 的取值是否与它一致。`,
      )
    }
    hide()
    return
  }

  // 自检：offset* 只有在 offsetParent 正好是容器时才等于「相对容器的位置」。
  // 将来谁在容器与行之间插入带 position 的包裹层，环会静默错位 —— dev 下喊一声。
  // 每个目标只喊一次：sync 挂在 ResizeObserver 上，逐帧回告会直接刷爆控制台。
  if (import.meta.env.DEV && target.offsetParent !== box && !warned.has(target)) {
    warned.add(target)
    console.warn(
      `[FxSelectionRing] 定位基准被破坏：${sel} 的 offsetParent 不是环所在的列表容器。` +
        '请确认容器带 position: relative，且容器与行之间没有其它定位元素。',
      target.offsetParent,
    )
  }

  const nextTop = target.offsetTop + props.inset
  const nextHeight = Math.max(0, target.offsetHeight - props.inset * 2)
  const nextLeft = target.offsetLeft
  const nextWidth = target.offsetWidth

  // 值没变就什么都不做：ResizeObserver 逐帧回调时不写 style，避免过渡被反复重定向
  if (
    visible.value &&
    top.value === nextTop &&
    height.value === nextHeight &&
    left.value === nextLeft &&
    width.value === nextWidth
  ) {
    return
  }

  top.value = nextTop
  height.value = nextHeight
  left.value = nextLeft
  width.value = nextWidth

  const wasHidden = !visible.value
  visible.value = true

  if (!ready.value) {
    // 首帧：以 is-instant 落位（无过渡），下一帧恢复过渡能力
    nextTick(() => {
      ready.value = true
    })
  } else if (wasHidden) {
    // 从隐藏恢复：这一帧不播过渡（否则会从陈旧位置滑过来），下一帧立刻收回抑制。
    // 注意这里**不能**动 ready —— 那会把接下来的正常移动也一起打成瞬移。
    instantOnce.value = true
    nextTick(() => {
      instantOnce.value = false
    })
  }
}

let raf: number | null = null
function requestSync() {
  if (raf !== null) return
  raf = requestAnimationFrame(() => {
    raf = null
    sync()
  })
}

function detachTarget() {
  roTarget?.disconnect()
  roTarget = null
  observedTarget = null
}

/**
 * 隐藏环（选中项不在本容器里 / key 传空）。
 * 刻意**不**回退 ready：ready 表示"过渡能力已就绪"，一旦就绪就永久有效；
 * 回退它会让下一次落位退化成瞬移 —— 对 active 来自路由 prop 的宿主（侧边栏、AI 侧栏），
 * 导航过程中很容易经过一次空值，那就会变成"每次都瞬移、看着像没做动效"。
 * 从隐藏恢复时避免"从陈旧位置滑进来"的诉求，交给一次性的 instantOnce（见 sync）。
 */
function hide() {
  visible.value = false
  detachTarget()
}

function ensureObservers() {
  const box = container()
  if (!box) return

  if (!roContainer) {
    roContainer = new ResizeObserver(requestSync)
    roContainer.observe(box)
  }

  const sel = targetSelector()
  const target = sel ? box.querySelector<HTMLElement>(sel) : null
  if (target !== observedTarget) {
    roTarget?.disconnect()
    observedTarget = target
    if (target) {
      roTarget = new ResizeObserver(requestSync)
      roTarget.observe(target)
    } else {
      roTarget = null
    }
  }
}

function refresh() {
  ensureObservers()
  sync()
}

watch(
  () => [props.active, props.revision] as const,
  () => nextTick(refresh),
  { immediate: true },
)

// 容器尺寸变化（增删行、宽度变化导致折行）由 RO 覆盖；但容器若定高（flex:1 + overflow），
// 内部行重排不会改容器尺寸，需要窗口 resize 兜一层（rAF 合帧，多实例也很便宜）。
onMounted(() => {
  window.addEventListener('resize', requestSync)
  nextTick(refresh)
})

onUnmounted(() => {
  window.removeEventListener('resize', requestSync)
  if (raf !== null) {
    cancelAnimationFrame(raf)
    raf = null
  }
  roContainer?.disconnect()
  roContainer = null
  detachTarget()
})
</script>

<style>
/* 非 scoped：全站列表共用同一份环样式，避免各写各的导致观感分叉 */
.fx-selection-ring {
  --ring-ease: cubic-bezier(0.22, 1, 0.36, 1);
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  visibility: hidden;
}
/* 位移轴：过渡属性按布局维度分档。全站 --ease 是给短距离 hover 用的，
   位移类的收尾要更快更稳（expo-out），否则长距离滑动末尾会"蹭"。 */
.fx-selection-ring--axis-y {
  transition:
    transform 180ms var(--ring-ease),
    height 180ms var(--ring-ease);
}
.fx-selection-ring--axis-x {
  transition:
    left 180ms var(--ring-ease),
    width 180ms var(--ring-ease);
}
.fx-selection-ring--axis-both {
  transition:
    transform 180ms var(--ring-ease),
    height 180ms var(--ring-ease),
    left 180ms var(--ring-ease),
    width 180ms var(--ring-ease);
}
.fx-selection-ring.is-on {
  visibility: visible;
}
/* 首次落位不播过渡：否则会从初始位置滑进来。
   特异性 (0,2,0) 高于上面三条 axis 规则 (0,1,0)，稳赢。 */
.fx-selection-ring.is-instant {
  transition: none;
}

/* 空心环：压在行上面（z-index 5），这样边框才能盖住行自身的 1px 边 */
.fx-selection-ring--ring {
  border: 1.5px solid var(--accent);
  border-radius: var(--radius-md);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 10%, transparent);
  z-index: 5;
}

/* 实心胶囊：同样画在行上面（z-index 5）。
   曾经想画在行下面（z-index 0 + DOM 排前面）以保持"底色在文字之下"，但那样太脆：
   行只要有不透明底色就永远看不见 —— 而这不罕见（--bg-surface / hover 的 --bg-hover 都是不透明的，
   模板库 .tpl-side-item 就自带 --bg-surface）。
   改成压在上面用低透明度着色。

   着色的强度是踩过坑才定下来的：一开始用主题的 --accent-light（5-14%，部分主题低到 5%），
   在侧边栏 / AI 侧栏这类"扁平大色块面板"上几乎看不出有东西在动，被用户判为"没效果"；
   而同时接入的 ring 变体（1.5px 100% 实色边框）一眼就能看出在滑。两者视觉权重差太远。
   现在用 accent 16% 实色 + 1px accent 34% 边框把这个"会滑的胶囊"勾出轮廓，
   位移才读得出来；边框在 border-box 内，不改变量出来的尺寸。 */
.fx-selection-ring--fill {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent);
  border-radius: var(--radius-sm);
  z-index: 5;
}
/* 左侧 accent 竖条：作为胶囊的一部分，跟着一起滑。
   上下留白用百分比而不是写死 8px —— 各列表行高差别很大（侧边栏 37px、收藏树 32px…），
   写死会让矮行上的竖条比例失真甚至高度算成负数。 */
.fx-selection-ring--bar::after {
  content: '';
  position: absolute;
  left: 0;
  top: 18%;
  bottom: 18%;
  width: 2.5px;
  border-radius: 9999px;
  background: var(--accent);
}

@media (prefers-reduced-motion: reduce) {
  .fx-selection-ring {
    transition: none;
  }
}
</style>
