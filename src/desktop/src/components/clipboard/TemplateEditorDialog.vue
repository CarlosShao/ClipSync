<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Input from '@/components/ui/input/Input.vue'
import Label from '@/components/ui/label/Label.vue'
import Button from '@/components/ui/button/Button.vue'
import { Textarea } from '@/components/ui/textarea'
import type { ClipboardTemplate } from '@/types'
import { extractVariables, isBuiltinVar, BUILTIN_VARS } from '@/stores/templateStore'

const props = defineProps<{ open: boolean; editing: ClipboardTemplate | null }>()
const emit = defineEmits<{ close: []; save: [payload: { name: string; content: string }] }>()

const { t } = useI18n()
const toast = useSonner()

const name = ref('')
const content = ref('')

watch(
  () => [props.open, props.editing] as const,
  ([open]) => {
    if (open) {
      name.value = props.editing?.name || ''
      content.value = props.editing?.content || ''
    }
  },
  { immediate: true },
)

const vars = computed(() => extractVariables(content.value))

function insertBuiltin(v: string) {
  content.value += (content.value && !content.value.endsWith('\n') ? '\n' : '') + `{{${v}}}`
}

function onSave() {
  const trimmed = name.value.trim()
  if (!trimmed) {
    toast.show(t('templates_name_required'), 'error')
    return
  }
  emit('save', { name: trimmed, content: content.value })
  emit('close')
}
</script>

<template>
  <ModalDialog :open="open" :title="editing ? t('templates_edit_title') : t('templates_create_title')" @close="emit('close')">
    <div class="tpl-form">
      <div class="tpl-field">
        <Label for="tpl-name">{{ t('templates_name') }}</Label>
        <Input id="tpl-name" v-model="name" :placeholder="t('templates_name_ph')" />
      </div>

      <div class="tpl-field">
        <Label for="tpl-content">{{ t('templates_content') }}</Label>
        <Textarea id="tpl-content" v-model="content" :placeholder="t('templates_content_ph')" class="tpl-content" />
        <div class="tpl-builtin-bar">
          <span class="tpl-builtin-label">{{ t('templates_builtin_label') }}：</span>
          <button
            v-for="v in BUILTIN_VARS"
            :key="v"
            type="button"
            class="tpl-builtin-btn"
            :title="`插入 {{${v}}}`"
            @click="insertBuiltin(v)"
          >{{ '{{' + v + '}}' }}</button>
        </div>
      </div>

      <div v-if="vars.length" class="tpl-detected">
        <span class="tpl-detected-label">{{ t('templates_detected_vars') }}：</span>
        <span
          v-for="v in vars"
          :key="v"
          :class="['var-chip', isBuiltinVar(v) ? 'var-builtin' : 'var-user']"
        >{{ '{{' + v + '}}' }}</span>
      </div>
    </div>

    <template #footer>
      <Button variant="ghost" @click="emit('close')">{{ t('templates_cancel') }}</Button>
      <Button @click="onSave">{{ t('templates_save') }}</Button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.tpl-form { display: flex; flex-direction: column; gap: 18px; }
.tpl-field { display: flex; flex-direction: column; gap: 8px; }
.tpl-content { min-height: 160px; font-family: var(--font-mono, monospace); font-size: 13px; }
.tpl-builtin-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.tpl-builtin-label { font-size: 12px; color: var(--text-muted); }
.tpl-builtin-btn {
  font-family: var(--font-mono, monospace); font-size: 12px; cursor: pointer;
  padding: 3px 8px; border-radius: 6px; border: 1px solid var(--border-default);
  background: var(--bg-surface); color: var(--text-secondary); transition: all 0.12s;
}
.tpl-builtin-btn:hover { border-color: var(--primary); color: var(--primary); }
.tpl-detected { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding-top: 4px; }
.tpl-detected-label { font-size: 12px; color: var(--text-muted); }
.var-chip { font-family: var(--font-mono, monospace); font-size: 11px; padding: 2px 7px; border-radius: 6px; border: 1px solid transparent; }
.var-builtin { background: color-mix(in srgb, var(--primary) 12%, transparent); color: var(--primary); border-color: color-mix(in srgb, var(--primary) 25%, transparent); }
.var-user { background: var(--bg-hover); color: var(--text-secondary); border-color: var(--border-default); }
</style>
