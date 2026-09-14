<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useClipboard, type ClipItem } from '@/composables/useClipboard'
import { clipViewSeg, batchMode } from '@/composables/clipboardState'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { deleteClips } from '@/api/clipboard'
import { useConfigStore } from '@/stores/configStore'
import { usePrivacy } from '@/composables/usePrivacy'
import { useFavoritePopover } from '@/composables/useFavoritePopover'
import { useClipItemDisplay } from '@/composables/useClipItemDisplay'
import { getCachedContent } from '@/composables/clipboardCache'
import { useClipboardActions } from '@/composables/useClipboardActions'
import { useClipboardOperations } from '@/composables/useClipboardOperations'
import { useClipboardKeyboard, setKeyboardLayer } from '@/composables/useClipboardKeyboard'
import { useContextMenu } from '@/composables/useContextMenu'
import { useFileUpload } from '@/composables/useFileUpload'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useProtectionDialog } from '@/composables/useProtectionDialog'
import { useItemPassword } from '@/composables/useItemPassword'
import { Upload, ClipboardList, AlertTriangle, RefreshCw, Sparkles, Star, Trash2, X, ArchiveRestore } from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import ProtectionDialog from '@/components/clipboard/ProtectionDialog.vue'
import ClipboardToolbar from '@/components/clipboard/ClipboardToolbar.vue'
import ClipboardFilterPanel from '@/components/clipboard/ClipboardFilterPanel.vue'
import ClipboardTableRow from '@/components/clipboard/ClipboardTableRow.vue'
import ClipDetailDrawer from '@/components/clipboard/ClipDetailDrawer.vue'
import ClipboardContextMenu from '@/components/clipboard/ClipboardContextMenu.vue'
import AiSuggestPopup from '@/components/ai/AiSuggestPopup.vue'
import InlineAiCard from '@/components/ai/InlineAiCard.vue'
import { useInlineAi } from '@/composables/useInlineAi'
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

const props = defineProps<{ mode?: 'default' | 'archive'; aiEnabled?: boolean }>()
const isArchive = computed(() => viewSeg.value === 'archive')
// 时间流视图启用 v1 时间线分组（置顶/今天/昨天/更早）
const isTimeline = computed(() => viewSeg.value === 'timeline')
// Clearline 页内视图分段（时间流/仅收藏/归档）——状态提升到 clipboardState（clipViewSeg），
// 轮询/同步刷新等无参 loadClipboardItems 才能沿用当前分段; 深链 /app/archive 通过 mode prop 落段。
const viewSeg = clipViewSeg
watch(
  () => props.mode,
  (m) => {
    viewSeg.value = m === 'archive' ? 'archive' : 'timeline'
  },
)
watch(viewSeg, () => reload())

const { t, tf } = useI18n()
const toast = useSonner()
const clip = useClipboard()
const configStore = useConfigStore()
const privacy = usePrivacy()
const itemPw = useItemPassword()
const fav = useFavoritePopover()
const display = useClipItemDisplay()

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
  confirmOpen,
  // 只负责通知 HomeView：面板开关的唯一真相源在 HomeView（setQuickPasteOpen），
  // 这里不再自己 toggle 一份本地 ref，否则一次按键会被 toggle 两次而互相抵消。
  toggleQuickPaste: () => emit('toggle-quick-paste'),
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

// === AI 主动建议（#230 方案 A 批量）：选中文本条目后，AI 一次给出 N 条建议 ===
const suggestOpen = ref(false)
const suggestItems = ref<{ id: string; content: string; preview?: string }[]>([])
const suggestCollectionNames = ref<string[]>([])
// 弹窗 ref（用于标记某条已应用）
const popupRef = ref<InstanceType<typeof import('@/components/ai/AiSuggestPopup.vue').default> | null>(null)

