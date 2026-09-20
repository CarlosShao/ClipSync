<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useMenuAccess } from '@/composables/useMenuAccess'
import {
  ArrowLeft,
  Settings2,
  Palette,
  Keyboard,
  Variable,
  Sparkles,
  Workflow,
  CreditCard,
  Database,
  ShieldCheck,
  Info,
  Search,
  X,
} from 'lucide-vue-next'
import GeneralSettings from './settings-dialog/GeneralSettings.vue'
import { useConfigStore } from '@/stores/configStore'
import AppearanceSettings from './settings-dialog/AppearanceSettings.vue'
import PrivacySettings from './settings-dialog/PrivacySettings.vue'
import DataSettings from './settings-dialog/DataSettings.vue'
import SubscriptionSettings from './settings-dialog/SubscriptionSettings.vue'
import TemplateVarsSettings from './settings-dialog/TemplateVarsSettings.vue'
import AboutView from './settings-dialog/AboutView.vue'
import AIProviderSettings from './settings-dialog/AIProviderSettings.vue'
import WorkflowRuleSettings from './settings-dialog/WorkflowRuleSettings.vue'
import ShortcutsSettings from './settings-dialog/ShortcutsSettings.vue'
import ThemeSubPage from './settings-dialog/sub-pages/ThemeSubPage.vue'
import ShortcutsSubPage from './settings-dialog/sub-pages/ShortcutsSubPage.vue'
import SecuritySubPage from './settings-dialog/sub-pages/SecuritySubPage.vue'
import SessionsSubPage from './settings-dialog/sub-pages/SessionsSubPage.vue'
import NotificationsSubPage from './settings-dialog/sub-pages/NotificationsSubPage.vue'
import ExportSubPage from './settings-dialog/sub-pages/ExportSubPage.vue'
import FeedbackSubPage from './settings-dialog/sub-pages/FeedbackSubPage.vue'
import PricingSubPage from './settings-dialog/sub-pages/PricingSubPage.vue'
import BillingSubPage from './settings-dialog/sub-pages/BillingSubPage.vue'
import InlineAiCard from '@/components/ai/InlineAiCard.vue'
import { useInlineAi } from '@/composables/useInlineAi'
import { useSettingsSearch } from './useSettingsSearch'

const { t, tf, currentLang } = useI18n()
const { can } = useMenuAccess()
const configStore = useConfigStore()

const props = defineProps<{ aiEnabled?: boolean }>()
// open-modal：设置内「当前套餐」子页（PricingSubPage）点开升级弹窗流时上抛，HomeView 绑定
const emit = defineEmits<{ 'open-modal': [type: string] }>()

// A5「审查设置」内联结果卡：设置快照交给 AI 逐项给风险与建议（结构化 JSON，可跳转分节），不跳侧栏
const reviewAi = useInlineAi()
const showReview = ref(false)
interface ReviewItem {
  key: string
  level: 'ok' | 'warn' | 'risk'
  advice: string
}
const reviewItems = ref<ReviewItem[] | null>(null)

// 快照行携带分节 key，供 AI 输出回填与「前往设置」跳转
const REVIEW_SNAPSHOT: { key: string; label: string; value: () => string }[] = [
  { key: 'general', label: '自动同步', value: () => (configStore.autoSync ? '开' : '关') },
  { key: 'general', label: '同步间隔', value: () => (configStore.syncInterval === 0 ? '实时' : configStore.syncInterval + ' 分钟') },
  { key: 'data', label: '历史上限', value: () => (configStore.maxHistory >= 999999 ? '不限' : configStore.maxHistory + ' 条') },
  { key: 'general', label: '图片压缩', value: () => (configStore.imageCompress ? '开' : '关') },
  { key: 'privacy', label: '隐私模式', value: () => (configStore.privacyMode ? '开' : '关') },
  { key: 'privacy', label: '失焦自动隐藏敏感内容', value: () => (configStore.autoBlur ? '开' : '关') },
  { key: 'general', label: '界面语言', value: () => (currentLang.value === 'zh' ? '中文' : 'English') },
]

