<script setup lang="ts">
import { ref } from 'vue'
import { Calendar } from '@/components/ui/calendar'
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
// 宽松类型：Calendar 的 v-model emit 类型（DateValue | DateValue[] | null）与
// @internationalized/date 多版本实例不兼容，此处仅需 toString()，与 ClipboardView 的 computed 模式等效
const customDate = ref()
const customTime = ref('23:59')

function applyCustom() {
  if (!customDate.value) return
  const [y, m, d] = customDate.value.toString().split('-').map(Number)
  const [hh, mm] = customTime.value.split(':').map(Number)
  const dt = new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0)
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
      <Popover v-model:open="customOpen">
        <PopoverTrigger as-child>
          <button type="button" class="expiry-custom-btn">{{ t('exp_custom') }}</button>
        </PopoverTrigger>
        <PopoverContent class="w-80 p-3 flex flex-col gap-2 z-[9999]">
          <Calendar v-model="customDate" />
          <div class="flex items-center gap-2">
            <label class="expiry-time-label">{{ t('exp_time') }}</label>
            <input v-model="customTime" type="time" class="expiry-time-input" />
          </div>
          <button type="button" class="expiry-apply-btn" :disabled="!customDate" @click="applyCustom">
            {{ t('exp_apply') }}
          </button>
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
.expiry-row {
  display: flex;
  gap: 6px;
}
.expiry-row > button {
  flex: 1;
}
.expiry-time-label {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.expiry-time-input {
  flex: 1;
  height: 30px;
  padding: 0 8px;
  font-size: 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
}
.expiry-apply-btn {
  font-size: 12px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
.expiry-apply-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
