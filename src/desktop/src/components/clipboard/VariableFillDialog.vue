<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Input from '@/components/ui/input/Input.vue'
import Label from '@/components/ui/label/Label.vue'
import Button from '@/components/ui/button/Button.vue'
import Checkbox from '@/components/ui/checkbox/Checkbox.vue'
import { useTemplateVariableStore } from '@/stores/templateVariableStore'

interface VarDef {
  name: string
  defaultValue: string
}

const props = defineProps<{ open: boolean; defs: VarDef[] }>()
const emit = defineEmits<{ close: []; confirm: [values: Record<string, string>, remember: string[]] }>()

const { t } = useI18n()
const varStore = useTemplateVariableStore()
const values = ref<Record<string, string>>({})
const remember = ref<Record<string, boolean>>({})

// 存在至少一个变量被全局默认值预填时，提示用户
const hasGlobalPrefill = computed(() => props.defs.some((d) => (varStore.variables[d.name] ?? '') !== ''))

watch(
  () => [props.open, props.defs] as const,
  ([open]) => {
    if (open) {
      const initV: Record<string, string> = {}
      const initR: Record<string, boolean> = {}
      props.defs.forEach((d) => {
        const g = varStore.variables[d.name] ?? ''
        initV[d.name] = g !== '' ? g : d.defaultValue
        initR[d.name] = true
      })
      values.value = initV
      remember.value = initR
    }
  },
  { immediate: true },
)

function onConfirm() {
  const remembered = props.defs.filter((d) => remember.value[d.name]).map((d) => d.name)
  emit('confirm', { ...values.value }, remembered)
  emit('close')
}
</script>

<template>
  <ModalDialog :open="open" :title="t('templates_fill_title')" @close="emit('close')">
    <p class="tpl-fill-desc">{{ t('templates_fill_desc') }}</p>
    <p v-if="hasGlobalPrefill" class="tpl-fill-hint">{{ t('templates_var_global_hint') }}</p>
    <div class="tpl-fill-list">
      <div v-for="d in defs" :key="d.name" class="tpl-field">
        <Label :for="`fill-${d.name}`">
          <span class="tpl-var-name">{{ '{' + '{' + d.name + '}' + '}' }}</span>
        </Label>
        <Input
          :id="`fill-${d.name}`"
          v-model="values[d.name]"
          :placeholder="t('templates_var_ph')"
          class="!p-4 leading-6"
        />
        <label class="tpl-remember">
          <Checkbox
            :model-value="!!remember[d.name]"
            @update:model-value="(v: boolean | 'indeterminate') => (remember[d.name] = v === true)"
          />
          <span>{{ t('templates_remember') }}</span>
        </label>
      </div>
    </div>

    <template #footer>
      <Button variant="outline" size="default" class="px-6 min-w-[100px] rounded-md" @click="emit('close')">{{
        t('templates_cancel')
      }}</Button>
      <Button size="default" class="px-6 min-w-[100px] rounded-md" @click="onConfirm">{{
        t('templates_insert')
      }}</Button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.tpl-fill-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}
.tpl-fill-hint {
  font-size: 12px;
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 8%, transparent);
  border-radius: var(--radius-md);
  padding: 8px 12px;
  margin-bottom: 16px;
  line-height: 1.5;
}
.tpl-fill-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.tpl-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tpl-var-name {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--primary);
}
.tpl-remember {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  margin-top: 2px;
}
</style>
