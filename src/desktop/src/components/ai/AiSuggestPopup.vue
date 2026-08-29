<script setup lang="ts">
import { ref, computed, watch, onUnmounted, onBeforeUnmount } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { useI18n } from '@/composables/useI18n'
import {
  getProviders,
  suggestClipboardBatch,
  type ClipSuggestion,
  type ClipSuggestionItem,
  type SuggestBatchItem,
} from '@/api/ai'
import { Sparkles, X, Heart, Archive, Trash2, Loader2, Tag, Check, ChevronDown, ChevronUp } from 'lucide-vue-next'

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
  /** 当前条目是否已收藏（用于跳过"建议收藏"按钮） */
  isFavorite?: boolean
}

const props = defineProps<{
  open: boolean
  /** 整批输入（N 条） */
  items: SuggestInputItem[]
  /** 现有收藏夹名称 */
  collections?: string[]
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
const { tf, tMsg } = useI18n()

/** 后端/协议层可能回传 i18n key；统一翻译，避免界面出现裸 key */
function errText(v?: string | null, fallback = ''): string {
  return tMsg(v, fallback) || fallback
}

const loading = ref(false)
const error = ref('')
/** key = itemId；value = 该条的建议 */
const suggestions = ref<Record<string, ClipSuggestion>>({})
const providerId = ref('')
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
const allExpanded = ref(true) // 默认全部展开，避免"还要手动展开才能看到完整建议"

// 全局统计
const totalCount = computed(() => props.items.length)
const suggestedCount = computed(() => Object.keys(suggestions.value).length)
const appliedCount = computed(() =>
  Object.values(applied.value).reduce(
    (n, m) => n + (m.favorited || m.archived || m.cleaned || (m.tags && m.tags.length) ? 1 : 0),
    0,
  ),
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
      error.value = errText(res.data.error, tf('ai_suggest_no_structured', 'AI 未返回结构化建议'))
    }
  } else {
    error.value = errText(res.error || res.data?.error, tf('ai_suggest_failed', '建议生成失败'))
  }
}

async function analyze() {
  if (loading.value) return
  await ensureProvider()
  if (!providerId.value) {
    error.value = tf('ai_suggest_no_provider', '请先在设置中添加 AI 供应商')
    return
  }
  const texts: SuggestBatchItem[] = props.items.map((it) => ({
    id: it.id,
    content: it.content || '',
    isFavorite: !!it.isFavorite,
  }))
  if (texts.length === 0) {
    error.value = tf('ai_suggest_no_text', '请先选中一条文本内容')
    return
  }
  loading.value = true
  error.value = ''
  suggestions.value = {}
  applied.value = {}
  expanded.value = {}
  // 只跑一次 AI 批量建议；不再做整批的相似度检测（之前只对第一条做，对批处理意义不大
  // 且每次重开弹窗都重跑导致"AI 建议重复"的体验问题）。
  try {
    await runBatch(texts)
  } catch (e: any) {
    error.value = errText(e?.message, tf('ai_suggest_failed', '建议生成失败'))
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
        error.value = ''
        applied.value = {}
        expandAll()
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

// 当 props.items 变化（即使 open 没变化）也重置展开态
watch(
  () => props.items.map((it) => it.id).join('|'),
  () => {
    if (props.open) expandAll()
  },
)

function expandAll() {
  const next: Record<string, boolean> = {}
  props.items.forEach((it) => (next[it.id] = true))
  expanded.value = next
  allExpanded.value = true
}
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

// ===== C8②：Esc / 点击外部关闭 =====
const popupEl = ref<HTMLElement | null>(null)
onClickOutside(popupEl, () => {
  if (props.open) emit('close')
})
function onWindowKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !props.open) return
  // 仅在弹窗打开时消费 Esc；捕获阶段拦截，避免冒泡到全局 Esc 仲裁（B3 已收归 HomeView）
  e.stopPropagation()
  e.preventDefault()
  emit('close')
}
window.addEventListener('keydown', onWindowKeydown, true)
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown, true))
</script>