function buildReviewContext(): string {
  return REVIEW_SNAPSHOT.map((r) => `- [${r.key}] ${r.label}: ${r.value()}`).join('\n')
}

/** 容错解析 AI 输出：剥 ```json 围栏 → 取首尾大括号；失败返回 null（降级纯文本） */
function parseReview(raw: string): ReviewItem[] | null {
  try {
    let s = String(raw || '').trim()
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) s = fence[1].trim()
    const start = s.indexOf('{')
    const end = s.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return null
    const obj = JSON.parse(s.slice(start, end + 1))
    if (!obj || !Array.isArray(obj.items)) return null
    const out: ReviewItem[] = []
    for (const it of obj.items) {
      if (!it || typeof it.key !== 'string' || typeof it.advice !== 'string') continue
      const level = it.level === 'warn' || it.level === 'risk' ? it.level : 'ok'
      out.push({ key: it.key, level, advice: it.advice })
    }
    return out.length ? out : null
  } catch {
    return null
  }
}

function runReview() {
  showReview.value = true
  reviewItems.value = null
  reviewAi.run(
    [
      '你是桌面端设置审查助手。以下是客户端设置快照，每行格式为「- [分节key] 设置名: 值」。',
      '请逐项检查是否存在风险或不合理之处（例如历史上限过小、隐私模式未开启但剪贴板常含敏感信息、同步间隔过长等）。',
      '只输出 JSON，不要任何解释文字或代码围栏，格式：',
      '{"items":[{"key":"分节key","level":"ok|warn|risk","advice":"一句话中文建议"}]}',
      'items 必须覆盖快照每一行；key 只能取行首方括号中的分节key；advice 为一句话中文建议，ok 项也给维持现状的肯定建议。',
    ].join('\n'),
    buildReviewContext(),
    { maxTokens: 4096 },
  ).then(() => {
    if (reviewAi.status.value === 'done') reviewItems.value = parseReview(reviewAi.text.value)
  })
}

function aiReview() {
  // 卡片已展开时再次点击 = 收起
  if (showReview.value) {
    closeReview()
    return
  }
  runReview()
}

function closeReview() {
  showReview.value = false
  reviewItems.value = null
  reviewAi.reset()
}

function gotoSection(key: string) {
  // 只允许跳到已知分节，防止 AI 幻觉 key 打破布局
  if (!sections.value.some((s) => s.key === key)) return
  scrollToSection(key)
}

// v2 原型（settings.html）：设置是「页面」而非弹窗 —— 左侧锚点导航 + 右侧全部分组堆叠滚动。
// 现有 dialog 组件原样迁入作为分组内容; 子页（ themes/security/... ）以页内替换视图呈现（返回即回）。
interface Section {
  key: string
  label: string
  desc: string
  icon: unknown
  gated?: boolean
}
const SECTION_ICONS: Record<string, unknown> = {
  general: Settings2,
  appearance: Palette,
  shortcuts: Keyboard,
  vars: Variable,
  ai: Sparkles,
  workflow: Workflow,
  subscription: CreditCard,
  data: Database,
  privacy: ShieldCheck,
  about: Info,
}
const sections = computed<Section[]>(() => {
  const all: Section[] = [
    { key: 'general', icon: Settings2, label: t('sg_gen'), desc: tf('set_d_general', '启动、语言与服务器连接') },
    { key: 'appearance', icon: Palette, label: t('sg_appear'), desc: tf('set_d_appearance', '主题、字号与界面风格') },
    { key: 'shortcuts', icon: Keyboard, label: t('sg_shortcuts'), desc: tf('set_d_shortcuts', '全局快捷键与录制') },
    { key: 'vars', icon: Variable, label: t('sg_tpl_vars', '模板变量'), desc: tf('set_d_vars', '模板变量的默认值管理') },
    { key: 'ai', icon: Sparkles, label: t('sg_ai'), desc: tf('set_d_ai', 'AI 模型与提供商配置'), gated: true },
    { key: 'workflow', icon: Workflow, label: t('sg_workflow', '自动化'), desc: tf('set_d_workflow', '剪贴自动化规则') },
    {
      key: 'subscription',
      icon: CreditCard,
      label: t('sg_sub_bill'),
      desc: tf('set_d_sub', '当前套餐与账单'),
      gated: true,
    },
    { key: 'data', icon: Database, label: t('sg_data'), desc: tf('set_d_data', '导出、导入与清理') },
    { key: 'privacy', icon: ShieldCheck, label: t('sg_privacy'), desc: tf('set_d_privacy', '密码、会话与通知偏好') },
    { key: 'about', icon: Info, label: t('sg_about'), desc: tf('set_d_about', '版本与许可') },
  ]
  return all.filter((s) => !s.gated || can(`settings.${s.key}`))
})

