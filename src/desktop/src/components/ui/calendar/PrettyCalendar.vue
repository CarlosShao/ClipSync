<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    modelValue?: Date | null
    minDate?: Date
    maxDate?: Date
  }>(),
  {
    modelValue: null,
  },
)

const emit = defineEmits<{ 'update:modelValue': [date: Date | null] }>()

const now = new Date()
const viewYear = ref(props.modelValue?.getFullYear() ?? now.getFullYear())
const viewMonth = ref(props.modelValue?.getMonth() ?? now.getMonth())

const showMonthPicker = ref(false)
const showYearPicker = ref(false)

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      viewYear.value = v.getFullYear()
      viewMonth.value = v.getMonth()
    }
  },
)

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

const MONTHS = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']

const yearRange = computed(() => {
  const start = now.getFullYear() - 10
  const end = now.getFullYear() + 10
  const years: number[] = []
  for (let y = start; y <= end; y++) {
    years.push(y)
  }
  return years
})

const monthLabel = computed(() => {
  return MONTHS[viewMonth.value]
})

const days = computed(() => {
  const first = new Date(viewYear.value, viewMonth.value, 1)
  const last = new Date(viewYear.value, viewMonth.value + 1, 0)
  const pad = first.getDay()
  const result: { date: Date; n: number; outside: boolean; disabled: boolean }[] = []

  const prevLast = new Date(viewYear.value, viewMonth.value, 0).getDate()
  for (let i = pad - 1; i >= 0; i--) {
    const d = new Date(viewYear.value, viewMonth.value - 1, prevLast - i)
    result.push({ date: d, n: prevLast - i, outside: true, disabled: isDisabled(d) })
  }

  for (let i = 1; i <= last.getDate(); i++) {
    const d = new Date(viewYear.value, viewMonth.value, i)
    result.push({ date: d, n: i, outside: false, disabled: isDisabled(d) })
  }

  const rem = 42 - result.length
  for (let i = 1; i <= rem; i++) {
    const d = new Date(viewYear.value, viewMonth.value + 1, i)
    result.push({ date: d, n: i, outside: true, disabled: isDisabled(d) })
  }

  return result
})

function isDisabled(d: Date): boolean {
  if (props.minDate && d < new Date(props.minDate.getFullYear(), props.minDate.getMonth(), props.minDate.getDate()))
    return true
  if (props.maxDate && d > new Date(props.maxDate.getFullYear(), props.maxDate.getMonth(), props.maxDate.getDate()))
    return true
  return false
}

