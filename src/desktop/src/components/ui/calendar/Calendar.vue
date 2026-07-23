<script lang="ts" setup>
import type { CalendarRootEmits, CalendarRootProps, DateValue } from 'reka-ui'
import type { HTMLAttributes, Ref } from 'vue'
import { getLocalTimeZone, today } from '@internationalized/date'
import { reactiveOmit, useVModel } from '@vueuse/core'
import { CalendarRoot, useDateFormatter, useForwardPropsEmits } from 'reka-ui'
import { createYear, createYearRange, toDate } from 'reka-ui/date'
import { computed, toRaw } from 'vue'
import { cn } from '@/lib/utils'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import {
  CalendarCell,
  CalendarCellTrigger,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHead,
  CalendarGridRow,
  CalendarHeadCell,
  CalendarHeader,
  CalendarNextButton,
  CalendarPrevButton,
} from '.'

const props = withDefaults(
  defineProps<CalendarRootProps & { class?: HTMLAttributes['class'] }>(),
  {
    modelValue: undefined,
  },
)
const emits = defineEmits<CalendarRootEmits>()

const delegatedProps = reactiveOmit(props, 'class')

const placeholder = useVModel(props, 'placeholder', emits, {
  passive: true,
  defaultValue: props.defaultPlaceholder ?? today(getLocalTimeZone()),
}) as Ref<DateValue>

const formatter = useDateFormatter(props.locale ?? 'en')

const yearRange = computed(() => {
  return createYearRange({
    start:
      props?.minValue ??
      (toRaw(props.placeholder) ?? props.defaultPlaceholder ?? today(getLocalTimeZone())).cycle('year', -100),

    end:
      props?.maxValue ??
      (toRaw(props.placeholder) ?? props.defaultPlaceholder ?? today(getLocalTimeZone())).cycle('year', 10),
  })
})

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <CalendarRoot
    v-slot="{ grid, weekDays, date }"
    v-bind="forwarded"
    v-model:placeholder="placeholder"
    data-slot="calendar"
    :class="cn('p-5', props.class)"
  >
    <CalendarHeader class="flex items-center justify-between mb-4">
      <CalendarPrevButton>
        <ChevronLeft class="size-3.5" />
      </CalendarPrevButton>

      <div class="flex items-center justify-center gap-1">
        <div class="relative">
          <div class="absolute inset-0 flex h-7 items-center text-sm font-medium pl-2.5 pointer-events-none">
            {{ formatter.custom(toDate(date), { month: 'short' }) }}
          </div>
          <NativeSelect
            class="text-xs h-7 pr-7 pl-2.5 text-transparent relative min-w-[64px] cursor-pointer"
            :model-value="date.month"
            @change="
              (e: Event) => {
                placeholder = placeholder.set({
                  month: Number((e?.target as any)?.value),
                })
              }
            "
          >
            <NativeSelectOption
              v-for="month in createYear({ dateObj: date })"
              :key="month.toString()"
              :value="month.month"
              :selected="date.month === month.month"
            >
              {{ formatter.custom(toDate(month), { month: 'short' }) }}
            </NativeSelectOption>
          </NativeSelect>
        </div>
        <div class="relative">
          <div class="absolute inset-0 flex h-7 items-center text-sm font-medium pl-2.5 pointer-events-none">
            {{ formatter.custom(toDate(date), { year: 'numeric' }) }}
          </div>
          <NativeSelect
            class="text-xs h-7 pr-7 pl-2.5 text-transparent relative min-w-[64px] cursor-pointer"
            :model-value="date.year"
            @change="
              (e: Event) => {
                placeholder = placeholder.set({
                  year: Number((e?.target as any)?.value),
                })
              }
            "
          >
            <NativeSelectOption
              v-for="year in yearRange"
              :key="year.toString()"
              :value="year.year"
              :selected="date.year === year.year"
            >
              {{ formatter.custom(toDate(year), { year: 'numeric' }) }}
            </NativeSelectOption>
          </NativeSelect>
        </div>
      </div>

      <CalendarNextButton>
        <ChevronRight class="size-3.5" />
      </CalendarNextButton>
    </CalendarHeader>

    <CalendarGrid v-for="month in grid" :key="month.value.toString()">
      <CalendarGridHead>
        <CalendarGridRow>
          <CalendarHeadCell v-for="day in weekDays" :key="day">
            {{ day }}
          </CalendarHeadCell>
        </CalendarGridRow>
      </CalendarGridHead>
      <CalendarGridBody>
        <CalendarGridRow v-for="(weekDates, index) in month.rows" :key="`weekDate-${index}`">
          <CalendarCell v-for="weekDate in weekDates" :key="weekDate.toString()" :date="weekDate">
            <CalendarCellTrigger :day="weekDate" :month="month.value" />
          </CalendarCell>
        </CalendarGridRow>
      </CalendarGridBody>
    </CalendarGrid>
  </CalendarRoot>
</template>

<style scoped>
:deep(button[data-slot='calendar-prev-button']),
:deep(button[data-slot='calendar-next-button']) {
  height: 28px;
  width: 28px;
  border-radius: 6px;
  color: var(--text-tertiary);
  transition: all 0.15s;
}
:deep(button[data-slot='calendar-prev-button']:hover),
:deep(button[data-slot='calendar-next-button']:hover) {
  background: var(--bg-active);
  color: var(--text-primary);
}
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
:deep(button[data-slot='calendar-cell-trigger']) {
  font-size: 12px;
  color: var(--text-primary);
  border-radius: 6px;
}
:deep(button[data-slot='calendar-cell-trigger'][data-selected]) {
  background: var(--color-primary, #6366f1);
  color: var(--color-primary-foreground, #ffffff);
}
:deep(button[data-slot='calendar-cell-trigger'][data-today]:not([data-selected])) {
  background: var(--accent-light);
  color: var(--accent);
  font-weight: 600;
}
:deep(button[data-slot='calendar-cell-trigger']:hover:not([data-selected]) {
  background: var(--bg-hover);
}
</style>
