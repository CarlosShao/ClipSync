<script setup lang="ts">
import { computed, ref } from 'vue'
import { onClickOutside } from '@vueuse/core'
import {
  PanelLeftOpen,
  ClipboardList,
  Monitor,
  FileText,
  User,
  Star,
  Crown,
  Settings,
  LogOut,
  Bell,
  ExternalLink,
  Megaphone,
} from 'lucide-vue-next'
import Button from '@/components/ui/button/Button.vue'
import { useI18n } from '@/composables/useI18n'
import { useNotifications } from '@/composables/useNotifications'
import { useMenuAccess } from '@/composables/useMenuAccess'
import { hasUpgradeHeadroom, tierRankByName } from '@/composables/useSubscriptionAccess'
import { useUser } from '@/composables/useUser'
import { useConfigStore } from '@/stores/configStore'
import { useDevice } from '@/composables/useDevice'
import { api } from '@/api/client'
import { openUrl } from '@/lib/tauri'
import { useAnnouncements } from '@/composables/useAnnouncements'

const { t } = useI18n()
const { unreadCount } = useNotifications()
// 公告未读数（横幅之外的第二触达：once 公告不弹常驻横幅，靠此徽标提示）
const { unreadCount: announcementUnreadCount } = useAnnouncements()
// 菜单访问控制（MA-01/02）：开关关闭的入口直接隐藏（服务端 403 兜底依然存在）
const { can } = useMenuAccess()
// MA-06：管理控制台外链仅超管可见（roleKey === 'super_admin'，决策记录 2026-09-07）
const { isSuperAdmin, fetchUser } = useUser()
const configStore = useConfigStore()
// Clearline：导航页脚「同步脉搏」——在线设备数（模块级单例 composable，HomeView 挂载时已 loadDevices）
const device = useDevice()
const onlineDeviceCount = computed(() => device.devices.value.filter((d) => d.online).length)
// 挂载即拉取当前用户 RBAC 角色（内部单飞去重，AI 面板等处复用同一份用户态）
fetchUser()
// 超管徽标在模板内联判定：roleKey=super_admin 显示「超级管理员」而非套餐名（"免费版"太误导）

const props = defineProps<{
  sidebarOpen: boolean
  currentSub: string
  itemsCount: number
  userName: string
  userPlan: string
  userEmail?: string
  userAvatarUrl?: string
  aiOpen?: boolean
}>()

const emit = defineEmits<{
  toggle: []
  navigate: [sub: string]
  'open-ai': []
  'open-modal': [type: string]
  logout: []
}>()

const isCollapsed = computed(() => !props.sidebarOpen)
const showUserMenu = ref(false)

// ===== 升级入口治理（订阅 UI 重做 · 入口矩阵）=====
// 统一走 can('nav.subscription')（enable_subscription 关闭时一并隐藏），并且：
//   · Free          ：账号区醒目升级条 + 账号菜单「升级」
//   · Pro           ：仅账号菜单「升级」（还能升 Enterprise），不给醒目条（避免催熟）
//   · Enterprise    ：两处都不出现（已无更高档可买，只升不降规则下没有可点入口）
//   · super_admin   ：两处都不出现 —— 套餐是商业身份、超管是系统身份（MA-06 同一
//                    决策：徽标显示「超级管理员」而非「免费版」），催超管付款不合理。
// 档位判定用 hasUpgradeHeadroom（按套餐名 rank，不额外请求 plans 目录）；
// 服务端 403/409 仍是权威兜底。
const showUpgradeEntry = computed(() => can('nav.subscription') && !isSuperAdmin.value)
const showUpgradeMenuItem = computed(() => showUpgradeEntry.value && hasUpgradeHeadroom(props.userPlan))
const showUpgradeChip = computed(
  () => showUpgradeMenuItem.value && tierRankByName(props.userPlan) === tierRankByName('Free'),
)

function openUpgrade() {
  if (!showUpgradeEntry.value) return
  closeUserMenu()
  emit('open-modal', 'pricing')
}