function openAiSuggest() {
  const selected = clip.items.value.filter((i) => i.selected && i.type === 'text' && (i.content || '').trim())
  if (selected.length === 0) {
    toast.show(t('ai_suggest_no_text'), 'error')
    return
  }
  // 批量建议：支持 N 条（N≤20，后端硬限），弹窗是列表卡片
  suggestItems.value = selected.map((i) => ({
    id: i.id,
    content: (i.content || i.preview || '').slice(0, 4000),
    preview: i.preview || (i.content || '').slice(0, 120),
    // 已收藏条目不再走"建议收藏"按钮（弹窗里隐藏该按钮 + 后端 system prompt 也跳过）
    isFavorite: !!(i as any).isFavorite,
  }))
  // 收藏夹名称（供 AI 建议分类时选择）
  try {
    const favs = localStorage.getItem('clipsync-favorites') || '[]'
    const arr = JSON.parse(favs)
    suggestCollectionNames.value = Array.isArray(arr) ? arr.map((f: any) => (typeof f === 'string' ? f : f?.name)).filter(Boolean) : []
  } catch {
    suggestCollectionNames.value = []
  }
  suggestOpen.value = true
}

function onSuggestClose() {
  suggestOpen.value = false
  // 不立刻清空 suggestItems，让关闭动画期间 popup 还能用
  setTimeout(() => {
    suggestItems.value = []
  }, 200)
}

function findItem(id: string): ClipItem | undefined {
  return clip.items.value.find((i) => i.id === id)
}

async function onSuggestFavorite(itemId: string) {
  const item = findItem(itemId)
  if (!item) return
  await clip.toggleFavorite(item)
  toast.show(t('clip_favorited'), 'success')
  popupRef.value?.markApplied(itemId, 'favorited')
}

async function onSuggestArchive(itemId: string) {
  const item = findItem(itemId)
  if (!item) return
  const ok = await clip.archiveItem(item)
  toast.show(ok ? t('archived_toast') : t('archive_fail'), ok ? 'success' : 'error')
  if (ok) popupRef.value?.markApplied(itemId, 'archived')
}

function onSuggestCleanup(itemId: string) {
  const item = findItem(itemId)
  if (!item) return
  // 复用单条删除流程（含确认框 + 敏感条目保护），弹窗保持打开，删除完成后标记
  ops.handleSingleDelete(item, () => {
    // 删除成功的回调（由 ops.handleSingleDelete 触发）；标记已应用
    popupRef.value?.markApplied(itemId, 'cleaned')
  })
}

// 应用 AI 推荐的标签（#235）：PUT /api/clipboard/:id 写 metadata.tags，并同步本地 item
async function onSuggestTags(itemId: string, tags: string[]) {
  const item = findItem(itemId)
  if (!item || !tags.length) return
  const ok = await api('PUT', `/api/clipboard/${item.id}`, { metadata: { tags } })
  if (ok.ok) {
    if (item.metadata) item.metadata.tags = tags
    else item.metadata = { tags }
    ;(item as any).tags = tags
    toast.show(t('ai_suggest_tags_applied', { n: tags.length }) || `已应用 ${tags.length} 个标签`, 'success')
    popupRef.value?.markApplied(itemId, 'tags', tags)
  } else {
    toast.show(ok.error || t('clip_tag_fail'), 'error')
  }
}

const filteredItems = computed(() => clip.filteredItems.value)
const isLoading = computed(() => clip.loading.value)
const totalItems = computed(() => clip.totalItems.value)
const hasMore = computed(() => clip.hasMore.value)
const loadingMore = computed(() => clip.loadingMore.value)
// 加载失败：与"确实没有数据"区分开，渲染错误态 + 重试按钮
const loadError = computed(() => clip.loadError.value)
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

function reload() {
  if (viewSeg.value === 'fav') {
    clip.loadClipboardItems({ view: 'all', favorite: true })
  } else {
    clip.loadClipboardItems({ view: viewSeg.value === 'archive' ? 'archive' : 'all' })
  }
}

