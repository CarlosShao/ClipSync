<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Switch from '@/components/ui/switch/Switch.vue'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'
import { RefreshCw } from 'lucide-vue-next'
import {
  getProviders,
  getPresets,
  createProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  getProviderModels,
  fetchProviderModels,
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
// 多选：该配置已启用的模型（tags 形式）
const formSelectedModels = ref<string[]>([])
// 上游刷新得到的完整模型列表（用于点选）
const formModels = ref<string[]>([])
const formIsDefault = ref(false)
const saving = ref(false)
const refreshingModels = ref(false)
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
    if (formSelectedModels.value.length === 0) {
      formSelectedModels.value = [preset.defaultModel]
    }
  }
}

function resetForm() {
  editingId.value = null
  formProvider.value = ''
  formName.value = ''
  formApiKey.value = ''
  formBaseUrl.value = ''
  formSelectedModels.value = []
  formModels.value = []
  formIsDefault.value = false
  formError.value = ''
}

function startEdit(p: AiProvider) {
  editingId.value = p.id
  formProvider.value = p.provider
  formName.value = p.name
  formApiKey.value = '' // 不回显密钥；留空表示不修改
  formBaseUrl.value = p.base_url || ''
  formSelectedModels.value = Array.isArray(p.models) && p.models.length > 0 ? [...p.models] : [p.model]
  formModels.value = Array.isArray(p.models) ? [...p.models] : []
  formIsDefault.value = p.is_default
  formError.value = ''
}

function toggleModel(m: string) {
  const idx = formSelectedModels.value.indexOf(m)
  if (idx >= 0) {
    formSelectedModels.value = formSelectedModels.value.filter((x) => x !== m)
  } else {
    formSelectedModels.value = [...formSelectedModels.value, m]
  }
}

// 刷新该供应商可用模型列表（上游 /models）。
// 已保存供应商走后端解密 key；未保存供应商用表单中的 key/baseUrl 直接拉取（不落地）。
async function refreshModels() {
  if (refreshingModels.value) return
  const hasKey = formApiKey.value.trim().length > 0
  if (!hasKey) {
    formError.value = t('ai_api_key_required')
    return
  }
  refreshingModels.value = true
  formError.value = ''
  try {
    let res
    if (editingId.value) {
      res = await getProviderModels(editingId.value)
    } else {
      res = await fetchProviderModels({
        provider: formProvider.value,
        baseUrl: formBaseUrl.value.trim(),
        apiKey: formApiKey.value.trim(),
      })
    }
    if (res.ok && res.data) {
      const list = res.data.models || []
      formModels.value = list
      // 把当前已选但不在新列表里的模型合并进去，避免用户先手工输入后被刷新清空
      const selected = new Set([...formSelectedModels.value, ...list.filter((m) => formSelectedModels.value.includes(m))])
      // 若当前未选任何模型，默认勾选第一个
      if (selected.size === 0 && list.length > 0) {
        selected.add(list[0])
      }
      formSelectedModels.value = Array.from(selected)
      toast.show(t('ai_models_refreshed'), 'success')
    } else {
      toast.show(res.error || t('ai_models_refresh_fail'), 'error')
    }
  } catch (e: any) {
    toast.show(String(e?.message || e), 'error')
  } finally {
    refreshingModels.value = false
  }
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
  if (formSelectedModels.value.length === 0) {
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
      model: formSelectedModels.value[0],
      models: formSelectedModels.value,
      isDefault: formIsDefault.value,
    }
    const res = editingId.value
      ? await updateProvider(editingId.value, payload)
      : await createProvider(payload)
    if (res.ok) {
      toast.show(t('ai_saved'), 'success')
      await load()
      resetForm()
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
          <div class="sg-hint">
            {{ presetLabel(p.provider) }} ·
            <template v-if="Array.isArray(p.models) && p.models.length > 1">
              {{ p.models[0] }} 等 {{ p.models.length }} 个模型
            </template>
            <template v-else>{{ p.model }}</template>
          </div>
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
        <!-- 已选模型以 tag 形式展示，可直接删除；亦可从下方列表点选添加 -->
        <div v-if="formSelectedModels.length" class="ai-models">
          <div class="ai-models-tags">
            <button
              v-for="m in formSelectedModels"
              :key="m"
              type="button"
              class="ai-model-tag ai-model-tag--selected"
              @click="toggleModel(m)"
            >
              {{ m }}
              <span class="ai-model-remove">×</span>
            </button>
          </div>
        </div>
        <Input
          v-model="formSelectedModels[formSelectedModels.length - 1]"
          :placeholder="t('ai_model_ph')"
          @keydown.enter.prevent="
            ($event.target as HTMLInputElement)?.value &&
              toggleModel(($event.target as HTMLInputElement).value)
          "
        />
        <div v-if="formModels.length" class="ai-models">
          <div class="ai-models-hint">{{ t('ai_models_hint') }}</div>
          <div class="ai-models-tags">
            <button
              v-for="m in formModels"
              :key="m"
              type="button"
              class="ai-model-tag"
              :class="{ active: formSelectedModels.includes(m) }"
              @click="toggleModel(m)"
            >
              {{ m }}
            </button>
          </div>
        </div>
        <div class="ai-models-actions">
          <Button
            size="sm"
            variant="outline"
            class="min-w-[100px]"
            :disabled="refreshingModels || !formApiKey.trim()"
            @click="refreshModels"
          >
            <RefreshCw v-if="!refreshingModels" :size="12" />
            {{ refreshingModels ? t('ai_refreshing') : t('ai_refresh_models') }}
          </Button>
        </div>
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
  padding: 22px 24px;
  background: var(--bg-hover);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}
.ai-field {
  margin-bottom: 16px;
}
.ai-field .custom-select {
  width: 100%;
}
.ai-field :deep(input) {
  padding-left: 14px;
  padding-right: 14px;
}
.ai-field :deep(.custom-select-trigger) {
  padding-left: 14px;
  padding-right: 14px;
}
.ai-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
  padding-left: 2px;
}
.ai-default-row {
  padding: 10px 4px;
}
.ai-models {
  margin-top: 10px;
}
.ai-models-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ai-model-tag {
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: transparent;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.ai-model-tag:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.ai-model-tag.active {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 500;
}
.ai-model-tag--selected {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 500;
  padding-right: 8px;
}
.ai-model-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 4px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-bg);
  font-size: 10px;
  line-height: 1;
}
.ai-model-tag--selected:hover .ai-model-remove {
  background: var(--danger, #ef4444);
  color: #fff;
}
.ai-models-hint {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 6px;
}
.ai-models-actions {
  margin-top: 10px;
}
.ai-models-actions :deep(.ai-model-tag svg) {
  display: inline-block;
  vertical-align: middle;
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
