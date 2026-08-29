<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useConfigStore } from '@/stores/configStore'
import Switch from '@/components/ui/switch/Switch.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'
import Button from '@/components/ui/button/Button.vue'

const { t, currentLang, setLang } = useI18n()
const toast = useSonner()
const configStore = useConfigStore()

const emit = defineEmits<{ 'open-modal': [type: string] }>()

const langModel = ref<string>(currentLang.value as string)
const syncIntervalModel = ref(String(configStore.syncInterval))
const maxHistoryModel = ref(String(configStore.maxHistory))

// ── 服务器地址（A1）───────────────────────────────────────────────
// 之前 configStore.load() 每次都会把 server_url 强制覆写成 localhost:3001，
// 用户无从配置，Rust 侧的配置持久化也就形同虚设。这里补上唯一的配置入口。
const isDev = import.meta.env.DEV
const DEFAULT_SERVER_URL = 'http://localhost:3001'
const serverUrlInput = ref(configStore.config.server_url)
/** 已生效（已持久化到 Rust）的地址 */
const serverUrl = computed(() => configStore.config.server_url)
/** 浏览器 dev 走 Vite proxy（相对路径），空地址也算是连通的 */
const serverConnected = computed(() => isDev || serverUrl.value.trim().length > 0)
/** 空串 = 用户主动清空 = 未连接，是合法状态；其余必须 http/https */
const serverUrlError = computed(() => {
  const v = serverUrlInput.value.trim()
  if (!v) return ''
  return /^https?:\/\/\S+$/i.test(v) ? '' : t('sg_server_url_invalid')
})
const serverUrlDirty = computed(() => serverUrlInput.value !== serverUrl.value)

// 外部（Rust 端/其他入口）改了地址时同步回输入框，但不覆盖用户正在编辑的内容
watch(serverUrl, (v) => {
  if (!serverUrlDirty.value) serverUrlInput.value = v
})

async function saveServerUrl() {
  if (serverUrlError.value) return
  const next = serverUrlInput.value.trim()
  await configStore.save({ server_url: next })
  toast.show(t('sg_server_url_saved'), 'success')
}

function resetServerUrl() {
  serverUrlInput.value = isDev ? '' : DEFAULT_SERVER_URL
  void saveServerUrl()
}

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
    <!-- 服务器地址（A1）：唯一配置入口，空 = 未连接 -->
    <div class="sg-row sg-row--stack">
      <div class="sg-label">
        <div class="sg-name">
          {{ t('sg_server_url') }}
          <span class="sg-conn" :class="serverConnected ? 'is-ok' : 'is-off'">{{
            serverConnected ? t('sg_server_url_ok') : t('sg_server_url_notset')
          }}</span>
        </div>
        <div class="sg-hint">{{ t('sg_server_url_h') }}</div>
      </div>
      <div class="sg-server">
        <input
          v-model="serverUrlInput"
          class="sg-input"
          :class="{ 'sg-input--invalid': !!serverUrlError }"
          :placeholder="t('sg_server_url_ph')"
          spellcheck="false"
          autocomplete="off"
          @keyup.enter="saveServerUrl"
        />
        <Button variant="outline" size="sm" :disabled="!serverUrlDirty || !!serverUrlError" @click="saveServerUrl">
          {{ t('btn_save') }}
        </Button>
        <Button variant="outline" size="sm" @click="resetServerUrl">{{ t('sg_server_url_reset') }}</Button>
      </div>
      <div v-if="serverUrlError" class="sg-note sg-note--error">{{ serverUrlError }}</div>
      <div v-else-if="serverUrlDirty" class="sg-note sg-note--warn">{{ t('sg_server_url_unsaved') }}</div>
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

/* 服务器地址：输入框 + 操作按钮需要纵向排布 */
.sg-row--stack {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

.sg-label {
  flex: 1;
  min-width: 0;
}

.sg-conn {
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 9999px;
  letter-spacing: 0.02em;
}
.sg-conn.is-ok {
  background: color-mix(in srgb, var(--success) 15%, transparent);
  color: var(--success);
}
.sg-conn.is-off {
  background: color-mix(in srgb, var(--warning) 15%, transparent);
  color: var(--warning);
}

.sg-server {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sg-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  font-size: 13px;
  font-family: var(--font-mono, monospace);
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  outline: none;
  transition: border-color 0.15s;
}
.sg-input:focus {
  border-color: var(--accent);
}
.sg-input--invalid {
  border-color: var(--danger);
}

.sg-note {
  font-size: 11px;
  line-height: 1.5;
}
.sg-note--error {
  color: var(--danger);
}
.sg-note--warn {
  color: var(--warning);
}

.sg-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
}

.sg-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 1px;
}
</style>