// v2 原型：点击条目 → 右侧详情抽屉（替代原预览弹窗入口）
const drawerItem = ref<ClipItem | null>(null)
function openDrawer(item: ClipItem) {
  drawerItem.value = item
}
function closeDrawer() {
  drawerItem.value = null
}
const { copyWithPinCheck, onCopyItem } = actions
function onDrawerCopy(item: ClipItem) {
  copyWithPinCheck(item)
}
function onDrawerDelete(item: ClipItem) {
  closeDrawer()
  ops.handleSingleDelete(item)
}
watch(drawerItem, (v) => {
  // 抽屉打开时冻结列表快捷键，Esc 只关抽屉
  setKeyboardLayer('modal', !!v)
})
function onDrawerKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && drawerItem.value) {
    e.stopPropagation()
    closeDrawer()
  }
}
window.addEventListener('keydown', onDrawerKeydown, true)
onUnmounted(() => window.removeEventListener('keydown', onDrawerKeydown, true))

function onDrawerAi(action: string, item: ClipItem) {
  const body = getCachedContent(item.id) || item.content || ''
  window.dispatchEvent(new CustomEvent('clipsync:toggle-ai'))
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('clipsync:ai-send-message', { detail: { content: `${action}：
${body.slice(0, 2000)}` } }))
  }, 120)
}

// 原型行内 AI 按钮：默认按「总结」处理（与详情抽屉首个原位 AI 动作一致）
function onRowAi(item: ClipItem) {
  onDrawerAi(t('ai_act_summary', '总结'), item)
}

// A1「总结今日动态」内联结果卡：页内弹出，不进侧栏消息流
const todaySummary = useInlineAi()
const showTodaySummary = ref(false)

function runTodaySummary() {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const todayItems = filteredItems.value.filter((i) => i.timestamp >= startOfToday.getTime())
  const body = todayItems
    .slice(0, 40)
    .map((i, n) => `${n + 1}. [${i.type}] ${(i.content || '').slice(0, 80)}`)
    .join('\n')
  if (!body) {
    toast.show(tf('summarize_empty', '今天还没有剪贴记录'), 'info')
    return
  }
  showTodaySummary.value = true
  todaySummary.run(
    '请根据以下今日剪贴板条目摘要，总结今天的工作动态：按主题归类列出要点，最后给一句整体小结。中文输出，简明扼要。',
    body,
  )
}

function onSummarizeToday() {
  // 卡片已展开时再次点击 = 收起
  if (showTodaySummary.value) {
    closeTodaySummary()
    return
  }
  runTodaySummary()
}

function closeTodaySummary() {
  showTodaySummary.value = false
  todaySummary.reset()
}

// 原型 v1「清理历史」：把超过历史上限设置（configStore.maxHistory）的旧记录批量删除。
// 铁律：已收藏 / 已置顶的条目一律保留，绝不进入清理名单。
// 服务端分页硬上限 100（validatePagination），须按 100/页拉取超限尾段；
// 列表按 置顶→时间 倒序，尾段即最旧记录。计数在开确认框之前算好，弹窗里展示真实数字。
const cleanupConfirm = ref(false)
const cleanupPlanned = ref<{ ids: string[]; skipped: number } | null>(null)
let cleanupPlanning = false
const cleanupMsg = computed(() => {
  const planned = cleanupPlanned.value
  if (!planned) return ''
  const limit = Math.max(1, Number(configStore.maxHistory) || 500)
  if (planned.skipped > 0) {
    return tf('cleanup_confirm_msg_skip', '将删除超出历史上限（{limit} 条）的 {n} 条旧记录（另有 {m} 条收藏/置顶记录会保留），删除后不可恢复。确定继续吗？', { limit, n: planned.ids.length, m: planned.skipped })
  }
  return tf('cleanup_confirm_msg', '将删除超出历史上限（{limit} 条）的 {n} 条旧记录，且不可恢复。确定继续吗？', { limit, n: planned.ids.length })
})
async function onCleanupHistory() {
  const limit = Math.max(1, Number(configStore.maxHistory) || 500)
  if (cleanupPlanning) return
  if (totalItems.value <= limit) {
    toast.show(tf('cleanup_under_limit', '当前共 {total} 条，未超过历史上限 {limit} 条，无需清理', { total: totalItems.value, limit }), 'info')
    return
  }
  cleanupPlanning = true
  try {
    const PAGE = 100
    const ids: string[] = []
    let skipped = 0
    let page = Math.floor(limit / PAGE) + 1
    for (;;) {
      const res = await api('GET', `/api/clipboard?page=${page}&limit=${PAGE}`)
      if (!res.ok) throw new Error(res.error || 'fetch failed')
      const items: Array<{ id?: string; isFavorite?: boolean; metadata?: { pinned?: unknown } }> = res.data?.items || []
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        if (!it?.id) continue
        if (it.isFavorite === true || String(it.metadata?.pinned ?? '') === 'true') {
          skipped++
          continue
        }
        if ((page - 1) * PAGE + i >= limit) ids.push(it.id)
      }
      if (items.length < PAGE) break
      page++
    }
    if (!ids.length) {
      toast.show(tf('cleanup_none_found', '超限部分均为收藏/置顶记录，没有可清理的条目'), 'info')
      return
    }
    cleanupPlanned.value = { ids, skipped }
    cleanupConfirm.value = true
  } catch (e: any) {
    toast.show(e?.message || tf('cleanup_fail', '清理失败'), 'error')
  } finally {
    cleanupPlanning = false
  }
}
async function doCleanupHistory() {
  const ids = cleanupPlanned.value?.ids || []
  if (!ids.length) return
  try {
    for (let i = 0; i < ids.length; i += 100) {
      await deleteClips(ids.slice(i, i + 100))
    }
    toast.show(tf('cleanup_done', '已清理 {n} 条超出上限的记录', { n: ids.length }), 'success')
    cleanupPlanned.value = null
    reload()
  } catch (e: any) {
    toast.show(e?.message || tf('cleanup_fail', '清理失败'), 'error')
  }
}

