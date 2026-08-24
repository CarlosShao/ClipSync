<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { getMemories, createMemory, updateMemory, deleteMemory, type AiMemory } from '@/api/ai'
import Button from '@/components/ui/button/Button.vue'
import Switch from '@/components/ui/switch/Switch.vue'
import { X, Plus, Trash2, Pencil, ChevronRight } from 'lucide-vue-next'

/**
 * AiMemoryPanel — 长程记忆面板（UI-E 两态复用）。
 *
 * variant='peek'  ：Inspector 内速览态——紧凑列表（最近 N 条 + 开关状态摘要），
 *                   无增删改操作；点击条目或「管理记忆」上抛 open-manage 由宿主
 *                   （AISidebar）打开完整管理弹层。
 * variant='manage'：独立管理弹层态——完整增删改 + 长程记忆开关（原有能力不变）。
 *
 * 同一组件、同一数据源（getMemories），仅按 variant 切换渲染密度与操作集。
 */
const props = withDefaults(
  defineProps<{
    open?: boolean
    memoryEnabled?: boolean
    variant?: 'manage' | 'peek'
    /** peek 态最多展示的记忆条数 */
    peekLimit?: number
  }>(),
  {
    open: true,
    memoryEnabled: false,
    variant: 'manage',
    peekLimit: 5,
  },
)
const emit = defineEmits<{ close: []; 'update:memoryEnabled': [boolean]; 'open-manage': [] }>()
const { t } = useI18n()

const isPeek = computed(() => props.variant === 'peek')

const items = ref<AiMemory[]>([])
const loading = ref(false)
const error = ref('')
const editingId = ref<string | null>(null)
const form = ref<{ category: AiMemory['category']; title: string; content: string }>({
  category: 'preference',
  title: '',
  content: '',
})

const categoryOptions: { value: AiMemory['category']; label: string }[] = [
  { value: 'preference', label: t('ai_mem_cat_preference') },
  { value: 'fact', label: t('ai_mem_cat_fact') },
  { value: 'project', label: t('ai_mem_cat_project') },
  { value: 'feedback', label: t('ai_mem_cat_feedback') },
  { value: 'other', label: t('ai_mem_cat_other') },
]

function catLabel(c: string): string {
  return categoryOptions.find((o) => o.value === c)?.label || c
}

// peek 态：仅展示最近 N 条（updatedAt 倒序）
const peekItems = computed(() =>
  [...items.value].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, props.peekLimit),
)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await getMemories()
    if (res.ok) items.value = res.data?.items || []
  } catch (e: any) {
    error.value = String(e?.message || e)
  } finally {
    loading.value = false
  }
}

onMounted(load)

function resetForm() {
  editingId.value = null
  form.value = { category: 'preference', title: '', content: '' }
}

function startEdit(m: AiMemory) {
  editingId.value = m.id
  form.value = { category: m.category, title: m.title, content: m.content }
}

async function save() {
  if (!form.value.title.trim()) {
    error.value = t('ai_name_required')
    return
  }
  if (!form.value.content.trim()) {
    error.value = t('ai_content_required')
    return
  }
  error.value = ''
  const payload = {
    category: form.value.category,
    title: form.value.title.trim(),
    content: form.value.content.trim(),
  }
  try {
    if (editingId.value) {
      const res = await updateMemory(editingId.value, payload)
      if (res.ok && res.data) {
        const idx = items.value.findIndex((i) => i.id === editingId.value)
        if (idx >= 0) items.value[idx] = res.data.memory
      }
    } else {
      const res = await createMemory(payload)
      if (res.ok && res.data) items.value.unshift(res.data.memory)
    }
    resetForm()
  } catch (e: any) {
    error.value = String(e?.message || e)
  }
}

async function remove(id: string) {
  try {
    const res = await deleteMemory(id)
    if (res.ok) {
      items.value = items.value.filter((i) => i.id !== id)
      if (editingId.value === id) resetForm()
    }
  } catch (e: any) {
    error.value = String(e?.message || e)
  }
}

function onToggleMemory(v: boolean) {
  emit('update:memoryEnabled', v)
}
</script>

