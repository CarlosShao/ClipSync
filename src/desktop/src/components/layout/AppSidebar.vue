<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()

const props = defineProps<{
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

const isCollapsed = computed(() => !props.sidebarOpen)

// Navigation items — single source of truth for both expanded and collapsed views
const mainNavItems = computed(() => [
  { key: 'clipboard', label: t('nav_clipboard'), badge: String(props.itemsCount) },
  { key: 'devices',   label: t('nav_devices'),   badge: '' },
  { key: 'shared-links', label: t('nav_shared_links'), badge: '' },
])

const accountNavItems = computed(() => [
  { key: 'profile',     label: t('nav_profile'),     badge: '' },
  { key: 'subscription', label: t('nav_subscription'), badge: '' },
  { key: 'settings',    label: t('nav_settings'),     badge: '' },
])
</script>

<template>
  <aside :class="['sidebar', { 'sidebar--collapsed': isCollapsed }]">

    <!-- ===== Header ===== -->
    <div class="sb-header">
      <!-- Expanded: logo + name -->
      <div class="sb-brand" v-show="!isCollapsed">
        <div class="sb-logo">C</div>
        <span class="sb-name">{{ t('app_name') }}</span>
      </div>
      <!-- Collapsed: logo only, centered -->
      <div class="sb-logo-wrap" v-show="isCollapsed">
        <div class="sb-logo sb-logo--sm">C</div>
      </div>
      <!-- Toggle button (always visible) -->
      <button class="sb-toggle" @click="emit('toggle')" :title="isCollapsed ? t('nav_expand') : t('nav_collapse')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
             class="sb-toggle-icon" :class="{ 'sb-toggle-icon--rotated': isCollapsed }">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>
    </div>

    <!-- ===== Main Navigation ===== -->
    <nav class="sb-nav">
      <div v-if="!isCollapsed" class="sb-sect-label">{{ t('nav_main') }}</div>
      <template v-for="item in mainNavItems" :key="item.key">
        <button
          :class="['sb-item', { active: currentSub === item.key }]"
          :title="isCollapsed ? item.label : undefined"
          @click="emit('navigate', item.key)"
        >
          <!-- Clipboard icon -->
          <svg v-if="item.key === 'clipboard'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/></svg>
          <!-- Devices/Monitor icon -->
          <svg v-else-if="item.key === 'devices'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          <!-- Links icon -->
          <svg v-else-if="item.key === 'shared-links'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
          <span v-show="!isCollapsed" class="sb-label">{{ item.label }}</span>
          <span v-if="item.badge && !isCollapsed" class="sb-badge">{{ item.badge }}</span>
        </button>
      </template>
    </nav>

    <!-- ===== Account Navigation ===== -->
    <nav class="sb-nav sb-nav--account">
      <template v-for="(item, idx) in accountNavItems" :key="item.key">
        <div v-if="idx === 0 && !isCollapsed" class="sb-sect-label">{{ t('nav_account') }}</div>
        <button
          :class="['sb-item', { active: currentSub === item.key }]"
          :title="isCollapsed ? item.label : undefined"
          @click="emit('navigate', item.key)"
        >
          <!-- User icon -->
          <svg v-if="item.key === 'profile'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 10-16 0"/></svg>
          <!-- Star icon -->
          <svg v-else-if="item.key === 'subscription'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          <!-- Settings/Gear icon -->
          <svg v-else-if="item.key === 'settings'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
          <span v-show="!isCollapsed" class="sb-label">{{ item.label }}</span>
        </button>
      </template>
    </nav>

    <!-- ===== Footer (expanded only: user + logout) ===== -->
    <div class="sb-footer" v-show="!isCollapsed">
      <div class="user-chip">
        <div class="user-avatar-ring"><div class="user-avatar-in">{{ userName ? userName.slice(0, 2) : 'CS' }}</div></div>
        <div class="user-info">
          <div class="user-name">{{ userName || 'User' }}</div>
          <div class="user-role">{{ t(userPlan === 'Pro' ? 'role_pro' : 'role_free') }}</div>
        </div>
      </div>
      <button class="logout-btn" @click="emit('logout')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        <span>{{ t('logout') }}</span>
      </button>
    </div>

    <!-- Footer avatar dot (collapsed only) -->
    <div class="sb-footer-dot" v-show="isCollapsed" :title="userName || 'User'">
      <div class="user-avatar-ring user-avatar-ring--sm"><div class="user-avatar-in user-avatar-in--sm">{{ userName ? userName.slice(0, 1) : 'C' }}</div></div>
    </div>
  </aside>
</template>

<style scoped>
/* ================================================================
 * Sidebar — VS Code / Notion style: expanded(220px) ↔ collapsed(56px)
 * Single element, CSS transition on width.
 * Collapsed shows icon-only rail with hover tooltips.
 * ================================================================ */

/* ---- Container ---- */
.sidebar {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-default);
  overflow: hidden;
  transition: width 280ms cubic-bezier(.4, 0, .2, 1);
}
.sidebar--collapsed { width: 56px; }