function toggleUserMenu() {
  showUserMenu.value = !showUserMenu.value
}
function closeUserMenu() {
  showUserMenu.value = false
}
/** AN-05 补充：公告入口——派发全局事件，由 HomeView 打开公告列表弹窗（模块级单例总线模式） */
function openAnnouncements() {
  window.dispatchEvent(new CustomEvent('clipsync:open-announcements'))
  closeUserMenu()
}
// Template ref for the footer container (used for click-outside detection)
let footerEl: HTMLElement | null = null
function setFooterRef(el: HTMLElement | null) {
  footerEl = el
  if (el)
    onClickOutside(el, () => {
      showUserMenu.value = false
    })
}

// Navigation items — Clearline IA：归档并入剪贴板页视图分段；个人/订阅/通知收进
// 标题栏铃铛与用户菜单，侧栏只保留业务五项（剪贴板/收藏/模板/设备 + 系统:设置）。
// kbd 键位与 HomeView 的 Ctrl+1..4 全局快捷键一一对应（纯提示，不改行为）。
const mainNavItems = computed(() => [
  { key: 'clipboard', label: t('nav_clipboard'), badge: String(props.itemsCount), kbd: 'Ctrl 1' },
  { key: 'favorites', label: t('nav_favorites'), badge: '', kbd: 'Ctrl 2' },
  { key: 'templates', label: t('nav_templates'), badge: '', kbd: 'Ctrl 3' },
  { key: 'devices', label: t('nav_devices'), badge: '', kbd: 'Ctrl 4' },
])

// MA-06：管理控制台外链地址。
// 优先取本地覆盖键 clipsync-admin-url（localStorage）；否则由当前服务器地址派生
// 同主机 + 5273 端口（管理台约定端口）；地址为空/非法时回落 http://localhost:5273。
// hostname 强制用 localhost（而非 serverUrl 的 127.0.0.1）：浏览器对 localhost 有
// IPv6/IPv4 双栈回退，两种监听形态的管理台 dev server 都能命中。
function resolveAdminConsoleUrl(): string {
  const override = (localStorage.getItem('clipsync-admin-url') || '').trim()
  if (override) return override
  const server = configStore.serverUrl
  if (server) {
    try {
      const u = new URL(server)
      u.port = '5273'
      u.hostname = 'localhost'
      return u.origin
    } catch {
      /* 非法地址走默认回落 */
    }
  }
  return 'http://localhost:5273'
}

// RB-SSO：单点登录打开管理台。
// 流程：POST /api/admin/sso/token（仅超管，后端 requireRole(100)）签发一次性 code（60s，Redis GETDEL 防重放）
// → 拼管理台 /sso?code=xxx → 管理台兑换页换正式会话，免密直达 dashboard。
// 签发失败（非超管/网络/Redis 不可用）降级为纯外链，走常规登录页。
async function openAdminConsole() {
  try {
    const resp = await api<{ code: number; data: { code: string; expiresIn: number } }>(
      'POST',
      '/api/admin/sso/token',
    )
    // api() 不解响应壳：resp.data 为响应体 { code, data }，真实凭据在 resp.data.data.code
    const ssoCode = resp.ok ? resp.data?.data?.code : undefined
    if (!ssoCode) throw new Error(resp.error || 'SSO 凭据签发失败')
    const adminUrl = new URL(resolveAdminConsoleUrl())
    adminUrl.pathname = '/sso'
    adminUrl.searchParams.set('code', ssoCode)
    openUrl(adminUrl.toString()).catch(() => {})
  } catch (err) {
    console.error('[SSO] failed to get code:', err)
    // 降级为纯外链（登录页兜底）
    openUrl(resolveAdminConsoleUrl()).catch(() => {})
  }
}
</script>

