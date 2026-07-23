<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useConfigStore } from '@/stores/configStore'
import Switch from '@/components/ui/switch/Switch.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'

const { t, currentLang, setLang } = useI18n()
const configStore = useConfigStore()

const emit = defineEmits<{ 'open-modal': [type: string] }>()

const langModel = ref<string>(currentLang.value as string)
const syncIntervalModel = ref(String(configStore.syncInterval))
const maxHistoryModel = ref(String(configStore.maxHistory))

function onMaxHistoryChange() {
  const val = Number(maxHistoryModel.value)
  if (val === 999999 && configStore.user.plan !== 'Pro' && configStore.user.plan !== 'Enterprise') {
    // Pro/Enterprise-only option selected without proper plan - reset to 500
    maxHistoryModel.value = String(configStore.maxHistory || 500)
    return
  }
  configStore.maxHistory = val
  configStore.savePrefs()
}

watch(langModel, (v) => setLang(v as 'zh' | 'en'))
watch(syncIntervalModel, (v) => {
  configStore.syncInterval = Number(v)
  configStore.savePrefs()
})
watch(maxHistoryModel, () => onMaxHistoryChange())
</script>

<template>
  <div class="settings-group">
    <div class="sg-header">{{ t('sg_gen') }}</div>
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_autosync') }}</div>
        <div class="sg-hint">{{ t('sg_autosync_h') }}</div>
      </div>
      <Switch :model-value="configStore.autoSync" @update:model-value="(v: boolean) => configStore.toggleAutoSync(v)" />
    </div>
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_imgcomp') }}</div>
        <div class="sg-hint">{{ t('sg_imgcomp_h') }}</div>
      </div>
      <Switch
        :model-value="configStore.imageCompress"
        @update:model-value="(v: boolean) => configStore.toggleImageCompress(v)"
      />
    </div>
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_startup') }}</div>
        <div class="sg-hint">{{ t('sg_startup_h') }}</div>
      </div>
      <Switch
        :model-value="configStore.autostart"
        @update:model-value="(v: boolean) => configStore.toggleAutostart(v)"
      />
    </div>
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_lang') }}</div>
        <div class="sg-hint">{{ t('sg_lang_h') }}</div>
      </div>
      <CustomSelect v-model="langModel">
        {{ langModel === 'zh' ? t('lang_zh') : t('lang_en') }}
        <template #options>
          <CustomSelectOption
            value="zh"
            :selected="langModel === 'zh'"
            @select="
              (v: string) => {
                langModel = v
                setLang(v as 'zh' | 'en')
              }
            "
            >{{ t('lang_zh') }}</CustomSelectOption
          >
          <CustomSelectOption
            value="en"
            :selected="langModel === 'en'"
            @select="
              (v: string) => {
                langModel = v
                setLang(v as 'zh' | 'en')
              }
            "
            >{{ t('lang_en') }}</CustomSelectOption
          >
        </template>
      </CustomSelect>
    </div>
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_interval') }}</div>
        <div class="sg-hint">{{ t('sg_interval_h') }}</div>
      </div>
      <CustomSelect v-model="syncIntervalModel">
        {{ syncIntervalModel === '0' ? t('int_rt') : syncIntervalModel === '5' ? t('int_5m') : t('int_15m') }}
        <template #options>
          <CustomSelectOption
            value="0"
            :selected="syncIntervalModel === '0'"
            @select="(v) => (syncIntervalModel = v)"
            >{{ t('int_rt') }}</CustomSelectOption
          >
          <CustomSelectOption
            value="5"
            :selected="syncIntervalModel === '5'"
            @select="(v) => (syncIntervalModel = v)"
            >{{ t('int_5m') }}</CustomSelectOption
          >
          <CustomSelectOption
            value="15"
            :selected="syncIntervalModel === '15'"
            @select="(v) => (syncIntervalModel = v)"
            >{{ t('int_15m') }}</CustomSelectOption
          >
        </template>
      </CustomSelect>
    </div>
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-name">{{ t('sg_maxhist') }}</div>
        <div class="sg-hint">{{ t('sg_maxhist_h') }}</div>
      </div>
      <CustomSelect v-model="maxHistoryModel">
        {{
          maxHistoryModel === '100'
            ? t('hist_100')
            : maxHistoryModel === '500'
              ? t('hist_500')
              : maxHistoryModel === '1000'
                ? t('hist_1k')
                : t('hist_unl')
        }}
        <template #options>
          <CustomSelectOption
            value="100"
            :selected="maxHistoryModel === '100'"
            @select="(v) => (maxHistoryModel = v)"
            >{{ t('hist_100') }}</CustomSelectOption
          >
          <CustomSelectOption
            value="500"
            :selected="maxHistoryModel === '500'"
            @select="(v) => (maxHistoryModel = v)"
            >{{ t('hist_500') }}</CustomSelectOption
          >
          <CustomSelectOption
            value="1000"
            :selected="maxHistoryModel === '1000'"
            @select="(v) => (maxHistoryModel = v)"
            >{{ t('hist_1k') }}</CustomSelectOption
          >
          <CustomSelectOption
            value="999999"
            :selected="maxHistoryModel === '999999'"
            :disabled="configStore.user.plan !== 'Pro' && configStore.user.plan !== 'Enterprise'"
            @select="(v) => (maxHistoryModel = v)"
            >{{ t('hist_unl')
            }}{{
              configStore.user.plan !== 'Pro' && configStore.user.plan !== 'Enterprise'
                ? ` (${t('upgrade_required')})`
                : ''
            }}</CustomSelectOption
          >
        </template>
      </CustomSelect>
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

.sg-row:hover {
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
</style>