/* ---- Header ---- */
.sb-header {
  display: flex;
  align-items: center;
  height: 48px;
  flex-shrink: 0;
  padding: 0 12px;
  gap: 8px;
  border-bottom: 1px solid var(--border-default);
  position: relative; /* ← 为内部 absolute 定位的 toggle 按钮提供定位参照系 */
}
.sidebar--collapsed .sb-header {
  justify-content: center;
  padding: 0;
}

.sb-brand { display: flex; align-items: center; gap: 8px; }
.sb-logo-wrap { display: flex; align-items: center; justify-content: center; }

.sb-logo {
  width: 28px; height: 28px;
  border-radius: var(--radius-sm);
  background: var(--accent-bg); color: var(--accent);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 14px;
  flex-shrink: 0;
}
.sb-logo--sm { width: 30px; height: 30px; font-size: 13px; border-radius: 8px; }

.sb-name { font-weight: 700; font-size: 14px; white-space: nowrap; }

.sb-toggle {
  margin-left: auto;
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  border-radius: var(--radius-sm);
  background: transparent; border: none;
  color: var(--text-tertiary); cursor: pointer;
  transition: background 150ms, color 150ms;
}
.sidebar--collapsed .sb-toggle { margin-left: 0; position: absolute; right: 4px; }
.sb-toggle:hover { background: var(--bg-hover); color: var(--text-primary); }

.sb-toggle-icon { transition: transform 280ms cubic-bezier(.4, 0, .2, 1); }
.sb-toggle-icon--rotated { transform: rotate(180deg); }

/* ---- Navigation ---- */
.sb-nav {
  display: flex;
  flex-direction: column;
  padding: 8px 8px;
  gap: 2px;
}
.sidebar--collapsed .sb-nav { padding: 8px 0; align-items: center; }

.sb-nav--account { margin-top: 8px; }

.sb-sect-label {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: .05em; color: var(--text-tertiary);
  padding: 10px 10px 4px; white-space: nowrap;
}

/* ---- Nav Item ---- */
.sb-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  font-size: 13px; font-weight: 500;
  color: var(--text-secondary);
  background: none; border: none; cursor: pointer;
  text-align: left; width: 100%; white-space: nowrap;
  transition: background 120ms, color 120ms;
  position: relative;
}
.sidebar--collapsed .sb-item {
  justify-content: center;
  width: 40px; height: 40px;
  padding: 0;
  border-radius: var(--radius-md);
}

.sb-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.sb-item.active {
  background: var(--accent-light); color: var(--accent);
}
/* Collapsed active indicator: left accent bar */
.sidebar--collapsed .sb-item.active::before {
  content: '';
  position: absolute;
  left: -8px; top: 8px; bottom: 8px;
  width: 3px; border-radius: 2px;
  background: var(--accent);
}

.sb-label { overflow: hidden; text-overflow: ellipsis; }

.sb-badge {
  margin-left: auto;
  font-size: 11px; color: var(--text-tertiary);
  background: var(--bg-hover); padding: 1px 7px;
  border-radius: 10px; line-height: 1.4;
}

/* ---- Footer (expanded) ---- */
.sb-footer {
  margin-top: auto;
  padding: 12px 12px;
  border-top: 1px solid var(--border-default);
}

.user-chip { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.user-avatar-ring { width: 32px; height: 32px; border-radius: 50%; background: var(--gradient-accent); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.user-avatar-ring--sm { width: 28px; height: 28px; }
.user-avatar-in { width: 28px; height: 28px; border-radius: 50%; background: var(--bg-sidebar); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }
.user-avatar-in--sm { width: 24px; height: 24px; font-size: 10px; }
.user-info { flex: 1; min-width: 0; }
.user-name { font-size: 13px; font-weight: 500; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-role { font-size: 11px; color: var(--text-tertiary); }

.logout-btn {
  display: flex; align-items: center; gap: 4px;
  font-size: 11.5px; color: var(--text-tertiary);
  padding: 4px 0; cursor: pointer;
  background: none; border: none;
}
.logout-btn:hover { color: var(--danger); }

/* ---- Footer dot (collapsed) ---- */
.sb-footer-dot {
  display: flex; justify-content: center; padding: 10px 0 8px;
  margin-top: auto;
}
</style>