<template>
  <aside :class="['sidebar', { 'sidebar--collapsed': isCollapsed }]" role="navigation" :aria-label="t('app_name')">
    <!-- ===== Header（折叠开关已上移标题栏；折叠态点 logo 展开） ===== -->
    <div v-show="isCollapsed" class="sb-header sb-header--clickable" @click="emit('toggle')">
      <div class="sb-logo-wrap">
        <PanelLeftOpen :size="15" stroke-width="2" class="sb-collapse-hint" />
      </div>
    </div>
    <div v-show="!isCollapsed" class="sb-header" />

    <!-- ===== Main Navigation ===== -->
    <nav class="sb-nav" :aria-label="t('nav_main')">
      <template v-for="item in mainNavItems" :key="item.key">
        <button
          :class="['sb-item', { active: currentSub === item.key }]"
          :title="isCollapsed ? item.label : undefined"
          :aria-current="currentSub === item.key ? 'page' : undefined"
          @click="emit('navigate', item.key)"
        >
          <ClipboardList v-if="item.key === 'clipboard'" :size="19" :stroke-width="1.8" />
          <Star v-else-if="item.key === 'favorites'" :size="19" :stroke-width="1.8" />
          <FileText v-else-if="item.key === 'templates'" :size="19" :stroke-width="1.8" />
          <Monitor v-else-if="item.key === 'devices'" :size="19" :stroke-width="1.8" />
          <span v-show="!isCollapsed" class="sb-label">{{ item.label }}</span>
          <span v-if="item.badge && !isCollapsed" class="sb-badge">{{ item.badge }}</span>
          <kbd v-if="item.kbd && !isCollapsed && !item.badge" class="sb-kbd">{{ item.kbd }}</kbd>
        </button>
      </template>
    </nav>

    <!-- ===== System ===== -->
    <nav class="sb-nav sb-nav--system">
      <div v-if="!isCollapsed" class="sb-sect-label">{{ t('nav_section_system', '系统') }}</div>
      <button
        class="sb-item"
        :class="{ active: currentSub === 'settings' }"
        :title="isCollapsed ? t('nav_settings') : undefined"
        :aria-current="currentSub === 'settings' ? 'page' : undefined"
        @click="emit('navigate', 'settings')"
      >
        <Settings :size="19" :stroke-width="1.8" />
        <span v-show="!isCollapsed" class="sb-label">{{ t('nav_settings') }}</span>
        <kbd v-if="!isCollapsed" class="sb-kbd">Ctrl ,</kbd>
      </button>
    </nav>

    <!-- ===== Footer: 同步脉搏 + user chip + popover menu ===== -->
    <div v-show="!isCollapsed" :ref="setFooterRef as any" class="sb-footer">
      <div class="sync-pill" :title="t('nav_sync_pill', { n: onlineDeviceCount })">
        <i class="pulse" aria-hidden="true" />
        <span>{{ t('nav_sync_pill', { n: onlineDeviceCount }) }}</span>
      </div>
      <!-- 升级入口收进账号行的套餐标签旁（2026-09-20 用户裁定）：
           原来那条通栏「升级套餐」大条太抢眼又和账号菜单里的「升级」重复，
           只留一个不带动作箭头的小胶囊。Free 用户才显示（判定同 showUpgradeChip）。 -->
      <!-- User chip — click toggles menu -->
      <div
        class="user-chip"
        :class="{ 'user-chip--active': showUserMenu }"
        :title="t('nav_profile') || 'View Profile'"
        role="button"
        tabindex="0"
        aria-haspopup="menu"
        :aria-expanded="showUserMenu"
        @click.stop="toggleUserMenu"
        @keydown.enter.prevent="toggleUserMenu"
        @keydown.space.prevent="toggleUserMenu"
      >
        <div class="user-avatar-ring">
          <img v-if="userAvatarUrl" :src="userAvatarUrl" alt="" class="user-avatar-img" />
          <div v-else class="user-avatar-in">{{ userName ? userName.slice(0, 2) : 'CS' }}</div>
        </div>
        <div class="user-info">
          <div class="user-name">{{ userName || 'User' }}</div>
          <div v-if="userEmail" class="user-email">{{ userEmail }}</div>
          <div class="user-plan">
            <span class="user-role">{{
              isSuperAdmin ? t('role_super_admin') : t('role_' + (userPlan || 'Free').toLowerCase())
            }}</span>
            <button
              v-if="showUpgradeChip && !showUserMenu"
              type="button"
              class="upgrade-chip"
              :title="t('sub_upgrade_plan')"
              @click.stop="openUpgrade"
            >
              <Crown :size="11" :stroke-width="2" />
              <span>{{ t('upgrade') }}</span>
            </button>
          </div>
        </div>
      </div>
      <!-- Popover menu (profile + subscription + notifications + admin + logout) -->
      <Transition name="user-menu-fade">
        <div v-if="showUserMenu" class="user-menu">
          <button
            class="user-menu-item"
            @click="
              () => {
                emit('navigate', 'profile')
                closeUserMenu()
              }
            "
          >
            <User :size="14" />
            <span>{{ t('nav_profile') || '个人资料' }}</span>
          </button>
          <!-- 升级：Free/Pro 可见（Enterprise 已无更高档 → 整项不渲染），走同一能力判定。
               图标用 Crown：Sparkles 与顶栏 AI 按钮同形，用户裁定不得重复（2026-09-19）。 -->
          <button v-if="showUpgradeMenuItem" class="user-menu-item user-menu-item--accent" @click="openUpgrade">
            <Crown :size="14" />
            <span>{{ t('upgrade') }}</span>
          </button>
          <button
            class="user-menu-item"
            @click="
              () => {
                emit('navigate', 'notifications')
                closeUserMenu()
              }
            "
          >
            <Bell :size="14" />
            <span>{{ t('nav_notifications') || '通知' }}</span>
            <span v-if="unreadCount > 0" class="user-menu-badge">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
          </button>
          <button class="user-menu-item" @click="openAnnouncements">
            <Megaphone :size="14" />
            <span>公告</span>
            <span v-if="announcementUnreadCount > 0" class="user-menu-badge">
              {{ announcementUnreadCount > 99 ? '99+' : announcementUnreadCount }}
            </span>
          </button>
          <!-- MA-06：管理控制台外链（仅超管），外部浏览器打开 -->
          <button v-if="isSuperAdmin" class="user-menu-item" @click="openAdminConsole">
            <ExternalLink :size="14" />
            <span>{{ t('nav_admin_console') || '管理控制台' }}</span>
          </button>
          <div class="user-menu-divider" />
          <button
            class="user-menu-item user-menu-item--danger"
            @click="
              () => {
                emit('logout')
                closeUserMenu()
              }
            "
          >
            <LogOut :size="14" />
            <span>{{ t('logout') }}</span>
          </button>
        </div>
      </Transition>
    </div>

    <!-- Footer avatar dot (collapsed only) -->
    <div v-show="isCollapsed" class="sb-collapsed-foot">
      <!-- 折叠态升级入口：仅 Free 用户的图标按钮（与展开态同一判定） -->
      <button
        v-if="showUpgradeChip"
        type="button"
        class="sb-footer-dot sb-footer-dot--upgrade"
        :title="t('sub_upgrade_plan')"
        @click="openUpgrade"
      >
        <Crown :size="14" :stroke-width="2" />
      </button>
      <div
        class="sb-footer-dot"
        :title="userName || 'User'"
        style="cursor: pointer; border-radius: var(--radius-md); transition: background 0.12s"
        role="button"
        tabindex="0"
        @click="emit('navigate', 'profile')"
        @keydown.enter.prevent="emit('navigate', 'profile')"
      >
        <div class="user-avatar-ring user-avatar-ring--sm">
          <div class="user-avatar-in user-avatar-in--sm">{{ userName ? userName.slice(0, 1) : 'C' }}</div>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* ================================================================
 * Clearline Sidebar — expanded(220px) ↔ collapsed(56px)
 * 5 项导航 + 系统分组 + 同步脉搏页脚；选中态 = accent-soft 底 + 蓝左条。
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
  transition: width 280ms var(--ease);
}
.sidebar--collapsed {
  width: 56px;
}

