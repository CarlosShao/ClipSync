<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'
import type { AiConversation, ConversationSearchHit } from '@/api/ai'
import { searchConversationHistory } from '@/api/ai'
import { MessageSquare, Trash2, Check, X, Pencil, Search, XCircle, MessageSquareText } from 'lucide-vue-next'

const props = defineProps<{
  conversations: AiConversation[]
  currentId: string
  loading?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  delete: [id: string]
  rename: [id: string, title: string]
  /** 命中搜索片段后：打开该对话并定位到对应消息片段 */
  locate: [hit: ConversationSearchHit]
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

// === 历史消息关键词搜索（#231）===
const searchQuery = ref('')
const searching = ref(false)
const searchError = ref('')
const searchHits = ref<ConversationSearchHit[]>([])
let searchTimer: ReturnType<typeof setTimeout> | null = null

async function runSearch(q: string) {
  const keyword = q.trim()
  if (!keyword) {
    searchHits.value = []
    searchError.value = ''
    return
  }
  searching.value = true
  searchError.value = ''
  try {
    const res = await searchConversationHistory(keyword)
    if (res.ok && res.data) {
      searchHits.value = res.data.items || []
    } else {
      searchHits.value = []
      searchError.value = res.error || '搜索失败'
    }
  } catch (e: any) {
    searchHits.value = []
    searchError.value = e?.message || '搜索失败'
  } finally {
    searching.value = false
  }
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => runSearch(searchQuery.value), 350)
}

function clearSearch() {
  searchQuery.value = ''
  searchHits.value = []
  searchError.value = ''
  if (searchTimer) clearTimeout(searchTimer)
}

function onHitClick(hit: ConversationSearchHit) {
  emit('select', hit.conversationId)
  // 定位到消息片段（父级滚动到对应消息）
  emit('locate', hit)
}

// 高亮片段中的关键词
function highlightSnippet(snippet: string, keyword: string): string {
  const k = keyword.trim()
  if (!k) return snippet
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return snippet.replace(new RegExp(`(${esc})`, 'gi'), '\u0001$1\u0002')
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
    </div>

    <!-- 搜索框（#231） -->
    <div class="ai-conv-search">
      <Search :size="13" class="ai-conv-search-icon" />
      <input
        v-model="searchQuery"
        class="ai-conv-search-input"
        :placeholder="t('ai_search_placeholder') || '搜索历史消息…'"
        @input="onSearchInput"
        @keydown.enter="runSearch(searchQuery)"
      />
      <button v-if="searchQuery" class="ai-conv-search-clear" @click="clearSearch">
        <XCircle :size="13" />
      </button>
    </div>

    <!-- 搜索模式：命中列表 -->
    <template v-if="searchQuery.trim()">
      <div v-if="searching" class="ai-conv-empty">{{ t('ai_searching') || '搜索中…' }}</div>
      <div v-else-if="searchError" class="ai-conv-empty ai-conv-empty--error">{{ searchError }}</div>
      <div v-else-if="!searchHits.length" class="ai-conv-empty">{{ t('ai_search_empty') || '没有找到匹配的消息' }}</div>
      <div v-else class="ai-conv-list">
        <div
          v-for="(hit, i) in searchHits"
          :key="hit.messageId || i"
          class="ai-conv-hit"
          :class="{ active: hit.conversationId === currentId }"
          @click="onHitClick(hit)"
        >
          <MessageSquareText :size="13" class="ai-conv-hit-icon" />
          <div class="ai-conv-hit-body">
            <div class="ai-conv-hit-head">
              <span class="ai-conv-hit-title">{{ hit.conversationTitle }}</span>
              <span class="ai-conv-hit-meta">
                {{ t('ai_search_pos', { pos: hit.posInConv, total: hit.totalInConv }) || `第 ${hit.posInConv}/${hit.totalInConv} 条` }}
              </span>
            </div>
            <span v-html="highlightSnippet(hit.snippet, searchQuery).replace(/\u0001/g, '<mark class=\'ai-conv-hit-mark\'>').replace(/\u0002/g, '</mark>')" class="ai-conv-hit-snippet" />
          </div>
        </div>
      </div>
    </template>

    <!-- 正常列表 -->
    <template v-else>
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
    </template>
  </div>
</template>

<style scoped>
.ai-conv-panel {
  width: 100%;
  min-width: 0;
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
.ai-conv-empty--error {
  color: var(--danger, #ef4444);
}
.ai-conv-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px 4px;
  flex-shrink: 0;
}
.ai-conv-search-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.ai-conv-search-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.15s;
}
.ai-conv-search-input:focus {
  border-color: var(--accent);
}
.ai-conv-search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  color: var(--text-tertiary);
  border: none;
  background: transparent;
  cursor: pointer;
}
.ai-conv-search-clear:hover {
  color: var(--text-primary);
}
.ai-conv-hit {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.12s;
  margin-bottom: 2px;
}
.ai-conv-hit:hover {
  background: var(--bg-hover);
}
.ai-conv-hit.active {
  background: var(--accent-bg);
}
.ai-conv-hit-icon {
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 2px;
}
.ai-conv-hit-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ai-conv-hit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ai-conv-hit-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-conv-hit-meta {
  font-size: 10.5px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.ai-conv-hit-snippet {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.ai-conv-hit-mark {
  background: transparent;
  color: var(--accent);
  font-weight: 700;
}
.ai-conv-list {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
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
