/**
 * 「AI 正在工作」占位文字的**流光**参数（一处维护）。流光速度**与点阵解耦**，用常规扫光节奏。
 *
 * 用户需求（原话）：「在工作的时候，这个 working 最好加个那个和 agent 流式工作开始那个思考中的动效，
 * 就是文字表面有光一遍一遍有节奏的划过，和左边那个粒子点阵动画的频率一样就行」。
 *
 * 点阵参数（LATTICE_*）保留仅作参考与历史对照，**不再驱动流光**：
 *   · InlineAiCard 用的是 `<FxLatticeLoader pattern="ripple" :grid="3">`（其余走组件默认值）；
 *   · 点阵整轮周期 `cycle = Math.round(pattern.loop × step × scale)`（FxLatticeLoader.vue:188-189）；
 *   · ripple / grid=3：`loop = 4.8`、`scale = 1.5`（PATTERNS，FxLatticeLoader.vue:106）；
 *   · `step` 默认 `90`（withDefaults，FxLatticeLoader.vue:175）；
 *   ⇒ cycle = round(4.8 × 90 × 1.5) = **648ms**；
 *   · 缓动取点阵格子用的 `--fxl-ease-in-out` = `cubic-bezier(0.77, 0, 0.175, 1)`（FxLatticeLoader.vue:265）。
 *
 * ⚠️ 这些数字**不允许两侧各改各的**：`src/utils/__tests__/aiShimmer.test.ts` 会直接解析
 * FxLatticeLoader.vue / InlineAiCard.vue 的源码重新算一遍周期，任一侧被改动都会红。
 */
export const LATTICE_PATTERN = 'ripple'
export const LATTICE_GRID = 3
/** 点阵整轮周期（ms）：round(loop × step × scale) */
export const LATTICE_CYCLE_MS = Math.round(4.8 * 90 * 1.5) // = 648
/** 点阵格子的缓动（--fxl-ease-in-out） */
export const LATTICE_EASE = 'cubic-bezier(0.77, 0, 0.175, 1)'

/**
 * 流光周期（ms）：**常规扫光速度**，与点阵**刻意解耦**。
 *
 * 用户实测否掉了"与点阵同频"：点阵整轮 648ms 太快 ✗ ⇒ 高频的 background-position 变化
 * 会让"文字表面扫光"被看成"整行字在闪"（不是想要的观感）。
 * 参考观感（"Churning 26.5s" 那种加载态）= 一道柔光大约 **每 1.5~2.5s** 扫过一轮。
 */
export const SHIMMER_CYCLE_MS = 1800
/** 流光缓动：匀缓（扫过时首尾不明显加速，避免忽快忽慢像抖动） */
export const SHIMMER_EASE = 'ease-in-out'

/** 光带渐变（文字表面扫过的一道亮带）；`accent` 用主题色，两侧回落到继承色 */
export function shimmerGradientCss(accent = 'var(--accent)'): string {
  return `linear-gradient(100deg, currentColor 0%, currentColor 38%, ${accent} 50%, currentColor 62%, currentColor 100%)`
}