/* ---- Header ---- */
.sb-header {
  display: flex;
  align-items: center;
  height: 40px;
  flex-shrink: 0;
  padding: 0 10px;
  gap: 8px;
  position: relative;
}
.sidebar--collapsed .sb-header {
  justify-content: center;
  padding: 0;
}

.sb-logo-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Toggle button — override shadcn ghost defaults to match sidebar */
.sb-toggle {
  margin-left: auto;
  width: 28px !important;
  height: 28px !important;
  padding: 0 !important;
  color: var(--text-tertiary);
  border-radius: var(--radius-sm);
}
.sb-toggle:hover {
  background: var(--bg-hover) !important;
  color: var(--text-primary);
}

/* Collapsed header: entire area is clickable */
.sb-header--clickable {
  cursor: pointer;
}
.sb-header--clickable:hover {
  background: var(--bg-hover);
}

.sb-collapse-hint {
  opacity: 0.4;
  transition: opacity 150ms;
}
.sb-header--clickable:hover .sb-collapse-hint {
  opacity: 0.7;
}

/* ---- Navigation ---- */
.sb-nav {
  display: flex;
  flex-direction: column;
  padding: 6px 10px;
  gap: 2px;
}
.sidebar--collapsed .sb-nav {
  padding: 6px 0;
  align-items: center;
}

