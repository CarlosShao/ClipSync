<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import {
  getProviders,
  suggestClipboard,
  similarityCheck,
  type ClipSuggestion,
  type DuplicateHit,
  type SimilarityCandidate,
} from '@/api/ai'
import { Sparkles, X, Heart, Archive, Trash2, Loader2, Tag, CopyX } from 'lucide-vue-next'

/**
 * AiSuggestPopup — 主动建议（#230）：选中剪贴板内容后，AI 主动给出
 * "是否值得收藏 / 建议分类 / 建议清理 / 智能标签"的结构化建议，并提供一键操作。
 * 同时做语义相似度检测（#236）：提示与已有条目的重复关系。
 */
const props = defineProps<{
  open: boolean
  /** 被分析的内容（文本） */
  content: string
  /** 现有收藏夹名称列表（用于建议分类） */
  collections?: string[]
  /** 语义重复检测候选（#236）：最近文本条目的 id+文本 */
  candidates?: SimilarityCandidate[]
}>()
const emit = defineEmits<{
  close: []
  /** 一键收藏 */
  'apply-favorite': []
  /** 一键归档 */
  'apply-archive': []
  /** 一键清理（删除） */
  'apply-cleanup': []
  /** 应用智能标签（#235） */
  'apply-tags': [tags: string[]]
}>()
const { t } = useI18n()

const loading = ref(false)
const error = ref('')
const suggestion = ref<ClipSuggestion | null>(null)
const providerId = ref('')
// 语义相似度检测结果（#236）
const duplicates = ref<DuplicateHit[]>([])
const dupChecking = ref(false)

async function ensureProvider() {
  if (providerId.value) return
  const res = await getProviders()
  if (res.ok && res.data?.items?.length) {
    const p = res.data.items.find((x) => x.is_default) || res.data.items[0]
    providerId.value = p.id
  }
}

// 语义重复检测（#236）：与候选条目比对，结果单独展示
async function checkDuplicates(text: string) {
  const cands = (props.candidates || []).slice(0, 10)
  if (!cands.length || !providerId.value) return
  dupChecking.value = true
  duplicates.value = []
  try {
    const res = await similarityCheck({
      providerId: providerId.value,
      content: text,
      candidates: cands,
    })
    if (res.ok && res.data?.duplicates?.length) {
      duplicates.value = res.data.duplicates
    }
  } catch {
    // 相似度检测失败不阻塞建议
    duplicates.value = []
  } finally {
    dupChecking.value = false
  }
}

async function analyze() {
  const text = (props.content || '').trim()
  if (!text || loading.value) return
  await ensureProvider()
  if (!providerId.value) {
    error.value = t('ai_suggest_no_provider') || '请先在设置中添加 AI 供应商'
    return
  }
  loading.value = true
  error.value = ''
  suggestion.value = null
  // 并行：建议 + 相似度检测
  checkDuplicates(text)
  try {
    const res = await suggestClipboard({
      providerId: providerId.value,
      content: text,
      collections: props.collections || [],
    })
    if (res.ok && res.data?.suggestion) {
      suggestion.value = res.data.suggestion
    } else {
      error.value = res.error || res.data?.error || '建议生成失败'
    }
  } catch (e: any) {
    error.value = e?.message || '建议生成失败'
  } finally {
    loading.value = false
  }
}