// 原型 v1 时间线分组：置顶 / 今天 / 昨天 / 更早（置顶由服务端排序置前）
// 非时间流视图（收藏/归档）返回单一无标题分节，渲染等价于平铺
const timelineSections = computed(() => {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const startOfYesterday = startOfToday.getTime() - 86_400_000
  const flat = !isTimeline.value
  const sections: { label: string; items: ClipItem[] }[] = []
  let cur = ''
  for (const it of filteredItems.value) {
    const label = flat
      ? ''
      : it.pinned
        ? t('timeline_pin', '置顶')
        : it.timestamp >= startOfToday.getTime()
          ? t('timeline_today', '今天')
          : it.timestamp >= startOfYesterday
            ? t('timeline_yesterday', '昨天')
            : t('timeline_earlier', '更早')
    if (label !== cur) {
      sections.push({ label, items: [] })
      cur = label
    }
    sections[sections.length - 1].items.push(it)
  }
  return sections
})
// 键盘 ↑↓ 聚焦仍按平铺序号：建 id -> 全局序号 映射
const flatIndexMap = computed(() => {
  const m = new Map<string, number>()
  filteredItems.value.forEach((it, i) => m.set(it.id, i))
  return m
})

onMounted(() => {
  fav.loadCollections()
  reload()
})

watch(
  () => props.mode,
  () => {
    reload()
  },
)

// === 键盘层级栈：把本组件的弹层登记到全局 'modal' 层 ===
// 登记后：① 列表快捷键（↑↓/Enter/Delete）在弹层打开时被冻结；
// ② HomeView 的 Esc 仲裁知道有弹层在，不会越过它去关底层。
watch(
  [confirmOpen, protectionDialogOpen, suggestOpen],
  () => {
    const open = !!(confirmOpen.value || protectionDialogOpen.value || suggestOpen.value)
    setKeyboardLayer('modal', open)
  },
  { immediate: true },
)

onUnmounted(() => {
  // 卸载时必须撤下，否则残留的 true 会永久冻结列表快捷键
  setKeyboardLayer('modal', false)
})
</script>

