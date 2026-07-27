<script setup lang="ts">
import { ref } from 'vue'
import PrettyCalendar from '@/components/ui/calendar/PrettyCalendar.vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/composables/useI18n'

const props = defineProps<{ modelValue?: string | null }>()
const emit = defineEmits<{ select: [iso: string | null] }>()
const { t } = useI18n()

const QUICK = [
  { key: 'exp_1h', ms: 3600_000 },
  { key: 'exp_1d', ms: 86400_000 },
  { key: 'exp_7d', ms: 7 * 86400_000 },
  { key: 'exp_30d', ms: 30 * 86400_000 },
]

function pickQuick(ms: number) {
  emit('select', new Date(Date.now() + ms).toISOString())
}
function clearExpiry() {
  emit('select', null)
}

const customOpen = ref(false)
const customDate = ref<Date | null>(new Date())
const customTime = ref('23:59')

/**
 * Guard against Radix / Reka UI auto-closing the popover on outside
 * interaction. When the open state changes to `false` while the
 * popover is still supposed to be open (e.g. pointer-down-outside
 * fired despite @interact-outside.prevent), we ignore the change.
 * Legitimate closes (applyCustom, clearExpiry) set the ref directly.
 */
function onPopoverOpenChange(open: boolean) {
  // Allow opening; block any auto-close triggered by outside-click detection
  if (open) {
    customOpen.value = true
  }
  // When `open === false` we simply do nothing — the ref stays true.
  // applyCustom() and clearExpiry() set customOpen.value directly.
}

function onDateChange(d: Date | null) {
  customDate.value = d
}

function applyCustom() {
  if (!customDate.value) return
  const [hh, mm] = customTime.value.split(':').map(Number)
  const dt = new Date(
    customDate.value.getFullYear(),
    customDate.value.getMonth(),
    customDate.value.getDate(),
    hh || 0,
    mm || 0,
    0, 0
  )
  emit('select', dt.toISOString())
  customOpen.value = false
}
</script>

<template>
  <div class="expiry-picker">
    <div class="expiry-quick">
      <button v-for="q in QUICK" :key="q.key" type="button" class="expiry-quick-btn" @click="pickQuick(q.ms)">
        {{ t(q.key) }}
      </button>
    </div>
    <div class="expiry-row">
      <Popover :open="customOpen" @update:open="onPopoverOpenChange">
        <PopoverTrigger as-child>
          <button type="button" class="expiry-custom-btn">{{ t('exp_custom') }}</button>
        </PopoverTrigger>
        <PopoverContent class="w-auto p-0 z-[9999]" align="start" @interact-outside.prevent>
          <div class="expiry-calendar-wrap" @click.stop @pointerdown.stop @pointerup.stop @pointerdown.capture.stop @pointerup.capture.stop>
            <PrettyCalendar :model-value="customDate" @update:model-value="onDateChange" @pointerdown.capture.stop />
            <div class="expiry-time-row">
              <label class="expiry-time-label">{{ t('exp_time') }}</label>
              <input v-model="customTime" type="time" class="expiry-time-input" />
            </div>
            <div class="expiry-apply-row">
              <button type="button" class="expiry-apply-btn" :disabled="!customDate" @click="applyCustom">
                {{ t('exp_apply') }}
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <button type="button" class="expiry-clear-btn" @click="clearExpiry">{{ t('exp_never') }}</button>
    </div>
  </div>
</template>

<style scoped>
.expiry-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 180px;
}
.expiry-quick {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.expiry-quick-btn,
.expiry-custom-btn,
.expiry-clear-btn {
  font-size: 12px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.12s;
}
.expiry-quick-btn:hover,
.expiry-custom-btn:hover,
.expiry-clear-btn:hover {
  background: var(--bg-hover);
}
.expiry-quick-btn:focus-visible,
.expiry-custom-btn:focus-visible,
.expiry-clear-btn:focus-visible,
.expiry-apply-btn:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
.expiry-row {
  display: flex;
  gap: 6px;
}
.expiry-row > button {
  flex: 1;
}
.expiry-calendar-wrap {
  padding: 4px;
}
.expiry-time-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 0;
}
.expiry-time-label {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.expiry-time-input {
  flex: 1;
  height: 32px;
  padding: 0 10px;
  font-size: 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
}
.expiry-time-input:focus {
  border-color: var(--accent);
}
.expiry-apply-row {
  padding: 8px 12px 12px;
}
.expiry-apply-btn {
  width: 100%;
  font-size: 13px;
  font-weight: 500;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  border: none;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  transition: opacity 0.15s;
}
.expiry-apply-btn:hover { opacity: 0.9; }
.expiry-apply-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
