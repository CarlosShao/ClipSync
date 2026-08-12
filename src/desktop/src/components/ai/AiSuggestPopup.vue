<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import {
  getProviders,
  suggestClipboardBatch,
  similarityCheck,
  type ClipSuggestion,
  type ClipSuggestionItem,
  type SuggestBatchItem,
  type DuplicateHit,
  type SimilarityCandidate,
} from '@/api/ai'
import {
  Sparkles,
  X,
  Heart,
  Archive,
  Trash2,
  Loader2,
  Tag,
  CopyX,
  Check,
  ChevronDown,
  ChevronUp,
} from 'lucide-vue-next'

/**
 * AiSuggestPopup — 主动建议（#230 升级为方案 A 批量）：
 *   选中 N 条文本条目后，AI 一次给出 N 条结构化建议（收藏/分类/清理/标签），
 *   弹窗展示为列表；每行可独立应用收藏/归档/清理/标签，不互相干扰；
 *   已应用的行标记为「已应用」灰态，弹窗不自动关闭，便于一气呵成处理一批。
 *
 * 同时保留单条语义相似度检测（#236），整批维度展示。
 */
interface SuggestInputItem extends SuggestBatchItem {
  /** 前端用来定位 ClipItem + 预览 */
  preview?: string
}

const props = defineProps<{
  open: boolean
  /** 整批输入（N 条） */
  items: SuggestInputItem[]
  /** 现有收藏夹名称 */
  collections?: string[]
  /** 语义相似度检测候选（#236）：最近 N 条非当前条目的 id+文本 */
  candidates?: SimilarityCandidate[]
}>()
const emit = defineEmits<{
  close: []
  /** 一键收藏：传 itemId（前端 ClipItem.id） */
  'apply-favorite': [itemId: string]
  /** 一键归档 */
  'apply-archive': [itemId: string]
  /** 一键清理（删除） */
  'apply-cleanup': [itemId: string]
  /** 一键应用标签：itemId + tags */
  'apply-tags': [itemId: string, tags: string[]]
}>()
const { t } = useI18n()

const loading = ref(false)
const error = ref('')
/** key = itemId；value = 该条的建议 */
const suggestions = ref<Record<string, ClipSuggestion>>({})
const providerId = ref('')
// 相似度检测：[{itemId, hits[]}]
const duplicatesMap = ref<Record<string, DuplicateHit[]>>({})
const dupChecking = ref(false)
// 已应用的标记（itemId -> 哪些操作已用）
interface AppliedMap {
  favorited?: boolean
  archived?: boolean
  cleaned?: boolean
  tags?: string[]
}
const applied = ref<Record<string, AppliedMap>>({})
// 每行的展开/折叠状态
const expanded = ref<Record<string, boolean>>({})
const allExpanded = ref(false)

// 全局统计
const totalCount = computed(() => props.items.length)
const suggestedCount = computed(() => Object.keys(suggestions.value).length)
const appliedCount = computed(() =>
  Object.values(applied.value).reduce((n, m) => n + (m.favorited || m.archived || m.cleaned || (m.tags && m.tags.length) ? 1 : 0), 0),
)

async function ensureProvider() {
  if (providerId.value) return
  const res = await getProviders()
  if (res.ok && res.data?.items?.length) {
    const p = res.data.items.find((x) => x.is_default) || res.data.items[0]
    providerId.value = p.id
  }
}

async function runBatch(texts: SuggestBatchItem[]) {
  const res = await suggestClipboardBatch({
    providerId: providerId.value,
    items: texts,
    collections: props.collections || [],
  })
  if (res.ok && res.data?.suggestions) {
    const map: Record<string, ClipSuggestion> = {}
    res.data.suggestions.forEach((it: ClipSuggestionItem) => {
      if (it.suggestion) map[it.id] = it.suggestion
    })
    suggestions.value = map
    if (Object.keys(map).length === 0) {
      error.value = res.data.error || 'AI 未返回结构化建议'
    }
  } else {
    error.value = res.error || res.data?.error || '建议生成失败'
  }
}