.sb-nav--system {
  margin-top: 8px;
  padding-top: 4px;
}

.sb-sect-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  padding: 6px 10px 6px;
  white-space: nowrap;
}

/* ---- Nav Item ---- */
.sb-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  width: 100%;
  white-space: nowrap;
  transition:
    background 160ms var(--ease),
    color 160ms var(--ease);
  position: relative;
}
.sidebar--collapsed .sb-item {
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border-radius: var(--radius-sm);
}

/* Muted icon color for inactive items — icon stays secondary until hover/active */
.sb-item :deep(svg) {
  color: var(--text-tertiary);
  transition: color 0.15s ease;
  flex-shrink: 0;
}
.sb-item:hover :deep(svg) {
  color: var(--text-primary);
}
.sb-item.active :deep(svg) {
  color: var(--accent);
}

/* Hover: clear background */
.sb-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.sb-item:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}

/* Active: accent-soft pill + left accent bar (Clearline 选中语言) */
.sb-item.active {
  background: var(--accent-light);
  color: var(--accent);
  font-weight: 600;
}
/* Left 2px accent bar on active item (expanded only) */
.sidebar:not(.sidebar--collapsed) .sb-item.active::after {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2.5px;
  border-radius: 9999px;
  background: var(--accent);
}
/* Collapsed active indicator: left accent bar */
.sidebar--collapsed .sb-item.active::before {
  content: '';
  position: absolute;
  left: -8px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 2px;
  background: var(--accent);
}

.sb-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.sb-badge {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-tertiary);
  background: var(--bg-hover);
  padding: 1px 7px;
  border-radius: 10px;
  line-height: 1.4;
  font-family: var(--font-content);
}
.sb-kbd {
  margin-left: auto;
  font-family: var(--font-content);
  font-size: 10px;
  color: var(--text-tertiary);
  background: transparent;
  border: none;
  padding: 0 2px;
}
.sb-item.active .sb-kbd {
  color: var(--accent);
  opacity: 0.7;
}

/* ---- Footer (expanded) ---- */
.sb-footer {
  position: relative;
  margin-top: auto;
  padding: 8px 12px 12px;
  border-top: 1px solid var(--border-subtle);
}

