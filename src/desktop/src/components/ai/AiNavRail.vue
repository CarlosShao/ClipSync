<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAiChatUi } from '@/composables/useAiChatUi'
import { useResizablePanel } from '@/composables/useResizablePanel'
import Button from '@/components/ui/button/Button.vue'
import type { AiConversation, ConversationSearchHit } from '@/api/ai'
import { searchConversationHistory } from '@/api/ai'
import {
  Plus,
  Search,
  MessageSquare,
  MessageSquareText,
  Trash2,
  Check,
  X,
  Pencil,
  XCircle,
  Brain,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-vue-next'

/**
 * AI Shell 左侧导航栏（UI-B）。
 * 三形态（由 useAiChatUi.navRailMode 驱动）：
 *   expanded — 行内 260px（可拖宽 200–360px，持久化 key 与旧 ai-sidebar-width 区分）
 *   icon     — 行内 48px 图标列（md 档自动降级 / 用户手动收起）
 *   overlay  — 浮层完整形态（sm 档唯一形态；icon 档可呼出）
 * 会话列表/搜索/重命名逻辑自旧 AiConversationList.vue 迁入（原文件已在 UI-F 收尾时删除）。
 */
defineProps<{
  conversations: AiConversation[]
  currentId: string
  loading?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  delete: [id: string]
  rename: [id: string, title: string]
  /** 命中搜索片段后：打开该对话并定位到对应消息 */
  locate: [hit: ConversationSearchHit]
  'new-chat': []
  'open-settings': []
  'open-memory': []
}>()

const { t } = useI18n()
const { breakpoint, navRailMode, navRailCollapsed, navOverlayOpen, setNavOverlayOpen, toggleNavRail } = useAiChatUi()

// 展开态宽度拖拽（左侧面板：拖右缘右移变宽 → invert）
const { width, startDrag } = useResizablePanel({
  storageKey: 'ai-nav-rail-width',
  min: 200,
  max: 360,
  default: 260,
  invert: true,
})

const isFullUi = computed(() => navRailMode.value !== 'icon')
const isFloat = computed(() => navRailMode.value === 'overlay')

// === 搜索（指令行风格，逻辑迁自 AiConversationList #231）===
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
      searchError.value = res.error || t('ai_search_failed', '搜索失败')
    }
  } catch (e) {
    searchHits.value = []
    searchError.value = e instanceof Error ? e.message : t('ai_search_failed', '搜索失败')
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

function highlightSnippet(snippet: string, keyword: string): string {
  const k = keyword.trim()
  if (!k) return snippet
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return snippet.replace(new RegExp(`(${esc})`, 'gi'), '\u0001$1\u0002')
}

// === 重命名（迁自 AiConversationList）===
const editingId = ref('')
const editingTitle = ref('')
const editInputRef = ref<HTMLInputElement | null>(null)

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

// === 通用 ===
function formatTime(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (isToday) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function onSelect(id: string) {
  emit('select', id)
  // 浮层形态下选择后自动收起
  if (navOverlayOpen.value) setNavOverlayOpen(false)
}

function onHitClick(hit: ConversationSearchHit) {
  emit('select', hit.conversationId)
  emit('locate', hit)
  if (navOverlayOpen.value) setNavOverlayOpen(false)
}

/** icon 形态点「展开」：md 档空间不足 → 呼出浮层；xl/lg 档恢复行内展开 */
function onExpandFromIcon() {
  if (breakpoint.value === 'md' || breakpoint.value === 'sm') {
    setNavOverlayOpen(true)
  } else {
    toggleNavRail()
  }
}

/** 浮层形态点「停靠」：关闭浮层并恢复行内展开（清掉手动收起标记） */
function onDockFromFloat() {
  setNavOverlayOpen(false)
  // 仅当此前是手动收起（collapsed=true）时恢复展开；md/sm 档空间不足，停靠后自动回落 icon/浮层形态
  if (navRailCollapsed.value) toggleNavRail()
}
</script>

<template>
  <div
    class="ai-nav"
    :class="{
      'ai-nav--inline': navRailMode === 'expanded',
      'ai-nav--icon': navRailMode === 'icon',
      'ai-nav--float': isFloat,
      'ai-nav--float-open': isFloat && navOverlayOpen,
    }"
    :style="navRailMode === 'expanded' ? { width: width + 'px' } : {}"
  >
    <!-- 行内展开态：右缘拖拽把手 -->
    <div v-if="navRailMode === 'expanded'" class="ai-nav-resize" title="拖拽调整宽度" @mousedown="startDrag" />

    <template v-if="isFullUi">
      <!-- 顶部：新建 + 指令行搜索 -->
      <div class="ai-nav-top">
        <button class="ai-nav-new" :title="t('ai_new_chat', '新对话')" @click="emit('new-chat')">
          <Plus :size="14" />
          <span>{{ t('ai_new_chat', '新对话') }}</span>
        </button>
        <div class="ai-nav-cmd">
          <span class="ai-nav-cmd-prefix" aria-hidden="true">&gt;</span>
          <input
            v-model="searchQuery"
            class="ai-nav-cmd-input"
            type="text"
            :placeholder="t('ai_search_placeholder', '搜索历史消息…')"
            @input="onSearchInput"
            @keydown.enter="runSearch(searchQuery)"
          />
          <button v-if="searchQuery" class="ai-nav-cmd-clear" :title="t('close_btn')" @click="clearSearch">
            <XCircle :size="13" />
          </button>
        </div>
      </div>

      <!-- 列表主体（容器查询：rail 窄时隐藏次要信息） -->
      <div class="ai-nav-body">
        <!-- 搜索命中模式 -->
        <template v-if="searchQuery.trim()">
          <div v-if="searching" class="ai-nav-empty">{{ t('ai_searching', '搜索中…') }}</div>
          <div v-else-if="searchError" class="ai-nav-empty ai-nav-empty--error">{{ searchError }}</div>
          <div v-else-if="!searchHits.length" class="ai-nav-empty">
            {{ t('ai_search_empty', '没有找到匹配的消息') }}
          </div>
          <div v-else class="ai-nav-scroll">
            <div
              v-for="(hit, i) in searchHits"
              :key="hit.messageId || i"
              class="ai-nav-hit"
              :class="{ active: hit.conversationId === currentId }"
              role="button"
              tabindex="0"
              @click="onHitClick(hit)"
              @keydown.enter="onHitClick(hit)"
            >
              <MessageSquareText :size="13" class="ai-nav-hit-icon" />
              <div class="ai-nav-hit-body">
                <div class="ai-nav-hit-head">
                  <span class="ai-nav-hit-title">{{ hit.conversationTitle }}</span>
                  <span class="ai-nav-hit-meta">
                    {{
                      t('ai_search_pos', { pos: hit.posInConv, total: hit.totalInConv }) ||
                      `${hit.posInConv}/${hit.totalInConv}`
                    }}
                  </span>
                </div>
                <!-- eslint-disable-next-line vue/no-v-html (高亮关键词，输入已转义正则) -->
                <span
                  class="ai-nav-hit-snippet"
                  v-html="
                    highlightSnippet(hit.snippet, searchQuery)
                      .replace(/\u0001/g, '<mark>')
                      .replace(/\u0002/g, '</mark>')
                  "
                />
              </div>
            </div>
          </div>
        </template>

        <!-- 会话列表模式 -->
        <template v-else>
          <div v-if="loading" class="ai-nav-empty">{{ t('loading', '加载中...') }}</div>
          <div v-else-if="!conversations.length" class="ai-nav-empty">
            {{ t('ai_no_history', '暂无历史对话') }}
          </div>
          <div v-else class="ai-nav-scroll">
            <div
              v-for="conv in conversations"
              :key="conv.id"
              class="ai-nav-conv"
              :class="{ active: conv.id === currentId }"
              role="button"
              tabindex="0"
              @click="onSelect(conv.id)"
              @keydown.enter="onSelect(conv.id)"
            >
              <MessageSquare :size="14" class="ai-nav-conv-icon" />
              <div class="ai-nav-conv-info">
                <input
                  v-if="editingId === conv.id"
                  ref="editInputRef"
                  v-model="editingTitle"
                  class="ai-nav-edit"
                  @keydown.enter.stop="submitRename(conv.id)"
                  @keydown.escape.stop="cancelRename"
                  @blur="submitRename(conv.id)"
                  @click.stop
                />
                <template v-else>
                  <span class="ai-nav-conv-name">{{ conv.title }}</span>
                  <span class="ai-nav-conv-meta">
                    <span
                      class="ai-nav-badge"
                      :class="conv.mode === 'agent' ? 'ai-nav-badge--agent' : 'ai-nav-badge--ask'"
                    >
                      {{ conv.mode === 'agent' ? 'Agent' : 'Ask' }}
                    </span>
                    {{ formatTime(conv.updated_at) }} · {{ conv.message_count }}
                    {{ t('ai_messages', '条消息') }}
                  </span>
                </template>
              </div>
              <div v-if="editingId !== conv.id" class="ai-nav-conv-actions">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  :title="t('ai_rename', '重命名')"
                  @click.stop="startRename(conv)"
                >
                  <Pencil :size="12" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  :title="t('ai_delete', '删除')"
                  @click.stop="emit('delete', conv.id)"
                >
                  <Trash2 :size="12" />
                </Button>
              </div>
              <div v-else class="ai-nav-conv-actions">
                <Button variant="ghost" size="icon-sm" @click.stop="submitRename(conv.id)">
                  <Check :size="12" />
                </Button>
                <Button variant="ghost" size="icon-sm" @click.stop="cancelRename">
                  <X :size="12" />
                </Button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- 底部：设置 / 形态切换（记忆入口已移至聊天页右上角） -->
      <div class="ai-nav-foot">
        <button class="ai-nav-foot-btn" :title="t('ai_settings', 'AI 设置')" @click="emit('open-settings')">
          <Settings :size="15" />
        </button>
        <span class="ai-nav-foot-spacer" />
        <button
          v-if="!isFloat"
          class="ai-nav-foot-btn"
          :title="t('ai_nav_collapse', '收起导航栏')"
          @click="toggleNavRail()"
        >
          <PanelLeftClose :size="15" />
        </button>
        <template v-else>
          <button class="ai-nav-foot-btn" :title="t('ai_nav_dock', '停靠导航栏')" @click="onDockFromFloat">
            <PanelLeftOpen :size="15" />
          </button>
          <button class="ai-nav-foot-btn" :title="t('close_btn')" @click="setNavOverlayOpen(false)">
            <X :size="15" />
          </button>
        </template>
      </div>
    </template>

    <!-- icon-rail 形态（48px） -->
    <template v-else>
      <div class="ai-nav-rail">
        <button class="ai-nav-rail-btn" :title="t('ai_new_chat', '新对话')" @click="emit('new-chat')">
          <Plus :size="16" />
        </button>
        <button class="ai-nav-rail-btn" :title="t('ai_search_placeholder', '搜索历史消息…')" @click="onExpandFromIcon">
          <Search :size="16" />
        </button>
        <div class="ai-nav-rail-convs">
          <button
            v-for="conv in conversations.slice(0, 9)"
            :key="conv.id"
            class="ai-nav-rail-btn"
            :class="{ 'ai-nav-rail-btn--active': conv.id === currentId }"
            :title="conv.title"
            @click="onSelect(conv.id)"
          >
            <MessageSquare :size="15" />
          </button>
        </div>
        <div class="ai-nav-rail-foot">
          <button class="ai-nav-rail-btn" :title="t('ai_settings', 'AI 设置')" @click="emit('open-settings')">
            <Settings :size="16" />
          </button>
          <button class="ai-nav-rail-btn" :title="t('ai_nav_expand', '展开导航栏')" @click="onExpandFromIcon">
            <PanelLeftOpen :size="16" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ai-nav {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-default);
  overflow: hidden;
  /* 查询容器挂根：宽度由形态/inline style 决定，子区块（新建按钮/列表）按 rail 实宽自适应 */
  container-type: inline-size;
  container-name: ai-nav;
}