async function checkDuplicates(texts: SuggestBatchItem[]) {
  const cands = (props.candidates || []).slice(0, 10)
  if (!cands.length || !providerId.value || texts.length === 0) return
  dupChecking.value = true
  duplicatesMap.value = {}
  try {
    // 只对前 1 条做相似度检测（保持原 #236 体验：避免 N 次串行调用）
    // 如果以后要做"每条都对所有候选比对"，可改为 Promise.all
    const target = texts[0]
    const res = await similarityCheck({
      providerId: providerId.value,
      content: target.content,
      candidates: cands,
    })
    if (res.ok && res.data?.duplicates?.length) {
      duplicatesMap.value[target.id] = res.data.duplicates
    }
  } catch {
    duplicatesMap.value = {}
  } finally {
    dupChecking.value = false
  }
}

async function analyze() {
  if (loading.value) return
  await ensureProvider()
  if (!providerId.value) {
    error.value = t('ai_suggest_no_provider') || '请先在设置中添加 AI 供应商'
    return
  }
  const texts: SuggestBatchItem[] = props.items.map((it) => ({ id: it.id, content: it.content || '' }))
  if (texts.length === 0) {
    error.value = t('ai_suggest_no_text') || '请先选中一条文本内容'
    return
  }
  loading.value = true
  error.value = ''
  suggestions.value = {}
  duplicatesMap.value = {}
  applied.value = {}
  expanded.value = {}
  // 并行：批量建议 + 相似度检测
  checkDuplicates(texts)
  try {
    await runBatch(texts)
  } catch (e: any) {
    error.value = e?.message || '建议生成失败'
  } finally {
    loading.value = false
  }
}

// 打开即开始分析。open 由 false → true 时强制清空所有状态，必重跑。
let timer: ReturnType<typeof setTimeout> | null = null
watch(
  () => props.open,
  (open, prev) => {
    if (open) {
      if (!prev) {
        suggestions.value = {}
        loading.value = false
        duplicatesMap.value = {}
        dupChecking.value = false
        error.value = ''
        applied.value = {}
        expanded.value = {}
        allExpanded.value = false
        if (timer) clearTimeout(timer)
        timer = setTimeout(analyze, 60)
      }
    } else if (timer) {
      clearTimeout(timer)
      timer = null
    }
  },
  { immediate: true },
)
onUnmounted(() => {
  if (timer) clearTimeout(timer)
})

// 操作按钮：发出事件后由父组件执行真实动作，再回调标记 applied
function onFavorite(itemId: string) {
  emit('apply-favorite', itemId)
}
function onArchive(itemId: string) {
  emit('apply-archive', itemId)
}
function onCleanup(itemId: string) {
  emit('apply-cleanup', itemId)
}
function onTags(itemId: string, tags: string[]) {
  emit('apply-tags', itemId, tags)
}

function toggleExpanded(id: string) {
  expanded.value[id] = !expanded.value[id]
}
function toggleAll() {
  allExpanded.value = !allExpanded.value
  const next: Record<string, boolean> = {}
  props.items.forEach((it) => (next[it.id] = allExpanded.value))
  expanded.value = next
}

// 暴露方法供父组件标记已应用（避免父组件难找弹窗实例）
defineExpose({
  markApplied(itemId: string, kind: 'favorited' | 'archived' | 'cleaned' | 'tags', payload?: string[]) {
    if (!applied.value[itemId]) applied.value[itemId] = {}
    if (kind === 'tags') {
      applied.value[itemId].tags = payload || []
    } else {
      applied.value[itemId][kind] = true
    }
  },
})

const hasAnySuggestion = computed(() => Object.keys(suggestions.value).length > 0)
const duplicateEntries = computed(() => Object.entries(duplicatesMap.value))
</script>

