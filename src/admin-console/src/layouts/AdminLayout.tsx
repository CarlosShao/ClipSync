import {
  BellOutlined,
  CloudUploadOutlined,
  ControlOutlined,
  CreditCardOutlined,
  DashboardOutlined,
  FileSearchOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MobileOutlined,
  MonitorOutlined,
  RobotOutlined,
  SafetyOutlined,
  SettingOutlined,
  ShoppingCartOutlined,
  TagsOutlined,
  TeamOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import { Badge, Button, Dropdown, Layout, Menu, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { useEffect } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ADMIN_ROLE_KEYS, useAuthStore } from '@/stores/authStore';
import { hasPerm } from '@/utils/permissions';
import { getOverview } from '@/api/overview';
import { getConfigs } from '@/api/configs';
import { queryKeys } from '@/queryKeys';
import ErrorBoundary from '@/components/ErrorBoundary';
import { useResizableSider, useStatePersistedCollapsed } from './useResizableSider';
import styles from './AdminLayout.module.css';

const { Sider, Header, Content } = Layout;

/** 导航项：antd Menu items 结构 + 权限点（RB-07：perm 缺省 = 有 token 即可；数组 = 任一满足） */
interface NavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  perm?: string | string[];
}

/**
 * 主导航（图标 + 文案）。仅图片标（不建子菜单）——分组留给后续真实需求，
 * 避免过早引入层级导致折叠态/权限裁剪逻辑复杂化。
 */
const NAV_ITEMS: NavItem[] = [
  { key: '/dashboard', label: '数据看板', icon: <DashboardOutlined /> },
  { key: '/users', label: '用户管理', icon: <TeamOutlined />, perm: 'admin.users.view' },
  { key: '/devices', label: '设备管理', icon: <MobileOutlined />, perm: 'admin.devices.view' },
  {
    key: '/orders',
    label: '订单与支付',
    icon: <ShoppingCartOutlined />,
    perm: 'admin.orders.view',
  },
  {
    key: '/subscriptions',
    label: '订阅管理',
    icon: <CreditCardOutlined />,
    perm: 'admin.subscriptions.view',
  },
  { key: '/plans', label: '套餐与价格', icon: <TagsOutlined />, perm: 'admin.plans.view' },
  // AN-04：版本发布管理（admin.release.manage，065 迁移仅授 super_admin）
  {
    key: '/releases',
    label: '版本发布',
    icon: <CloudUploadOutlined />,
    perm: 'admin.release.manage',
  },
  { key: '/audit', label: '审计日志', icon: <FileSearchOutlined />, perm: 'admin.audit.view' },
  // AN-12：管理员安全策略 —— 管理员会话（复用 admin.users.view，不新增权限键）
  { key: '/security', label: '管理员会话', icon: <SafetyOutlined />, perm: 'admin.users.view' },
  { key: '/roles', label: '角色权限', icon: <UserSwitchOutlined />, perm: 'admin.roles.view' },
  {
    key: '/settings',
    label: '系统设置',
    icon: <SettingOutlined />,
    perm: ['admin.configs.view', 'admin.announce.send'],
  },
  // AN-02：客户端策略下发（与系统设置同权限域，仅新增不改既有项）
  { key: '/policies', label: '客户端策略', icon: <ControlOutlined />, perm: 'admin.configs.view' },
  { key: '/ops', label: '运维监控', icon: <MonitorOutlined />, perm: 'admin.ops.view' },
  // AN-03：AI 平台设置（admin.ai.manage，062 迁移仅授 super_admin）
  { key: '/ai', label: 'AI 平台', icon: <RobotOutlined />, perm: 'admin.ai.manage' },
];

/** 侧边栏宽度约束（展开态） */
const SIDER_MIN = 168;
const SIDER_MAX = 320;
const SIDER_DEFAULT = 208;
/** 折叠态宽度：仅容一列图标 */
const SIDER_COLLAPSED = 64;
const SIDER_STORAGE_KEY = 'clipsync-admin-sider-width';

function LogoMark() {
  return (
    <div className={styles.logoMark}>
      <svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden>
        <rect x="9.8" y="10.5" width="5" height="19" rx="2.5" fill="#fff" />
        <rect x="33.2" y="18.5" width="5" height="19" rx="2.5" fill="#fff" />
        <rect x="20.9" y="19.5" width="9" height="9" rx="2.6" fill="#fff" />
        <line
          x1="16.4"
          y1="26"
          x2="18.6"
          y2="24.7"
          stroke="#fff"
          strokeWidth="3.4"
          strokeLinecap="round"
          opacity=".55"
        />
      </svg>
    </div>
  );
}

/**
 * 后台主布局：可折叠/可拖拽调宽的侧边栏导航（antd Layout.Sider + Menu） + 内容区。
 *
 * - 折叠：antd Sider 原生 collapsible，状态持久化到 localStorage
 * - 调宽：antd 5.x Sider 无原生 resizable，由 useResizableSider 提供拖拽手柄
 * - 权限：NAV_ITEMS 按 hasPerm 过滤（RB-07），无权限项不进菜单
 * - 登录校验兜底：无 token 或角色非管理角色时不渲染内容
 */
