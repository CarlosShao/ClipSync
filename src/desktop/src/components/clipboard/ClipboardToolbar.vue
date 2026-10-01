<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { useI18n } from '@/composables/useI18n'
import { useClipboard, type ClipboardFilter } from '@/composables/useClipboard'
import { useSearchHistory } from '@/composables/useSearchHistory'
import SearchHistoryDropdown from './SearchHistoryDropdown.vue'
import {
  Upload,
  Plus,
  Search,
  Filter,
  X,
  Trash2,
  ArchiveRestore,
  Sparkles,
  Star,
  Type,
  Link2,
  Code2,
  Image as ImageIcon,
  FileText,
  CircleCheck,
  Archive,
  Calendar,
  History,
  Wifi,
} from 'lucide-vue-next'
import { Trash2 as TrashIcon } from 'lucide-vue-next'
import { getClipboardStats, type ClipboardStats } from '@/api/clipboard'
import { useDevice } from '@/composables/useDevice'
import CountUp from '@/components/fx/CountUp.vue'
import FxRubberSegment from '@/components/fx/FxRubberSegment.vue'
import FxJellyRadio from '@/components/fx/FxJellyRadio.vue'
import FxSpotlightCard from '@/components/fx/FxSpotlightCard.vue'
import StarBorder from '@/components/fx/StarBorder.vue'

defineProps<{
  view: 'timeline' | 'fav' | 'archive'
  showFilterPanel: boolean
  aiEnabled?: boolean
  summaryActive?: boolean
}>()
const emit = defineEmits<{
  upload: []
  'new-clip': []
  'set-view': [view: 'timeline' | 'fav' | 'archive']
  'toggle-filter-panel': []
  'batch-delete': []
  'batch-unarchive': []
  'batch-ai-suggest': []
  'batch-favorite': []
  'cleanup-history': []
  'summarize-today': []
}>()

const { t, tf } = useI18n()
const clip = useClipboard()
const sh = useSearchHistory()
const device = useDevice()

// 原型 v1 统计卡：今日/昨日/本周/收藏/置顶（服务端聚合），总数变化即刷新
const stats = ref<ClipboardStats | null>(null)
async function refreshStats() {
  const s = await getClipboardStats()
  if (s) stats.value = s
}
onMounted(refreshStats)
watch(
  () => clip.totalItems.value,
  () => refreshStats(),
)
const onlineDeviceCount = computed(() => device.devices.value.filter((d) => d.online).length)
const todayDelta = computed(() => {
  const s = stats.value
  if (!s) return ''
  const d = s.today - s.yesterday
  return d >= 0 ? `+${d} ${tf('stats_vs_yesterday', '较昨日')}` : `${d} ${tf('stats_vs_yesterday', '较昨日')}`
})

const batchMode = computed(() => clip.batchMode.value)
const allSelected = computed(() => clip.allSelected.value)

const CHIP_ICONS: Record<string, any> = { text: Type, images: ImageIcon, links: Link2, files: FileText }

// fx/SpotlightCard 光斑色：accent 低透明度，DOM 侧可直接用 color-mix（不需要走 canvas 那套 rgb 解析）
const STAT_SPOT = 'color-mix(in srgb, var(--accent) 13%, transparent)'
// fx/StarBorder 绕边光色：登录页同一套配方（accent 70% 混白，1-2px 边缘缝里才看得见）
const CTA_GLOW = 'color-mix(in srgb, var(--accent) 70%, white)'

// 历史下拉显隐：聚焦显示、失焦延迟关闭（确保下拉项 mousedown 先触发）
const showHistory = ref(false)

// 类型 chips（与 useClipboard.activeFilter 对齐）
const filterOptions = computed(() => [
  { value: 'all' as const, label: t('tab_all') },
  { value: 'text' as const, label: t('tab_text') },
  { value: 'images' as const, label: t('tab_images') },
  { value: 'links' as const, label: t('tab_links') },
  { value: 'files' as const, label: t('tab_files') },
])

// 视图切换分段项（Rubber Segment 的 items）：取值与 emit('set-view') 对齐
const viewSegItems = computed(() => [
  { value: 'timeline', label: t('view_timeline', '时间流') },
  { value: 'fav', label: t('view_fav_only', '仅收藏') },
  { value: 'archive', label: t('nav_archive') },
])

