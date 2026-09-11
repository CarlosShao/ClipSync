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
 * 主导航（图标 + 文案），按「业务 → 配置 → 系统」三段分组。
 *
 * 排序依据（而非历史追加顺序）：
 *   1. 概览 —— 看板只此一项，置于最顶
 *   2. 业务 —— 日常运营高频：用户 / 设备 / 订单 / 订阅
 *   3. 配置 —— 低频、影响面大：套餐定价、客户端策略
 *   4. 系统 —— 管理自身：权限、会话、审计、发布、运维、AI、设置
 *      · 系统设置置于末位（管理台惯例：设置不放业务区）
 *      · 超管专属项（release/ops/ai）集中在系统段尾部，普通 admin 看不到它们，
 *        其菜单自然只剩「系统设置」，不会出现空组
 *
 * 分组用 antd Menu 的 type:'group'——折叠态下分组标题自动隐藏、只留图标，
 * 无需额外分支判断。
 */
interface NavGroup {
  key: string;
  /** 分组标题（仅展开态显示；折叠态由 antd 自动隐藏） */
  label: string;
  children: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    key: 'g-overview',
    // 单组仅一项：不显示组标题（靠间距与下方业务区分隔即可）
    label: '',
    children: [{ key: '/dashboard', label: '数据看板', icon: <DashboardOutlined /> }],
  },
  {
    key: 'g-business',
    label: '业务运营',
    children: [
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
    ],
  },
  {
    key: 'g-config',
    label: '配置',
    children: [
      { key: '/plans', label: '套餐与价格', icon: <TagsOutlined />, perm: 'admin.plans.view' },
      // AN-02：客户端策略下发（与系统设置同权限域，仅新增不改既有项）
      {
        key: '/policies',
        label: '客户端策略',
        icon: <ControlOutlined />,
        perm: 'admin.configs.view',
      },
    ],
  },
  {
    key: 'g-system',
    label: '系统',
    children: [
      { key: '/roles', label: '角色权限', icon: <UserSwitchOutlined />, perm: 'admin.roles.view' },
      // AN-12：管理员安全策略 —— 管理员会话（复用 admin.users.view，不新增权限键）
      { key: '/security', label: '管理员会话', icon: <SafetyOutlined />, perm: 'admin.users.view' },
      { key: '/audit', label: '审计日志', icon: <FileSearchOutlined />, perm: 'admin.audit.view' },
      // AN-04：版本发布管理（admin.release.manage，065 迁移仅授 super_admin）
      {
        key: '/releases',
        label: '版本发布',
        icon: <CloudUploadOutlined />,
        perm: 'admin.release.manage',
      },
      { key: '/ops', label: '运维监控', icon: <MonitorOutlined />, perm: 'admin.ops.view' },
      // AN-03：AI 平台设置（admin.ai.manage，062 迁移仅授 super_admin）
      { key: '/ai', label: 'AI 平台', icon: <RobotOutlined />, perm: 'admin.ai.manage' },
      // 系统设置置末（管理台惯例）
      {
        key: '/settings',
        label: '系统设置',
        icon: <SettingOutlined />,
        perm: ['admin.configs.view', 'admin.announce.send'],
      },
    ],
  },
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

  // RB-07：按权限裁剪——逐组过滤子项，整组无可见项时该组不渲染
  // （否则普通 admin 会看到只剩标题的空组）
  const canSee = (item: NavItem) =>
    !item.perm ||
    (Array.isArray(item.perm) ? item.perm.some((p) => hasPerm(p)) : hasPerm(item.perm));

  const visibleGroups = NAV_GROUPS.map((group) => ({
    ...group,
    children: group.children.filter(canSee),
  })).filter((group) => group.children.length > 0);

  const visibleItems = visibleGroups.flatMap((g) => g.children);

  const menuItems: MenuProps['items'] = visibleGroups.map((group) => ({
    key: group.key,
    type: 'group' as const,
    // 空 label 的分组不渲染标题（见 NAV_GROUPS.g-overview 注释）
    label: group.label || undefined,
    children: group.children.map((item) => ({
      key: item.key,
      icon: item.icon,
      label: item.label,
    })),
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
