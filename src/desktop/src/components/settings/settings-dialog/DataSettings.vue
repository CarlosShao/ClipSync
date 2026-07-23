<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { useConfigStore } from '@/stores/configStore'
import Switch from '@/components/ui/switch/Switch.vue'
import { ChevronRight } from 'lucide-vue-next'

const { t } = useI18n()
const configStore = useConfigStore()
const emit = defineEmits<{ 'open-sub-page': [page: string] }>()
</script>

<template>
  <div class="settings-group">
    <div class="sg-header">{{ t('sg_data') }}</div>
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_motion') }}</div>
        <div class="sg-hint">{{ t('sg_motion_h') }}</div>
      </div>
      <Switch
        :model-value="configStore.reduceMotion"
        @update:model-value="(v: boolean) => configStore.toggleReduceMotion(v)"
      />
    </div>
    <div class="sg-row sg-row--clickable" @click="emit('open-sub-page', 'export')">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_export') }}</div>
        <div class="sg-hint">{{ t('sg_export_h') }}</div>
      </div>
      <ChevronRight class="sg-arrow" />
    </div>
  </div>
</template>

<style scoped>
.settings-group {
  margin-bottom: 24px;
}
.sg-header {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  margin-bottom: 8px;
}
.sg-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  gap: 16px;
}
.sg-row--clickable {
  cursor: pointer;
}
.sg-row--clickable:hover {
  background: var(--bg-hover);
}
.sg-label {
  flex: 1;
  min-width: 0;
}
.sg-name {
  font-size: 14px;
  font-weight: 500;
}
.sg-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 1px;
}
.sg-arrow {
  width: 16px;
  height: 16px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
</style>
