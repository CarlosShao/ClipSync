<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Input from '@/components/ui/input/Input.vue'
import Label from '@/components/ui/label/Label.vue'
import Button from '@/components/ui/button/Button.vue'

const props = defineProps<{ open: boolean; variables: string[] }>()
const emit = defineEmits<{ close: []; confirm: [values: Record<string, string>] }>()

const { t } = useI18n()
const values = ref<Record<string, string>>({})

watch(
  () => [props.open, props.variables] as const,
  ([open]) => {
    if (open) {
      const init: Record<string, string> = {}
      props.variables.forEach((v) => (init[v] = ''))
      values.value = init
    }
  },
  { immediate: true },
)

function onConfirm() {
  emit('confirm', { ...values.value })
  emit('close')
}
</script>

<template>
  <ModalDialog :open="open" :title="t('templates_fill_title')" @close="emit('close')">
    <p class="tpl-fill-desc">{{ t('templates_fill_desc') }}</p>
    <div class="tpl-fill-list">
      <div v-for="v in variables" :key="v" class="tpl-field">
        <Label :for="`fill-${v}`">
          <span class="tpl-var-name">{{ '{' + '{' + v + '}' + '}' }}</span>
        </Label>
        <Input :id="`fill-${v}`" v-model="values[v]" :placeholder="t('templates_var_ph')" />
      </div>
    </div>

    <template #footer>
      <Button variant="ghost" @click="emit('close')">{{ t('templates_cancel') }}</Button>
      <Button @click="onConfirm">{{ t('templates_insert') }}</Button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.tpl-fill-desc { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }
.tpl-fill-list { display: flex; flex-direction: column; gap: 14px; }
.tpl-field { display: flex; flex-direction: column; gap: 6px; }
.tpl-var-name { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--primary); }
</style>
