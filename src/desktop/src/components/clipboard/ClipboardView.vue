<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useConfigStore } from '@/stores/configStore'
import { usePrivacy } from '@/composables/usePrivacy'
import { useFavoritePopover } from '@/composables/useFavoritePopover'
import { useClipItemDisplay } from '@/composables/useClipItemDisplay'
import { useClipboardActions } from '@/composables/useClipboardActions'
import { useClipboardOperations } from '@/composables/useClipboardOperations'
import { useClipboardKeyboard } from '@/composables/useClipboardKeyboard'
import { useContextMenu } from '@/composables/useContextMenu'
import { useFileUpload } from '@/composables/useFileUpload'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useProtectionDialog } from '@/composables/useProtectionDialog'
import { useItemPassword } from '@/composables/useItemPassword'
import { Copy, Upload, ClipboardList } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import Checkbox from '@/components/ui/checkbox/Checkbox.vue'
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import ProtectionDialog from '@/components/clipboard/ProtectionDialog.vue'
import ClipboardToolbar from '@/components/clipboard/ClipboardToolbar.vue'
import ClipboardFilterBar from '@/components/clipboard/ClipboardFilterBar.vue'
import ClipboardFilterPanel from '@/components/clipboard/ClipboardFilterPanel.vue'
import ClipboardTableRow from '@/components/clipboard/ClipboardTableRow.vue'
import ClipboardContextMenu from '@/components/clipboard/ClipboardContextMenu.vue'
import AiSuggestPopup from '@/components/ai/AiSuggestPopup.vue'
import { api } from '@/api/client'

const emit = defineEmits<{
  'toggle-quick-paste': []
  'preview-image': [item: ClipItem]
  'preview-text': [item: ClipItem]
  'preview-file': [item: ClipItem]
  'version-history': [item: ClipItem]
  'show-pin-dialog': []
  'show-pin-setup': []
  'toggle-sensitive': [item: ClipItem]
}>()

const props = defineProps<{ mode?: 'default' | 'archive' }>()
const isArchive = computed(() => props.mode === 'archive')

const { t } = useI18n()
const toast = useSonner()
const clip = useClipboard()
const configStore = useConfigStore()
const privacy = usePrivacy()
const itemPw = useItemPassword()
const fav = useFavoritePopover()
const display = useClipItemDisplay()

const showQuickPaste = ref(false)
const {
  confirmOpen,
  confirmTitle,
  confirmMessage,
  confirmConfirmText,
  confirmVariant,
  confirmSecondaryText,
  confirmSecondaryVariant,
  showConfirm,
  onConfirmDialog,
  onCancelDialog,
  onSecondaryDialog,
} = useConfirmDialog()
const {
  protectionDialogOpen,
  protectionDialogItem,
  openProtectionDialog,
  onProtectionProtected,
  onProtectionUnprotected,
  onProtectionUnlocked,
} = useProtectionDialog()
const actions = useClipboardActions({ emit, openProtectionDialog })
const ops = useClipboardOperations(isArchive, emit, showConfirm)
const keyboard = useClipboardKeyboard({
  showQuickPaste,
  confirmOpen,
  toggleQuickPaste: () => {
    showQuickPaste.value = !showQuickPaste.value
    emit('toggle-quick-paste')
  },
  copySelected: actions.copyWithPinCheck,
  deleteSelected: ops.handleSingleDelete,
})
const { focusedIndex } = keyboard
const ctx = useContextMenu(actions, focusedIndex)
const upload = useFileUpload()

// PIN 保护与高级加密共用保护弹窗：is-unlocked 需同时识别 itemPw.unlockedIds（高级）
// 和 privacy.isPinUnlocked（PIN 临时解锁），否则明文状态下再次打开设置仍要求输入密码。
const isProtectionDialogUnlocked = computed(() => {
  const item = protectionDialogItem.value
  if (!item?.id) return false
  if (itemPw.isUnlocked(item.id)) return true
  if (item.metadata?.sensitive === true) {
    return privacy.isPinUnlocked(item.id)
  }
  return false
})

function onToggleSelect(item: ClipItem, val: boolean) {
  const idx = clip.items.value.findIndex((i) => i.id === item.id)
  if (idx >= 0) {
    clip.items.value = clip.items.value.map((i, index) => (index === idx ? { ...i, selected: val } : i))
  }
}

const showFilterPanel = ref(false)
function toggleFilterPanel() {
  showFilterPanel.value = !showFilterPanel.value
}

// === AI 主动建议（#230）：选中文本条目后，AI 给出收藏/分类/清理建议 ===
const suggestOpen = ref(false)
const suggestContent = ref('')
const suggestCollectionNames = ref<string[]>([])
// 语义相似度检测候选（#236）
const suggestCandidates = ref<import('@/api/ai').SimilarityCandidate[]>([])
// 当前被建议的条目（用于一键收藏/归档/清理）
const suggestItem = ref<ClipItem | null>(null)