export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { accessToken, roleKey, nickname, clearAuth } = useAuthStore();

  // AF-32：通知铃铛接真实待办（复用看板 pendingItems 聚合），点击条目跳转对应页面
  const { data: overview } = useQuery({
    queryKey: queryKeys.overview(),
    queryFn: getOverview,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const pendingItems = overview?.pendingItems ?? [];

  // AF-51：管理台空闲自动登出（读 session_timeout_minutes；0/缺省 = 不启用）
  // ⚠️ hooks 必须在条件 return（未登录重定向）之前调用
  const { data: configs } = useQuery({
    queryKey: queryKeys.configs(),
    queryFn: getConfigs,
    staleTime: 5 * 60_000,
  });
  const idleTimeoutMinutes = Number(
    configs?.find((c) => c.key === 'session_timeout_minutes')?.value ?? 0
  );
  useEffect(() => {
    if (!Number.isFinite(idleTimeoutMinutes) || idleTimeoutMinutes <= 0) return;
    let lastActive = Date.now();
    const bump = () => {
      lastActive = Date.now();
    };
    const events = ['mousemove', 'keydown', 'click', 'scroll'] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - lastActive > idleTimeoutMinutes * 60_000) {
        clearAuth();
        window.location.replace('/login');
      }
    }, 30_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      window.clearInterval(timer);
    };
  }, [idleTimeoutMinutes, clearAuth]);

  const [collapsed, setCollapsed] = useStatePersistedCollapsed();

  const { width, onPointerDown, onPointerMove, endDrag, onKeyDown } = useResizableSider({
    min: SIDER_MIN,
    max: SIDER_MAX,
    defaultWidth: SIDER_DEFAULT,
    storageKey: SIDER_STORAGE_KEY,
    enabled: !collapsed,
  });

  if (!accessToken || !roleKey || !ADMIN_ROLE_KEYS.includes(roleKey)) {
    return <Navigate to="/login" replace />;
  }

  const handleLogout = () => {
    clearAuth();
    void navigate('/login', { replace: true });
  };

  // RB-07：按权限裁剪菜单项
  const visibleItems = NAV_ITEMS.filter(
    (item) =>
      !item.perm ||
      (Array.isArray(item.perm) ? item.perm.some((p) => hasPerm(p)) : hasPerm(item.perm))
  );

  const menuItems: MenuProps['items'] = visibleItems.map((item) => ({
    key: item.key,
    icon: item.icon,
    label: item.label,
  }));

  // 选中项：取匹配度最高的前缀（/subscriptions 与 /subscriptions-x 不应互相误判）
  const selectedKey =
    visibleItems
      .map((i) => i.key)
      .filter((k) => location.pathname === k || location.pathname.startsWith(`${k}/`))
      .sort((a, b) => b.length - a.length)[0] ?? '';

  const pendingMenu = {
    items: pendingItems.length
      ? pendingItems.map((p) => ({ key: p.id, label: `${p.title} · ${p.target}` }))
      : [{ key: 'empty', label: '暂无待办', disabled: true }],
    onClick: ({ key }: { key: string }) => {
      const item = pendingItems.find((p) => p.id === key);
      if (item?.actionTo) void navigate(item.actionTo);
    },
  };

  return (
    <ErrorBoundary>
      <Layout className={styles.root}>
        <Sider
          className={styles.sider}
          theme="light"
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          trigger={null}
          width={width}
          collapsedWidth={SIDER_COLLAPSED}
        >
          <div className={styles.brand}>
            <LogoMark />
            {!collapsed ? (
              <>
                <span className={styles.brandName}>ClipSync Admin</span>
                <span className={styles.brandVersion}>v0.1</span>
              </>
            ) : null}
          </div>

          <Menu
            className={styles.menu}
            mode="inline"
            selectedKeys={selectedKey ? [selectedKey] : []}
            items={menuItems}
            onClick={({ key }) => void navigate(key)}
            // 折叠态不渲染 label（只留图标 + Tooltip），避免文字挤压
            inlineCollapsed={collapsed}
          />

          {!collapsed ? (
            <div
              className={styles.resizeHandle}
              role="separator"
              aria-orientation="vertical"
              aria-label="拖动调整侧边栏宽度"
              aria-valuenow={width}
              aria-valuemin={SIDER_MIN}
              aria-valuemax={SIDER_MAX}
              tabIndex={0}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={onKeyDown}
            />
          ) : null}
        </Sider>

        <Layout>
          <Header className={styles.header}>
            <Tooltip title={collapsed ? '展开侧边栏' : '折叠侧边栏'} placement="bottomLeft">
              <Button
                type="text"
                className={styles.collapseBtn}
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => setCollapsed(!collapsed)}
                aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'}
              />
            </Tooltip>
            <div className={styles.right}>
              {import.meta.env.DEV ? <span className={styles.envTag}>DEV 环境</span> : null}
              {/* AF-32：铃铛接真实待办（此前为无响应装饰） */}
              <Dropdown menu={pendingMenu} placement="bottomRight" trigger={['click']}>
                <Badge count={pendingItems.length} size="small" offset={[-4, 4]} color="var(--red)">
                  <Button
                    className={styles.bell}
                    type="text"
                    icon={<BellOutlined />}
                    aria-label="通知"
                  />
                </Badge>
              </Dropdown>
              <Tooltip title={nickname ?? '管理员'} placement="bottom">
                <div className={styles.avatar}>CS</div>
              </Tooltip>
              <Tooltip title="退出" placement="bottom">
                <Button
                  className={styles.logoutBtn}
                  type="text"
                  icon={<LogoutOutlined />}
                  onClick={handleLogout}
                  aria-label="退出登录"
                />
              </Tooltip>
            </div>
          </Header>
          <Content className={styles.content}>
            <Outlet />
          </Content>
        </Layout>
      </Layout>
    </ErrorBoundary>
  );
}
