<!-- Adapted from vue-bits Micro/SpringCheck (MIT + Commons Clause).
     本地库：D:\work\AI\component library\vue-bits\src\content\Micro\SpringCheck\SpringCheck.vue
     改动：
       ① reduce-motion 改用 fx/useReducedMotion —— 上游直接用 motion-v 的 useReducedMotion，
          只认系统 prefers-reduced-motion，会导致设置页的「动画开关」（html.reduce-motion）
          关不掉它；fx 层必须消费双通道版本
       ② 默认值改为「无标签纯勾选框」：strike='none'、boxSize=16、boxRadius=5（对齐原 .cbx 的
          16px / 5px 圆角）、颜色取主题变量，这样剪贴板与收藏页的勾选框可以逐字替换 .cbx
       ③ 无标签时不再强制 44px 行高（--sc-row 取 boxSize），否则批量选择条会被撑高
       ④ 无标签时不渲染标签容器（上游会留下一个空 span + 删除线测量节点） -->
<script setup lang="ts">
import { Tick02Icon } from '@hugeicons/core-free-icons';
import { animate, motionValue, type AnimationPlaybackControls } from 'motion-v';
import { computed, onMounted, onUnmounted, ref, useSlots, watch, watchPostEffect, type CSSProperties } from 'vue';
import { useReducedMotion } from './useReducedMotion';

export type StrikeSide = 'left' | 'center' | 'right' | 'none';

interface SpringCheckProps {
  label?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  color?: string;
  fillColor?: string;
  checkColor?: string;
  boxSize?: number;
  boxRadius?: number;
  fontSize?: number;
  bounce?: number;
  strikeLag?: number;
  doneOpacity?: number;
  strike?: StrikeSide;
  ariaLabel?: string;
  className?: string;
}

