<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'
import GeneralSettings from './GeneralSettings.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import PrivacySettings from './PrivacySettings.vue'
import DataSettings from './DataSettings.vue'
import SubscriptionSettings from './SubscriptionSettings.vue'
import TemplateVarsSettings from './TemplateVarsSettings.vue'
import AboutView from './AboutView.vue'
import ShortcutsSettings from './ShortcutsSettings.vue'
import ThemeSubPage from './sub-pages/ThemeSubPage.vue'
import ShortcutsSubPage from './sub-pages/ShortcutsSubPage.vue'
import SecuritySubPage from './sub-pages/SecuritySubPage.vue'
import SessionsSubPage from './sub-pages/SessionsSubPage.vue'
import NotificationsSubPage from './sub-pages/NotificationsSubPage.vue'
import ExportSubPage from './sub-pages/ExportSubPage.vue'
import FeedbackSubPage from './sub-pages/FeedbackSubPage.vue'
import PricingSubPage from './sub-pages/PricingSubPage.vue'
import BillingSubPage from './sub-pages/BillingSubPage.vue'
import {
  Settings, Palette, Keyboard, Shield,
  Database, CreditCard, Variable, Info, X, ArrowLeft,
} from 'lucide-vue-next'

const { t } = useI18n()

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const activeCategory = ref('general')
const activeSubPage = ref('')

// Sub-page registry: maps sub-page key → { category, label }
const subPageRegistry: Record<string, { category: string; label: string }> = {
  themes:        { category: 'appearance',   label: 'sg_theme' },
  shortcuts:     { category: 'shortcuts',    label: 'sg_kb_shortcuts' },
  security:      { category: 'privacy',      label: 'sg_2fa' },
  sessions:      { category: 'privacy',      label: 'sg_sessions' },
  notifications: { category: 'privacy',      label: 'sg_notifp' },
  export:        { category: 'data',         label: 'sg_export' },
  feedback:      { category: 'data',         label: 'fb_title' },
  pricing:       { category: 'subscription', label: 'sg_current_plan' },
  billing:       { category: 'subscription', label: 'sg_billing' },
}

const subPageLabel = computed(() => {
  if (!activeSubPage.value) return ''
  const entry = subPageRegistry[activeSubPage.value]
  return entry ? t(entry.label) : activeSubPage.value
})

interface NavItem {
  key: string
  label: string
  icon: any
}

const navItems = computed<NavItem[]>(() => [
  { key: 'general',      label: t('sg_gen'),      icon: Settings },
  { key: 'appearance',   label: t('sg_appear'),    icon: Palette },
  { key: 'shortcuts',    label: t('sg_shortcuts'),  icon: Keyboard },
  { key: 'privacy',      label: t('sg_privacy'),    icon: Shield },
  { key: 'data',         label: t('sg_data'),       icon: Database },
  { key: 'subscription', label: t('sg_sub_bill'),   icon: CreditCard },
  { key: 'variables',    label: t('sg_tpl_vars'),   icon: Variable },
  { key: 'about',        label: t('sg_about') || '关于', icon: Info },
])

function handleOpenSubPage(page: string) {
  activeSubPage.value = page
}

function goBack() {
  activeSubPage.value = ''
}

function handleCategoryClick(key: string) {
  activeCategory.value = key
  activeSubPage.value = ''
}

function onBackdropClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('sd-backdrop')) emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) {
    if (activeSubPage.value) {
      goBack()
    } else {
      emit('close')
    }
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sd-backdrop" @keydown="onKeydown" @click="onBackdropClick">
      <div class="sd-panel" role="dialog" aria-modal="true">
        <!-- Header -->
        <div class="sd-header">
          <div class="sd-header-left">
            <Button
              v-if="activeSubPage"
              variant="ghost"
              size="icon-sm"
              class="sd-back"
              @click="goBack"
            >
              <ArrowLeft :size="18" />
            </Button>
            <Settings v-else :size="18" />
            <span class="sd-title">{{ activeSubPage ? subPageLabel : t('settings_t') }}</span>
          </div>
          <Button variant="ghost" size="icon-sm" class="sd-close" @click="emit('close')">
            <X :size="16" />
          </Button>
        </div>

        <!-- Body: sidebar + content -->
        <div class="sd-body">
          <!-- Left sidebar nav -->
          <nav class="sd-sidebar" aria-label="Settings navigation">
            <Button
              v-for="item in navItems"
              :key="item.key"
              variant="ghost"
              size="sm"
              class="sd-nav-item"
              :class="{ active: activeCategory === item.key }"
              @click="handleCategoryClick(item.key)"
            >
              <component :is="item.icon" :size="16" />
              <span>{{ item.label }}</span>
            </Button>
          </nav>

          <!-- Divider -->
          <div class="sd-divider" />

          <!-- Right content -->
          <div class="sd-content">
            <!-- Sub-page view -->
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

            <!-- Category views -->
            <template v-else>
              <GeneralSettings v-if="activeCategory === 'general'" />
              <AppearanceSettings v-else-if="activeCategory === 'appearance'" @open-sub-page="handleOpenSubPage" />
              <ShortcutsSettings v-else-if="activeCategory === 'shortcuts'" @open-sub-page="handleOpenSubPage" />
              <PrivacySettings v-else-if="activeCategory === 'privacy'" @open-sub-page="handleOpenSubPage" />
              <DataSettings v-else-if="activeCategory === 'data'" @open-sub-page="handleOpenSubPage" />
              <SubscriptionSettings v-else-if="activeCategory === 'subscription'" @open-sub-page="handleOpenSubPage" />
              <TemplateVarsSettings v-else-if="activeCategory === 'variables'" />
              <AboutView v-else-if="activeCategory === 'about'" />
            </template>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ===== Backdrop ===== */
.sd-backdrop {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-modal-overlay);
  animation: sd-fadeIn 0.12s ease;
}
@keyframes sd-fadeIn { from { opacity: 0; } to { opacity: 1; } }

/* ===== Panel ===== */
.sd-panel {
  width: 900px; max-width: 92vw; height: 640px; max-height: 85vh;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-modal);
  display: flex; flex-direction: column;
  overflow: hidden;
  animation: sd-slideUp 0.18s ease;
}
@keyframes sd-slideUp { from { opacity: 0; transform: translateY(12px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

/* ===== Header ===== */
.sd-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.sd-header-left { display: flex; align-items: center; gap: 10px; color: var(--text-primary); }
.sd-title { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.sd-close { color: var(--text-secondary); }
.sd-back { color: var(--text-secondary); margin-right: 2px; }

/* ===== Body ===== */
.sd-body {
  display: flex; flex: 1; min-height: 0; overflow: hidden;
}

/* ===== Sidebar Nav ===== */
.sd-sidebar {
  width: 180px; flex-shrink: 0;
  display: flex; flex-direction: column;
  padding: 12px 8px;
  gap: 2px;
  overflow-y: auto;
}
.sd-nav-item {
  display: flex; align-items: center; gap: 10px;
  width: 100%; justify-content: flex-start;
  padding: 8px 12px;
  font-size: 13px; font-weight: 500;
  color: var(--text-secondary);
  border-radius: var(--radius-md);
  transition: all 0.15s;
  text-align: left;
}
.sd-nav-item:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.sd-nav-item.active {
  color: var(--accent);
  background: var(--accent-bg);
  font-weight: 600;
}

/* ===== Divider ===== */
.sd-divider {
  width: 1px;
  background: var(--border-default);
  flex-shrink: 0;
}

/* ===== Content Area ===== */
.sd-content {
  flex: 1; min-width: 0;
  overflow-y: auto;
  padding: 20px 28px;
}
</style>
