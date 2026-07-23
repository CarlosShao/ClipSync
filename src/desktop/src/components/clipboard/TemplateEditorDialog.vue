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
import { useTemplateVariableStore } from '@/stores/templateVariableStore'

const props = defineProps<{ open: boolean; editing: ClipboardTemplate | null }>()
const emit = defineEmits<{ close: []; save: [payload: { name: string; content: string }] }>()

const { t } = useI18n()
const toast = useSonner()
const varStore = useTemplateVariableStore()

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
const globalVars = computed(() => varStore.list())

function insertVar(v: string) {
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
  <ModalDialog
    :open="open"
    :title="editing ? t('templates_edit_title') : t('templates_create_title')"
    @close="emit('close')"
  >
    <div class="tpl-form">
      <div class="tpl-field">
        <Label for="tpl-name">{{ t('templates_name') }}</Label>
        <Input id="tpl-name" v-model="name" :placeholder="t('templates_name_ph')" class="!p-4 leading-6" />
      </div>

      <div class="tpl-field">
        <Label for="tpl-content">{{ t('templates_content') }}</Label>
        <Textarea
          id="tpl-content"
          v-model="content"
          :placeholder="t('templates_content_ph')"
          class="tpl-content min-h-[180px] !p-6 leading-relaxed"
        />
        <p class="tpl-var-help">{{ t('templates_var_help') }}</p>
        <div class="tpl-builtin-bar">
          <span class="tpl-builtin-label">{{ t('templates_builtin_label') }}：</span>
          <button
            v-for="v in BUILTIN_VARS"
            :key="v"
            type="button"
            class="tpl-builtin-btn"
            :title="`插入 {{${v}}}`"
            @click="insertVar(v)"
          >
            {{ '{' + '{' + v + '}' + '}' }}
          </button>
        </div>
        <div v-if="globalVars.length" class="tpl-builtin-bar">
          <span class="tpl-builtin-label">{{ t('templates_global_var_label') }}：</span>
          <button
            v-for="gv in globalVars"
            :key="gv.name"
            type="button"
            class="tpl-builtin-btn"
            :title="`插入 {{${gv.name}}}`"
            @click="insertVar(gv.name)"
          >
            {{ '{' + '{' + gv.name + '}' + '}' }}
          </button>
        </div>
      </div>

      <div v-if="vars.length" class="tpl-detected">
        <span class="tpl-detected-label">{{ t('templates_detected_vars') }}：</span>
        <span v-for="v in vars" :key="v" :class="['var-chip', isBuiltinVar(v) ? 'var-builtin' : 'var-user']">{{
          '{' + '{' + v + '}' + '}'
        }}</span>
      </div>
    </div>

    <template #footer>
      <Button variant="outline" size="default" class="px-6 min-w-[100px] rounded-md" @click="emit('close')">{{
        t('templates_cancel')
      }}</Button>
      <Button size="default" class="px-6 min-w-[100px] rounded-md" @click="onSave">{{ t('templates_save') }}</Button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.tpl-form {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.tpl-field {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tpl-content {
  min-height: 180px;
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  padding: 24px;
}
.tpl-builtin-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.tpl-builtin-label {
  font-size: 12px;
  color: var(--text-muted);
}
.tpl-var-help {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
  margin: 0;
}
.tpl-builtin-btn {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  cursor: pointer;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  transition: all 0.12s;
}
.tpl-builtin-btn:hover {
  border-color: var(--primary);
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 5%, transparent);
}
.tpl-detected {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: 4px;
}
.tpl-detected-label {
  font-size: 12px;
  color: var(--text-muted);
}
.var-chip {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 8px;
  border: 1px solid transparent;
}
.var-builtin {
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  color: var(--primary);
  border-color: color-mix(in srgb, var(--primary) 25%, transparent);
}
.var-user {
  background: var(--bg-hover);
  color: var(--text-secondary);
  border-color: var(--border-default);
}
</style>