// 条目类型 chips 的 items（Jelly Radio）：与 CHIP_ICONS 对齐，图标是 lucide 组件
const chipItems = computed(() =>
  filterOptions.value.map((o) => ({ value: o.value as string, label: o.label, icon: CHIP_ICONS[o.value] })),
)

const activeFilter = computed(() => clip.activeFilter.value)
const selectedCount = computed(() => clip.selectedCount.value)
const searchInput = ref(clip.searchQuery.value)

// 与全局 searchQuery 双向同步（外部清空时输入框也要清空）
watch(
  () => clip.searchQuery.value,
  (q) => {
    if (q !== searchInput.value) searchInput.value = q
  },
)

function onSearchFocus() {
  showHistory.value = true
  sh.load()
}

function onSearchBlur() {
  // 延迟关闭，确保下拉项 mousedown 能先触发
  setTimeout(() => {
    showHistory.value = false
  }, 150)
}

// 输入防抖 300ms，避免每敲一个字母都打后端；用 id 标记避免与立即提交/清空竞态。
let searchSessionId = 0
const debouncedSetSearch = useDebounceFn((id: number, q: string) => {
  if (id !== searchSessionId) return
  clip.setSearch(q)
}, 300)

watch(searchInput, (q) => {
  searchSessionId++
  debouncedSetSearch(searchSessionId, q)
})

async function commitSearch(kw?: string) {
  searchSessionId++ // 废弃可能正在 pending 的防抖调用
  const keyword = (kw ?? searchInput.value).trim()
  if (!keyword) return
  searchInput.value = keyword
  clip.setSearch(keyword)
  await sh.record(keyword) // 失败已在 composable 内 console.warn
}

function pickHistory(kw: string) {
  searchInput.value = kw
  commitSearch(kw)
}

function clearSearch() {
  searchSessionId++ // 废弃可能正在 pending 的防抖调用
  searchInput.value = ''
  clip.clearSearch()
}
</script>

