<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useTemplateVariableStore } from '@/stores/templateVariableStore'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import { ChevronDown } from 'lucide-vue-next'

const { t } = useI18n()
const toast = useSonner()
const varStore = useTemplateVariableStore()
const tplVarList = computed(() => varStore.list())

const editingVarName = ref('')
const editValue = ref('')
const newVarName = ref('')
const newVarValue = ref('')
const varError = ref('')
const addOpen = ref(false)

function startEditVar(v: { name: string; value: string }) {
  editingVarName.value = v.name
  editValue.value = v.value
}

async function saveEditVar(name: string) {
  const ok = await varStore.setVariable(name, editValue.value)
  if (ok) {
    toast.show(t('tpl_vars_saved') || '变量已保存', 'success')
    editingVarName.value = ''
    editValue.value = ''
  }
}

async function removeVar(name: string) {
  await varStore.removeVariable(name)
}

async function addVar() {
  varError.value = ''
  const name = newVarName.value.trim()
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    varError.value = t('tpl_vars_name_invalid') || '变量名必须是字母/下划线开头的标识符'
    return
  }
  const ok = await varStore.setVariable(name, newVarValue.value)
  if (ok) {
    toast.show(t('tpl_vars_saved') || '变量已保存', 'success')
    newVarName.value = ''
    newVarValue.value = ''
    addOpen.value = false
  }
}

onMounted(() => {
  if (!varStore.initialized) varStore.fetchVariables()
})
</script>

<template>
  <div class="settings-group">
    <div class="sg-header">{{ t('sg_tpl_vars') }}</div>
    <div class="sg-row">
      <div class="sg-label">
        <div class="sg-hint">{{ t('sg_tpl_vars_h') }}</div>
      </div>
    </div>

    <div v-for="v in tplVarList" :key="v.name" class="tpl-var-block">
      <div class="sg-row">
        <div class="sg-label" style="cursor: pointer" @click="editingVarName = editingVarName === v.name ? '' : v.name">
          <div class="sg-name tpl-var-name">{{ '{' + '{' + v.name + '}' + '}' }}</div>
          <div class="sg-hint">{{ v.value || t('tpl_vars_empty_value') }}</div>
        </div>
        <Button size="sm" variant="outline" class="min-w-[100px]" @click="removeVar(v.name)">{{
          t('tpl_vars_delete')
        }}</Button>
      </div>
      <div v-if="editingVarName === v.name" class="pwd-change-form">
        <div class="pwd-field">
          <label class="pwd-label">{{ t('tpl_vars_value') }}</label>
          <Input
            v-model="editValue"
            class="sg-input--block"
            :placeholder="t('tpl_vars_value_ph')"
            @keyup.enter="saveEditVar(v.name)"
          />
        </div>
        <div class="pwd-actions">
          <Button class="pwd-btn" @click="saveEditVar(v.name)">{{ t('tpl_vars_save') }}</Button>
          <Button variant="outline" class="pwd-btn" @click="editingVarName = ''">{{ t('cancel_btn') }}</Button>
        </div>
      </div>
    </div>

    <div v-if="tplVarList.length === 0" class="tpl-var-empty">{{ t('tpl_vars_empty') }}</div>

    <div class="sg-row sg-row--clickable" @click="addOpen = !addOpen">
      <div class="sg-label">
        <div class="sg-name">{{ t('tpl_vars_add') }}</div>
        <div class="sg-hint">{{ t('tpl_vars_add_h') }}</div>
      </div>
      <ChevronDown :class="['sg-arrow', { 'sg-arrow--rotated': addOpen }]" />
    </div>
    <div v-if="addOpen" class="pwd-change-form">
      <div class="pwd-field">
        <label class="pwd-label">{{ t('tpl_vars_name') }}</label>
        <Input v-model="newVarName" class="sg-input--block" :placeholder="t('tpl_vars_name_ph')" />
      </div>
      <div class="pwd-field">
        <label class="pwd-label">{{ t('tpl_vars_value') }}</label>
        <Input
          v-model="newVarValue"
          class="sg-input--block"
          :placeholder="t('tpl_vars_value_ph')"
          @keyup.enter="addVar"
        />
      </div>
      <div class="pwd-actions">
        <Button class="pwd-btn" @click="addVar">{{ t('tpl_vars_add') }}</Button>
        <Button
          variant="outline"
          class="pwd-btn"
          @click="
            () => {
              addOpen = false
              newVarName = ''
              newVarValue = ''
              varError = ''
            }
          "
          >{{ t('cancel_btn') }}</Button
        >
      </div>
      <div v-if="varError" class="pwd-error">{{ varError }}</div>
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
  transition: transform 0.2s;
}
.sg-arrow--rotated {
  transform: rotate(180deg);
}
.sg-input--block {
  width: 100%;
  padding-left: 16px !important;
}
.pwd-change-form {
  margin: 4px 0 8px;
  padding: 20px 24px;
  background: var(--bg-hover);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}
.pwd-field {
  margin-bottom: 14px;
  padding-left: 4px;
}
.pwd-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 6px;
  padding-left: 4px;
}
.pwd-actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  padding-left: 4px;
}
.pwd-btn {
  min-width: 100px;
}
.pwd-error {
  color: var(--danger, #ef4444);
  font-size: 12px;
  margin-top: 6px;
}
.tpl-var-block {
  margin-bottom: 2px;
}
.tpl-var-name {
  font-family: var(--font-mono, monospace);
  color: var(--primary);
}
.tpl-var-empty {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 4px 14px 10px;
}
</style>
