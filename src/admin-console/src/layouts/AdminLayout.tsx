import { BellOutlined, LogoutOutlined } from '@ant-design/icons';
import { Badge, Button, Dropdown, Tooltip } from 'antd';
import { useEffect } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ADMIN_ROLE_KEYS, useAuthStore } from '@/stores/authStore';
import { hasPerm } from '@/utils/permissions';
import { getOverview } from '@/api/overview';
import { getConfigs } from '@/api/configs';
import { queryKeys } from '@/queryKeys';
import styles from './AdminLayout.module.css';

/** 导航项权限点（RB-07）：perm 缺省 = 有 token 即可（如数据看板）；数组 = 任一满足即显示 */
interface NavItem {
  key: string;
  label: string;
  perm?: string | string[];
}

const NAV_ITEMS: NavItem[] = [
  { key: '/dashboard', label: '数据看板' },
  { key: '/users', label: '用户管理', perm: 'admin.users.view' },
  { key: '/devices', label: '设备管理', perm: 'admin.devices.view' },
  { key: '/orders', label: '订单与支付', perm: 'admin.orders.view' },
  { key: '/subscriptions', label: '订阅管理', perm: 'admin.subscriptions.view' },
  { key: '/plans', label: '套餐与价格', perm: 'admin.plans.view' },
  // AN-04：版本发布管理（admin.release.manage，065 迁移仅授 super_admin）
  { key: '/releases', label: '版本发布', perm: 'admin.release.manage' },
  { key: '/audit', label: '审计日志', perm: 'admin.audit.view' },
  // AN-12：管理员安全策略 —— 管理员会话（复用 admin.users.view，不新增权限键）
  { key: '/security', label: '管理员会话', perm: 'admin.users.view' },
  { key: '/roles', label: '角色权限', perm: 'admin.roles.view' },
  { key: '/settings', label: '系统设置', perm: ['admin.configs.view', 'admin.announce.send'] },
  // AN-02：客户端策略下发（与系统设置同权限域，仅新增不改既有项）
  { key: '/policies', label: '客户端策略', perm: 'admin.configs.view' },
  { key: '/ops', label: '运维监控', perm: 'admin.ops.view' },
  // AN-03：AI 平台设置（admin.ai.manage，062 迁移仅授 super_admin）
  { key: '/ai', label: 'AI 平台', perm: 'admin.ai.manage' },
];

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
 * 后台主布局：顶栏主导航（对照草图 B 顶栏 1:1）+ 内容区。
 * 登录校验兜底：无 token 或角色非管理角色时不渲染内容。
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

  if (!accessToken || !roleKey || !ADMIN_ROLE_KEYS.includes(roleKey)) {
    return <Navigate to="/login" replace />;
  }

  const handleLogout = () => {
    clearAuth();
    void navigate('/login', { replace: true });
  };

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
    <div style={{ minHeight: '100vh' }}>
      <header className={styles.topnav}>
        <div className={styles.brand}>
          <LogoMark />
          ClipSync Admin
          <span className={styles.brandVersion}>v0.1</span>
        </div>
        <span className={styles.divider} />
        <nav className={styles.nav} aria-label="主导航">
          {NAV_ITEMS.filter(
            (item) =>
              !item.perm ||
              (Array.isArray(item.perm) ? item.perm.some((p) => hasPerm(p)) : hasPerm(item.perm))
          ).map((item) => {
            const active = location.pathname.startsWith(item.key);
            return (
              <button
                key={item.key}
                type="button"
                className={`${styles.navBtn} ${active ? styles.navBtnActive : ''}`}
                onClick={() => void navigate(item.key)}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
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
      </header>
      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
  );
}
