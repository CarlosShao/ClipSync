import {
  BellOutlined,
  LogoutOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { Badge, Button, Tooltip } from 'antd';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { ADMIN_ROLE_KEYS, useAuthStore } from '@/stores/authStore';
import styles from './AdminLayout.module.css';

const NAV_ITEMS = [
  { key: '/dashboard', label: '数据看板' },
  { key: '/users', label: '用户管理' },
  { key: '/devices', label: '设备管理' },
  { key: '/orders', label: '订单与支付' },
  { key: '/subscriptions', label: '订阅管理' },
  { key: '/audit', label: '审计日志' },
  { key: '/roles', label: '角色权限' },
  { key: '/settings', label: '系统设置' },
] as const;

function LogoMark() {
  return (
    <div className={styles.logoMark}>
      <svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden>
        <rect x="9.8" y="10.5" width="5" height="19" rx="2.5" fill="#fff" />
        <rect x="33.2" y="18.5" width="5" height="19" rx="2.5" fill="#fff" />
        <rect x="20.9" y="19.5" width="9" height="9" rx="2.6" fill="#fff" />
        <line x1="16.4" y1="26" x2="18.6" y2="24.7" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" opacity=".55" />
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

  if (!accessToken || !roleKey || !ADMIN_ROLE_KEYS.includes(roleKey)) {
    return <Navigate to="/login" replace />;
  }

  const handleLogout = () => {
    clearAuth();
    void navigate('/login', { replace: true });
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
          {NAV_ITEMS.map((item) => {
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
          <div className={styles.search}>
            <SearchOutlined className={styles.searchIcon} />
            搜索：用户 / 订单 / IP
          </div>
          <Tooltip title="通知">
            <Badge dot offset={[-4, 4]} color="var(--red)">
              <Button className={styles.bell} type="text" icon={<BellOutlined />} aria-label="通知" />
            </Badge>
          </Tooltip>
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