const activeSubPage = ref('')
const subPageRegistry: Record<string, string> = {
  themes: 'sg_theme',
  shortcuts: 'sg_kb_shortcuts',
  security: 'sg_2fa',
  sessions: 'sg_sessions',
  notifications: 'sg_notifp',
  export: 'sg_export',
  feedback: 'fb_title',
  pricing: 'sg_current_plan',
  billing: 'sg_billing',
}
const subPageLabel = computed(() => {
  const entry = subPageRegistry[activeSubPage.value]
  return entry ? t(entry) : activeSubPage.value
})

// 从哪个设置分节进入的子页，返回时回到那个锚点（而不是滚回顶部误显「关于」）
const returnSection = ref('general')
function openSubPage(page: string) {
  returnSection.value = activeSection.value
  activeSubPage.value = page
  // 主列表会被整块卸载，搜索结果里的 DOM 引用随之失效——顺手清掉
  clearSearch()
}
function goBack() {
  activeSubPage.value = ''
  const target = returnSection.value
  nextTick(() => {
    const el = rootRef.value?.querySelector('#sec-' + target)
    if (el) {
      activeSection.value = target
      el.scrollIntoView({ block: 'start' })
    } else {
      rootRef.value?.scrollTo({ top: 0 })
    }
  })
}

// 锚点导航 + 滚动联动高亮
// 用滚动监听而非 IntersectionObserver：IO 的 root 必须是真正的滚动容器，
// 一旦容器判断失误 observer 就再也不触发（表现为高亮卡死在第一项）。
const rootRef = ref<HTMLElement | null>(null)
const activeSection = ref('general')

function scrollToSection(key: string) {
  activeSection.value = key
  rootRef.value?.querySelector('#sec-' + key)?.scrollIntoView({ block: 'start' })
}

// 顶部全文搜索：直接扫 .set-content 里已渲染的设置行（详见 useSettingsSearch）
const contentRef = ref<HTMLElement | null>(null)
const searchWrapRef = ref<HTMLElement | null>(null)
const {
  query: searchQuery,
  open: searchOpen,
  hits: searchHits,
  active: searchActive,
  reveal: revealHit,
  acceptFirst: acceptSearch,
  moveActive: moveSearchActive,
  openPanel: openSearchPanel,
  setActive: setSearchActive,
  clearSearch,
} = useSettingsSearch({
  root: contentRef,
  scroller: rootRef,
  wrap: searchWrapRef,
  scrollToSection,
})