function openAiSuggest() {
  const selected = clip.items.value.filter((i) => i.selected && i.type === 'text' && (i.content || '').trim())
  if (selected.length === 0) {
    toast.show(t('ai_suggest_no_text'), 'error')
    return
  }
  // 只分析第一条选中的文本条目（避免一次调用消耗过多 token）
  suggestItem.value = selected[0]
  suggestContent.value = (selected[0].content || selected[0].preview || '').slice(0, 4000)
  // 收藏夹名称（供 AI 建议分类时选择）
  try {
    const favs = localStorage.getItem('clipsync-favorites') || '[]'
    const arr = JSON.parse(favs)
    suggestCollectionNames.value = Array.isArray(arr) ? arr.map((f: any) => (typeof f === 'string' ? f : f?.name)).filter(Boolean) : []
  } catch {
    suggestCollectionNames.value = []
  }
  // 语义重复检测候选（#236）：最近 10 条非当前文本条目
  suggestCandidates.value = clip.items.value
    .filter((i) => i.type === 'text' && i.id !== suggestItem.value?.id && (i.content || i.preview || '').trim())
    .slice(0, 10)
    .map((i) => ({ id: i.id, text: (i.content || i.preview || '').slice(0, 200) }))
  suggestOpen.value = true
}

function onSuggestClose() {
  suggestOpen.value = false
  suggestItem.value = null
}

async function onSuggestFavorite() {
  if (!suggestItem.value) return
  await clip.toggleFavorite(suggestItem.value)
  toast.show(t('favorited_toast'), 'success')
  onSuggestClose()
}

async function onSuggestArchive() {
  if (!suggestItem.value) return
  const ok = await clip.archiveItem(suggestItem.value)
  toast.show(ok ? t('archived_toast') : t('archive_fail'), ok ? 'success' : 'error')
  onSuggestClose()
}

function onSuggestCleanup() {
  if (!suggestItem.value) return
  const item = suggestItem.value
  // 复用单条删除流程（含确认框 + 敏感条目保护），避免绕过安全校验
  onSuggestClose()
  ops.handleSingleDelete(item)
}

// 应用 AI 推荐的标签（#235）：PUT /api/clipboard/:id 写 metadata.tags，并同步本地 item
async function onSuggestTags(tags: string[]) {
  if (!suggestItem.value || !tags.length) return
  const item = suggestItem.value
  const ok = await api('PUT', `/api/clipboard/${item.id}`, { metadata: { tags } })
  if (ok.ok) {
    // 同步本地 ClipItem（tags 存于 metadata，ClipItem 从 metadata 读 tags）
    if (item.metadata) item.metadata.tags = tags
    else item.metadata = { tags }
    // 如果列表从 metadata 重建 tags 字段，也同步
    ;(item as any).tags = tags
    toast.show(t('ai_suggest_tags_applied', { n: tags.length }) || `已应用 ${tags.length} 个标签`, 'success')
    onSuggestClose()
  } else {
    toast.show(ok.error || '应用标签失败', 'error')
  }
}

const filteredItems = computed(() => clip.filteredItems.value)
const isLoading = computed(() => clip.loading.value)
const totalItems = computed(() => clip.totalItems.value)
const hasMore = computed(() => clip.hasMore.value)
const loadingMore = computed(() => clip.loadingMore.value)
const remaining = computed(() => Math.max(0, totalItems.value - filteredItems.value.length))
const allSelected = computed(() => clip.allSelected.value)

let scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null
function onClipboardScroll(e: Event) {
  if (scrollDebounceTimer) return
  scrollDebounceTimer = setTimeout(() => {
    scrollDebounceTimer = null
  }, 150)
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) clip.loadMore()
}

onMounted(() => {
  fav.loadCollections()
  clip.loadClipboardItems({ view: isArchive.value ? 'archive' : 'all' })
})

watch(
  () => props.mode,
  () => {
    clip.loadClipboardItems({ view: isArchive.value ? 'archive' : 'all' })
  },
)
</script>

