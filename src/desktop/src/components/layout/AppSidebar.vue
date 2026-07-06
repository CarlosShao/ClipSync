<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()

defineProps<{
  sidebarOpen: boolean
  currentSub: string
  itemsCount: number
  userName: string
  userPlan: string
}>()

const emit = defineEmits<{
  toggle: []
  navigate: [sub: string]
  logout: []
}>()
</script>

<template>
  <!-- Expanded Sidebar -->
  <aside v-show="sidebarOpen" class="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-brand">
        <div class="sidebar-logo">C</div>
        <span class="sidebar-name">ClipSync</span>
      </div>
      <button class="btn-icon" @click="emit('toggle')" :title="t('nav_main')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="15" y1="18" x2="9" y2="12" /><line x1="9" y1="12" x2="15" y2="6" />
        </svg>
      </button>
    </div>

    <div class="sidebar-section-label">{{ t('nav_main') }}</div>
    <nav class="sidebar-nav">
      <button :class="['nav-item', { active: currentSub === 'clipboard' }]" @click="emit('navigate', 'clipboard')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/>
        </svg>
        <span>{{ t('nav_clipboard') }}</span>
        <span class="nav-counter">{{ itemsCount }}</span>
      </button>
      <button :class="['nav-item', { active: currentSub === 'devices' }]" @click="emit('navigate', 'devices')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
        <span>{{ t('nav_devices') }}</span>
      </button>
      <button :class="['nav-item', { active: currentSub === 'shared-links' }]" @click="emit('navigate', 'shared-links')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
        </svg>
        <span>{{ t('nav_shared_links') }}</span>
      </button>
    </nav>

    <div class="sidebar-section-label">{{ t('nav_account') }}</div>
    <nav class="sidebar-nav">
      <button :class="['nav-item', { active: currentSub === 'profile' }]" @click="emit('navigate', 'profile')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 10-16 0"/>
        </svg>
        <span>{{ t('nav_profile') }}</span>
      </button>
      <button :class="['nav-item', { active: currentSub === 'subscription' }]" @click="emit('navigate', 'subscription')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
        <span>{{ t('nav_subscription') }}</span>
      </button>
      <button :class="['nav-item', { active: currentSub === 'settings' }]" @click="emit('navigate', 'settings')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
        <span>{{ t('nav_settings') }}</span>
      </button>
    </nav>

    <div class="sidebar-footer">
      <div class="user-chip">
        <div class="user-avatar-ring"><div class="user-avatar-in">{{ userName ? userName.slice(0, 2) : 'CS' }}</div></div>
        <div class="user-info">
          <div class="user-name">{{ userName || 'User' }}</div>
          <div class="user-role">{{ t(userPlan === 'Pro' ? 'role_pro' : 'role_free') }}</div>
        </div>
      </div>
      <button class="btn-text-link logout-btn" @click="emit('logout')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
        <span>{{ t('logout') }}</span>
      </button>
    </div>
  </aside>

  <!-- Collapsed Sidebar -->
  <div v-if="!sidebarOpen" class="sidebar-collapsed">
    <button class="btn-icon" @click="emit('toggle')">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="9" y1="18" x2="15" y2="12" /><line x1="15" y1="12" x2="9" y2="6" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* ===== SIDEBAR ===== */
.sidebar { width: 220px; flex-shrink: 0; display: flex; flex-direction: column; background: var(--bg-sidebar); border-right: 1px solid var(--border-default); }
.sidebar-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 14px; height: 52px; border-bottom: 1px solid var(--border-default); }
.sidebar-brand { display: flex; align-items: center; gap: 8px; }
.sidebar-logo { width: 28px; height: 28px; border-radius: var(--radius-sm); background: var(--accent-bg); color: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px; }
.sidebar-name { font-weight: 700; font-size: 14px; }
.sidebar-section-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--text-tertiary); padding: 16px 14px 6px; }
.sidebar-nav { padding: 4px 8px; display: flex; flex-direction: column; gap: 1px; }
.nav-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: var(--radius-sm); font-size: 13px; color: var(--text-secondary); background: none; border: none; cursor: pointer; text-align: left; width: 100%; }
.nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.nav-item.active { background: var(--accent-light); color: var(--accent); font-weight: 500; }
.nav-counter { margin-left: auto; font-size: 11px; color: var(--text-tertiary); background: var(--bg-hover); padding: 1px 6px; border-radius: 8px; }
.sidebar-footer { margin-top: auto; padding: 12px 14px; border-top: 1px solid var(--border-default); }
.user-chip { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.user-avatar-ring { width: 30px; height: 30px; border-radius: 50%; background: var(--gradient-accent); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.user-avatar-in { width: 26px; height: 26px; border-radius: 50%; background: var(--bg-sidebar); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; }
.user-info { flex: 1; }
.user-name { font-size: 13px; font-weight: 500; line-height: 1.3; }
.user-role { font-size: 11px; color: var(--text-tertiary); }
.logout-btn { display: flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--text-tertiary); padding: 4px 0; }
.logout-btn:hover { color: var(--danger); }
.sidebar-collapsed { width: 40px; flex-shrink: 0; display: flex; align-items: flex-start; justify-content: center; padding-top: 14px; border-right: 1px solid var(--border-default); background: var(--bg-sidebar); }
</style>