// 原型逻辑：区块顶边越过滚动区上方 96px 判定线即成为当前项；滚到底时强制末项。
// 判定线用固定小偏移而非 35% 视口高：短分组（如「订阅与账单」只有两行）返回时
// 整组都落在 35% 带内，高亮会被后面的分组抢走（2026-09-19 用户实测：从账单历史
// 返回后锚点错选「安全设置」）。scrollToSection/goBack 都是 block:'start' 对齐
// 顶边，96px 带保证被导航的那个分组胜出。
function updateActiveSection() {
  const root = rootRef.value
  if (!root) return
  const band = root.getBoundingClientRect().top + 96
  let current = sections.value[0]?.key ?? 'general'
  for (const s of sections.value) {
    const el = root.querySelector('#sec-' + s.key) as HTMLElement | null
    if (el && el.getBoundingClientRect().top <= band) current = s.key
  }
  if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) {
    current = sections.value[sections.value.length - 1]?.key ?? current
  }
  activeSection.value = current
}

function onSettingsScroll() {
  updateActiveSection()
}

onMounted(() => {
  rootRef.value?.addEventListener('scroll', onSettingsScroll, { passive: true })
  nextTick(updateActiveSection)
})
onUnmounted(() => rootRef.value?.removeEventListener('scroll', onSettingsScroll))
</script>