<template>
  <div class="clipboard-page">
    <ClipboardToolbar
      :is-archive="isArchive"
      :total-items="totalItems"
      @upload="upload.triggerFileUpload"
      @new-clip="keyboard.toggleQuickPaste"
    />
    <input :ref="upload.fileInputRef" type="file" style="display: none" multiple @change="upload.handleFileUpload" />

    <ClipboardFilterBar
      :is-archive="isArchive"
      :show-filter-panel="showFilterPanel"
      @toggle-filter-panel="toggleFilterPanel"
      @batch-delete="ops.handleBatchDelete"
      @batch-unarchive="ops.handleBatchUnarchive"
      @batch-ai-suggest="openAiSuggest"
    />

    <ClipboardFilterPanel :open="showFilterPanel" @close="showFilterPanel = false" />

    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="confirmTitle"
      :message="confirmMessage"
      :confirm-text="confirmConfirmText"
      :cancel-text="t('cancel_btn')"
      :confirm-variant="confirmVariant"
      :secondary-text="confirmSecondaryText"
      :secondary-variant="confirmSecondaryVariant"
      @confirm="onConfirmDialog"
      @cancel="onCancelDialog"
      @secondary="onSecondaryDialog"
    />

    <ProtectionDialog
      v-model:open="protectionDialogOpen"
      :item-id="protectionDialogItem?.id || ''"
      :content="protectionDialogItem?.content || ''"
      :current-level="
        protectionDialogItem?.metadata?.protected
          ? 'advanced'
          : protectionDialogItem?.metadata?.sensitive
            ? 'pin'
            : 'none'
      "
      :item-name="protectionDialogItem?.content || ''"
      :is-unlocked="isProtectionDialogUnlocked"
      @protected="onProtectionProtected"
      @unprotected="onProtectionUnprotected"
      @unlocked="onProtectionUnlocked"
    />

    <div class="clipboard-view" role="region" :aria-label="t('nav_clipboard')" @scroll="onClipboardScroll">
      <div
        v-if="isLoading && filteredItems.length === 0"
        class="skeleton-wrap"
        :aria-label="t('ver_loading')"
        role="status"
      >
        <div v-for="n in 6" :key="n" class="skeleton-row">
          <div class="sk sk-checkbox" />
          <div class="sk sk-content" />
          <div class="sk sk-source" />
          <div class="sk sk-badge" />
          <div class="sk sk-time" />
          <div class="sk sk-actions" />
        </div>
      </div>

      <div v-else-if="filteredItems.length > 0" class="table-wrapper">
        <Table role="table" :aria-label="t('nav_clipboard')">
          <TableHeader>
            <TableRow>
              <TableHead class="w-12">
                <Checkbox :model-value="allSelected" @update:model-value="() => clip.toggleSelectAll()" />
              </TableHead>
              <TableHead>{{ t('head_content') }}</TableHead>
              <TableHead class="w-[160px]">{{ t('head_source') }}</TableHead>
              <TableHead class="w-[64px]">{{ t('head_type') }}</TableHead>
              <TableHead class="w-[90px]">{{ t('head_time') }}</TableHead>
              <TableHead class="w-[150px] text-center">{{ t('head_actions') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <ClipboardTableRow
              v-for="(item, idx) in filteredItems"
              :key="item.id"
              :item="item"
              :focused="idx === focusedIndex"
              :is-archive="isArchive"
              :more-open-id="ctx.moreOpenId"
              @focus="focusedIndex = idx"
              @dblclick="actions.onDblClick"
              @contextmenu="ctx.openCtxMenu"
              @preview="actions.onPreview"
              @copy="actions.onCopyItem"
              @delete="ops.handleSingleDelete"
              @unarchive="ops.handleUnarchive"
              @toggle-more="ctx.toggleMore"
              @share="
                (item) => {
                  ops.shareItem(item)
                  ctx.closeMore()
                }
              "
              @reveal="
                (item) => {
                  ops.revealFileFolder(item)
                  ctx.closeMore()
                }
              "
              @open-protection="
                (item) => {
                  openProtectionDialog(item)
                  ctx.closeMore()
                }
              "
              @archive-toggle="
                (item) => {
                  ops.onArchiveToggle(item)
                  ctx.closeMore()
                }
              "
              @expiry-from-dropdown="ctx.openExpiryFromDropdown"
              @toggle-select="onToggleSelect"
            />
          </TableBody>
        </Table>

        <div v-if="hasMore" class="load-more-wrap">
          <Button variant="outline" size="sm" :disabled="loadingMore" @click="clip.loadMore()">
            <span v-if="loadingMore">{{ t('loading_more') }}</span>
            <span v-else>{{ t('load_more') }}（{{ remaining }}）</span>
          </Button>
        </div>
      </div>

      <div v-else class="empty-state">
        <div class="empty-icon-wrap">
          <ClipboardList :size="48" style="color: var(--text-tertiary)" />
        </div>
        <h3 class="empty-title">{{ isArchive ? t('archive_empty_title') : t('empty_title') }}</h3>
        <p class="empty-desc">{{ isArchive ? t('archive_empty_desc') : t('empty_desc') }}</p>
        <div v-if="!isArchive" class="empty-hints">
          <div class="empty-hint">
            <Copy :size="14" class="empty-hint-icon" />
            <span>{{ t('empty_hint_copy') }}</span>
          </div>
          <div class="empty-hint">
            <svg
              class="empty-hint-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              width="14"
              height="14"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8" />
            </svg>
            <span>{{ t('empty_hint_shortcut') }}</span>
          </div>
          <div class="empty-hint">
            <Upload :size="14" class="empty-hint-icon" />
            <span>{{ t('empty_hint_upload') }}</span>
          </div>
        </div>
        <p v-if="!isArchive" class="empty-action">{{ t('empty_action') }}</p>
      </div>
    </div>

    <ClipboardContextMenu
      :item="ctx.ctxItem"
      :x="ctx.ctxX"
      :y="ctx.ctxY"
      :is-archive="isArchive"
      :initial-mode="ctx.ctxInitialMode"
      @close="ctx.closeCtxMenu"
      @copy="actions.copyWithPinCheck"
      @share="ops.shareItem"
      @preview="actions.onPreview"
      @reveal="ops.revealFileFolder"
      @open-protection="openProtectionDialog"
      @archive-toggle="ops.onArchiveToggle"
      @delete="ops.handleSingleDelete"
    />

    <!-- AI 主动建议（#230）：选中文本条目后给出收藏/分类/清理建议 -->
    <AiSuggestPopup
      :open="suggestOpen"
      :content="suggestContent"
      :collections="suggestCollectionNames"
      :candidates="suggestCandidates"
      @close="onSuggestClose"
      @apply-favorite="onSuggestFavorite"
      @apply-archive="onSuggestArchive"
      @apply-cleanup="onSuggestCleanup"
      @apply-tags="onSuggestTags"
    />
  </div>
</template>

<style scoped>
.clipboard-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.clipboard-view {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}
.table-wrapper {
  border: none;
  border-radius: 0;
  overflow: visible;
}
.load-more-wrap {
  display: flex;
  justify-content: center;
  padding: 16px 0 28px;
}
.load-more-wrap :deep(button) {
  padding-left: 22px !important;
  padding-right: 22px !important;
}
.clipboard-view :deep(table) {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
}
/* shadcn-vue Table 组件内部用 <div class="... overflow-auto"> 包裹 <table>，
   这个 overflow-auto 创建了一个新的包含块，切断了 thead sticky 相对
   .clipboard-view 滚动容器的定位上下文，导致表头 sticky 完全失效。
   必须把这个包裹 div 的 overflow 改为 visible，让 sticky 回到正确的滚动容器。 */
.clipboard-view :deep(.overflow-auto) {
  overflow: visible !important;
}
.clipboard-view :deep(thead) {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
}
.clipboard-view :deep(thead tr) {
  border-bottom: 1px solid var(--border-default);
}
.clipboard-view :deep(thead th) {
  padding: 10px 16px;
  text-align: center;
  font-weight: 500;
  font-size: 12px;
  color: var(--text-tertiary);
  background: var(--bg-surface);
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
}
.clipboard-view :deep(tbody tr) {
  border-bottom: 1px solid var(--border-subtle);
  transition: background 0.12s ease;
}
.clipboard-view :deep(tbody tr:hover) {
  background: var(--bg-hover);
}
.clipboard-view :deep(tbody tr.focused) {
  background: var(--accent-light);
  box-shadow: inset 3px 0 0 var(--accent);
}
.clipboard-view :deep(tbody tr.focused:hover) {
  background: var(--accent-light);
}
.clipboard-view :deep(tbody tr:last-child) {
  border-bottom-color: transparent;
}
.clipboard-view :deep(tbody td) {
  padding: 8px 16px;
  vertical-align: middle;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  text-align: center;
}
.empty-icon-wrap {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  background: var(--bg-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}
.empty-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 6px;
}
.empty-desc {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.empty-hints {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}
.empty-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}
.empty-hint-icon {
  flex-shrink: 0;
  color: var(--text-tertiary);
}
.empty-action {
  font-size: 13px;
  color: var(--accent);
  margin-top: 16px;
  font-weight: 500;
}

.skeleton-wrap {
  padding: 0;
}
.skeleton-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-subtle);
}
.sk {
  border-radius: var(--radius-sm);
  background: linear-gradient(90deg, rgba(0, 0, 0, 0.04) 25%, rgba(0, 0, 0, 0.08) 50%, rgba(0, 0, 0, 0.04) 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s ease-in-out infinite;
}
.sk-checkbox {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 4px;
}
.sk-content {
  flex: 1;
  height: 20px;
  max-width: 40%;
}
.sk-source {
  width: 80px;
  height: 14px;
  flex-shrink: 0;
}
.sk-badge {
  width: 52px;
  height: 22px;
  flex-shrink: 0;
  border-radius: 9999px;
}
.sk-time {
  width: 48px;
  height: 14px;
  flex-shrink: 0;
}
.sk-actions {
  width: 100px;
  height: 14px;
  flex-shrink: 0;
}
@keyframes skeleton-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
</style>