<template>
  <!-- v2 原型排版：page-head（标题/副题/动作） + 筛选行（搜索 + 类型 chips + 视图分段 + 批量） -->
  <div class="page-inner">
    <div class="page-head">
      <div>
        <div class="page-eyebrow">Clipboard Stream</div>
        <div class="page-title page-title--big">{{ t('nav_clipboard') }}</div>
        <div class="page-sub">{{ t('page_sub_clip', '跨设备实时同步 · 本地加密存储 · 保留 30 天') }}</div>
      </div>
      <div class="page-acts">
        <button
          v-if="view !== 'archive' && aiEnabled"
          type="button"
          class="pl-btn"
          :class="{ 'pl-btn--on': summaryActive }"
          :aria-pressed="summaryActive ? 'true' : 'false'"
          @click="emit('summarize-today')"
        >
          <Sparkles :size="14" /><span>{{ tf('summarize_today', '总结今日动态') }}</span>
        </button>
        <button v-if="view !== 'archive'" type="button" class="pl-btn" @click="emit('cleanup-history')">
          <TrashIcon :size="14" /><span>{{ tf('cleanup_history', '清理历史') }}</span>
        </button>
        <button v-if="view !== 'archive'" type="button" class="pl-btn" @click="emit('upload')">
          <Upload :size="14" /><span>{{ t('upload_file') }}</span>
        </button>
        <!-- fx/StarBorder：主 CTA 绕边流光（登录页同款，速度放慢一档避免抢注意力） -->
        <StarBorder
          v-if="view !== 'archive'"
          as="div"
          custom-class="toolbar-cta-border"
          :color="CTA_GLOW"
          speed="5s"
          :thickness="2"
          border-radius="var(--radius-sm)"
        >
          <button type="button" class="pl-btn pl-btn--acc toolbar-cta" @click="emit('new-clip')">
            <Plus :size="14" /><span>{{ t('new_clip') }}</span>
          </button>
        </StarBorder>
      </div>
    </div>

    <!-- 原型 v1 统计卡：真实服务端数据；fx/SpotlightCard 给每张卡加光标聚光 -->
    <div class="clip-stats reveal-stagger">
      <FxSpotlightCard class="clip-stat" :spotlight-color="STAT_SPOT" :radius="150">
        <span class="clip-stat-k"><Calendar :size="12" />{{ tf('stats_today', '今日新增') }}</span>
        <span class="clip-stat-v"
          ><CountUp v-if="stats?.today != null" :key="stats.today" :to="stats.today" :duration="0.9" /><template v-else
            >—</template
          ><em>{{ tf('stats_unit_tiao', '条') }}</em></span
        >
        <span class="clip-stat-d">{{ todayDelta }}</span>
      </FxSpotlightCard>
      <FxSpotlightCard class="clip-stat" :spotlight-color="STAT_SPOT" :radius="150">
        <span class="clip-stat-k"><History :size="12" />{{ tf('stats_week', '本周累计') }}</span>
        <span class="clip-stat-v"
          ><CountUp v-if="stats?.week != null" :key="stats.week" :to="stats.week" :duration="0.9" /><template v-else
            >—</template
          ><em>{{ tf('stats_unit_tiao', '条') }}</em></span
        >
        <span class="clip-stat-d">{{ tf('stats_week_sub', '自然周 · 实时同步') }}</span>
      </FxSpotlightCard>
      <FxSpotlightCard class="clip-stat" :spotlight-color="STAT_SPOT" :radius="150">
        <span class="clip-stat-k"><Star :size="12" />{{ t('nav_favorites') }}</span>
        <span class="clip-stat-v"
          ><CountUp
            v-if="stats?.favorites != null"
            :key="stats.favorites"
            :to="stats.favorites"
            :duration="0.9"
          /><template v-else>—</template><em>{{ tf('stats_unit_tiao', '条') }}</em></span
        >
        <span class="clip-stat-d">{{ tf('stats_fav_sub', '{n} 条置顶', { n: stats?.pinned ?? 0 }) }}</span>
      </FxSpotlightCard>
      <FxSpotlightCard class="clip-stat" :spotlight-color="STAT_SPOT" :radius="150">
        <span class="clip-stat-k"><Wifi :size="12" />{{ tf('stats_devices', '在线设备') }}</span>
        <span class="clip-stat-v"
          ><CountUp :key="onlineDeviceCount" :to="onlineDeviceCount" :duration="0.9" /><em>{{
            tf('stats_unit_tai', '台')
          }}</em></span
        >
        <span class="clip-stat-d">{{ tf('stats_dev_sub', '端到端加密 · 实时同步') }}</span>
      </FxSpotlightCard>
    </div>

    <div class="clip-filter-row">
      <div class="pl-search clip-search">
        <Search :size="14" />
        <input
          v-model="searchInput"
          type="text"
          :placeholder="t('search_ph')"
          :aria-label="t('search_ph')"
          @focus="onSearchFocus"
          @blur="onSearchBlur"
          @keyup.enter="commitSearch()"
        />
        <button
          v-if="searchInput.length > 0"
          type="button"
          class="clip-search-clear"
          :title="t('clear_search')"
          @click="clearSearch"
        >
          <X :size="13" />
        </button>
        <SearchHistoryDropdown
          v-if="showHistory"
          :keywords="sh.history.value"
          :loaded="sh.loaded.value"
          @pick="pickHistory"
          @clear="sh.clear"
        />
      </div>

      <!-- 条目类型筛选：Jelly Radio（vue-bits Micro/JellyRadio）—— 选中/悬停时胶囊有果冻回弹。
           配色沿用原 .chip 的 token（未选中 = --bg-surface / --text-secondary；
           选中 = --accent-light / --accent）。原来 .chip.active 的静态底色已撤掉（指示器唯一化）。 -->
      <FxJellyRadio
        class="clip-type-radio"
        size="sm"
        :swell="0.14"
        :gap="6"
        :radius="13"
        chip-color="var(--bg-surface)"
        active-color="var(--accent-light)"
        text-color="var(--text-secondary)"
        active-text-color="var(--accent)"
        :items="chipItems"
        :value="activeFilter"
        :aria-label="t('filter_label', '筛选') "
        @change="(v: string) => clip.setFilter(v as ClipboardFilter)"
      />

      <!-- 视图切换：Rubber Segment（vue-bits Micro/RubberSegment）—— 指示块带橡皮筋拉伸/挤压，
           拖拽与点击都能切换。原来 .seg 的静态 .active 白底已撤掉（指示器唯一化）。
           配色对齐原 .seg 用的 token：track=--bg-hover / thumb=--bg-surface。 -->
      <FxRubberSegment
        class="clip-view-seg"
        size="sm"
        :radius="6"
        :inset="2"
        track-color="var(--bg-hover)"
        thumb-color="var(--bg-surface)"
        text-color="var(--text-secondary)"
        active-text-color="var(--text-primary)"
        :items="viewSegItems"
        :value="view"
        :aria-label="t('nav_clipboard')"
        @change="(v: string) => emit('set-view', v as 'timeline' | 'fav' | 'archive')"
      />

      <button
        type="button"
        class="pl-icon-btn"
        :class="{ on: showFilterPanel }"
        :title="t('adv_filter')"
        @click="emit('toggle-filter-panel')"
      >
        <Filter :size="15" />
      </button>

      <!-- 原型：批量选择模式开关 -->
      <button
        type="button"
        class="pl-btn pl-btn--sm clip-batch-toggle"
        :class="{ 'pl-btn--acc': batchMode }"
        @click="clip.toggleBatch()"
      >
        <CircleCheck :size="13" /><span>{{ t('batch_select_btn', '批量选择') }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Jelly Radio 接入：对齐原 .chip 的外观与行高
   1) 原 chips 有 1px 边框，而组件的可视元素是内层 span → 补回来；选中态透明（同原 .chip.active）
   2) 组件根部为"果冻溢出"预留了上下内边距，会把工具栏行撑高 → 纵向归零（横向保留，避免溢出撞到邻居）
   3) lucide 图标默认 24px，原 chips 是 12px → 收窄 */
