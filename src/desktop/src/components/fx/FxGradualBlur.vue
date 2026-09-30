<!-- Adapted from vue-bits Animations/GradualBlur (commit 07c0f76, MIT + Commons Clause).
     本地库：D:\work\AI\component library\vue-bits\src\content\Animations\GradualBlur\GradualBlur.vue
     改动：
       ① 接 useReducedMotion —— reduce 命中时强制 animated=false（不播透明度过渡）、
          且不建立 IntersectionObserver（scroll 模式在减少动画下没有意义）
       ② 注入的全局样式 id 由 gradual-blur-styles 改为 fx-gradual-blur-styles，避免与其它来源撞名
       ③ 默认 zIndex 由 1000 降为 12（上游 1000 是落地页全屏遮罩用，在应用内会盖住抽屉/弹层） -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type CSSProperties, type StyleValue } from 'vue'
import { useReducedMotion } from './useReducedMotion'

export type FxGradualBlurProps = {
  position?: 'top' | 'bottom' | 'left' | 'right'
  strength?: number
  height?: string
  // 下面这批是可选的高级项，显式写 `| undefined`：既如实表达「可不传」，
  // 也让 vue/require-default-prop 不必给它们塞无意义的默认值
  width?: string | undefined
  divCount?: number
  exponential?: boolean
  zIndex?: number
  animated?: boolean | 'scroll'
  duration?: string
  easing?: string
  opacity?: number
  curve?: 'linear' | 'bezier' | 'ease-in' | 'ease-out' | 'ease-in-out'
  responsive?: boolean
  mobileHeight?: string | undefined
  tabletHeight?: string | undefined
  desktopHeight?: string | undefined
  mobileWidth?: string | undefined
  tabletWidth?: string | undefined
  desktopWidth?: string | undefined
  preset?:
    | 'top'
    | 'bottom'
    | 'left'
    | 'right'
    | 'subtle'
    | 'intense'
    | 'smooth'
    | 'sharp'
    | 'header'
    | 'footer'
    | 'sidebar'
    | 'page-header'
    | 'page-footer'
  gpuOptimized?: boolean | undefined
  hoverIntensity?: number | undefined
  target?: 'parent' | 'page'
  onAnimationComplete?: (() => void) | undefined
  className?: string
  style?: CSSProperties | undefined
}

const props = withDefaults(defineProps<FxGradualBlurProps>(), {
  position: 'bottom',
  strength: 2,
  height: '6rem',
  divCount: 5,
  exponential: false,
  zIndex: 12,
  animated: false,
  duration: '0.3s',
  easing: 'ease-out',
  opacity: 1,
  curve: 'linear',
  responsive: false,
  target: 'parent',
  className: '',
})

const reduced = useReducedMotion()

const DEFAULT_CONFIG: Partial<FxGradualBlurProps> = {
  position: 'bottom',
  strength: 2,
  height: '6rem',
  divCount: 5,
  exponential: false,
  zIndex: 12,
  animated: false,
  duration: '0.3s',
  easing: 'ease-out',
  opacity: 1,
  curve: 'linear',
  responsive: false,
  target: 'parent',
  className: '',
  style: {},
}

const PRESETS: Record<string, Partial<FxGradualBlurProps>> = {
  top: { position: 'top', height: '6rem' },
  bottom: { position: 'bottom', height: '6rem' },
  left: { position: 'left', height: '6rem' },
  right: { position: 'right', height: '6rem' },

  subtle: { height: '4rem', strength: 1, opacity: 0.8, divCount: 3 },
  intense: { height: '10rem', strength: 4, divCount: 8, exponential: true },

  smooth: { height: '8rem', curve: 'bezier', divCount: 10 },
  sharp: { height: '5rem', curve: 'linear', divCount: 4 },

  header: { position: 'top', height: '8rem', curve: 'ease-out' },
  footer: { position: 'bottom', height: '8rem', curve: 'ease-out' },
  sidebar: { position: 'left', height: '6rem', strength: 2.5 },

  'page-header': {
    position: 'top',
    height: '10rem',
    target: 'page',
    strength: 3,
  },
  'page-footer': {
    position: 'bottom',
    height: '10rem',
    target: 'page',
    strength: 3,
  },
}