<template>
  <Teleport to="body">
    <Transition name="suggest-float">
      <div v-if="open" class="ai-suggest-popup">
        <!-- Header -->
        <div class="ai-suggest-head">
          <div class="ai-suggest-title">
            <Sparkles class="w-4 h-4 ai-suggest-title-icon" />
            <span>{{ t('ai_suggest_title') || 'AI 建议' }}</span>
            <span class="ai-suggest-counter">
              <template v-if="loading">
                <Loader2 :size="11" class="animate-spin" />
                <span>{{ t('ai_suggest_loading') || '分析中…' }}</span>
              </template>
              <template v-else>
                <span>{{ suggestedCount }}/{{ totalCount }}</span>
                <template v-if="appliedCount > 0">
                  <span class="ai-suggest-counter-sep">·</span>
                  <span class="ai-suggest-counter-applied">{{ t('ai_suggest_applied_n', { n: appliedCount }) || `已应用 ${appliedCount}` }}</span>
                </template>
              </template>
            </span>
          </div>
          <div class="ai-suggest-head-actions">
            <button
              v-if="hasAnySuggestion && !loading"
              class="ai-suggest-icon-btn"
              :title="allExpanded ? (t('ai_suggest_collapse_all') || '全部收起') : (t('ai_suggest_expand_all') || '全部展开')"
              @click="toggleAll"
            >
              <ChevronDown v-if="!allExpanded" :size="14" />
              <ChevronUp v-else :size="14" />
            </button>
            <button class="ai-suggest-icon-btn" :title="t('cancel_btn') || '关闭'" @click="emit('close')">
              <X :size="14" />
            </button>
          </div>
        </div>

        <!-- Loading -->
        <div v-if="loading" class="ai-suggest-status">
          <Loader2 class="w-4 h-4 animate-spin ai-suggest-status-icon" />
          <span>{{ t('ai_suggest_loading') || 'AI 正在分析 N 条内容…' }}</span>
        </div>

        <!-- Error -->
        <div v-else-if="error" class="ai-suggest-status ai-suggest-status--error">
          <span>{{ error }}</span>
        </div>

        <!-- Body: list of suggestion cards -->
        <div v-else-if="hasAnySuggestion" class="ai-suggest-body">
          <!-- 整批维度的相似度检测 -->
          <div v-if="dupChecking" class="ai-suggest-dup-row">
            <Loader2 :size="13" class="animate-spin" />
            <span>{{ t('ai_suggest_dup_checking') || '正在检测重复内容…' }}</span>
          </div>
          <div v-else-if="duplicateEntries.length" class="ai-suggest-dup">
            <div class="ai-suggest-dup-head">
              <CopyX :size="13" />
              <span>
                {{ t('ai_suggest_dup_found_n', { n: duplicateEntries.reduce((s, [, h]) => s + h.length, 0) }) || `发现 ${duplicateEntries.reduce((s, [, h]) => s + h.length, 0)} 条可能重复的条目` }}
              </span>
            </div>
            <div v-for="[itemId, hits] in duplicateEntries" :key="itemId" class="ai-suggest-dup-list">
              <div v-for="h in hits" :key="h.id" class="ai-suggest-dup-item">
                <span class="ai-suggest-dup-degree" :class="h.degree === 'high' ? 'ai-suggest-dup-degree--high' : ''">
                  {{ h.degree === 'high' ? (t('ai_suggest_dup_high') || '高') : (t('ai_suggest_dup_medium') || '中') }}
                </span>
                <span class="ai-suggest-dup-reason">{{ h.reason }}</span>
              </div>
            </div>
          </div>

          <!-- 一行一条建议 -->
          <div
            v-for="input in props.items"
            :key="input.id"
            class="ai-suggest-card"
            :class="{
              'ai-suggest-card--collapsed': !expanded[input.id],
              'ai-suggest-card--applied': applied[input.id]?.favorited || applied[input.id]?.archived || applied[input.id]?.cleaned || (applied[input.id]?.tags && applied[input.id].tags!.length),
            }"
          >
            <button class="ai-suggest-card-head" @click="toggleExpanded(input.id)">
              <div class="ai-suggest-card-preview">
                <span class="ai-suggest-card-snippet">
                  {{ (input.preview || input.content || '').slice(0, 80) }}
                </span>
              </div>
              <div class="ai-suggest-card-tags">
                <span
                  v-if="suggestions[input.id]"
                  class="ai-suggest-card-pill"
                  :class="suggestions[input.id].worth_favorite ? 'ai-suggest-card-pill--fav' : 'ai-suggest-card-pill--neutral'"
                >
                  <Heart :size="11" />
                  <span>{{ suggestions[input.id].worth_favorite ? (t('ai_suggest_fav_yes') || '建议收藏') : (t('ai_suggest_fav_no') || '不收藏') }}</span>
                </span>
                <span
                  v-if="suggestions[input.id]"
                  class="ai-suggest-card-pill"
                  :class="{
                    'ai-suggest-card-pill--warn': suggestions[input.id].action === 'cleanup',
                    'ai-suggest-card-pill--archive': suggestions[input.id].action === 'archive',
                  }"
                >
                  <component
                    :is="suggestions[input.id].action === 'cleanup' ? Trash2 : suggestions[input.id].action === 'archive' ? Archive : Sparkles"
                    :size="11"
                  />
                  <span>
                    {{
                      suggestions[input.id].action === 'cleanup'
                        ? (t('ai_suggest_btn_cleanup') || '清理')
                        : suggestions[input.id].action === 'archive'
                          ? (t('ai_suggest_btn_archive') || '归档')
                          : (t('ai_suggest_btn_keep') || '保留')
                    }}
                  </span>
                </span>
                <span
                  v-if="applied[input.id]?.favorited || applied[input.id]?.archived || applied[input.id]?.cleaned || (applied[input.id]?.tags && applied[input.id].tags!.length)"
                  class="ai-suggest-card-applied"
                >
                  <Check :size="11" />
                  <span>{{ t('ai_suggest_applied') || '已应用' }}</span>
                </span>
              </div>
              <component :is="expanded[input.id] ? ChevronUp : ChevronDown" :size="14" class="ai-suggest-card-chevron" />
            </button>

            <!-- 展开：详情 + 操作 -->
            <div v-if="expanded[input.id]" class="ai-suggest-card-body">
              <!-- 收藏建议行 -->
              <div v-if="suggestions[input.id]" class="ai-suggest-row">
                <Heart :size="13" :class="suggestions[input.id].worth_favorite ? 'ai-suggest-fav-yes' : 'ai-suggest-fav-no'" />
                <div class="ai-suggest-row-text">
                  <span class="ai-suggest-row-label">
                    {{ suggestions[input.id].worth_favorite ? (t('ai_suggest_fav_yes') || '建议收藏') : (t('ai_suggest_fav_no') || '不值得收藏') }}
                  </span>
                  <span class="ai-suggest-row-reason">{{ suggestions[input.id].reason }}</span>
                  <span
                    v-if="suggestions[input.id].worth_favorite && suggestions[input.id].suggested_collection"
                    class="ai-suggest-row-collection"
                  >
                    {{ t('ai_suggest_collection_hint', { name: suggestions[input.id].suggested_collection }) || `建议归入「${suggestions[input.id].suggested_collection}」` }}
                  </span>
                </div>
                <button
                  v-if="suggestions[input.id].worth_favorite && !applied[input.id]?.favorited"
                  class="ai-suggest-btn ai-suggest-btn--primary"
                  @click="onFavorite(input.id)"
                >
                  <Heart :size="12" />
                  <span>{{ t('ai_suggest_btn_favorite') || '收藏' }}</span>
                </button>
                <span v-else-if="applied[input.id]?.favorited" class="ai-suggest-applied-tag">
                  <Check :size="12" />
                  <span>{{ t('ai_suggest_applied_fav') || '已收藏' }}</span>
                </span>
              </div>

              <!-- 动作建议行 -->
              <div v-if="suggestions[input.id]" class="ai-suggest-row">
                <component
                  :is="suggestions[input.id].action === 'cleanup' ? Trash2 : suggestions[input.id].action === 'archive' ? Archive : Sparkles"
                  :size="13"
                  class="ai-suggest-action-icon"
                />
                <div class="ai-suggest-row-text">
                  <span class="ai-suggest-row-label">
                    {{
                      suggestions[input.id].action === 'cleanup'
                        ? (t('ai_suggest_btn_cleanup') || '清理')
                        : suggestions[input.id].action === 'archive'
                          ? (t('ai_suggest_btn_archive') || '归档')
                          : (t('ai_suggest_btn_keep') || '保留')
                    }}
                  </span>
                  <span class="ai-suggest-row-reason">{{ suggestions[input.id].action_reason }}</span>
                </div>
                <button
                  v-if="suggestions[input.id].action === 'archive' && !applied[input.id]?.archived"
                  class="ai-suggest-btn"
                  @click="onArchive(input.id)"
                >
                  <Archive :size="12" />
                  <span>{{ t('ai_suggest_btn_archive') || '归档' }}</span>
                </button>
                <button
                  v-else-if="suggestions[input.id].action === 'cleanup' && !applied[input.id]?.cleaned"
                  class="ai-suggest-btn ai-suggest-btn--danger"
                  @click="onCleanup(input.id)"
                >
                  <Trash2 :size="12" />
                  <span>{{ t('ai_suggest_btn_cleanup') || '清理' }}</span>
                </button>
                <span v-else-if="applied[input.id]?.archived || applied[input.id]?.cleaned" class="ai-suggest-applied-tag">
                  <Check :size="12" />
                  <span>{{ applied[input.id]?.archived ? (t('ai_suggest_applied_archive') || '已归档') : (t('ai_suggest_applied_cleanup') || '已清理') }}</span>
                </span>
              </div>

              <!-- 标签建议行 -->
              <div v-if="suggestions[input.id]?.suggested_tags?.length" class="ai-suggest-row">
                <Tag :size="13" class="ai-suggest-action-icon" />
                <div class="ai-suggest-row-text">
                  <span class="ai-suggest-row-label">{{ t('ai_suggest_tags_label') || '推荐标签' }}</span>
                  <div class="ai-suggest-tags">
                    <span
                      v-for="tag in suggestions[input.id].suggested_tags"
                      :key="tag"
                      class="ai-suggest-tag-chip"
                      :class="{ 'ai-suggest-tag-chip--applied': applied[input.id]?.tags?.includes(tag) }"
                    >
                      #{{ tag }}
                    </span>
                  </div>
                </div>
                <button
                  v-if="!applied[input.id]?.tags?.length"
                  class="ai-suggest-btn ai-suggest-btn--primary"
                  @click="onTags(input.id, suggestions[input.id].suggested_tags)"
                >
                  <Tag :size="12" />
                  <span>{{ t('ai_suggest_btn_tags') || '应用' }}</span>
                </button>
                <span v-else class="ai-suggest-applied-tag">
                  <Check :size="12" />
                  <span>{{ t('ai_suggest_applied_tags', { n: applied[input.id]?.tags?.length || 0 }) || `已应用 ${applied[input.id]?.tags?.length} 个标签` }}</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Empty -->
        <div v-else class="ai-suggest-status">
          <span>{{ t('ai_suggest_empty') || '无可用建议' }}</span>
        </div>

        <!-- Footer hint -->
        <div v-if="hasAnySuggestion && !loading" class="ai-suggest-foot">
          <span>{{ t('ai_suggest_foot_hint') || '点击行展开详情；操作后自动标记已应用，可继续处理下一条' }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ai-suggest-popup {
  position: fixed;
  bottom: 88px;
  right: 20px;
  width: 420px;
  max-width: calc(100vw - 40px);
  max-height: min(86vh, 820px);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 14px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.22), 0 2px 8px rgba(0, 0, 0, 0.06);
  z-index: 120;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ============ Header ============ */
.ai-suggest-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: linear-gradient(180deg, var(--bg-surface) 0%, var(--bg-hover) 100%);
}
.ai-suggest-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
}
.ai-suggest-title-icon {
  color: var(--accent);
}
.ai-suggest-counter {
  margin-left: 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-tertiary);
  background: var(--bg-hover);
  padding: 2px 8px;
  border-radius: 999px;
}
.ai-suggest-counter-sep {
  opacity: 0.5;
}
.ai-suggest-counter-applied {
  color: var(--success, #10b981);
  font-weight: 600;
}
.ai-suggest-head-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.ai-suggest-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 0;
  background: transparent;
  border-radius: 6px;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.ai-suggest-icon-btn:hover {
  background: var(--bg-active);
  color: var(--text-primary);
}

/* ============ Body ============ */
.ai-suggest-body {
  flex: 1;
  min-height: 0; /* flex 子项不写 min-height: 0 会撑破父容器，导致 overflow 滚动条不出现 */
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  background: var(--bg-surface);
}

.ai-suggest-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 16px 18px;
  color: var(--text-secondary);
  font-size: 13px;
  background: var(--bg-surface);
}
.ai-suggest-status-icon {
  color: var(--accent);
}
.ai-suggest-status--error {
  color: var(--danger, #ef4444);
}

/* ============ 整批相似度检测 ============ */
.ai-suggest-dup-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 8px 12px;
  background: var(--bg-hover);
  border-radius: 8px;
}
.ai-suggest-dup {
  border-left: 3px solid var(--warning, #f59e0b);
  background: color-mix(in srgb, var(--warning, #f59e0b) 6%, transparent);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
}
.ai-suggest-dup-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--warning, #b45309);
  margin-bottom: 4px;
}
.ai-suggest-dup-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ai-suggest-dup-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-secondary);
}
.ai-suggest-dup-degree {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
  margin-top: 1px;
}
.ai-suggest-dup-degree--high {
  background: color-mix(in srgb, var(--warning, #f59e0b) 18%, transparent);
  color: var(--warning, #b45309);
}
.ai-suggest-dup-reason {
  line-height: 1.5;
  word-break: break-word;
}

/* ============ 一条建议卡片 ============ */
.ai-suggest-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  overflow: hidden;
  transition: border-color 0.15s, opacity 0.2s;
}
.ai-suggest-card:hover {
  border-color: color-mix(in srgb, var(--accent) 25%, var(--border-default));
}
.ai-suggest-card--collapsed .ai-suggest-card-body {
  display: none;
}
.ai-suggest-card--applied {
  opacity: 0.72;
  background: color-mix(in srgb, var(--success, #10b981) 4%, var(--bg-surface));
  border-color: color-mix(in srgb, var(--success, #10b981) 18%, var(--border-default));
}

.ai-suggest-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
}
.ai-suggest-card-preview {
  flex: 1;
  min-width: 0;
}
.ai-suggest-card-snippet {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12.5px;
  color: var(--text-primary);
  line-height: 1.4;
}
.ai-suggest-card-tags {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}
.ai-suggest-card-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  font-size: 10.5px;
  font-weight: 600;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-secondary);
  white-space: nowrap;
}
.ai-suggest-card-pill--fav {
  background: color-mix(in srgb, var(--danger, #f43f5e) 14%, transparent);
  color: var(--danger, #f43f5e);
}
.ai-suggest-card-pill--warn {
  background: color-mix(in srgb, var(--warning, #f59e0b) 14%, transparent);
  color: var(--warning, #b45309);
}
.ai-suggest-card-pill--archive {
  background: color-mix(in srgb, var(--info, #6366f1) 14%, transparent);
  color: var(--info, #6366f1);
}
.ai-suggest-card-pill--neutral {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}
.ai-suggest-card-applied {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  font-size: 10.5px;
  font-weight: 600;
  border-radius: 999px;
  background: color-mix(in srgb, var(--success, #10b981) 14%, transparent);
  color: var(--success, #059669);
}
.ai-suggest-card-chevron {
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.ai-suggest-card-body {
  padding: 4px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}

.ai-suggest-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12.5px;
}
.ai-suggest-row-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ai-suggest-row-label {
  font-weight: 600;
  color: var(--text-primary);
}
.ai-suggest-row-reason {
  color: var(--text-secondary);
  line-height: 1.5;
  word-break: break-word;
}
.ai-suggest-row-collection {
  color: var(--accent);
  font-size: 11.5px;
  margin-top: 2px;
}
.ai-suggest-fav-yes { color: var(--danger, #f43f5e); }
.ai-suggest-fav-no { color: var(--text-tertiary); }
.ai-suggest-action-icon {
  color: var(--text-secondary);
  flex-shrink: 0;
  margin-top: 1px;
}

.ai-suggest-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-default);
  background: transparent;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.15s;
}
.ai-suggest-btn:hover {
  background: var(--bg-hover);
}
.ai-suggest-btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-foreground, #fff);
}
.ai-suggest-btn--primary:hover {
  background: var(--accent-hover, var(--accent));
  filter: brightness(1.05);
}
.ai-suggest-btn--danger {
  border-color: var(--danger, #ef4444);
  color: var(--danger, #ef4444);
}
.ai-suggest-btn--danger:hover {
  background: var(--danger-bg);
}

.ai-suggest-applied-tag {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 600;
  background: color-mix(in srgb, var(--success, #10b981) 14%, transparent);
  color: var(--success, #059669);
}

.ai-suggest-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.ai-suggest-tag-chip {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-bg);
  border-radius: 999px;
  padding: 1px 8px;
  white-space: nowrap;
}
.ai-suggest-tag-chip--applied {
  background: color-mix(in srgb, var(--success, #10b981) 18%, var(--accent-bg));
  color: var(--success, #059669);
}

/* ============ Footer ============ */
.ai-suggest-foot {
  padding: 8px 14px;
  font-size: 11px;
  color: var(--text-tertiary);
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-hover);
  text-align: center;
}

/* ============ Transition ============ */
.suggest-float-enter-active,
.suggest-float-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.suggest-float-enter-from,
.suggest-float-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}
</style>