/* 同步脉搏（v2 nav-foot）：常驻同步状态可见性 */
.sync-pill {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  margin-bottom: 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  font-size: 11.5px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
}
/* 同步状态珠（静态精致态）。
   这里原本是 2.4s 无限光环动画。实测：只要页面上有持续运行的 CSS 动画，
   浏览器就永远无法进入空闲帧 —— 合成器按显示器刷新率持续要帧
   （3440×1440@165Hz 下 BeginImplFrame 恒定 165/s），GPU 进程约 28% 单核
   全耗在每帧的合成/提交上；动画一停，这些线程立刻归零。
   故改为静态"玻璃珠"：径向高光给出立体质感、极轻外发光给出存在感，
   观感比闪烁圆点更沉稳。gradient/box-shadow 都是静态绘制，运行时零开销。
   （将来若接入真实的"同步中"状态，加 .is-syncing 挂回光环动画即可。） */
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background:
    radial-gradient(circle at 34% 28%, rgb(255 255 255 / 0.55), rgb(255 255 255 / 0) 58%),
    var(--success);
  box-shadow:
    0 0 0 2.5px color-mix(in srgb, var(--success) 13%, transparent),
    0 0 7px color-mix(in srgb, var(--success) 32%, transparent);
}

.user-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background 0.15s ease;
  padding: 6px 4px;
  margin-bottom: 0;
  position: relative;
}
.user-chip:hover {
  background: var(--bg-hover);
}
.user-chip--active {
  background: var(--bg-hover);
}

/* User popover menu — appears above the chip */
.user-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 12px;
  right: 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-dropdown);
  padding: 4px;
  z-index: var(--z-dropdown);
  overflow: hidden;
}
.user-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.12s ease;
  text-align: left;
}
.user-menu-item:hover {
  background: var(--bg-hover);
}
.user-menu-item:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
  background: var(--bg-hover);
}
.user-menu-item--danger {
  color: var(--danger);
}
.user-menu-item--danger:hover {
  background: var(--danger-bg);
}
.user-menu-divider {
  height: 1px;
  background: var(--border-subtle);
  margin: 2px 6px;
}
.user-menu-badge {
  margin-left: auto;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  color: #ffffff;
  background: var(--danger);
  border-radius: 9999px;
}

/* Transition for user menu fade */
.user-menu-fade-enter-active {
  animation: menuFadeIn 0.12s ease-out;
}
.user-menu-fade-leave-active {
  animation: menuFadeOut 0.1s ease-in;
}
@keyframes menuFadeIn {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@keyframes menuFadeOut {
  from {
    opacity: 1;
    transform: translateY(0);
  }
  to {
    opacity: 0;
    transform: translateY(4px);
  }
}
.user-avatar-ring {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--gradient-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: var(--shadow-card);
}
.user-avatar-ring--sm {
  width: 28px;
  height: 28px;
}
.user-avatar-in {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--bg-sidebar);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
}
.user-avatar-img {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  object-fit: cover;
}
.user-avatar-in--sm {
  width: 24px;
  height: 24px;
  font-size: 10px;
}
.user-info {
  flex: 1;
  min-width: 0;
}
.user-name {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-email {
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-role {
  font-size: 11px;
  color: var(--text-tertiary);
}

.user-plan {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* ---- 升级小胶囊（贴在套餐标签右侧，不再是通栏大条）---- */
.upgrade-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  padding: 1px 7px;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
  border-radius: 999px;
  background: var(--accent-light);
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.5;
  cursor: pointer;
  transition:
    background 160ms var(--ease),
    border-color 160ms var(--ease);
}
.upgrade-chip:hover {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border-color: var(--accent);
}
.upgrade-chip:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
.user-menu-item--accent {
  color: var(--accent);
}

/* ---- Footer dot (collapsed) ---- */
.sb-collapsed-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.sb-footer-dot {
  display: flex;
  justify-content: center;
  padding: 10px 0 8px;
}
.sb-footer-dot--upgrade {
  width: 30px;
  height: 30px;
  padding: 0;
  margin: 0;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
  border-radius: var(--radius-sm);
  background: var(--accent-light);
  color: var(--accent);
  cursor: pointer;
}
.sb-footer-dot--upgrade:hover {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
</style>