const CURVE_FUNCTIONS: Record<string, (p: number) => number> = {
  linear: (p) => p,
  bezier: (p) => p * p * (3 - 2 * p),
  'ease-in': (p) => p * p,
  'ease-out': (p) => 1 - Math.pow(1 - p, 2),
  'ease-in-out': (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
}

const containerRef = ref<HTMLDivElement | null>(null)
const isHovered = ref(false)
const isVisible = ref(true)
const responsiveHeight = ref(props.height)
const responsiveWidth = ref(props.width)

const config = computed(() => {
  const presetConfig = props.preset && PRESETS[props.preset] ? PRESETS[props.preset] : {}
  return {
    ...DEFAULT_CONFIG,
    ...presetConfig,
    ...props,
    // 减少动画：过渡与 scroll 显隐一律降级为静态
    animated: reduced.value ? false : props.animated,
  } as Required<FxGradualBlurProps>
})

const getGradientDirection = (position: string): string => {
  const directions: Record<string, string> = {
    top: 'to top',
    bottom: 'to bottom',
    left: 'to left',
    right: 'to right',
  }
  return directions[position] || 'to bottom'
}

const debounce = <T extends (...a: unknown[]) => void>(fn: T, wait: number) => {
  let timeout: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => fn(...args), wait)
  }
}

const updateResponsiveDimensions = () => {
  if (!config.value.responsive) return

  const width = window.innerWidth
  const currentConfig = config.value

  let newHeight = currentConfig.height
  if (width <= 480 && currentConfig.mobileHeight) {
    newHeight = currentConfig.mobileHeight
  } else if (width <= 768 && currentConfig.tabletHeight) {
    newHeight = currentConfig.tabletHeight
  } else if (width <= 1024 && currentConfig.desktopHeight) {
    newHeight = currentConfig.desktopHeight
  }
  responsiveHeight.value = newHeight

  let newWidth = currentConfig.width
  if (width <= 480 && currentConfig.mobileWidth) {
    newWidth = currentConfig.mobileWidth
  } else if (width <= 768 && currentConfig.tabletWidth) {
    newWidth = currentConfig.tabletWidth
  } else if (width <= 1024 && currentConfig.desktopWidth) {
    newWidth = currentConfig.desktopWidth
  }
  responsiveWidth.value = newWidth
}

let intersectionObserver: IntersectionObserver | null = null

const setupIntersectionObserver = () => {
  // 减少动画下不建立观察器：scroll 显隐本身就是动效
  if (reduced.value) return
  if (config.value.animated !== 'scroll' || !containerRef.value) return

  intersectionObserver = new IntersectionObserver(
    ([entry]) => {
      isVisible.value = entry.isIntersecting
    },
    { threshold: 0.1 },
  )

  intersectionObserver.observe(containerRef.value)
}

const blurDivs = computed(() => {
  const divs: Array<{ style: CSSProperties }> = []
  const increment = 100 / config.value.divCount
  const currentStrength =
    isHovered.value && config.value.hoverIntensity
      ? config.value.strength * config.value.hoverIntensity
      : config.value.strength

  const curveFunc = CURVE_FUNCTIONS[config.value.curve] || CURVE_FUNCTIONS.linear

  for (let i = 1; i <= config.value.divCount; i++) {
    let progress = i / config.value.divCount
    progress = curveFunc(progress)

    let blurValue: number
    if (config.value.exponential) {
      blurValue = Number(Math.pow(2, progress * 4)) * 0.0625 * currentStrength
    } else {
      blurValue = 0.0625 * (progress * config.value.divCount + 1) * currentStrength
    }

    const p1 = Math.round((increment * i - increment) * 10) / 10
    const p2 = Math.round(increment * i * 10) / 10
    const p3 = Math.round((increment * i + increment) * 10) / 10
    const p4 = Math.round((increment * i + increment * 2) * 10) / 10

    let gradient = `transparent ${p1}%, black ${p2}%`
    if (p3 <= 100) gradient += `, black ${p3}%`
    if (p4 <= 100) gradient += `, transparent ${p4}%`

    const direction = getGradientDirection(config.value.position)

    const divStyle: CSSProperties = {
      maskImage: `linear-gradient(${direction}, ${gradient})`,
      WebkitMaskImage: `linear-gradient(${direction}, ${gradient})`,
      backdropFilter: `blur(${blurValue.toFixed(3)}rem)`,
      opacity: config.value.opacity,
      transition:
        config.value.animated && config.value.animated !== 'scroll'
          ? `backdrop-filter ${config.value.duration} ${config.value.easing}`
          : undefined,
    }

    divs.push({ style: divStyle })
  }

  return divs
})

