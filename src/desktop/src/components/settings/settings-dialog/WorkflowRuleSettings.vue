<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { api } from '@/api/client'
import { Plus, Trash2, Power, Pencil, Check, X } from 'lucide-vue-next'
import CustomSelect from '@/components/ui/select/CustomSelect.vue'
import CustomSelectOption from '@/components/ui/select/CustomSelectOption.vue'

/**
 * WorkflowRuleSettings — 工作流规则引擎管理（任务 #237）
 * 「当…时自动…」：配置规则，新剪贴板条目满足条件时自动执行动作。
 */
interface WorkflowRule {
  id: string
  name: string
  enabled: boolean
  contentType: 'text' | 'image' | 'file' | 'link' | 'code'
  matchMode: 'keyword' | 'regex'
  keywords: string[]
  actionType: 'favorite' | 'archive' | 'tag' | 'move_to_collection'
  actionValue: string | null
  actionApplyTags: string[]
  priority: number
}

const { t } = useI18n()

const rules = ref<WorkflowRule[]>([])
const loading = ref(false)
const error = ref('')

// 新建/编辑表单
const editing = ref<Partial<WorkflowRule> | null>(null)
const isNew = ref(false)
const showForm = ref(false)

const CONTENT_TYPES = ['text', 'image', 'file', 'link', 'code']
const ACTIONS = ['favorite', 'archive', 'tag', 'move_to_collection']