<template>
  <!-- ===== 速览态（Inspector 内）：紧凑列表，无增删改 ===== -->
  <div v-if="isPeek" class="ai-memory-peek">
    <div class="ai-memory-peek-status" @click="emit('open-manage')">
      <span class="ai-memory-peek-dot" :class="memoryEnabled ? 'on' : 'off'" />
      <span class="ai-memory-peek-text">
        {{ memoryEnabled ? t('ai_memory_on', '长程记忆已开启') : t('ai_memory_off', '长程记忆已关闭') }}
        <template v-if="items.length"> · {{ items.length }}</template>
      </span>
      <ChevronRight :size="13" class="ai-memory-peek-arrow" />
    </div>

    <div v-if="loading" class="ai-memory-peek-hint">{{ t('loading', '加载中…') }}</div>
    <div v-else-if="error" class="ai-memory-peek-hint ai-memory-peek-hint--err">{{ error }}</div>
    <div v-else-if="peekItems.length === 0" class="ai-memory-peek-hint">
      {{ t('ai_memory_empty', '暂无记忆') }}
    </div>
    <ul v-else class="ai-memory-peek-list">
      <li v-for="m in peekItems" :key="m.id" class="ai-memory-peek-item" @click="emit('open-manage')">
        <span class="ai-memory-cat">{{ catLabel(m.category) }}</span>
        <span class="ai-memory-peek-title">{{ m.title }}</span>
      </li>
    </ul>

    <button class="ai-memory-peek-manage" @click="emit('open-manage')">
      {{ t('ai_memory_manage', '管理记忆') }}
    </button>
  </div>

  <!-- ===== 管理弹层态：完整增删改（原有能力） ===== -->
  <div v-else class="ai-memory">
    <!-- 头部 -->
    <div class="ai-memory-header">
      <div class="ai-memory-title">
        <span>{{ t('ai_memory') }}</span>
      </div>
      <Button variant="ghost" size="icon-sm" :title="t('close_btn')" @click="emit('close')">
        <X :size="16" />
      </Button>
    </div>

    <!-- 长程记忆模式开关 -->
    <div class="ai-memory-mode">
      <div class="ai-memory-mode-text">
        <div class="ai-memory-mode-label">{{ t('ai_memory_mode') }}</div>
        <div class="ai-memory-mode-hint">{{ t('ai_memory_mode_hint') }}</div>
      </div>
      <Switch :model-value="memoryEnabled" @update:model-value="onToggleMemory" />
    </div>

    <div v-if="error" class="ai-memory-error">{{ error }}</div>

    <!-- 列表 -->
    <div class="ai-memory-list">
      <div v-if="loading" class="ai-memory-loading">{{ t('loading') || '加载中…' }}</div>
      <div v-else-if="items.length === 0" class="ai-memory-empty">{{ t('ai_memory_empty') }}</div>
      <div
        v-for="m in items"
        :key="m.id"
        class="ai-memory-item"
        :class="{ 'ai-memory-item--edit': editingId === m.id }"
      >
        <div class="ai-memory-item-head">
          <span class="ai-memory-cat">{{ catLabel(m.category) }}</span>
          <div class="ai-memory-item-actions">
            <Button variant="ghost" size="icon-sm" :title="t('ai_memory_edit')" @click="startEdit(m)">
              <Pencil :size="13" />
            </Button>
            <Button variant="ghost" size="icon-sm" :title="t('ai_memory_delete')" @click="remove(m.id)">
              <Trash2 :size="13" />
            </Button>
          </div>
        </div>
        <div class="ai-memory-item-title">{{ m.title }}</div>
        <div class="ai-memory-item-content">{{ m.content }}</div>
      </div>
    </div>

    <!-- 表单 -->
    <div class="ai-memory-form">
      <div class="ai-memory-form-row">
        <select v-model="form.category" class="ai-memory-select">
          <option v-for="o in categoryOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
      <input v-model="form.title" class="ai-memory-input" :placeholder="t('ai_memory_title_ph')" />
      <textarea v-model="form.content" class="ai-memory-textarea" rows="3" :placeholder="t('ai_memory_content_ph')" />
      <div class="ai-memory-form-actions">
        <Button v-if="editingId" variant="ghost" size="sm" @click="resetForm">{{ t('ai_memory_cancel') }}</Button>
        <Button size="sm" class="ai-memory-save-btn" @click="save">
          <Plus :size="14" />
          {{ editingId ? t('ai_memory_save') : t('ai_memory_add') }}
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 速览态（Inspector 内紧凑形态） ===== */
.ai-memory-peek {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.ai-memory-peek-status {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: opacity 0.12s;
}
.ai-memory-peek-status:hover {
  opacity: 0.8;
}
.ai-memory-peek-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-tertiary);
}
.ai-memory-peek-dot.on {
  background: var(--success);
}
.ai-memory-peek-dot.off {
  background: var(--text-tertiary);
}
.ai-memory-peek-text {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-memory-peek-arrow {
  flex-shrink: 0;
  color: var(--text-tertiary);
}
.ai-memory-peek-hint {
  padding: 8px 0;
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  text-align: center;
}
.ai-memory-peek-hint--err {
  color: var(--danger);
}
.ai-memory-peek-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ai-memory-peek-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color 0.12s;
}
.ai-memory-peek-item:hover {
  background: var(--bg-hover);
}
.ai-memory-peek-title {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-memory-peek-manage {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--accent);
  cursor: pointer;
  transition: opacity 0.12s;
}
.ai-memory-peek-manage:hover {
  opacity: 0.8;
}

/* ===== 管理弹层态（原有样式） ===== */
.ai-memory {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ai-memory-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.ai-memory-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.ai-memory-mode {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.ai-memory-mode-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.ai-memory-mode-hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  margin-top: 4px;
}
.ai-memory-error {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--danger);
}
.ai-memory-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ai-memory-loading,
.ai-memory-empty {
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
  padding: 20px 0;
}
.ai-memory-item {
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--bg-elevated, var(--bg-surface));
}
.ai-memory-item--edit {
  border-color: var(--accent);
}
.ai-memory-item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ai-memory-cat {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accent-bg);
  color: var(--accent);
  flex-shrink: 0;
}
.ai-memory-item-actions {
  display: flex;
  gap: 2px;
}
.ai-memory-item-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 4px;
}
.ai-memory-item-content {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  margin-top: 2px;
  white-space: pre-wrap;
  word-break: break-word;
}
.ai-memory-form {
  flex-shrink: 0;
  border-top: 1px solid var(--border-default);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ai-memory-select,
.ai-memory-input,
.ai-memory-textarea {
  width: 100%;
  background: var(--bg-input, var(--bg-surface));
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-primary);
  outline: none;
}
.ai-memory-textarea {
  resize: vertical;
  font-family: inherit;
}
.ai-memory-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.ai-memory-save-btn {
  gap: 6px;
  padding-left: 14px;
  padding-right: 14px;
  min-width: 100px;
}
</style>
