<script setup lang="ts">
import { ref, computed, watch, onMounted, reactive } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useTemplateStore } from '@/stores/templateStore'
import { useTemplateVariableStore } from '@/stores/templateVariableStore'
import type { ClipboardTemplate } from '@/types'
import { FileText, Plus, SearchX, Search, Sparkles, Pencil, Trash2, Zap } from 'lucide-vue-next'
import TemplateList from './TemplateList.vue'
import TemplateEditorDialog from './TemplateEditorDialog.vue'
import VariableFillDialog from './VariableFillDialog.vue'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import Button from '@/components/ui/button/Button.vue'

const { t, tf } = useI18n()
const store = useTemplateStore()
const props = defineProps<{ aiEnabled?: boolean }>()

// 原型「AI 生成模板」：呼出 AI 面板按场景起草
function aiGenerate() {
  window.dispatchEvent(new CustomEvent('clipsync:toggle-ai'))
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent('clipsync:ai-send-message', {
        detail: {
          content: tf(
            'tpl_ai_generate_prompt',
            '生成模板：根据我的高频使用场景起草新模板，正文用 {{变量}} 作占位符。',
          ),
        },
      }),
    )
  }, 120)
}

// v1 原型排版：左列表 + 右详情（选中即看，编辑仍走弹窗）
const selectedId = ref<string | null>(null)
const selected = computed(() => store.templates.find((tpl) => tpl.id === selectedId.value) || null)

/* {{变量}} 高亮预览（原型 .var-hl） */
function esc(raw: string): string {
  return String(raw).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function hlVars(raw: string): string {
  return esc(raw.replace(/\s+/g, ' ').trim()).replace(
    /\{\{\s*([^:{}]+?)\s*\}\}/g,
    (_m, k) => `<span class="var-hl">{{${String(k).trim()}}}</span>`,
  )
}
function extractVars(tpl: ClipboardTemplate): string[] {
  return [...new Set((tpl.content.match(/\{\{\s*([^:{}]+?)\s*\}\}/g) || []).map((m) => m.replace(/[{}]/g, '').trim()))]
}
function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    const p = (n: number) => (n < 10 ? '0' + n : String(n))
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  } catch {
    return ''
  }
}
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

