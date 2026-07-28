<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'
import type { AiConversation } from '@/api/ai'
import { MessageSquare, Plus, Trash2, Check, X, Pencil } from 'lucide-vue-next'

const props = defineProps<{
  conversations: AiConversation[]
  currentId: string
  loading?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  new: []
  delete: [id: string]
  rename: [id: string, title: string]
}>()

const { t } = useI18n()
const editingId = ref('')
const editingTitle = ref('')
const editInputRef = ref<HTMLInputElement | null>(null)

function formatTime(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (isToday) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function startRename(conv: AiConversation) {
  editingId.value = conv.id
  editingTitle.value = conv.title
  nextTick(() => editInputRef.value?.focus())
}

function submitRename(id: string) {
  const title = editingTitle.value.trim()
  if (title) emit('rename', id, title)
  editingId.value = ''
}

function cancelRename() {
  editingId.value = ''
}
</script>

<template>
  <div class="ai-conv-panel">
    <div class="ai-conv-header">
      <span class="ai-conv-title">{{ t('ai_history') || '历史对话' }}</span>
      <Button variant="ghost" size="icon-sm" :title="t('ai_new_chat') || '新对话'" @click="emit('new')">
        <Plus :size="15" />
      </Button>
    </div>

    <div v-if="loading" class="ai-conv-empty">{{ t('loading') || '加载中...' }}</div>
    <div v-else-if="!conversations.length" class="ai-conv-empty">
      {{ t('ai_no_history') || '暂无历史对话' }}
    </div>

    <div v-else class="ai-conv-list">
      <div
        v-for="conv in conversations"
        :key="conv.id"
        class="ai-conv-item"
        :class="{ active: conv.id === currentId }"
        @click="emit('select', conv.id)"
      >
        <MessageSquare :size="14" class="ai-conv-icon" />
        <div class="ai-conv-info">
          <input
            v-if="editingId === conv.id"
            ref="editInputRef"
            v-model="editingTitle"
            class="ai-conv-input"
            @keydown.enter.stop="submitRename(conv.id)"
            @keydown.escape.stop="cancelRename"
            @blur="submitRename(conv.id)"
            @click.stop
          />
          <span v-else class="ai-conv-name">{{ conv.title }}</span>
          <span class="ai-conv-meta">
            {{ formatTime(conv.updated_at) }} · {{ conv.message_count }} {{ t('ai_messages') || '条消息' }}
          </span>
        </div>
        <div class="ai-conv-actions">
          <Button
            v-if="editingId !== conv.id"
            variant="ghost"
            size="icon-sm"
            :title="t('ai_rename') || '重命名'"
            @click.stop="startRename(conv)"
          >
            <Pencil :size="12" />
          </Button>
          <template v-else>
            <Button variant="ghost" size="icon-sm" @click.stop="submitRename(conv.id)">
              <Check :size="12" />
            </Button>
            <Button variant="ghost" size="icon-sm" @click.stop="cancelRename">
              <X :size="12" />
            </Button>
          </template>
          <Button
            variant="ghost"
            size="icon-sm"
            :title="t('ai_delete') || '删除'"
            @click.stop="emit('delete', conv.id)"
          >
            <Trash2 :size="12" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-conv-panel {
  width: 220px;
  min-width: 220px;
  border-right: 1px solid var(--border-default);
  background: var(--bg-surface);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ai-conv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.ai-conv-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.ai-conv-empty {
  padding: 20px 14px;
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
}
.ai-conv-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.ai-conv-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.12s;
  margin-bottom: 2px;
}
.ai-conv-item:hover {
  background: var(--bg-hover);
}
.ai-conv-item.active {
  background: var(--accent-bg);
}
.ai-conv-icon {
  color: var(--text-secondary);
  flex-shrink: 0;
}
.ai-conv-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ai-conv-name {
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-conv-meta {
  font-size: 11px;
  color: var(--text-secondary);
}
.ai-conv-input {
  width: 100%;
  font-size: 12px;
  padding: 2px 6px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
}
.ai-conv-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s;
}
.ai-conv-item:hover .ai-conv-actions,
.ai-conv-item.active .ai-conv-actions {
  opacity: 1;
}
</style>
