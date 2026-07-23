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
  confirmOpen, confirmTitle, confirmMessage, confirmConfirmText,
  confirmVariant, confirmSecondaryText, confirmSecondaryVariant,
  showConfirm, onConfirmDialog, onCancelDialog, onSecondaryDialog,
} = useConfirmDialog()
const {
  protectionDialogOpen, protectionDialogItem,
  openProtectionDialog,
  onProtectionProtected, onProtectionUnprotected, onProtectionUnlocked,
} = useProtectionDialog()
const actions = useClipboardActions(emit)
const ops = useClipboardOperations(isArchive, emit)
const keyboard = useClipboardKeyboard({
  showQuickPaste,
  confirmOpen,
  toggleQuickPaste: () => { showQuickPaste.value = !showQuickPaste.value; emit('toggle-quick-paste') },
  copySelected: actions.copyWithPinCheck,
  deleteSelected: ops.handleSingleDelete,
})
const { focusedIndex } = keyboard
const ctx = useContextMenu(actions, focusedIndex)
const upload = useFileUpload()

const showFilterPanel = ref(false)
function toggleFilterPanel() { showFilterPanel.value = !showFilterPanel.value }

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
  scrollDebounceTimer = setTimeout(() => { scrollDebounceTimer = null }, 150)
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) clip.loadMore()
}

onMounted(() => {
  fav.loadCollections()
  clip.loadClipboardItems({ view: isArchive.value ? 'archive' : 'all' })
})

watch(() => props.mode, () => {
  clip.loadClipboardItems({ view: isArchive.value ? 'archive' : 'all' })
})
</script>

<template>
  <div class="clipboard-page">
    <ClipboardToolbar :is-archive="isArchive" :total-items="totalItems" @upload="upload.triggerFileUpload" @new-clip="keyboard.toggleQuickPaste" />
    <input :ref="upload.fileInputRef" type="file" style="display:none" multiple @change="upload.handleFileUpload" />

    <ClipboardFilterBar
      :is-archive="isArchive"
      :show-filter-panel="showFilterPanel"
      @toggle-filter-panel="toggleFilterPanel"
      @batch-delete="ops.handleBatchDelete"
      @batch-unarchive="ops.handleBatchUnarchive"
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
      :current-level="protectionDialogItem?.metadata?.protected ? 'advanced' : (protectionDialogItem?.metadata?.sensitive ? 'pin' : 'none')"
      :item-name="protectionDialogItem?.content || ''"
      :is-unlocked="itemPw.isUnlocked(protectionDialogItem?.id || '')"
      @protected="onProtectionProtected"
      @unprotected="onProtectionUnprotected"
      @unlocked="onProtectionUnlocked"
    />

    <div class="clipboard-view" role="region" :aria-label="t('nav_clipboard')" @scroll="onClipboardScroll">
      <div v-if="isLoading && filteredItems.length === 0" class="skeleton-wrap" :aria-label="t('ver_loading')" role="status">
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
              @share="(item) => { ops.shareItem(item); ctx.closeMore() }"
              @reveal="(item) => { ops.revealFileFolder(item); ctx.closeMore() }"
              @open-protection="(item) => { openProtectionDialog(item); ctx.closeMore() }"
              @archive-toggle="(item) => { ops.onArchiveToggle(item); ctx.closeMore() }"
              @expiry-from-dropdown="ctx.openExpiryFromDropdown"
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
          <ClipboardList :size="48" style="color:var(--text-tertiary)" />
        </div>
        <h3 class="empty-title">{{ isArchive ? t('archive_empty_title') : t('empty_title') }}</h3>
        <p class="empty-desc">{{ isArchive ? t('archive_empty_desc') : t('empty_desc') }}</p>
        <div v-if="!isArchive" class="empty-hints">
          <div class="empty-hint">
            <Copy :size="14" class="empty-hint-icon" />
            <span>{{ t('empty_hint_copy') }}</span>
          </div>
          <div class="empty-hint">
            <svg class="empty-hint-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8"/></svg>
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
  </div>
</template>

<style scoped>
.clipboard-page { display: flex; flex-direction: column; height: 100%; }
.clipboard-view { flex: 1; overflow-y: auto; padding: 0; }
.table-wrapper { border: none; border-radius: 0; overflow: visible; }
.load-more-wrap { display: flex; justify-content: center; padding: 16px 0 28px; }
.load-more-wrap :deep(button) { padding-left: 22px !important; padding-right: 22px !important; }
.clipboard-view :deep(table) { border-collapse: separate; border-spacing: 0; width: 100%; }
.clipboard-view :deep(thead tr) { border-bottom: 1px solid var(--border-default); }
.clipboard-view :deep(thead th) {
  padding: 10px 16px; text-align: center; font-weight: 500; font-size: 12px;
  color: var(--text-tertiary); background: var(--bg-surface);
  position: sticky; top: 0; z-index: 1;
}
.clipboard-view :deep(tbody tr) { border-bottom: 1px solid var(--border-subtle); transition: background .12s ease; }
.clipboard-view :deep(tbody tr:hover) { background: var(--bg-hover); }
.clipboard-view :deep(tbody tr.focused) { background: var(--accent-light); box-shadow: inset 3px 0 0 var(--accent); }
.clipboard-view :deep(tbody tr.focused:hover) { background: var(--accent-light); }
.clipboard-view :deep(tbody tr:last-child) { border-bottom-color: transparent; }
.clipboard-view :deep(tbody td) { padding: 8px 16px; vertical-align: middle; }

.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 80px 20px; text-align: center; }
.empty-icon-wrap { width: 64px; height: 64px; border-radius: 16px; background: var(--bg-hover); display: flex; align-items: center; justify-content: center; margin-bottom: 16px; }
.empty-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.empty-desc { font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.empty-hints { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
.empty-hint { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); }
.empty-hint-icon { flex-shrink: 0; color: var(--text-tertiary); }
.empty-action { font-size: 13px; color: var(--accent); margin-top: 16px; font-weight: 500; }

.skeleton-wrap { padding: 0; }
.skeleton-row { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid var(--border-subtle); }
.sk { border-radius: var(--radius-sm); background: var(--bg-hover); animation: skeleton-pulse 1.5s ease-in-out infinite; }
.sk-checkbox { width: 18px; height: 18px; flex-shrink: 0; border-radius: 4px; }
.sk-content { flex: 1; height: 20px; max-width: 40%; }
.sk-source { width: 80px; height: 14px; flex-shrink: 0; }
.sk-badge { width: 52px; height: 22px; flex-shrink: 0; border-radius: 9999px; }
.sk-time { width: 48px; height: 14px; flex-shrink: 0; }
.sk-actions { width: 100px; height: 14px; flex-shrink: 0; }
@keyframes skeleton-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