watch(
  filtered,
  (list) => {
    if (selectedId.value && !list.some((tpl) => tpl.id === selectedId.value)) selectedId.value = list[0]?.id ?? null
    if (!selectedId.value) selectedId.value = list[0]?.id ?? null
  },
  { immediate: true },
)


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
    selectedId.value = editing.value.id
  } else {
    const created = await store.create(payload.name, payload.content)
    if (created?.id) selectedId.value = created.id
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
    <div class="page-inner">
      <!-- v2 原型页头：标题 + 副题 + 新建 -->
      <div class="page-head">
        <div>
          <div class="page-eyebrow">Template Library</div>
          <div class="page-title page-title--big">{{ t('nav_templates') }}</div>
          <div class="page-sub">{{ tf('page_sub_tpl', '带变量占位符的文本骨架 · 填充变量后一键渲染复制') }}</div>
        </div>
        <div class="page-acts">
          <div class="pl-search tpl-search">
            <Search :size="14" />
            <input v-model="search" type="text" :placeholder="t('tpl_search_ph', '搜索模板…')" />
          </div>
          <button v-if="props.aiEnabled" type="button" class="pl-btn" @click="aiGenerate">
            <Sparkles :size="14" /><span>{{ tf('tpl_ai_generate', 'AI 生成模板') }}</span>
          </button>
          <button type="button" class="pl-btn pl-btn--acc" @click="onNew">
            <Plus :size="14" /><span>{{ t('tpl_new_btn', '新建模板') }}</span>
          </button>
        </div>
      </div>

    <div v-if="store.loading && !store.initialized" class="tpl-loading">
      {{ t('templates_loading') }}
    </div>

    <template v-else>
      <!-- v1 原型排版：左列表 + 右详情 -->
      <div v-if="filtered.length" class="tpl-split">
        <div class="tpl-side">
          <div
            v-for="tpl in filtered"
            :key="tpl.id"
            :class="['tpl-side-item', { active: selectedId === tpl.id }]"
            @click="selectedId = tpl.id"
          >
            <div class="tpl-side-name">{{ tpl.name }}</div>
            <div class="tpl-side-meta">{{ tf('tpl_updated_ago', '更新于 {ago}', { ago: fmtTime(tpl.updated_at) }) }}</div>
          </div>
        </div>

        <div class="tpl-detail">
          <template v-if="selected">
            <div class="tpl-detail-head">
              <div class="tpl-detail-name">{{ selected.name }}</div>
              <div class="tpl-detail-acts">
                <button type="button" class="pl-btn pl-btn--sm pl-btn--acc" @click="onInsert(selected)">
                  <Zap :size="12" />{{ t('tpl_use_btn', '使用') }}
                </button>
                <button type="button" class="pl-icon-btn" :title="t('edit', '编辑')" @click="onEdit(selected)">
                  <Pencil :size="13" />
                </button>
                <button type="button" class="pl-icon-btn tpl-del" :title="t('delete')" @click="deleteTarget = selected">
                  <Trash2 :size="13" />
                </button>
              </div>
            </div>
            <div class="tpl-detail-body" v-html="hlVars(selected.content)"></div>
            <div v-if="extractVars(selected).length" class="tpl-detail-vars">
              <span v-for="v in extractVars(selected)" :key="v" class="var-chip"
                >{{ '{' + '{' + v + '}' + '}' }}</span
              >
            </div>
          </template>
          <div v-else class="tpl-detail-empty">
            <FileText :size="28" :stroke-width="1.5" />
            <div>{{ tf('tpl_pick_hint', '从左侧选择一个模板查看详情') }}</div>
          </div>
        </div>
      </div>

      <div v-else-if="store.templates.length" class="tpl-empty">
        <SearchX :size="40" :stroke-width="1.5" />
        <div class="tpl-empty-title">{{ t('templates_no_match') }}</div>
      </div>

      <div v-else class="tpl-empty">
        <FileText :size="40" :stroke-width="1.5" />
        <div class="tpl-empty-title">{{ t('templates_empty_title') }}</div>
        <div class="tpl-empty-desc">{{ t('templates_empty_desc') }}</div>
        <Button size="default" class="tpl-empty-btn px-6 min-w-[120px]" @click="onNew">
          <Plus :size="16" /> {{ t('templates_empty_new') }}
        </Button>
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
  </div>
</template>

<style scoped>
.tpl-view {
  height: 100%;
  overflow-y: auto;
  box-sizing: border-box;
}
.tpl-view .page-inner {
  max-width: 1080px;
  margin: 0 auto;
  padding: 20px 28px 48px;
}
.tpl-search {
  width: 220px;
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

<style scoped>
/* v1 原型排版：左列表 + 右详情 */
.tpl-split {
  display: grid;
  grid-template-columns: minmax(220px, 300px) 1fr;
  gap: 16px;
  align-items: start;
}
.tpl-side {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tpl-side-item {
  padding: 12px 14px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card, none);
  cursor: pointer;
  transition:
    border-color 160ms var(--ease),
    box-shadow 160ms var(--ease);
}
.tpl-side-item:hover {
  border-color: var(--border-strong, #cbd0d8);
}
.tpl-side-item.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.tpl-side-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tpl-side-meta {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-tertiary);
}
.tpl-detail {
  min-height: 320px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card, none);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
}
.tpl-detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 12px;
}
.tpl-detail-name {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tpl-detail-acts {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.tpl-detail-body {
  flex: 1;
  min-height: 120px;
  font-family: var(--font-content);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-all;
}
.tpl-detail-vars {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--border-subtle);
  margin-top: 12px;
}
.tpl-detail-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-tertiary);
  font-size: 12.5px;
  padding: 60px 0;
}
.tpl-del:hover {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
}
</style>