/* ---- 行内展开态：宽度由 inline style 控制（200–360px） ---- */
.ai-nav--inline {
  flex: 0 0 auto;
}

/* 右缘拖拽把手 */
.ai-nav-resize {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: var(--z-sticky);
  background: transparent;
  transition: opacity 0.12s;
}
.ai-nav-resize:hover {
  background: var(--accent);
  opacity: 0.4;
}

/* ---- icon-rail 形态（48px） ---- */
.ai-nav--icon {
  flex: 0 0 auto;
  width: 48px;
  border-right: 1px solid var(--border-default);
}
.ai-nav-rail {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 0;
}
.ai-nav-rail-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    color 0.12s,
    background-color 0.12s;
}
.ai-nav-rail-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.ai-nav-rail-btn--active {
  color: var(--accent);
  background: var(--accent-bg);
}
.ai-nav-rail-convs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 100%;
  padding: 4px 0;
}
.ai-nav-rail-foot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

/* ---- 浮层形态 ---- */
.ai-nav--float {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: calc(var(--z-rail) + 1);
  width: 260px;
  border-right: 1px solid var(--border-default);
  box-shadow: var(--shadow-lg);
  transform: translateX(-100%);
  opacity: 0;
  visibility: hidden;
  transition:
    transform 0.18s ease,
    opacity 0.18s ease,
    visibility 0.18s;
}
.ai-nav--float-open {
  transform: translateX(0);
  opacity: 1;
  visibility: visible;
}

