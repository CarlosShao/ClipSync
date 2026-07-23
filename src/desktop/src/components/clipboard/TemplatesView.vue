<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useTemplateStore } from '@/stores/templateStore'
import { useTemplateVariableStore } from '@/stores/templateVariableStore'
import type { ClipboardTemplate } from '@/types'
import { FileText, Plus, SearchX } from 'lucide-vue-next'
import TemplateToolbar from './TemplateToolbar.vue'
import TemplateList from './TemplateList.vue'
import TemplateEditorDialog from './TemplateEditorDialog.vue'
import VariableFillDialog from './VariableFillDialog.vue'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import Button from '@/components/ui/button/Button.vue'

const { t } = useI18n()
const store = useTemplateStore()

const search = ref('')
const editorOpen = ref(false)
const editing = ref<ClipboardTemplate | null>(null)
const fillState = reactive<{
  open: boolean
  tpl: ClipboardTemplate | null
  defs: { name: string; defaultValue: string }[]
}>({ open: false, tpl: null, defs: [] })
const deleteTarget = ref<ClipboardTemplate | null>(null)

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return store.templates
  return store.templates.filter((tpl) => tpl.name.toLowerCase().includes(q) || tpl.content.toLowerCase().includes(q))
})

onMounted(() => {
  if (!store.initialized) store.fetchTemplates()
})

function onNew() {
  editing.value = null
  editorOpen.value = true
}

function onEdit(tpl: ClipboardTemplate) {
  editing.value = tpl
  editorOpen.value = true
}

async function onEditorSave(payload: { name: string; content: string }) {
  if (editing.value) {
    await store.update(editing.value.id, payload)
  } else {
    await store.create(payload.name, payload.content)
  }
  editorOpen.value = false
  editing.value = null
}

function onInsert(tpl: ClipboardTemplate) {
  const defs = store.userVariableDefs(tpl)
  if (defs.length > 0) {
    fillState.tpl = tpl
    fillState.defs = defs
    fillState.open = true
  } else {
    store.insertTemplate(tpl)
  }
}

async function onFillConfirm(values: Record<string, string>, remember: string[]) {
  // 把勾选「记住」且非空的输入回写到全局变量存储（下次自动预填）
  const varStore = useTemplateVariableStore()
  for (const name of remember) {
    const val = values[name]
    if (val !== undefined && val !== '') {
      await varStore.setVariable(name, val)
    }
  }
  if (fillState.tpl) {
    await store.insertTemplate(fillState.tpl, values)
  }
  fillState.open = false
  fillState.tpl = null
  fillState.defs = []
}

async function confirmDelete() {
  if (deleteTarget.value) {
    await store.remove(deleteTarget.value.id)
    deleteTarget.value = null
  }
}
</script>

<template>
  <div class="tpl-view">
    <TemplateToolbar v-model:search="search" @new="onNew" />

    <div v-if="store.loading && !store.initialized" class="tpl-loading">
      {{ t('templates_loading') }}
    </div>

    <template v-else>
      <TemplateList
        v-if="filtered.length"
        :templates="filtered"
        @edit="onEdit"
        @insert="onInsert"
        @delete="(tpl) => (deleteTarget = tpl)"
      />

      <div v-else-if="!store.templates.length" class="tpl-empty">
        <FileText :size="40" :stroke-width="1.5" />
        <div class="tpl-empty-title">{{ t('templates_empty_title') }}</div>
        <div class="tpl-empty-desc">{{ t('templates_empty_desc') }}</div>
        <Button size="default" class="tpl-empty-btn px-6 min-w-[120px]" @click="onNew">
          <Plus :size="16" /> {{ t('templates_empty_new') }}
        </Button>
      </div>

      <div v-else class="tpl-empty">
        <SearchX :size="40" :stroke-width="1.5" />
        <div class="tpl-empty-title">{{ t('templates_no_match') }}</div>
      </div>
    </template>

    <TemplateEditorDialog :open="editorOpen" :editing="editing" @close="editorOpen = false" @save="onEditorSave" />

    <VariableFillDialog
      :open="fillState.open"
      :defs="fillState.defs"
      @close="fillState.open = false"
      @confirm="onFillConfirm"
    />

    <ConfirmDialog
      :open="!!deleteTarget"
      :title="t('templates_delete_title')"
      :message="t('templates_delete_msg')"
      :confirm-text="t('templates_delete_btn')"
      @update:open="(v) => !v && (deleteTarget = null)"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.tpl-view {
  width: 100%;
  padding: 4px 4px 40px;
  box-sizing: border-box;
}
.tpl-loading {
  padding: 40px;
  text-align: center;
  color: var(--text-muted);
  font-size: 14px;
}
.tpl-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 72px 24px;
  color: var(--text-muted);
  text-align: center;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
}
.tpl-empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-secondary);
}
.tpl-empty-desc {
  font-size: 13px;
  max-width: 360px;
  line-height: 1.6;
}
.tpl-empty-btn {
  margin-top: 10px;
}
</style>