// 打开即开始分析。
// ⚠️ 关掉弹窗只关 open，suggestion/loading/duplicates 不能保留——
//   否则用户关弹窗→选别的条目→再开，会看到上轮建议。
//   必须在 open 由 false → true 时强制重置，再走 analyze。
let timer: ReturnType<typeof setTimeout> | null = null
watch(
  () => props.open,
  (open, prev) => {
    if (open) {
      // 关闭→打开：强制清掉上轮结果，触发新一轮分析
      if (!prev) {
        suggestion.value = null
        loading.value = false
        duplicates.value = []
        dupChecking.value = false
        error.value = ''
        if (timer) clearTimeout(timer)
        timer = setTimeout(analyze, 60)
      }
    } else {
      // 关闭时清掉定时器
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  },
  { immediate: true },
)

const actionLabel = computed(() => {
  if (!suggestion.value) return ''
  const s = suggestion.value
  if (s.action === 'archive') return t('ai_suggest_btn_archive') || '归档'
  if (s.action === 'cleanup') return t('ai_suggest_btn_cleanup') || '清理'
  return t('ai_suggest_btn_keep') || '保留'
})

const actionIcon = computed(() => {
  if (!suggestion.value) return Sparkles
  if (suggestion.value.action === 'archive') return Archive
  if (suggestion.value.action === 'cleanup') return Trash2
  return Sparkles
})

function applyAction() {
  if (!suggestion.value) return
  const s = suggestion.value
  if (s.action === 'archive') emit('apply-archive')
  else if (s.action === 'cleanup') emit('apply-cleanup')
  // keep：无动作，仅展示理由
}

function applyFavorite() {
  emit('apply-favorite')
}

function applyTags() {
  if (!suggestion.value?.suggested_tags?.length) return
  emit('apply-tags', suggestion.value.suggested_tags)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="suggest-float">
      <div v-if="open" class="ai-suggest-popup">
        <div class="ai-suggest-head">
          <div class="flex items-center gap-1.5 text-xs font-medium">
            <Sparkles class="w-3.5 h-3.5 text-accent" />
            <span>{{ t('ai_suggest_title') || 'AI 建议' }}</span>
          </div>
          <button class="p-1 rounded-md hover:bg-muted transition-colors" @click="emit('close')">
            <X class="w-3.5 h-3.5" />
          </button>
        </div>

        <!-- 加载中 -->
        <div v-if="loading" class="ai-suggest-body ai-suggest-loading">
          <Loader2 class="w-4 h-4 animate-spin" />
          <span>{{ t('ai_suggest_loading') || 'AI 正在分析内容…' }}</span>
        </div>

        <!-- 错误 -->
        <div v-else-if="error" class="ai-suggest-body ai-suggest-error">
          <span>{{ error }}</span>
        </div>

        <!-- 语义相似度检测（#236）：提示与已有条目重复 -->
        <div v-else-if="dupChecking" class="ai-suggest-body ai-suggest-dup-row">
          <Loader2 :size="13" class="animate-spin" />
          <span>{{ t('ai_suggest_dup_checking') || '正在检测重复内容…' }}</span>
        </div>
        <div v-else-if="duplicates.length" class="ai-suggest-body ai-suggest-dup">
          <div class="ai-suggest-dup-head">
            <CopyX :size="13" class="ai-suggest-dup-icon" />
            <span class="ai-suggest-dup-title">
              {{ t('ai_suggest_dup_found', { n: duplicates.length }) || `发现 ${duplicates.length} 条可能重复的条目` }}
            </span>
          </div>
          <div v-for="d in duplicates" :key="d.id" class="ai-suggest-dup-item">
            <span class="ai-suggest-dup-degree" :class="d.degree === 'high' ? 'ai-suggest-dup-degree--high' : ''">
              {{ d.degree === 'high' ? (t('ai_suggest_dup_high') || '高') : (t('ai_suggest_dup_medium') || '中') }}
            </span>
            <span class="ai-suggest-dup-reason">{{ d.reason }}</span>
          </div>
        </div>

        <!-- 建议内容 -->
        <div v-else-if="suggestion" class="ai-suggest-body">
          <!-- 收藏建议 -->
          <div class="ai-suggest-row">
            <Heart :size="13" :class="suggestion.worth_favorite ? 'ai-suggest-fav-yes' : 'ai-suggest-fav-no'" />
            <div class="ai-suggest-row-text">
              <span class="ai-suggest-row-label">
                {{ suggestion.worth_favorite ? (t('ai_suggest_fav_yes') || '建议收藏') : (t('ai_suggest_fav_no') || '不值得收藏') }}
              </span>
              <span class="ai-suggest-row-reason">{{ suggestion.reason }}</span>
              <span v-if="suggestion.worth_favorite && suggestion.suggested_collection" class="ai-suggest-row-collection">
                {{ t('ai_suggest_collection_hint', { name: suggestion.suggested_collection }) || `建议归入「${suggestion.suggested_collection}」` }}
              </span>
            </div>
            <button v-if="suggestion.worth_favorite" class="ai-suggest-btn ai-suggest-btn--primary" @click="applyFavorite">
              <Heart :size="12" /> {{ t('ai_suggest_btn_favorite') || '收藏' }}
            </button>
          </div>

          <!-- 动作建议 -->
          <div class="ai-suggest-row">
            <component :is="actionIcon" :size="13" class="ai-suggest-action-icon" />
            <div class="ai-suggest-row-text">
              <span class="ai-suggest-row-label">{{ actionLabel }}</span>
              <span class="ai-suggest-row-reason">{{ suggestion.action_reason }}</span>
            </div>
            <button
              v-if="suggestion.action !== 'keep'"
              class="ai-suggest-btn"
              :class="suggestion.action === 'cleanup' ? 'ai-suggest-btn--danger' : 'ai-suggest-btn--ghost'"
              @click="applyAction"
            >
              {{ actionLabel }}
            </button>
          </div>

          <!-- 智能标签（#235）：AI 推荐标签，一键应用 -->
          <div v-if="suggestion.suggested_tags?.length" class="ai-suggest-row">
            <Tag :size="13" class="ai-suggest-action-icon" />
            <div class="ai-suggest-row-text">
              <span class="ai-suggest-row-label">{{ t('ai_suggest_tags_label') || '推荐标签' }}</span>
              <div class="ai-suggest-tags">
                <span v-for="tag in suggestion.suggested_tags" :key="tag" class="ai-suggest-tag-chip">#{{ tag }}</span>
              </div>
            </div>
            <button class="ai-suggest-btn ai-suggest-btn--primary" @click="applyTags">
              <Tag :size="12" /> {{ t('ai_suggest_btn_tags') || '应用' }}
            </button>
          </div>
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
  width: 340px;
  max-width: calc(100vw - 40px);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  z-index: 120;
  overflow: hidden;
}
.ai-suggest-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 6px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-primary);
}
.ai-suggest-body {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 260px;
  overflow-y: auto;
}
.ai-suggest-loading,
.ai-suggest-error {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 12.5px;
}
.ai-suggest-error {
  color: var(--danger, #ef4444);
}
.ai-suggest-dup {
  border-left: 3px solid var(--warning, #f59e0b);
  background: color-mix(in srgb, var(--warning, #f59e0b) 6%, transparent);
  border-radius: 6px;
}
.ai-suggest-dup-row {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 12.5px;
}
.ai-suggest-dup-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--warning, #b45309);
}
.ai-suggest-dup-icon { flex-shrink: 0; }
.ai-suggest-dup-title { font-size: 12px; }
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
  padding: 0 5px;
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
}
.ai-suggest-fav-yes { color: var(--danger, #f43f5e); }
.ai-suggest-fav-no { color: var(--text-tertiary); }
.ai-suggest-action-icon { color: var(--text-secondary); flex-shrink: 0; margin-top: 1px; }
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
  cursor: pointer;
  transition: all 0.15s;
}
.ai-suggest-btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.ai-suggest-btn--primary:hover { opacity: 0.9; }
.ai-suggest-btn--ghost:hover { background: var(--bg-hover); }
.ai-suggest-btn--danger {
  border-color: var(--danger, #ef4444);
  color: var(--danger, #ef4444);
}
.ai-suggest-btn--danger:hover { background: rgba(239, 68, 68, 0.08); }
.ai-suggest-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
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
</style>