const VISUAL_DURATION = 0.2;
const RULE_END = 0.84;
const SWELL = 0.35;
const TICK_PATH = String((Tick02Icon as unknown as [string, { d: string }][])[0][1].d);
const ORIGIN: Record<StrikeSide, string> = {
  left: 'left center',
  center: 'center',
  right: 'right center',
  none: 'left center'
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const zetaOf = (bounce: number) =>
  bounce <= 0 ? 1 : -Math.log(bounce) / Math.sqrt(Math.PI ** 2 + Math.log(bounce) ** 2);

const readings = (t: number, doneOpacity: number, strikeLag: number) => {
  const held = clamp01(t);
  return {
    fill: `scale(${Math.max(t, 0)})`,
    box: `scale(${1 + SWELL * Math.max(0, t - 1)})`,
    tick: 1 - held,
    word: 1 - (1 - doneOpacity) * held,
    rule: `scaleX(${clamp01((held - strikeLag) / (RULE_END - strikeLag))})`
  };
};

const props = withDefaults(defineProps<SpringCheckProps>(), {
  // ② 默认即"纯勾选框"：无标签、无删除线、16px 方框 + 5px 圆角（与原 .cbx 一致）
  label: '',
  checked: undefined,
  defaultChecked: false,
  disabled: false,
  color: 'var(--border-strong)',
  fillColor: 'var(--accent)',
  // 打勾色：必须与 accent 填充形成对比。硬编码 #ffffff 在「浅色 accent」主题（mono 暗色等）
  // 下是白勾白底 —— 用户反馈"暗色下勾也看不清"。--text-inverse 每个主题里正好是 accent 上的可读色。
  checkColor: 'var(--text-inverse)',
  boxSize: 16,
  boxRadius: 5,
  fontSize: 13,
  bounce: 0.2,
  strikeLag: 0.12,
  doneOpacity: 0.42,
  strike: 'none',
  ariaLabel: undefined,
  className: ''
});

const emit = defineEmits<{ change: [checked: boolean] }>();

const slots = useSlots();
// ③④ 无标签：不占 44px 行高，也不渲染标签容器
const hasLabel = computed(() => !!props.label || !!slots.default);

const controlled = computed(() => props.checked !== undefined);
const inner = ref(props.defaultChecked);
const on = computed(() => (controlled.value ? !!props.checked : inner.value));
const reduce = useReducedMotion();

const t = motionValue(on.value ? 1 : 0);
let viaPointer = false;
let instant = false;
let controls: AnimationPlaybackControls | null = null;
let off: (() => void) | undefined;
const rowRef = ref<HTMLButtonElement | null>(null);
const boxRef = ref<HTMLSpanElement | null>(null);
const fillRef = ref<HTMLSpanElement | null>(null);
const tickRef = ref<SVGPathElement | null>(null);
const wordRef = ref<HTMLSpanElement | null>(null);
const ruleRef = ref<HTMLSpanElement | null>(null);

// the fill, tick, word and rule follow the spring by hand so the swell never waits on a render
const write = () => {
  const r = readings(t.get(), props.doneOpacity, props.strikeLag);
  if (fillRef.value) fillRef.value.style.transform = r.fill;
  if (boxRef.value) boxRef.value.style.transform = r.box;
  if (tickRef.value) tickRef.value.style.strokeDashoffset = String(r.tick);
  if (wordRef.value) wordRef.value.style.opacity = String(r.word);
  if (ruleRef.value) ruleRef.value.style.transform = r.rule;
};
watchPostEffect(write);
onMounted(() => {
  off = t.on('change', write);
  write();
});
onUnmounted(() => {
  off?.();
  controls?.stop();
});

watch(
  [on, reduce, () => props.bounce],
  () => {
    const target = on.value ? 1 : 0;
    controls?.stop();
    if (reduce.value || instant) {
      instant = false;
      t.jump(target);
      return;
    }
    if (t.get() === target && t.getVelocity() === 0) return;
    controls = animate(t, target, {
      type: 'spring',
      visualDuration: VISUAL_DURATION,
      bounce: 1 - zetaOf(props.bounce)
    });
  },
  { flush: 'post' }
);

const handlePointerDown = (e: PointerEvent) => {
  if (e.button !== 0 || props.disabled) return;
  viaPointer = true;
  if (!reduce.value && rowRef.value) rowRef.value.dataset.pressed = '';
};
const handlePointerUp = () => {
  if (rowRef.value) delete rowRef.value.dataset.pressed;
};
const handlePointerCancel = () => {
  viaPointer = false;
  handlePointerUp();
};
const toggle = () => {
  if (props.disabled) return;
  instant = !viaPointer;
  viaPointer = false;
  const next = !on.value;
  if (!controlled.value) inner.value = next;
  emit('change', next);
};

const cssVars = computed(() => {
  const ring = props.boxSize >= 24 ? 2 : 1.5;
  const gap = Math.min(16, Math.max(8, Math.round(props.boxSize * 0.43)));
  const ruleHeight = Math.max(1.5, Math.round(props.fontSize / 6) / 2);
  return {
    '--sc-ink': props.color,
    '--sc-fill': props.fillColor,
    '--sc-check': props.checkColor,
    '--sc-box': `${props.boxSize}px`,
    '--sc-radius': `${props.boxRadius}px`,
    '--sc-font': `${props.fontSize}px`,
    '--sc-ring': `${ring}px`,
    '--sc-gap': `${gap}px`,
    '--sc-row': `${hasLabel.value ? Math.max(44, props.boxSize + 16) : props.boxSize}px`,
    '--sc-rule': `${ruleHeight}px`,
    '--sc-origin': ORIGIN[props.strike] || ORIGIN.left,
    '--sc-ease-out': 'cubic-bezier(0.23, 1, 0.32, 1)'
  } as CSSProperties;
});
</script>

<template>
  <button
    ref="rowRef"
    type="button"
    role="checkbox"
    :aria-checked="on"
    :aria-label="ariaLabel"
    :disabled="disabled"
    class="fx-sc-btn group inline-flex relative items-center gap-[var(--sc-gap)] bg-transparent disabled:opacity-50 p-0 border-0 outline-none min-h-[var(--sc-row)] font-medium text-[length:var(--sc-font)] text-left leading-[1.2] tracking-[-0.01em] [-webkit-touch-callout:none] touch-manipulation cursor-pointer disabled:cursor-not-allowed select-none [-webkit-tap-highlight-color:transparent] [color:var(--sc-ink)]"
    :class="className"
    :style="cssVars"
    @pointerdown="handlePointerDown"
    @pointerup="handlePointerUp"
    @pointercancel="handlePointerCancel"
    @pointerleave="handlePointerCancel"
    @click="toggle"
  >
    <span
      class="flex-none rounded-[var(--sc-radius)] group-focus-visible:outline-offset-[3px] w-[var(--sc-box)] h-[var(--sc-box)] motion-reduce:transition-none [transition:transform_160ms_var(--sc-ease-out)] group-data-[pressed]:[transform:scale(0.95)] group-focus-visible:[outline:2px_solid_color-mix(in_srgb,var(--sc-ink)_45%,transparent)]"
    >
      <span
        ref="boxRef"
        class="relative place-items-center grid rounded-[inherit] w-full h-full overflow-hidden origin-center"
      >
        <span class="fx-sc-ring" aria-hidden="true" />
        <span
          ref="fillRef"
          class="absolute inset-0 rounded-[inherit] origin-center [background:var(--sc-fill)]"
          style="transform: scale(0)"
        />
        <svg
          class="relative fill-none w-[68%] h-[68%] overflow-visible [stroke:var(--sc-check)] [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:2.6]"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path ref="tickRef" :d="TICK_PATH" pathLength="1" stroke-dasharray="1" style="stroke-dashoffset: 1" />
        </svg>
      </span>
    </span>
    <span v-if="hasLabel" class="inline-block relative">
      <span ref="wordRef" class="inline-block">
        <slot>{{ label }}</slot>
      </span>
      <span
        v-if="strike !== 'none'"
        ref="ruleRef"
        class="top-[46%] absolute inset-x-0 bg-current rounded-[2px] h-[var(--sc-rule)] pointer-events-none [transform-origin:var(--sc-origin)]"
        aria-hidden="true"
        style="transform: scaleX(0)"
      />
    </span>
  </button>
</template>

<style scoped>
/* ① 内描边：上游用 opacity-[0.28] 的 --sc-ink 画环（hover 也只提到 0.5）。
   实测在浅色与暗色主题下都淡到几乎看不见 —— 用户反馈「勾选框看不见但能点」。
   这里改为实色描边，与原来的 .cbx 对齐（1.5px solid var(--border-strong)），
   hover 转 accent（与 .cbx:hover 的 border-color 一致）。 */
.fx-sc-ring {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 var(--sc-ring) var(--sc-ink);
  transition: box-shadow 120ms ease;
}
.fx-sc-btn:hover:not(:disabled) .fx-sc-ring {
  box-shadow: inset 0 0 0 var(--sc-ring) var(--accent);
}
.fx-sc-btn:disabled .fx-sc-ring {
  box-shadow: inset 0 0 0 var(--sc-ring) var(--border-default);
}
</style>