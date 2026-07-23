<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useClipboard } from '@/composables/useClipboard'
import { parseDate, type DateValue } from '@internationalized/date'
import Button from '@/components/ui/button/Button.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { Calendar as CalendarIcon } from 'lucide-vue-next'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const clip = useClipboard()

// 设备列表：面板首次展开时懒加载
const devices = ref<{ id: string; name: string; platform?: string }[]>([])
const deviceLoading = ref(false)

watch(
  () => props.open,
  async (open) => {
    if (open && devices.value.length === 0 && !deviceLoading.value) {
      deviceLoading.value = true
      try {
        devices.value = await clip.loadDevices()
      } catch (e) {
        console.warn('[Clipboard] loadDevices failed:', e)
      } finally {
        deviceLoading.value = false
      }
    }
  },
  { immediate: true },
)

// 设备筛选：当前选中设备的名称（用于 CustomSelect 触发器展示）
const deviceLabel = computed(() => {
  const id = clip.advancedFilters.value.deviceId
  if (!id) return t('filter_all_devices')
  const d = devices.value.find((x) => x.id === id)
  return d ? d.name : t('filter_all_devices')
})
function onDeviceChange(v: string) {
  clip.advancedFilters.value.deviceId = v
  clip.loadClipboardItems({ page: 1 })
}

// 日期筛选：字符串 YYYY-MM-DD <-> @internationalized/date DateValue
const dateFromValue = computed<DateValue | undefined>({
  get: () => {
    const str = clip.advancedFilters.value.dateFrom
    if (!str) return undefined
    try {
      return parseDate(str)
    } catch {
      return undefined
    }
  },
  set: (val) => {
    clip.advancedFilters.value.dateFrom = val ? val.toString() : ''
    clip.loadClipboardItems({ page: 1 })
  },
})
const dateToValue = computed<DateValue | undefined>({
  get: () => {
    const str = clip.advancedFilters.value.dateTo
    if (!str) return undefined
    try {
      return parseDate(str)
    } catch {
      return undefined
    }
  },
  set: (val) => {
    clip.advancedFilters.value.dateTo = val ? val.toString() : ''
    clip.loadClipboardItems({ page: 1 })
  },
})
</script>

<template>
  <!-- 高级搜索筛选面板 -->
  <div v-if="open" class="adv-filter-panel">
    <div class="adv-filter-grid">
      <div class="adv-filter-field adv-filter-field--device">
        <label>{{ t('filter_device') }}</label>
        <CustomSelect
          v-model="clip.advancedFilters.value.deviceId"
          class="adv-filter-select-cs"
          size="sm"
          @update:model-value="onDeviceChange"
        >
          {{ deviceLabel }}
          <template #options>
            <CustomSelectOption
              value=""
              :selected="clip.advancedFilters.value.deviceId === ''"
              @select="onDeviceChange('')"
              >{{ t('filter_all_devices') }}</CustomSelectOption
            >
            <CustomSelectOption
              v-for="d in devices"
              :key="d.id"
              :value="d.id"
              :selected="clip.advancedFilters.value.deviceId === d.id"
              @select="onDeviceChange(d.id)"
              >{{ d.name }}</CustomSelectOption
            >
          </template>
        </CustomSelect>
      </div>
      <div class="adv-filter-field">
        <label>{{ t('filter_from') }}</label>
        <Popover>
          <PopoverTrigger as-child>
            <Button variant="outline" class="font-normal h-8 px-3 gap-2 min-w-[90px] rounded-md">
              <CalendarIcon class="h-4 w-4 shrink-0" />
              <span class="truncate">{{ clip.advancedFilters.value.dateFrom || t('filter_from') }}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent class="w-80 p-4 z-[9999]">
            <Calendar v-model="dateFromValue" />
          </PopoverContent>
        </Popover>
      </div>
      <div class="adv-filter-field">
        <label>{{ t('filter_to') }}</label>
        <Popover>
          <PopoverTrigger as-child>
            <Button variant="outline" class="font-normal h-8 px-3 gap-2 min-w-[90px] rounded-md">
              <CalendarIcon class="h-4 w-4 shrink-0" />
              <span class="truncate">{{ clip.advancedFilters.value.dateTo || t('filter_to') }}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent class="w-80 p-4 z-[9999]">
            <Calendar v-model="dateToValue" />
          </PopoverContent>
        </Popover>
      </div>
      <div class="adv-filter-field adv-filter-field--actions">
        <div class="adv-filter-label-placeholder"></div>
        <div class="adv-filter-actions-inline">
          <Button
            variant="ghost"
            size="sm"
            class="min-w-[80px] rounded-md px-4 h-8"
            @click="clip.clearAdvancedFilters()"
            >{{ t('filter_clear') }}</Button
          >
          <Button variant="outline" size="sm" class="min-w-[80px] rounded-md px-4 h-8" @click="emit('close')">{{
            t('filter_close')
          }}</Button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 高级搜索筛选面板 ===== */
.filter-active {
  border-color: var(--color-primary, #6366f1) !important;
  color: var(--color-primary, #6366f1) !important;
}
.adv-filter-panel {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  padding: 20px 24px;
  margin: 0 12px 8px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
.adv-filter-grid {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  flex: 1;
  align-items: flex-end;
}
.adv-filter-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.adv-filter-field--actions {
  gap: 0;
}
.adv-filter-field label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  height: 18px;
  line-height: 18px;
}
.adv-filter-label-placeholder {
  height: 18px;
}
.adv-filter-field--device {
  min-width: 170px;
}
.adv-filter-field--actions {
  min-width: 180px;
  margin-left: auto;
}
.adv-filter-actions-inline {
  display: flex;
  gap: 8px;
  align-items: center;
}
.adv-filter-field .custom-select,
.adv-filter-field .custom-select-trigger {
  height: 32px !important;
  min-height: 32px !important;
}
.adv-filter-field .h-8 {
  height: 32px !important;
  min-height: 32px !important;
}
.filter-input-sm {
  height: 32px !important;
  min-height: 32px !important;
  padding: 0 12px !important;
  font-size: 13px !important;
}
</style>
