<script setup lang="ts">
import { computed } from 'vue'
import {
  ChevronLeft, ChevronRight, Clipboard, Monitor, Link,
  User, Star, Settings, LogOut,
} from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
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
    <div class="sb-header" @click="emit('toggle')" :class="{ 'sb-header--clickable': isCollapsed }">
      <!-- Expanded: logo + name + toggle -->
      <div class="sb-brand" v-show="!isCollapsed">
        <div class="sb-logo">C</div>
        <span class="sb-name">{{ t('app_name') }}</span>
      </div>
      <!-- Collapsed: centered logo + hint chevron -->
      <div class="sb-logo-wrap" v-show="isCollapsed">
        <div class="sb-logo sb-logo--sm">C</div>
        <ChevronRight :size="10" stroke-width="2.5" class="sb-collapse-hint" />
      </div>
      <!-- Toggle button (expanded only) -->
      <Button v-show="!isCollapsed" variant="ghost" size="icon" class="sb-toggle" @click.stop="emit('toggle')" :title="t('nav_collapse')">
        <ChevronLeft :size="14" stroke-width="2.5" />
      </Button>
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
          <Clipboard v-if="item.key === 'clipboard'" :size="20" :stroke-width="1.8" />
          <Monitor v-else-if="item.key === 'devices'" :size="20" :stroke-width="1.8" />
          <Link v-else-if="item.key === 'shared-links'" :size="20" :stroke-width="1.8" />
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
          <User v-if="item.key === 'profile'" :size="20" :stroke-width="1.8" />
          <Star v-else-if="item.key === 'subscription'" :size="20" :stroke-width="1.8" />
          <Settings v-else-if="item.key === 'settings'" :size="20" :stroke-width="1.8" />
          <span v-show="!isCollapsed" class="sb-label">{{ item.label }}</span>
        </button>
      </template>
    </nav>

    <!-- ===== Footer (expanded only: user + logout) ===== -->
    <div class="sb-footer" v-show="!isCollapsed">
      <div class="user-chip" @click="emit('navigate', 'profile')" :title="t('nav_profile') || 'View Profile'">
        <div class="user-avatar-ring"><div class="user-avatar-in">{{ userName ? userName.slice(0, 2) : 'CS' }}</div></div>
        <div class="user-info">
          <div class="user-name">{{ userName || 'User' }}</div>
          <div class="user-role">{{ t(userPlan === 'Pro' ? 'role_pro' : 'role_free') }}</div>
        </div>
      </div>
      <Button variant="ghost" class="logout-btn" @click="emit('logout')">
        <LogOut :size="13" />
        <span>{{ t('logout') }}</span>
      </Button>
    </div>

    <!-- Footer avatar dot (collapsed only) -->
    <div class="sb-footer-dot" v-show="isCollapsed" :title="userName || 'User'" @click="emit('navigate', 'profile')" style="cursor:pointer;border-radius:var(--radius-md);transition:background .12s;">
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
  transition: width 280ms cubic-bezier(.4, 0 .2, 1);
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
  position: relative;
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

/* Toggle button — override shadcn ghost defaults to match sidebar */
.sb-toggle {
  margin-left: auto;
  width: 28px !important;
  height: 28px !important;
  padding: 0 !important;
  color: var(--text-tertiary);
  border-radius: var(--radius-sm);
}
.sb-toggle:hover { background: var(--bg-hover) !important; color: var(--text-primary); }

/* Collapsed header: entire area is clickable */
.sb-header--clickable { cursor: pointer; }
.sb-header--clickable:hover { background: var(--bg-hover); }

/* Small chevron hint next to collapsed logo */
.sb-logo-wrap { display: flex; align-items: center; justify-content: center; gap: 4px; }
.sb-collapse-hint { opacity: 0.4; transition: opacity 150ms; }
.sb-header--clickable:hover .sb-collapse-hint { opacity: 0.7; }

/* ---- Navigation ---- */
.sb-nav {
  display: flex;
  flex-direction: column;
  padding: 10px 10px 6px;
  gap: 3px;
}
.sidebar--collapsed .sb-nav { padding: 8px 0; align-items: center; }

.sb-nav--account {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
}

.sb-sect-label {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: .05em; color: var(--text-tertiary);
  padding: 6px 10px 8px; white-space: nowrap;
}

/* ---- Nav Item ---- */
.sb-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  font-size: 13px; font-weight: 500;
  color: var(--text-secondary);
  background: none; border: none; cursor: pointer;
  text-align: left; width: 100%; white-space: nowrap;
  transition: background .15s ease, color .15s ease, box-shadow .15s ease;
  position: relative;
}
.sidebar--collapsed .sb-item {
  justify-content: center;
  width: 40px; height: 40px;
  padding: 0;
  border-radius: var(--radius-md);
}

/* Muted icon color for inactive items — icon stays secondary until hover/active */
.sb-item :deep(svg) { color: var(--text-tertiary); transition: color .15s ease; }
.sb-item:hover :deep(svg) { color: var(--text-primary); }
.sb-item.active :deep(svg) { color: var(--accent); }

/* Hover: clear background */
.sb-item:hover { background: var(--bg-hover); color: var(--text-primary); }

/* Active: visible pill background + left accent indicator (shadcn-style) */
.sb-item.active {
  background: var(--accent-bg);
  color: var(--accent);
  font-weight: 600;
  /* Subtle shadow to lift from surface like shadcn docs */
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
/* Left 2px accent bar on active item (expanded) */
.sb-item.active::after {
  content: '';
  position: absolute;
  left: 4px; top: 9px; bottom: 9px;
  width: 2.5px; border-radius: 9999px;
  background: var(--accent);
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
  padding: 10px 12px 12px;
  border-top: 1px solid var(--border-default);
}

.user-chip { 
  display: flex; align-items: center; gap: 8px; 
  cursor: pointer; border-radius: var(--radius-md); 
  transition: background .15s ease; 
  padding: 6px 4px; margin-bottom: 4px;
}
.user-chip:hover { background: var(--bg-hover); }
.user-avatar-ring { width: 34px; height: 34px; border-radius: 50%; background: var(--gradient-accent); display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.user-avatar-ring--sm { width: 28px; height: 28px; }
.user-avatar-in { width: 30px; height: 30px; border-radius: 50%; background: var(--bg-sidebar); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }
.user-avatar-in--sm { width: 24px; height: 24px; font-size: 10px; }
.user-info { flex: 1; min-width: 0; }
.user-name { font-size: 13px; font-weight: 500; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-role { font-size: 11px; color: var(--text-tertiary); }

/* Logout button — override shadcn ghost for sidebar footer style */
.logout-btn {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text-tertiary);
  padding: 6px 8px;
  height: auto !important;
  border-radius: var(--radius-md);
  transition: color .15s ease, background .15s ease;
}
.logout-btn:hover { color: var(--danger); background: var(--danger-bg) !important; }

/* ---- Footer dot (collapsed) ---- */
.sb-footer-dot {
  display: flex; justify-content: center; padding: 10px 0 8px;
  margin-top: auto;
}
</style>