<template>
  <div class="clipboard-page">
    <input :ref="upload.fileInputRef" type="file" style="display: none" multiple @change="upload.handleFileUpload" />

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
      <!-- 工具栏置于滚动容器内：与卡片共用同一居中宽度（滚动条不引起错位） -->
      <ClipboardToolbar
        :view="viewSeg"
        :show-filter-panel="showFilterPanel"
        :ai-enabled="props.aiEnabled"
        :summary-active="showTodaySummary"
        @cleanup-history="onCleanupHistory"
        @summarize-today="onSummarizeToday"
        @set-view="(v: 'timeline' | 'fav' | 'archive') => (viewSeg = v)"
        @upload="upload.triggerFileUpload"
        @new-clip="keyboard.toggleQuickPaste"
        @toggle-filter-panel="toggleFilterPanel"
        @batch-delete="ops.handleBatchDelete"
        @batch-unarchive="ops.handleBatchUnarchive"
        @batch-favorite="ops.handleBatchFavorite"
        @batch-ai-suggest="openAiSuggest"
      />
      <!-- A1 内联结果卡：总结今日动态（页内弹出，不进侧栏消息流） -->
      <InlineAiCard
        v-if="showTodaySummary"
        class="today-summary-card"
        :title="tf('inline_ai_summarize_today', '总结今日动态')"
        :status="todaySummary.status.value"
        :text="todaySummary.text.value"
        :error="todaySummary.error.value"
        closable
        @close="closeTodaySummary"
        @retry="runTodaySummary"
      />
      <!-- 原型 .batch-bar：批量选择模式吸附条 -->
      <div v-if="batchMode" class="batch-bar clip-batchbar">
        <label>
          <input type="checkbox" class="cbx" :checked="clip.allSelected.value" @change="clip.toggleSelectAll()" />{{ t('batch_select_all', '全选') }}
        </label>
        <span class="sel-info">{{ tf('batch_selected_n', '已选 {n} 项', { n: clip.selectedCount.value }) }}</span>
        <span class="clip-batchbar-grow" />
        <template v-if="!isArchive">
          <button type="button" class="pl-btn pl-btn--sm" :disabled="clip.selectedCount.value === 0" @click="ops.handleBatchFavorite()">
            <Star :size="12" />{{ t('batch_favorite_btn') || '收藏' }}
          </button>
          <button type="button" class="pl-btn pl-btn--sm" :disabled="clip.selectedCount.value === 0" @click="openAiSuggest()">
            <Sparkles :size="12" />{{ t('ai_suggest_btn_batch') || 'AI 建议' }}
          </button>
          <button type="button" class="pl-btn pl-btn--sm pl-btn--danger" :disabled="clip.selectedCount.value === 0" @click="ops.handleBatchDelete()">
            <Trash2 :size="12" />{{ t('batch_delete_short') || '删除' }}
          </button>
        </template>
        <template v-else>
          <button type="button" class="pl-btn pl-btn--sm" :disabled="clip.selectedCount.value === 0" @click="ops.handleBatchUnarchive()">
            <ArchiveRestore :size="12" />{{ t('unarchive_selected_btn') || '恢复' }}
          </button>
          <button type="button" class="pl-btn pl-btn--sm pl-btn--danger" :disabled="clip.selectedCount.value === 0" @click="ops.handleBatchDelete()">
            <Trash2 :size="12" />{{ t('batch_delete_short') || '删除' }}
          </button>
        </template>
        <button type="button" class="pl-btn pl-btn--sm" style="background: transparent; border-color: transparent; box-shadow: none" @click="clip.toggleBatch()">
          <X :size="12" />{{ t('cancel_btn') }}
        </button>
      </div>
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

      <!-- 加载失败：必须可重试，且不能伪装成"暂无内容" -->
      <div v-else-if="loadError && filteredItems.length === 0" class="error-state">
        <div class="error-icon-wrap">
          <AlertTriangle :size="48" style="color: var(--danger)" />
        </div>
        <h3 class="error-title">{{ t('load_failed_title') }}</h3>
        <p class="error-desc">{{ t('load_failed_desc') }}</p>
        <p v-if="loadError" class="error-detail">{{ loadError }}</p>
        <Button variant="outline" size="sm" class="error-retry-btn" :disabled="isLoading" @click="reload">
          <RefreshCw :size="14" class="error-retry-icon" />
          <span>{{ t('retry_btn') }}</span>
        </Button>
      </div>

      <div v-else-if="filteredItems.length > 0" class="table-wrapper">
        <div class="clip-list" role="list" :aria-label="t('nav_clipboard')">
          <template v-for="sec in timelineSections" :key="sec.label || 'flat'">
            <!-- 原型 v1 分节头：置顶 / 今天 / 昨天 / 更早 -->
            <div v-if="sec.label" class="clip-group">
              <b>{{ sec.label }}</b><span class="n">{{ sec.items.length }}</span>
            </div>
            <ClipboardTableRow
              v-for="item in sec.items"
              :key="item.id"
              role="listitem"
              :item="item"
              :focused="flatIndexMap.get(item.id) === focusedIndex"
              :is-archive="isArchive"
              :more-open-id="ctx.moreOpenId"
              :selecting="batchMode"
              @focus="focusedIndex = flatIndexMap.get(item.id) ?? -1"
            @click="openDrawer"
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
            @version-history="
              (item) => {
                emit('version-history', item)
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
            @ai="onRowAi"
            @pin-toggle="clip.togglePinned"
          />
          </template>
        </div>

        <div v-if="hasMore" class="load-more">
          <Button variant="outline" size="sm" :disabled="loadingMore" @click="clip.loadMore()">
            <span v-if="loadingMore">{{ t('loading_more') }}</span>
            <span v-else>{{ t('load_more') }}</span>
          </Button>
          <span class="rem">{{ tf('more_rem', '还有 {n} 条 · 共 {total} 条', { n: remaining, total: totalItems }) }}</span>
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

    <!-- 原型 v1 清理历史：二次确认 -->
    <ConfirmDialog
      :open="cleanupConfirm"
      :title="tf('cleanup_confirm_title', '清理历史记录')"
      :message="cleanupMsg"
      :confirm-text="tf('cleanup_confirm_btn', '清理')"
      :confirm-variant="'destructive'"
      @update:open="(v: boolean) => (cleanupConfirm = v)"
      @confirm="doCleanupHistory"
    />

    <!-- v2 原型：条目详情抽屉 -->
    <ClipDetailDrawer
      :item="drawerItem"
      @close="closeDrawer"
      @copy="onDrawerCopy"
      @toggle-fav="clip.toggleFavorite"
      @delete="onDrawerDelete"
      @ai="onDrawerAi"
    />

    <!-- AI 主动建议（#230 批量）：选中文本条目后给出收藏/分类/清理建议 -->
    <AiSuggestPopup
      ref="popupRef"
      :open="suggestOpen"
      :items="suggestItems"
      :collections="suggestCollectionNames"
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
.clip-list {
  display: block;
}
/* A1 内联 AI 结果卡：与工具栏留出间距。
   注意：通用规则 .clipboard-view > * 的 28px 内边距会被卡片自带背景画出
   （与批量条当年同坑），这里用双类名提权覆盖为 1024 可视宽度，与列表卡片对齐 */
.clipboard-view > .today-summary-card.today-summary-card {
  max-width: 1024px;
  padding-left: 0;
  padding-right: 0;
  margin-top: 10px;
}
/* 与工具栏 page-inner 对齐：同一 1080 栅格 */
.clipboard-view > *:not(.table-wrapper) {
  max-width: 1080px;
  margin-left: auto;
  margin-right: auto;
  padding-left: 28px;
  padding-right: 28px;
}
/* 批量条背景盒与卡片可视宽度一致（1024 居中），不再左右外扩 */
.clipboard-view > .batch-bar {
  max-width: 1024px;
  margin-left: auto;
  margin-right: auto;
  padding-left: 10px;
  padding-right: 10px;
}
.clipboard-view > .table-wrapper {
  max-width: 1080px;
  margin-left: auto;
  margin-right: auto;
  padding: 0 28px 28px;
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

.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  text-align: center;
}
.error-icon-wrap {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  background: var(--danger-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}
.error-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 6px;
}
.error-desc {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.error-detail {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 6px;
  max-width: 460px;
  word-break: break-all;
}
.error-retry-btn {
  margin-top: 18px;
  gap: 6px !important;
  padding-left: 18px !important;
  padding-right: 18px !important;
}
.error-retry-icon {
  flex-shrink: 0;
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