/* ---- 完整形态：顶部 ---- */
.ai-nav-top {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 10px 6px;
  flex-shrink: 0;
}
.ai-nav-new {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 10px;
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--accent);
  background: rgba(var(--accent-rgb), 0.1);
  border: 1px solid rgba(var(--accent-rgb), 0.35);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background-color 0.12s;
}
.ai-nav-new:hover {
  background: rgba(var(--accent-rgb), 0.16);
}

/* 指令行风格搜索框 */
.ai-nav-cmd {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  transition: border-color 0.15s;
}
.ai-nav-cmd:focus-within {
  border-color: var(--accent);
}
.ai-nav-cmd-prefix {
  color: var(--accent);
  user-select: none;
}
.ai-nav-cmd-input {
  flex: 1;
  min-width: 0;
  font: inherit;
  color: var(--text-primary);
  background: transparent;
  border: none;
  outline: none;
  caret-color: var(--accent);
}
.ai-nav-cmd-input::placeholder {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}
.ai-nav-cmd-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.ai-nav-cmd-clear:hover {
  color: var(--text-primary);
}

/* ---- 完整形态：列表主体 ---- */
.ai-nav-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ai-nav-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 6px;
}
.ai-nav-empty {
  padding: 20px 12px;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  text-align: center;
}
.ai-nav-empty--error {
  color: var(--danger);
}