<template>
  <div ref="rootRef" class="settings-page">
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-eyebrow">Preferences</div>
          <div class="page-title page-title--big">{{ activeSubPage ? subPageLabel : t('sg_title', '设置') }}</div>
          <div class="page-sub">
            {{ activeSubPage ? '' : t('page_sub_set', '偏好保存在本机 · 仅在当前设备生效') }}
          </div>
        </div>
        <div class="page-acts">
          <!-- 顶部全文搜索：扫已渲染的设置行，回车/点击结果 = 滚到所属分组 + 高亮该行 -->
          <div v-if="!activeSubPage" ref="searchWrapRef" class="set-search">
            <Search class="set-search-ico" :size="14" />
            <input
              v-model="searchQuery"
              type="text"
              class="set-search-input"
              role="combobox"
              aria-autocomplete="list"
              aria-controls="set-search-panel"
              :aria-expanded="searchOpen && searchQuery.trim() ? 'true' : 'false'"
              :placeholder="tf('set_search_ph', '搜索设置项')"
              :aria-label="tf('set_search_ph', '搜索设置项')"
              autocomplete="off"
              spellcheck="false"
              @focus="openSearchPanel"
              @keydown.down.prevent="moveSearchActive(1)"
              @keydown.up.prevent="moveSearchActive(-1)"
              @keydown.enter.prevent="acceptSearch"
              @keydown.esc.prevent="clearSearch"
            />
            <button
              v-if="searchQuery"
              type="button"
              class="set-search-clear"
              :aria-label="tf('set_search_clear', '清空搜索')"
              :title="tf('set_search_clear', '清空搜索')"
              @click="clearSearch"
            >
              <X :size="12" />
            </button>
            <ul
              v-show="searchOpen && !!searchQuery.trim()"
              id="set-search-panel"
              class="set-search-panel"
              role="listbox"
              :aria-label="tf('set_search_ph', '搜索设置项')"
            >
              <li v-if="!searchHits.length" class="set-search-empty">{{ tf('set_search_empty', '无匹配设置') }}</li>
              <li
                v-for="(h, i) in searchHits"
                :key="h.sectionKey + '|' + h.label + '|' + i"
                class="set-search-item"
                :class="{ 'is-active': i === searchActive }"
                role="option"
                :aria-selected="i === searchActive"
                @mouseenter="setSearchActive(i)"
                @click="revealHit(h)"
              >
                <span class="ssi-main">
                  <span class="ssi-label">{{ h.label }}</span>
                  <span v-if="h.hint" class="ssi-hint">{{ h.hint }}</span>
                </span>
                <span class="ssi-section">{{ h.sectionLabel }}</span>
              </li>
            </ul>
          </div>
          <button
            v-if="!activeSubPage && props.aiEnabled"
            type="button"
            class="pl-btn"
            :class="{ 'pl-btn--on': showReview }"
            @click="aiReview"
          >
            <Sparkles :size="14" /><span>{{ tf('set_ai_review', '审查设置') }}</span>
          </button>
          <!-- 返回：纯图标即可，无需文案 -->
          <button
            v-if="activeSubPage"
            type="button"
            class="pl-btn set-back-btn"
            :title="t('back')"
            :aria-label="t('back')"
            @click="goBack"
          >
            <ArrowLeft :size="15" />
          </button>
        </div>
      </div>

      <!-- A5 内联结果卡：审查设置（结构化建议，warn/risk 可跳转分节；不进侧栏消息流） -->
      <InlineAiCard
        v-if="showReview && !activeSubPage"
        class="set-review-card"
        :title="tf('set_ai_review', '审查设置')"
        :status="reviewAi.status.value"
        :text="reviewAi.text.value"
        :error="reviewAi.error.value"
        closable
        @close="closeReview"
        @retry="runReview"
      >
        <template v-if="reviewItems" #body>
          <ul class="review-list">
            <li v-for="(it, i) in reviewItems" :key="i" class="review-item" :class="'lv-' + it.level">
              <span class="review-dot" />
              <span class="review-advice">{{ it.advice }}</span>
              <button v-if="it.level !== 'ok'" type="button" class="pl-btn pl-btn--sm review-goto" @click="gotoSection(it.key)">
                {{ tf('inline_ai_goto_setting', '前往设置') }}
              </button>
            </li>
          </ul>
        </template>
      </InlineAiCard>

      <!-- 子页：页内替换视图（不弹窗） -->
      <template v-if="activeSubPage">
        <ThemeSubPage v-if="activeSubPage === 'themes'" @back="goBack" />
        <ShortcutsSubPage v-else-if="activeSubPage === 'shortcuts'" @back="goBack" />
        <SecuritySubPage v-else-if="activeSubPage === 'security'" @back="goBack" />
        <SessionsSubPage v-else-if="activeSubPage === 'sessions'" @back="goBack" />
        <NotificationsSubPage v-else-if="activeSubPage === 'notifications'" @back="goBack" />
        <ExportSubPage v-else-if="activeSubPage === 'export'" @back="goBack" />
        <FeedbackSubPage v-else-if="activeSubPage === 'feedback'" @back="goBack" />
        <PricingSubPage v-else-if="activeSubPage === 'pricing'" @back="goBack" @open-modal="(type) => emit('open-modal', type)" />
        <BillingSubPage v-else-if="activeSubPage === 'billing'" @back="goBack" />
      </template>

      <!-- 原型排版：左锚点导航 + 右分组堆叠 -->
      <div v-else class="set-layout">
        <nav class="set-nav" :aria-label="t('sg_title', '设置')">
          <a
            v-for="s in sections"
            :key="s.key"
            :class="{ active: activeSection === s.key }"
            @click.prevent="scrollToSection(s.key)"
          >
            <component :is="s.icon" :size="13" /><span>{{ s.label }}</span>
          </a>
        </nav>

        <div ref="contentRef" class="set-content">
          <section v-for="s in sections" :key="s.key" class="set-group" :id="'sec-' + s.key">
            <h3 class="gt">{{ s.label }}</h3>
            <p class="gd">{{ s.desc }}</p>

            <GeneralSettings v-if="s.key === 'general'" @open-sub-page="openSubPage" />
            <AppearanceSettings v-else-if="s.key === 'appearance'" @open-sub-page="openSubPage" />
            <ShortcutsSettings v-else-if="s.key === 'shortcuts'" @open-sub-page="openSubPage" />
            <TemplateVarsSettings v-else-if="s.key === 'vars'" />
            <AIProviderSettings v-else-if="s.key === 'ai'" />
            <WorkflowRuleSettings v-else-if="s.key === 'workflow'" />
            <SubscriptionSettings v-else-if="s.key === 'subscription'" @open-sub-page="openSubPage" />
            <DataSettings v-else-if="s.key === 'data'" @open-sub-page="openSubPage" />
            <PrivacySettings v-else-if="s.key === 'privacy'" @open-sub-page="openSubPage" />
            <AboutView v-else-if="s.key === 'about'" />
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  height: 100%;
  overflow-y: auto;
}
/* A5 审查设置：按钮激活态 + 结果卡与结构化建议清单 */
.pl-btn--on {
  background: var(--accent-light);
  border-color: var(--accent);
  color: var(--accent);
}
.set-review-card {
  margin-bottom: 16px;
}
.review-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.review-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12.5px;
}
.review-item:last-child {
  border-bottom: none;
}
.review-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success);
}
.lv-warn .review-dot {
  background: var(--warning);
}
.lv-risk .review-dot {
  background: var(--danger);
}
.review-advice {
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.review-goto {
  flex: none;
}
/* 子页返回按钮：方形图标钮，明显但不抢眼 */
.set-back-btn {
  width: 30px;
  height: 30px;
  padding: 0;
  justify-content: center;
  color: var(--text-secondary);
}
.set-back-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.set-content {
  min-width: 0;
}
/* ---- 顶部全文搜索 ---- */
/* 输入框与 .pl-btn 同一套语言：细边框 + 小圆角 + 聚焦走 accent */
.set-search {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 220px;
  height: 30px;
  padding: 0 6px 0 9px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-card);
  color: var(--text-tertiary);
  transition:
    border-color var(--ease-d, 160ms) var(--ease),
    box-shadow var(--ease-d, 160ms) var(--ease);
}
.set-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-light);
}
.set-search-ico {
  flex: none;
}
.set-search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
}
.set-search-input::placeholder {
  color: var(--text-tertiary);
  font-weight: 400;
}
.set-search-clear {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.set-search-clear:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.set-search-panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: min(420px, 80vw);
  max-height: 320px;
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-dropdown);
}
.set-search-empty {
  padding: 10px;
  font-size: 12.5px;
  color: var(--text-tertiary);
  text-align: center;
}
.set-search-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.set-search-item.is-active {
  background: var(--accent-light);
}
.ssi-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ssi-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ssi-hint {
  font-size: 11.5px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ssi-section {
  flex: none;
  max-width: 40%;
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 搜索结果命中行的临时高亮：节点由子组件渲染，需要 :deep() 穿透 */
.set-content :deep(.set-search-hit) {
  border-radius: var(--radius-sm);
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  background: var(--accent-light);
}
.set-content :deep(h3.gt.set-search-hit) {
  outline-offset: 0;
}
/* 迁入的 dialog 分组组件自带 sg-* 行样式；在页面里收紧外框，交给 set-group 头部表达层级 */
.set-content :deep(.settings-group) {
  padding: 0;
  background: transparent;
  border: none;
  box-shadow: none;
}
.set-content :deep(.settings-group > .sg-header) {
  display: none;
}
/* 原型：每个分节一张连续大卡片，行与行之间用细分隔线（不再逐行独立卡片）。
   不设 overflow:hidden——卡片末行是 CustomSelect 时下拉弹层会被卡片边缘截断；
   行背景均为透明，圆角处不会穿帮。 */
.set-content :deep(.settings-group) {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  padding: 4px 14px;
}
.set-content :deep(.settings-group > .sg-row) {
  padding: 12px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.set-content :deep(.settings-group > .sg-row:last-child) {
  border-bottom: none;
}
.set-content :deep(.settings-group > .sg-row--clickable) {
  cursor: pointer;
}
/* 下拉弹层要盖过下一张设置卡片 */
.set-content :deep(.custom-select-dropdown) {
  z-index: 40;
}
/* 设置项文字统一主色黑（不随主题强调色走） */
.set-content :deep(.settings-group .sg-name) {
  color: var(--text-primary);
  font-weight: 600;
}
.set-content :deep(.settings-group .sg-hint) {
  color: var(--text-secondary);
}
.set-group > .gt {
  color: var(--text-primary);
  font-weight: 700;
}
.set-group > .gd {
  color: var(--text-secondary);
}
</style>
