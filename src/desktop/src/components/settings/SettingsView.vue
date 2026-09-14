<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useMenuAccess } from '@/composables/useMenuAccess'
import { ArrowLeft, Settings2, Palette, Keyboard, Variable, Sparkles, Workflow, CreditCard, Database, ShieldCheck, Info } from 'lucide-vue-next'
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

const { t, tf, currentLang } = useI18n()
const { can } = useMenuAccess()
const configStore = useConfigStore()

const props = defineProps<{ aiEnabled?: boolean }>()

// AI 审查设置：把当前客户端设置的真实快照交给 AI 检查（管理台关闭 AI 时入口隐藏）
function askAi(prompt: string) {
  window.dispatchEvent(new CustomEvent('clipsync:toggle-ai'))
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('clipsync:ai-send-message', { detail: { content: prompt } }))
  }, 120)
}
function aiReview() {
  const s = [
    `- 自动同步: ${configStore.autoSync ? '开' : '关'}`,
    `- 同步间隔: ${configStore.syncInterval === 0 ? '实时' : configStore.syncInterval + ' 分钟'}`,
    `- 历史上限: ${configStore.maxHistory >= 999999 ? '不限' : configStore.maxHistory + ' 条'}`,
    `- 图片压缩: ${configStore.imageCompress ? '开' : '关'}`,
    `- 隐私模式: ${configStore.privacyMode ? '开' : '关'}`,
    `- 失焦自动隐藏敏感内容: ${configStore.autoBlur ? '开' : '关'}`,
    `- 界面语言: ${currentLang.value === 'zh' ? '中文' : 'English'}`,
  ].join('\n')
  askAi(
    `${tf('set_ai_review', '审查设置')}：\n${s}\n请逐项检查以上客户端设置是否存在风险或不合理之处（例如历史上限过小、隐私模式未开启但剪贴板常含敏感信息、同步间隔过长等），给出修改建议。`,
  )
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
    { key: 'subscription', icon: CreditCard, label: t('sg_sub_bill'), desc: tf('set_d_sub', '当前套餐、用量与账单'), gated: true },
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

// 原型逻辑：区块顶边越过滚动区上部 35% 分界线即成为当前项；滚到底时强制末项
function updateActiveSection() {
  const root = rootRef.value
  if (!root) return
  const band = root.getBoundingClientRect().top + root.clientHeight * 0.35
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
            {{ activeSubPage ? '' : t('page_sub_set', '偏好保存在本机 · 同步类设置将下发到全部设备') }}
          </div>
        </div>
        <div class="page-acts">
          <button v-if="!activeSubPage && props.aiEnabled" type="button" class="pl-btn" @click="aiReview">
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

      <!-- 子页：页内替换视图（不弹窗） -->
      <template v-if="activeSubPage">
        <ThemeSubPage v-if="activeSubPage === 'themes'" @back="goBack" />
        <ShortcutsSubPage v-else-if="activeSubPage === 'shortcuts'" @back="goBack" />
        <SecuritySubPage v-else-if="activeSubPage === 'security'" @back="goBack" />
        <SessionsSubPage v-else-if="activeSubPage === 'sessions'" @back="goBack" />
        <NotificationsSubPage v-else-if="activeSubPage === 'notifications'" @back="goBack" />
        <ExportSubPage v-else-if="activeSubPage === 'export'" @back="goBack" />
        <FeedbackSubPage v-else-if="activeSubPage === 'feedback'" @back="goBack" />
        <PricingSubPage v-else-if="activeSubPage === 'pricing'" @back="goBack" />
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

        <div class="set-content">
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
