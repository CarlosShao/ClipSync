<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Switch from '@/components/ui/switch/Switch.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'
import {
  getProviders,
  getPresets,
  createProvider,
  updateProvider,
  deleteProvider,
  testProvider,
} from '@/api/ai'
import type { AiProvider, AiProviderPreset } from '@/api/ai'

const { t } = useI18n()
const toast = useSonner()

const providers = ref<AiProvider[]>([])
const presets = ref<AiProviderPreset[]>([])
const loading = ref(false)

const editingId = ref<string | null>(null)
const formProvider = ref('')
const formName = ref('')
const formApiKey = ref('')
const formBaseUrl = ref('')
const formModel = ref('')
const formIsDefault = ref(false)
const saving = ref(false)
const formError = ref('')
const confirmingDeleteId = ref<string | null>(null)
const testingId = ref<string | null>(null)

const formProviderLabel = computed(() => {
  const p = presets.value.find((x) => x.provider === formProvider.value)
  return p?.label || formProvider.value
})

function presetLabel(provider: string) {
  const p = presets.value.find((x) => x.provider === provider)
  return p?.label || provider
}

async function load() {
  loading.value = true
  try {
    const [p, pr] = await Promise.all([getProviders(), getPresets()])
    if (p.ok) providers.value = p.data?.items || []
    if (pr.ok) presets.value = pr.data?.items || []
  } catch (e) {
    console.warn('[AI] load providers failed', e)
  } finally {
    loading.value = false
  }
}

function onProviderChange(v: string) {
  formProvider.value = v
  const preset = presets.value.find((x) => x.provider === v)
  if (preset) {
    if (!formBaseUrl.value) formBaseUrl.value = preset.defaultBaseUrl
    if (!formModel.value) formModel.value = preset.defaultModel
  }
}

function resetForm() {
  editingId.value = null
  formProvider.value = ''
  formName.value = ''
  formApiKey.value = ''
  formBaseUrl.value = ''
  formModel.value = ''
  formIsDefault.value = false
  formError.value = ''
}

function startEdit(p: AiProvider) {
  editingId.value = p.id
  formProvider.value = p.provider
  formName.value = p.name
  formApiKey.value = '' // 不回显密钥；留空表示不修改
  formBaseUrl.value = p.base_url || ''
  formModel.value = p.model
  formIsDefault.value = p.is_default
  formError.value = ''
}

async function save() {
  formError.value = ''
  if (!formProvider.value) {
    formError.value = t('ai_provider_required')
    return
  }
  if (!formName.value.trim()) {
    formError.value = t('ai_name_required')
    return
  }
  if (!formModel.value.trim()) {
    formError.value = t('ai_model_required')
    return
  }
  saving.value = true
  try {
    const payload = {
      provider: formProvider.value,
      name: formName.value.trim(),
      apiKey: formApiKey.value || undefined,
      baseUrl: formBaseUrl.value.trim() || undefined,
      model: formModel.value.trim(),
      isDefault: formIsDefault.value,
    }
    const res = editingId.value
      ? await updateProvider(editingId.value, payload)
      : await createProvider(payload)
    if (res.ok) {
      toast.show(t('ai_saved'), 'success')
      resetForm()
      await load()
    } else {
      formError.value = res.error || t('ai_save_failed')
    }
  } catch (e: any) {
    formError.value = String(e?.message || e)
  } finally {
    saving.value = false
  }
}

async function remove(id: string) {
  const res = await deleteProvider(id)
  if (res.ok) {
    toast.show(t('ai_deleted'), 'success')
    if (confirmingDeleteId.value === id) confirmingDeleteId.value = null
    await load()
  } else {
    toast.show(res.error || t('ai_delete_failed'), 'error')
  }
}