<template>
  <Teleport to="body">
    <Transition name="suggest-float">
      <div v-if="open" ref="popupEl" class="ai-suggest-popup">
        <!-- Header -->
        <div class="ai-suggest-head">
          <div class="ai-suggest-title">
            <Sparkles class="w-4 h-4 ai-suggest-title-icon" />
            <span>{{ tf('ai_suggest_title', 'AI 建议') }}</span>
            <span class="ai-suggest-counter">
              <template v-if="loading">
                <Loader2 :size="11" class="animate-spin" />
                <span>{{ tf('ai_suggest_loading', '分析中…') }}</span>
              </template>
              <template v-else>
                <span>{{ suggestedCount }}/{{ totalCount }}</span>
                <template v-if="appliedCount > 0">
                  <span class="ai-suggest-counter-sep">·</span>
                  <span class="ai-suggest-counter-applied">{{
                    tf('ai_suggest_applied_n', `已应用 ${appliedCount}`, { n: appliedCount })
                  }}</span>
                </template>
              </template>
            </span>
          </div>
          <div class="ai-suggest-head-actions">
            <button
              v-if="hasAnySuggestion && !loading"
              class="ai-suggest-icon-btn"
              :title="allExpanded ? tf('ai_suggest_collapse_all', '全部收起') : tf('ai_suggest_expand_all', '全部展开')"
              @click="toggleAll"
            >
              <ChevronDown v-if="!allExpanded" :size="14" />
              <ChevronUp v-else :size="14" />
            </button>
            <button class="ai-suggest-icon-btn" :title="tf('cancel_btn', '关闭')" @click="emit('close')">
              <X :size="14" />
            </button>
          </div>
        </div>

        <!-- Loading -->
        <div v-if="loading" class="ai-suggest-status">
          <Loader2 class="w-4 h-4 animate-spin ai-suggest-status-icon" />
          <span>{{ tf('ai_suggest_loading', 'AI 正在分析 N 条内容…') }}</span>
        </div>

        <!-- Error -->
        <div v-else-if="error" class="ai-suggest-status ai-suggest-status--error">
          <span>{{ tMsg(error) }}</span>
        </div>

        <!-- Body: list of suggestion cards -->
        <div v-else-if="hasAnySuggestion" class="ai-suggest-body">
          <div
            v-for="input in props.items"
            :key="input.id"
            class="ai-suggest-card"
            :class="{
              'ai-suggest-card--collapsed': !expanded[input.id],
              'ai-suggest-card--applied':
                applied[input.id]?.favorited ||
                applied[input.id]?.archived ||
                applied[input.id]?.cleaned ||
                (applied[input.id]?.tags && applied[input.id].tags!.length),
            }"
          >
            <button class="ai-suggest-card-head" @click="toggleExpanded(input.id)">
              <div class="ai-suggest-card-preview">
                <span class="ai-suggest-card-snippet">
                  {{ (input.preview || input.content || '').slice(0, 80) }}
                </span>
              </div>
              <div class="ai-suggest-card-tags">
                <!-- 收藏状态 pill：已收藏→"已收藏"，未收藏→AI 建议（值得 / 不值得） -->
                <span v-if="input.isFavorite" class="ai-suggest-card-pill ai-suggest-card-pill--fav-existed">
                  <Heart :size="11" fill="currentColor" />
                  <span>{{ tf('ai_suggest_applied_fav', '已收藏') }}</span>
                </span>
                <span
                  v-else-if="suggestions[input.id]"
                  class="ai-suggest-card-pill"
                  :class="
                    suggestions[input.id].worth_favorite ? 'ai-suggest-card-pill--fav' : 'ai-suggest-card-pill--neutral'
                  "
                >
                  <Heart :size="11" />
                  <span>{{
                    suggestions[input.id].worth_favorite
                      ? tf('ai_suggest_fav_yes', '建议收藏')
                      : tf('ai_suggest_fav_no', '不收藏')
                  }}</span>
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
                    :is="
                      suggestions[input.id].action === 'cleanup'
                        ? Trash2
                        : suggestions[input.id].action === 'archive'
                          ? Archive
                          : Sparkles
                    "
                    :size="11"
                  />
                  <span>
                    {{
                      suggestions[input.id].action === 'cleanup'
                        ? tf('ai_suggest_btn_cleanup', '清理')
                        : suggestions[input.id].action === 'archive'
                          ? tf('ai_suggest_btn_archive', '归档')
                          : tf('ai_suggest_btn_keep', '保留')
                    }}
                  </span>
                </span>
                <span
                  v-if="
                    applied[input.id]?.favorited ||
                    applied[input.id]?.archived ||
                    applied[input.id]?.cleaned ||
                    (applied[input.id]?.tags && applied[input.id].tags!.length)
                  "
                  class="ai-suggest-card-applied"
                >
                  <Check :size="11" />
                  <span>{{ tf('ai_suggest_applied', '已应用') }}</span>
                </span>
              </div>
              <component
                :is="expanded[input.id] ? ChevronUp : ChevronDown"
                :size="14"
                class="ai-suggest-card-chevron"
              />
            </button>

            <!-- 展开：详情 + 操作 -->
            <div v-if="expanded[input.id]" class="ai-suggest-card-body">
              <!-- 收藏建议行：已收藏的条目跳过整行（已收藏没必要再建议收藏） -->
              <div v-if="!input.isFavorite && suggestions[input.id]" class="ai-suggest-row">
                <Heart
                  :size="13"
                  :class="suggestions[input.id].worth_favorite ? 'ai-suggest-fav-yes' : 'ai-suggest-fav-no'"
                />
                <div class="ai-suggest-row-text">
                  <span class="ai-suggest-row-label">
                    {{
                      suggestions[input.id].worth_favorite
                        ? tf('ai_suggest_fav_yes', '建议收藏')
                        : tf('ai_suggest_fav_no', '不值得收藏')
                    }}
                  </span>
                  <span class="ai-suggest-row-reason">{{ suggestions[input.id].reason }}</span>
                  <span
                    v-if="suggestions[input.id].worth_favorite && suggestions[input.id].suggested_collection"
                    class="ai-suggest-row-collection"
                  >
                    {{
                      tf('ai_suggest_collection_hint', `建议归入「${suggestions[input.id].suggested_collection}」`, {
                        name: suggestions[input.id].suggested_collection || '',
                      })
                    }}
                  </span>
                </div>
                <button
                  v-if="suggestions[input.id].worth_favorite && !applied[input.id]?.favorited"
                  class="ai-suggest-btn ai-suggest-btn--primary"
                  @click="onFavorite(input.id)"
                >
                  <Heart :size="12" />
                  <span>{{ tf('ai_suggest_btn_favorite', '收藏') }}</span>
                </button>
                <span v-else-if="applied[input.id]?.favorited" class="ai-suggest-applied-tag">
                  <Check :size="12" />
                  <span>{{ tf('ai_suggest_applied_fav', '已收藏') }}</span>
                </span>
              </div>
              <!-- 已收藏条目：显示一个静态标识行，避免出现"建议收藏"按钮的奇怪行为 -->
              <div v-else-if="input.isFavorite" class="ai-suggest-row">
                <Heart :size="13" class="ai-suggest-fav-yes" :fill="'currentColor'" />
                <div class="ai-suggest-row-text">
                  <span class="ai-suggest-row-label">{{ tf('ai_suggest_applied_fav', '已收藏') }}</span>
                  <span class="ai-suggest-row-reason">{{
                    tf('ai_suggest_already_favorited_hint', '该条目已加入收藏，无需重复操作')
                  }}</span>
                </div>
              </div>

              <!-- 动作建议行 -->
              <div v-if="suggestions[input.id]" class="ai-suggest-row">
                <component
                  :is="
                    suggestions[input.id].action === 'cleanup'
                      ? Trash2
                      : suggestions[input.id].action === 'archive'
                        ? Archive
                        : Sparkles
                  "
                  :size="13"
                  class="ai-suggest-action-icon"
                />
                <div class="ai-suggest-row-text">
                  <span class="ai-suggest-row-label">
                    {{
                      suggestions[input.id].action === 'cleanup'
                        ? tf('ai_suggest_btn_cleanup', '清理')
                        : suggestions[input.id].action === 'archive'
                          ? tf('ai_suggest_btn_archive', '归档')
                          : tf('ai_suggest_btn_keep', '保留')
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
                  <span>{{ tf('ai_suggest_btn_archive', '归档') }}</span>
                </button>
                <button
                  v-else-if="suggestions[input.id].action === 'cleanup' && !applied[input.id]?.cleaned"
                  class="ai-suggest-btn ai-suggest-btn--danger"
                  @click="onCleanup(input.id)"
                >
                  <Trash2 :size="12" />
                  <span>{{ tf('ai_suggest_btn_cleanup', '清理') }}</span>
                </button>
                <span
                  v-else-if="applied[input.id]?.archived || applied[input.id]?.cleaned"
                  class="ai-suggest-applied-tag"
                >
                  <Check :size="12" />
                  <span>{{
                    applied[input.id]?.archived
                      ? tf('ai_suggest_applied_archive', '已归档')
                      : tf('ai_suggest_applied_cleanup', '已清理')
                  }}</span>
                </span>
              </div>

              <!-- 标签建议行：仅在「值得收藏」时显示（不值得收藏的条目打标签无意义） -->
              <div
                v-if="suggestions[input.id]?.worth_favorite && suggestions[input.id]?.suggested_tags?.length"
                class="ai-suggest-row"
              >
                <Tag :size="13" class="ai-suggest-action-icon" />
                <div class="ai-suggest-row-text">
                  <span class="ai-suggest-row-label">{{ tf('ai_suggest_tags_label', '推荐标签') }}</span>
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
                  <span>{{ tf('ai_suggest_btn_tags', '应用') }}</span>
                </button>
                <span v-else class="ai-suggest-applied-tag">
                  <Check :size="12" />
                  <span>{{
                    tf('ai_suggest_applied_tags', `已应用 ${applied[input.id]?.tags?.length} 个标签`, {
                      n: applied[input.id]?.tags?.length || 0,
                    })
                  }}</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Empty -->
        <div v-else class="ai-suggest-status">
          <span>{{ tf('ai_suggest_empty', '无可用建议') }}</span>
        </div>

        <!-- Footer hint -->
        <div v-if="hasAnySuggestion && !loading" class="ai-suggest-foot">
          <span>{{ tf('ai_suggest_foot_hint', '点击行展开详情；操作后自动标记已应用，可继续处理下一条') }}</span>
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
  width: 440px;
  max-width: calc(100vw - 40px);
  /* 5+ 条全部展开需要更大空间；弹窗顶部空间 ≈ 88+40=128px，屏幕减去顶部空间 = 92vh 给 body 留够。
     同时给 overflow 留余地避免完全顶到屏幕边缘。 */
  max-height: calc(100vh - 128px);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 14px;
  box-shadow:
    0 16px 40px rgba(0, 0, 0, 0.22),
    0 2px 8px rgba(0, 0, 0, 0.06);
  z-index: calc(var(--z-overlay) + 20);
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
  color: var(--success);
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
  transition:
    background 0.15s,
    color 0.15s;
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
  overflow-x: hidden;
  background: var(--bg-surface);
  /* 自定义滚动条：Windows 上很多浏览器默认滚动条太细不明显 */
  scrollbar-width: thin;
  scrollbar-color: var(--border-default) transparent;
}
.ai-suggest-body::-webkit-scrollbar {
  width: 8px;
}
.ai-suggest-body::-webkit-scrollbar-track {
  background: transparent;
}
.ai-suggest-body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--text-tertiary) 35%, transparent);
  border-radius: 999px;
}
.ai-suggest-body::-webkit-scrollbar-thumb:hover {
  background: var(--text-tertiary);
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
  color: var(--danger);
}