async function loadRules() {
  loading.value = true
  error.value = ''
  try {
    const res = await api<{ items: WorkflowRule[] }>('GET', '/api/workflow-rules')
    if (res.ok && res.data) rules.value = res.data.items || []
    else error.value = res.error || '加载失败'
  } catch (e: any) {
    error.value = e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function startCreate() {
  editing.value = {
    name: '',
    enabled: true,
    contentType: 'text',
    matchMode: 'keyword',
    keywords: [],
    actionType: 'favorite',
    actionValue: '',
    actionApplyTags: [],
    priority: 100,
  }
  isNew.value = true
  showForm.value = true
}

function startEdit(rule: WorkflowRule) {
  editing.value = {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    contentType: rule.contentType,
    matchMode: rule.matchMode,
    keywords: [...(rule.keywords || [])],
    actionType: rule.actionType,
    actionValue: rule.actionValue || '',
    actionApplyTags: [...(rule.actionApplyTags || [])],
    priority: rule.priority ?? 100,
  }
  isNew.value = false
  showForm.value = true
}

function cancelEdit() {
  showForm.value = false
  editing.value = null
}

// 关键词/标签输入（逗号分隔）
const keywordInput = ref('')
const tagsInput = ref('')

function syncInputs() {
  keywordInput.value = (editing.value?.keywords || []).join(', ')
  tagsInput.value = (editing.value?.actionApplyTags || []).join(', ')
}

async function saveRule() {
  if (!editing.value) return
  const name = (editing.value.name || '').trim()
  if (!name) {
    error.value = t('wf_name_required') || '规则名称不能为空'
    return
  }
  // 解析关键词
  const keywords = keywordInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  if (keywords.length === 0) {
    error.value = t('wf_keyword_required') || '至少需要一个关键词'
    return
  }
  const actionApplyTags = tagsInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  const body = {
    name,
    enabled: editing.value.enabled !== false,
    contentType: editing.value.contentType,
    matchMode: editing.value.matchMode,
    keywords,
    actionType: editing.value.actionType,
    actionValue: editing.value.actionType === 'tag' ? (actionApplyTags[0] || editing.value.actionValue || '') : editing.value.actionValue || null,
    actionApplyTags: editing.value.actionType === 'tag' ? actionApplyTags : [],
    priority: Number(editing.value.priority) || 100,
  }
  try {
    if (isNew.value) {
      const res = await api<{ id: string }>('POST', '/api/workflow-rules', body)
      if (!res.ok) { error.value = res.error || '创建失败'; return }
    } else {
      const res = await api<{ ok: boolean }>('PUT', `/api/workflow-rules/${editing.value.id}`, body)
      if (!res.ok) { error.value = res.error || '更新失败'; return }
    }
    showForm.value = false
    editing.value = null
    await loadRules()
  } catch (e: any) {
    error.value = e?.message || '保存失败'
  }
}

async function deleteRule(id: string) {
  try {
    const res = await api<{ ok: boolean }>('DELETE', `/api/workflow-rules/${id}`)
    if (res.ok) await loadRules()
    else error.value = res.error || '删除失败'
  } catch (e: any) {
    error.value = e?.message || '删除失败'
  }
}

async function toggleRule(rule: WorkflowRule) {
  try {
    const res = await api<{ enabled: boolean }>('PATCH', `/api/workflow-rules/${rule.id}/toggle`)
    if (res.ok) {
      rule.enabled = res.data?.enabled ?? !rule.enabled
    } else {
      error.value = res.error || '切换失败'
    }
  } catch (e: any) {
    error.value = e?.message || '切换失败'
  }
}

function typeLabel(type: string) {
  const m: Record<string, string> = { text: '文本', image: '图片', file: '文件', link: '链接', code: '代码' }
  return m[type] || type
}
function actionLabel(a: string) {
  const m: Record<string, string> = { favorite: '自动收藏', archive: '自动归档', tag: '自动打标签', move_to_collection: '移入收藏夹' }
  return m[a] || a
}

onMounted(loadRules)
</script>

<template>
  <div class="wf-settings">
    <div class="wf-header">
      <div class="wf-title-row">
        <h3 class="wf-title">{{ t('wf_title') || '自动规则（工作流）' }}</h3>
        <button class="wf-add-btn" @click="startCreate">
          <Plus :size="14" /> {{ t('wf_add') || '新建规则' }}
        </button>
      </div>
      <p class="wf-desc">{{ t('wf_desc') || '当复制的内容满足条件时自动执行动作（收藏/归档/打标签/移入收藏夹）。' }}</p>
    </div>

    <div v-if="error" class="wf-error">{{ error }}</div>

    <!-- 新建/编辑表单 -->
    <div v-if="showForm && editing" class="wf-form">
      <div class="wf-form-grid">
        <label class="wf-field wf-field--full">
          <span class="wf-label">{{ t('wf_name') || '规则名称' }}</span>
          <input v-model="editing.name" class="wf-input" :placeholder="t('wf_name_ph') || '例如：复制代码自动收藏'" />
        </label>

        <label class="wf-field">
          <span class="wf-label">{{ t('wf_content_type') || '内容类型' }}</span>
          <CustomSelect :model-value="editing!.contentType" @update:model-value="(v: string) => (editing!.contentType = v as WorkflowRule['contentType'])">
            {{ typeLabel(editing!.contentType as string) }}
            <template #options>
              <CustomSelectOption
                v-for="ct in CONTENT_TYPES"
                :key="ct"
                :value="ct"
                :selected="editing!.contentType === ct"
                @select="(v: string) => (editing!.contentType = v as WorkflowRule['contentType'])"
              >{{ typeLabel(ct) }}</CustomSelectOption>
            </template>
          </CustomSelect>
        </label>

        <label class="wf-field">
          <span class="wf-label">{{ t('wf_match_mode') || '匹配方式' }}</span>
          <CustomSelect :model-value="editing!.matchMode" @update:model-value="(v: string) => (editing!.matchMode = v as WorkflowRule['matchMode'])">
            {{ editing!.matchMode === 'keyword' ? (t('wf_mode_keyword') || '关键词') : (t('wf_mode_regex') || '正则') }}
            <template #options>
              <CustomSelectOption
                value="keyword"
                :selected="editing!.matchMode === 'keyword'"
                @select="(v: string) => (editing!.matchMode = v as WorkflowRule['matchMode'])"
              >{{ t('wf_mode_keyword') || '关键词' }}</CustomSelectOption>
              <CustomSelectOption
                value="regex"
                :selected="editing!.matchMode === 'regex'"
                @select="(v: string) => (editing!.matchMode = v as WorkflowRule['matchMode'])"
              >{{ t('wf_mode_regex') || '正则' }}</CustomSelectOption>
            </template>
          </CustomSelect>
        </label>

        <label class="wf-field wf-field--full">
          <span class="wf-label">{{ t('wf_keywords') || '关键词 / 正则（逗号分隔）' }}</span>
          <input v-model="keywordInput" class="wf-input" :placeholder="editing.matchMode === 'regex' ? '例如：^\\d{6}$' : '例如：python, todo, 合同'" @focus="syncInputs" />
        </label>

        <label class="wf-field">
          <span class="wf-label">{{ t('wf_action') || '动作' }}</span>
          <CustomSelect :model-value="editing!.actionType" @update:model-value="(v: string) => { editing!.actionType = v as WorkflowRule['actionType']; syncInputs() }">
            {{ actionLabel(editing!.actionType as string) }}
            <template #options>
              <CustomSelectOption
                v-for="a in ACTIONS"
                :key="a"
                :value="a"
                :selected="editing!.actionType === a"
                @select="(v: string) => { editing!.actionType = v as WorkflowRule['actionType']; syncInputs() }"
              >{{ actionLabel(a) }}</CustomSelectOption>
            </template>
          </CustomSelect>
        </label>

        <label v-if="editing.actionType === 'move_to_collection'" class="wf-field">
          <span class="wf-label">{{ t('wf_collection') || '收藏夹名' }}</span>
          <input v-model="editing.actionValue" class="wf-input" placeholder="例如：代码" />
        </label>

        <label v-if="editing.actionType === 'tag'" class="wf-field wf-field--full">
          <span class="wf-label">{{ t('wf_tags') || '要打的标签（逗号分隔）' }}</span>
          <input v-model="tagsInput" class="wf-input" placeholder="例如：todo, 工作, 重要" @focus="syncInputs" />
        </label>

        <label class="wf-field">
          <span class="wf-label">{{ t('wf_priority') || '优先级' }}</span>
          <input v-model.number="editing.priority" type="number" class="wf-input" min="0" max="1000" />
        </label>

        <label class="wf-field wf-field--full wf-check">
          <input v-model="editing.enabled" type="checkbox" />
          <span>{{ t('wf_enabled') || '启用此规则' }}</span>
        </label>
      </div>

      <div class="wf-form-actions">
        <button class="wf-btn wf-btn--primary" @click="saveRule">
          <Check :size="13" /> {{ t('wf_save') || '保存' }}
        </button>
        <button class="wf-btn" @click="cancelEdit">
          <X :size="13" /> {{ t('wf_cancel') || '取消' }}
        </button>
      </div>
    </div>

    <!-- 规则列表 -->
    <div v-if="loading" class="wf-empty">{{ t('loading') || '加载中…' }}</div>
    <div v-else-if="!rules.length && !showForm" class="wf-empty">
      {{ t('wf_empty') || '还没有规则。点击「新建规则」创建第一个。' }}
    </div>

    <div v-else class="wf-list">
      <div v-for="rule in rules" :key="rule.id" class="wf-item" :class="{ disabled: !rule.enabled }">
        <div class="wf-item-main">
          <div class="wf-item-head">
            <span class="wf-item-name">{{ rule.name }}</span>
            <span class="wf-item-badge">{{ typeLabel(rule.contentType) }}</span>
            <span class="wf-item-badge wf-item-badge--action">{{ actionLabel(rule.actionType) }}</span>
          </div>
          <div class="wf-item-detail">
            {{ rule.matchMode === 'regex' ? '正则' : '关键词' }}：{{ rule.keywords.join(', ') }}
            <template v-if="rule.actionType === 'move_to_collection'"> → {{ rule.actionValue }}</template>
            <template v-if="rule.actionType === 'tag'"> → {{ rule.actionApplyTags.join(', ') }}</template>
          </div>
        </div>
        <div class="wf-item-actions">
          <button class="wf-icon-btn" :class="{ on: rule.enabled }" :title="rule.enabled ? t('wf_disable') || '停用' : t('wf_enable') || '启用'" @click="toggleRule(rule)">
            <Power :size="13" />
          </button>
          <button class="wf-icon-btn" :title="t('wf_edit') || '编辑'" @click="startEdit(rule)">
            <Pencil :size="13" />
          </button>
          <button class="wf-icon-btn wf-icon-btn--danger" :title="t('wf_delete') || '删除'" @click="deleteRule(rule.id)">
            <Trash2 :size="13" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-settings { padding: 4px 2px; }
.wf-header { margin-bottom: 14px; }
.wf-title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.wf-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin: 0; }
.wf-add-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 5px 12px; border-radius: 6px;
  border: 1px solid var(--accent); color: var(--accent);
  background: transparent; font-size: 12.5px; cursor: pointer;
  transition: all 0.15s;
}
.wf-add-btn:hover { background: var(--accent-bg); }
.wf-desc { font-size: 12px; color: var(--text-secondary); margin: 6px 0 0; line-height: 1.6; }
.wf-error { color: var(--danger); font-size: 12.5px; padding: 8px 0; }
.wf-form {
  border: 1px solid var(--border-default); border-radius: 10px;
  padding: 14px; margin-bottom: 14px; background: var(--bg-surface);
}
.wf-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.wf-field { display: flex; flex-direction: column; gap: 4px; }
.wf-field :deep(.custom-select) { width: 100%; }
.wf-field--full { grid-column: 1 / -1; }
.wf-label { font-size: 12px; color: var(--text-secondary); }
.wf-input {
  font-size: 12.5px; padding: 6px 10px;
  border: 1px solid var(--border-default); border-radius: 6px;
  background: var(--bg-input); color: var(--text-primary); outline: none;
}
.wf-input:focus { border-color: var(--accent); }
.wf-check { flex-direction: row; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-primary); }
.wf-form-actions { display: flex; gap: 8px; margin-top: 14px; }
.wf-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 16px; border-radius: 6px; font-size: 12.5px;
  border: 1px solid var(--border-default); background: transparent; cursor: pointer;
  color: var(--text-primary);
}
.wf-btn--primary { background: var(--accent); border-color: var(--accent); color: var(--accent-foreground); }
.wf-empty { color: var(--text-tertiary); font-size: 12.5px; padding: 20px 0; text-align: center; }
.wf-list { display: flex; flex-direction: column; gap: 8px; }
.wf-item {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border: 1px solid var(--border-subtle);
  border-radius: 8px; background: var(--bg-surface);
  transition: opacity 0.15s;
}
.wf-item.disabled { opacity: 0.55; }
.wf-item-main { flex: 1; min-width: 0; }
.wf-item-head { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
.wf-item-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.wf-item-badge {
  font-size: 10.5px; padding: 1px 6px; border-radius: 4px;
  background: var(--bg-hover); color: var(--text-secondary);
}
.wf-item-badge--action { background: var(--accent-bg); color: var(--accent); }
.wf-item-detail {
  font-size: 11.5px; color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wf-item-actions { display: flex; gap: 2px; flex-shrink: 0; }
.wf-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 5px;
  border: none; background: transparent; color: var(--text-secondary);
  cursor: pointer; transition: all 0.12s;
}
.wf-icon-btn:hover { background: var(--bg-hover); }
.wf-icon-btn.on { color: var(--success); }
.wf-icon-btn--danger:hover { color: var(--danger); background: rgba(239, 68, 68, 0.08); }
</style>