/* 搜索命中项 */
.ai-nav-hit {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background-color 0.12s;
  margin-bottom: 2px;
}
.ai-nav-hit:hover {
  background: var(--bg-hover);
}
.ai-nav-hit.active {
  background: var(--accent-bg);
}
.ai-nav-hit-icon {
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 2px;
}
.ai-nav-hit-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ai-nav-hit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ai-nav-hit-title {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-nav-hit-meta {
  font-size: var(--text-2xs);
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.ai-nav-hit-snippet {
  font-size: var(--text-xs);
  line-height: 1.55;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.ai-nav-hit-snippet :deep(mark) {
  background: transparent;
  color: var(--accent);
  font-weight: 700;
}

/* 会话项 */
.ai-nav-conv {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background-color 0.12s;
  margin-bottom: 2px;
}
.ai-nav-conv:hover {
  background: var(--bg-hover);
}
.ai-nav-conv.active {
  background: var(--accent-bg);
}
.ai-nav-conv-icon {
  color: var(--text-secondary);
  flex-shrink: 0;
}
.ai-nav-conv.active .ai-nav-conv-icon {
  color: var(--accent);
}
.ai-nav-conv-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ai-nav-conv-name {
  font-size: var(--text-base);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-nav-conv-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-2xs);
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
}
.ai-nav-edit {
  width: 100%;
  font-size: var(--text-base);
  padding: 2px 6px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
}
.ai-nav-conv-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s;
}
.ai-nav-conv:hover .ai-nav-conv-actions,
.ai-nav-conv.active .ai-nav-conv-actions {
  opacity: 1;
}

/* 模式徽章 */
.ai-nav-badge {
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  border-radius: 999px;
  font-size: var(--text-2xs);
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.02em;
  border: 1px solid transparent;
}
.ai-nav-badge--agent {
  color: var(--accent);
  background: rgba(var(--accent-rgb), 0.1);
  border-color: rgba(var(--accent-rgb), 0.35);
}
.ai-nav-badge--ask {
  color: var(--text-tertiary);
  background: var(--bg-hover);
  border-color: var(--border-default);
}

/* ---- 完整形态：底部 ---- */
.ai-nav-foot {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  border-top: 1px solid var(--border-default);
  flex-shrink: 0;
}
.ai-nav-foot-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    color 0.12s,
    background-color 0.12s;
}
.ai-nav-foot-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.ai-nav-foot-spacer {
  flex: 1;
}

/* ---- 容器查询：rail 变窄时收紧次要信息 ---- */
@container ai-nav (max-width: 230px) {
  .ai-nav-conv-meta {
    visibility: hidden;
  }
  .ai-nav-new span {
    display: none;
  }
}
@container ai-nav (max-width: 200px) {
  .ai-nav-conv-actions {
    display: none;
  }
}

/* ---- 键盘可达性：focus-visible 高亮（--accent token） ---- */
.ai-nav-new:focus-visible,
.ai-nav-cmd-clear:focus-visible,
.ai-nav-foot-btn:focus-visible,
.ai-nav-rail-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.ai-nav-hit:focus-visible,
.ai-nav-conv:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

/* 尊重系统「减少动态效果」设置 */
@media (prefers-reduced-motion: reduce) {
  .ai-nav--float {
    transition: none;
  }
}
</style>