function isToday(d: Date): boolean {
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

function isSelected(d: Date): boolean {
  if (!props.modelValue) return false
  const v = props.modelValue
  return d.getFullYear() === v.getFullYear() && d.getMonth() === v.getMonth() && d.getDate() === v.getDate()
}

function prev() {
  if (viewMonth.value === 0) {
    viewMonth.value = 11
    viewYear.value--
  } else {
    viewMonth.value--
  }
}

function next() {
  if (viewMonth.value === 11) {
    viewMonth.value = 0
    viewYear.value++
  } else {
    viewMonth.value++
  }
}

function selectMonth(m: number) {
  viewMonth.value = m
  showMonthPicker.value = false
}

function selectYear(y: number) {
  viewYear.value = y
  showYearPicker.value = false
}

function pick(item: { date: Date; disabled: boolean; outside: boolean }) {
  if (item.disabled) return
  if (item.outside) {
    viewYear.value = item.date.getFullYear()
    viewMonth.value = item.date.getMonth()
  }
  emit('update:modelValue', item.date)
}

function closeDropdowns() {
  showMonthPicker.value = false
  showYearPicker.value = false
}
</script>

<template>
  <div class="pc" @click="closeDropdowns">
    <div class="pc-hdr">
      <button type="button" class="pc-nav" @click.stop="prev">
        <ChevronLeft :size="16" />
      </button>
      <div class="pc-hdr-center">
        <div class="pc-selector-wrapper" @click.stop>
          <button
            type="button"
            class="pc-selector"
            :class="{ 'pc-selector--active': showMonthPicker }"
            @click.stop="
              showMonthPicker = !showMonthPicker
              showYearPicker = false
            "
          >
            {{ monthLabel }}
            <ChevronDown :size="12" />
          </button>
          <div v-if="showMonthPicker" class="pc-dropdown pc-dropdown--month">
            <button
              v-for="(m, idx) in MONTHS"
              :key="idx"
              type="button"
              class="pc-dropdown-item"
              :class="{ 'pc-dropdown-item--active': idx === viewMonth }"
              @click.stop="selectMonth(idx)"
            >
              {{ m }}
            </button>
          </div>
        </div>
        <div class="pc-selector-wrapper" @click.stop>
          <button
            type="button"
            class="pc-selector"
            :class="{ 'pc-selector--active': showYearPicker }"
            @click.stop="
              showYearPicker = !showYearPicker
              showMonthPicker = false
            "
          >
            {{ viewYear }}
            <ChevronDown :size="12" />
          </button>
          <div v-if="showYearPicker" class="pc-dropdown pc-dropdown--year">
            <button
              v-for="y in yearRange"
              :key="y"
              type="button"
              class="pc-dropdown-item"
              :class="{ 'pc-dropdown-item--active': y === viewYear }"
              @click.stop="selectYear(y)"
            >
              {{ y }}
            </button>
          </div>
        </div>
      </div>
      <button type="button" class="pc-nav" @click.stop="next">
        <ChevronRight :size="16" />
      </button>
    </div>
    <div class="pc-week">
      <span v-for="w in WEEKDAYS" :key="w" class="pc-wd">{{ w }}</span>
    </div>
    <div class="pc-grid">
      <button
        v-for="(d, i) in days"
        :key="i"
        type="button"
        class="pc-day"
        :class="{
          'pc-day--out': d.outside,
          'pc-day--today': isToday(d.date),
          'pc-day--sel': isSelected(d.date),
          'pc-day--off': d.disabled,
        }"
        :disabled="d.disabled"
        @click.stop="pick(d)"
      >
        {{ d.n }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.pc {
  padding: 6px;
  user-select: none;
  min-width: 268px;
  position: relative;
}
.pc-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 4px 10px;
}
.pc-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.pc-nav:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.pc-hdr-center {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pc-selector-wrapper {
  position: relative;
}
.pc-selector {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.15s;
  letter-spacing: -0.01em;
}
.pc-selector:hover {
  background: var(--bg-hover);
}
.pc-selector--active {
  background: var(--bg-active);
}
.pc-dropdown {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-top: 4px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-elevated);
  z-index: var(--z-dropdown);
  max-height: 200px;
  overflow-y: auto;
  animation: fadeIn 0.15s ease;
}
.pc-dropdown--month {
  min-width: 80px;
}
.pc-dropdown--year {
  min-width: 70px;
}
.pc-dropdown-item {
  display: block;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-primary);
  cursor: pointer;
  text-align: center;
  transition: all 0.12s;
}
.pc-dropdown-item:hover {
  background: var(--bg-hover);
}
.pc-dropdown-item--active {
  background: var(--accent);
  color: var(--text-inverse);
  font-weight: 600;
}
.pc-dropdown-item--active:hover {
  background: var(--accent-hover);
}
.pc-week {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  padding-bottom: 6px;
  margin-bottom: 2px;
  border-bottom: 1px solid var(--border-subtle);
}
.pc-wd {
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  padding: 2px 0;
  letter-spacing: 0.03em;
}
.pc-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.pc-day {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 34px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  font-size: 13px;
  font-weight: 400;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.12s ease;
}
.pc-day:hover:not(.pc-day--off):not(.pc-day--sel) {
  background: var(--bg-hover);
}
.pc-day--today:not(.pc-day--sel) {
  font-weight: 600;
  color: var(--accent);
}
.pc-day--today:not(.pc-day--sel)::after {
  content: '';
  position: absolute;
  inset: 4px;
  border-radius: var(--radius-xs);
  border: 1.5px solid var(--accent);
  pointer-events: none;
}
.pc-day--sel {
  background: var(--accent) !important;
  color: var(--text-inverse) !important;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}
.pc-day--out {
  color: var(--text-tertiary);
  opacity: 0.4;
}
.pc-day--out:hover:not(.pc-day--off) {
  opacity: 0.65;
}
.pc-day--off {
  color: var(--text-tertiary);
  opacity: 0.25;
  cursor: not-allowed;
}
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}
</style>