.clip-type-radio {
  padding-top: 0;
  padding-bottom: 0;
}
.clip-type-radio :deep(button > span) {
  border: 1px solid var(--border-default);
}
.clip-type-radio :deep(button[data-on='true'] > span) {
  border-color: transparent;
}
.clip-type-radio :deep(svg) {
  width: 12px;
  height: 12px;
}
.page-inner {
  /* flex 列容器内 margin auto 会 shrink-to-fit，必须显式撑满再由 max-width 收口 */
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  /* 顶部只留一口气：眉题贴近标题栏，不再大片留白 */
  padding: 10px 28px 0;
}
/* 原型 v1 统计卡 */
.clip-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  padding-bottom: 16px;
}
.clip-stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 14px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
}
/* fx/StarBorder 包住主 CTA：外层只负责 2px 光带，按钮外观仍是 .pl-btn--acc */
.toolbar-cta-border {
  display: inline-flex;
  flex: none;
}
.clip-stat-k {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-secondary);
}
.clip-stat-k svg {
  color: var(--text-tertiary);
}
.clip-stat-v {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.15;
  color: var(--text-primary);
  letter-spacing: -0.02em;
}
.clip-stat-v em {
  font-style: normal;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
  margin-left: 4px;
}
.clip-stat-d {
  font-size: 10.5px;
  color: var(--text-tertiary);
}
.clip-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 原型：搜索 + 类型 chips + 分段 + 批量选择 恒在一行 */
  flex-wrap: nowrap;
  padding-bottom: 16px;
}
.clip-search {
  flex: 1 1 200px;
  min-width: 150px;
  position: relative;
  height: 30px;
}
.clip-filter-row .chip {
  flex: none;
}
.clip-filter-row .seg {
  margin-left: auto;
  flex: none;
}
.clip-batch-toggle {
  height: 26px;
  flex: none;
}
.clip-search input {
  font-size: 12.5px;
}
.clip-search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.clip-search-clear:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
/* 「总结今日动态」卡片展开中的按钮态 */
.pl-btn--on {
  background: var(--accent-light);
  border-color: var(--accent);
  color: var(--accent);
}
</style>