const containerStyle = computed((): StyleValue => {
  const isVertical = ['top', 'bottom'].includes(config.value.position)
  const isHorizontal = ['left', 'right'].includes(config.value.position)
  const isPageTarget = config.value.target === 'page'

  const baseStyle: CSSProperties = {
    position: isPageTarget ? 'fixed' : 'absolute',
    pointerEvents: config.value.hoverIntensity ? 'auto' : 'none',
    opacity: isVisible.value ? 1 : 0,
    transition: config.value.animated ? `opacity ${config.value.duration} ${config.value.easing}` : undefined,
    zIndex: isPageTarget ? config.value.zIndex + 100 : config.value.zIndex,
    ...config.value.style,
  }

  if (isVertical) {
    baseStyle.height = responsiveHeight.value
    baseStyle.width = responsiveWidth.value || '100%'
    baseStyle[config.value.position] = '0'
    baseStyle.left = '0'
    baseStyle.right = '0'
  } else if (isHorizontal) {
    baseStyle.width = responsiveWidth.value || responsiveHeight.value
    baseStyle.height = '100%'
    baseStyle[config.value.position] = '0'
    baseStyle.top = '0'
    baseStyle.bottom = '0'
  }

  return baseStyle
})

const debouncedResize = debounce(updateResponsiveDimensions, 100)

onMounted(() => {
  // Initialize responsive dimensions
  if (config.value.responsive) {
    updateResponsiveDimensions()
    window.addEventListener('resize', debouncedResize)
  }

  if (config.value.animated === 'scroll') {
    isVisible.value = false
    setupIntersectionObserver()
  }

  injectStyles()
})

onUnmounted(() => {
  if (config.value.responsive) {
    window.removeEventListener('resize', debouncedResize)
  }

  if (intersectionObserver) {
    intersectionObserver.disconnect()
    intersectionObserver = null
  }
})

watch(
  () => isVisible.value,
  (newVisible) => {
    if (newVisible && config.value.animated === 'scroll' && props.onAnimationComplete) {
      const timeout = setTimeout(
        () => {
          if (props.onAnimationComplete) {
            props.onAnimationComplete()
          }
        },
        parseFloat(config.value.duration) * 1000,
      )

      return () => clearTimeout(timeout)
    }
  },
)

const injectStyles = () => {
  if (typeof document === 'undefined') return
  const id = 'fx-gradual-blur-styles'
  if (document.getElementById(id)) return
  const el = document.createElement('style')
  el.id = id
  el.textContent = `.fx-gradual-blur{pointer-events:none;transition:opacity .3s ease-out}.fx-gradual-blur-inner{pointer-events:none}`
  document.head.appendChild(el)
}
</script>

<template>
  <div
    ref="containerRef"
    :class="[
      'fx-gradual-blur gradual-blur relative isolate',
      config.target === 'page' ? 'gradual-blur-page' : 'gradual-blur-parent',
      config.className,
    ]"
    :style="containerStyle"
    @mouseenter="hoverIntensity ? (isHovered = true) : null"
    @mouseleave="hoverIntensity ? (isHovered = false) : null"
  >
    <div class="relative w-full h-full">
      <div v-for="(div, index) in blurDivs" :key="index" class="absolute inset-0" :style="div.style" />
    </div>
    <div v-if="$slots.default" class="relative">
      <slot />
    </div>
  </div>
</template>