/* ============ 一条建议卡片 ============ */
.ai-suggest-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  overflow: hidden;
  transition:
    border-color 0.15s,
    opacity 0.2s;
}
.ai-suggest-card:hover {
  border-color: color-mix(in srgb, var(--accent) 25%, var(--border-default));
}
.ai-suggest-card--collapsed .ai-suggest-card-body {
  display: none;
}
.ai-suggest-card--applied {
  opacity: 0.72;
  background: color-mix(in srgb, var(--success) 4%, var(--bg-surface));
  border-color: color-mix(in srgb, var(--success) 18%, var(--border-default));
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
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}
.ai-suggest-card-pill--warn {
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  color: var(--warning);
}
.ai-suggest-card-pill--archive {
  background: color-mix(in srgb, var(--info) 14%, transparent);
  color: var(--info);
}
.ai-suggest-card-pill--neutral {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}
.ai-suggest-card-pill--fav-existed {
  /* 已收藏条目：固定标识，与"AI 建议收藏"区分开 */
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent);
  font-weight: 600;
}
.ai-suggest-card-applied {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  font-size: 10.5px;
  font-weight: 600;
  border-radius: 999px;
  background: color-mix(in srgb, var(--success) 14%, transparent);
  color: var(--success);
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
.ai-suggest-fav-yes {
  color: var(--danger);
}
.ai-suggest-fav-no {
  color: var(--text-tertiary);
}
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
  color: var(--accent-foreground);
}
.ai-suggest-btn--primary:hover {
  background: var(--accent-hover);
  filter: brightness(1.05);
}
.ai-suggest-btn--danger {
  border-color: var(--danger);
  color: var(--danger);
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
  background: color-mix(in srgb, var(--success) 14%, transparent);
  color: var(--success);
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
  background: color-mix(in srgb, var(--success) 18%, var(--accent-bg));
  color: var(--success);
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
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.suggest-float-enter-from,
.suggest-float-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}
</style>