async function test(id: string) {
  testingId.value = id
  try {
    const res = await testProvider(id)
    if (res.ok && res.data?.ok) {
      toast.show(t('ai_test_ok'), 'success')
    } else {
      const detail = res.data?.detail ? `${res.data.detail} ` : ''
      toast.show(detail + (res.error || t('ai_test_fail')), 'error')
    }
  } catch (e: any) {
    toast.show(String(e?.message || e), 'error')
  } finally {
    testingId.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="settings-group">
    <div class="sg-header">{{ t('sg_ai') }}</div>
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-hint">{{ t('ai_intro') }}</div>
      </div>
    </div>

    <!-- 供应商列表 -->
    <div v-for="p in providers" :key="p.id" class="ai-prov-card">
      <div class="sg-row">
        <div class="sg-label">
          <div class="sg-name">
            {{ p.name }}
            <span v-if="p.is_default" class="ai-badge ai-badge--default">{{ t('ai_default') }}</span>
            <span v-if="p.has_key" class="ai-badge ai-badge--key">{{ t('ai_key_set') }}</span>
            <span v-else class="ai-badge ai-badge--nokey">{{ t('ai_no_key') }}</span>
          </div>
          <div class="sg-hint">{{ presetLabel(p.provider) }} · {{ p.model }}</div>
        </div>
        <div class="ai-card-actions">
          <Button size="sm" variant="outline" class="min-w-[100px]" :disabled="testingId === p.id" @click="test(p.id)">
            {{ testingId === p.id ? t('ai_testing') : t('ai_test') }}
          </Button>
          <Button size="sm" variant="outline" class="min-w-[100px]" @click="startEdit(p)">{{ t('ai_edit') }}</Button>
          <Button
            v-if="confirmingDeleteId !== p.id"
            size="sm"
            variant="outline"
            class="min-w-[100px]"
            @click="confirmingDeleteId = p.id"
            >{{ t('ai_delete') }}</Button
          >
          <template v-else>
            <Button size="sm" variant="destructive" class="min-w-[100px]" @click="remove(p.id)">{{
              t('ai_confirm_delete')
            }}</Button>
            <Button size="sm" variant="ghost" class="min-w-[100px]" @click="confirmingDeleteId = null">{{
              t('cancel_btn')
            }}</Button>
          </template>
        </div>
      </div>
    </div>

    <div v-if="!loading && providers.length === 0" class="ai-empty">{{ t('ai_no_providers') }}</div>

    <!-- 新增 / 编辑表单 -->
    <div class="sg-row sg-row--clickable" @click="resetForm()">
      <div class="sg-label">
        <div class="sg-name">{{ editingId ? t('ai_edit_provider') : t('ai_add_provider') }}</div>
        <div class="sg-hint">{{ t('ai_form_h') }}</div>
      </div>
    </div>

    <div class="ai-form">
      <div class="ai-field">
        <label class="ai-label">{{ t('ai_provider_label') }}</label>
        <CustomSelect :model-value="formProvider" @update:model-value="onProviderChange">
          {{ formProvider ? formProviderLabel : t('ai_select_provider') }}
          <template #options>
            <CustomSelectOption
              v-for="pr in presets"
              :key="pr.provider"
              :value="pr.provider"
              :selected="formProvider === pr.provider"
              @select="onProviderChange"
            >
              {{ pr.label }}
            </CustomSelectOption>
          </template>
        </CustomSelect>
      </div>

      <div class="ai-field">
        <label class="ai-label">{{ t('ai_name') }}</label>
        <Input v-model="formName" :placeholder="t('ai_name_ph')" />
      </div>

      <div class="ai-field">
        <label class="ai-label">{{ t('ai_api_key') }}</label>
        <Input
          v-model="formApiKey"
          type="password"
          autocomplete="off"
          :placeholder="editingId ? t('ai_api_key_keep') : t('ai_api_key_ph')"
        />
      </div>

      <div class="ai-field">
        <label class="ai-label">{{ t('ai_base_url') }}</label>
        <Input v-model="formBaseUrl" :placeholder="t('ai_base_url_ph')" />
      </div>

      <div class="ai-field">
        <label class="ai-label">{{ t('ai_model') }}</label>
        <Input v-model="formModel" :placeholder="t('ai_model_ph')" />
      </div>

      <div class="sg-row ai-default-row">
        <div class="sg-label">
          <div class="sg-name">{{ t('ai_default') }}</div>
          <div class="sg-hint">{{ t('ai_default_h') }}</div>
        </div>
        <Switch :model-value="formIsDefault" @update:model-value="(v: boolean) => (formIsDefault = v)" />
      </div>

      <div v-if="formError" class="ai-error">{{ formError }}</div>

      <div class="ai-form-actions">
        <Button class="min-w-[100px]" :disabled="saving" @click="save">{{ saving ? t('ai_saving') : t('ai_save') }}</Button>
        <Button variant="outline" class="min-w-[100px]" @click="resetForm()">{{ t('cancel_btn') }}</Button>
      </div>
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
.ai-prov-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  margin: 6px 0;
}
.ai-card-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.ai-badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  margin-left: 6px;
  vertical-align: middle;
}
.ai-badge--default {
  background: var(--accent-bg);
  color: var(--accent);
}
.ai-badge--key {
  background: var(--success-bg, #dcfce7);
  color: var(--success, #16a34a);
}
.ai-badge--nokey {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}
.ai-empty {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 8px 14px 12px;
}
.ai-form {
  margin: 8px 0;
  padding: 18px 20px;
  background: var(--bg-hover);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}
.ai-field {
  margin-bottom: 14px;
}
.ai-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.ai-default-row {
  padding-left: 0;
  padding-right: 0;
}
.ai-error {
  color: var(--danger, #ef4444);
  font-size: 12px;
  margin: 4px 0 10px;
}
.ai-form-actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}
</style>
