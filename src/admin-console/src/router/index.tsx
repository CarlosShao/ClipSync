import { Spin } from 'antd';
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import AdminLayout from '@/layouts/AdminLayout';
import { RequireRole } from '@/router/RequireRole';

const LoginPage = lazy(() => import('@/pages/login'));
const SsoPage = lazy(() => import('@/pages/sso'));
const DashboardPage = lazy(() => import('@/pages/dashboard'));
const UsersPage = lazy(() => import('@/pages/users'));
const DevicesPage = lazy(() => import('@/pages/devices'));
const OrdersPage = lazy(() => import('@/pages/orders'));
const SubscriptionsPage = lazy(() => import('@/pages/subscriptions'));
const PlansPage = lazy(() => import('@/pages/plans'));
// AN-02：客户端策略下发页（复用 configs.view/manage 权限键，不新增权限）
const PoliciesPage = lazy(() => import('@/pages/policies'));
const AuditPage = lazy(() => import('@/pages/audit'));
const RolesPage = lazy(() => import('@/pages/roles'));
const SettingsPage = lazy(() => import('@/pages/settings'));
const OpsPage = lazy(() => import('@/pages/ops'));
const NotFoundPage = lazy(() => import('@/pages/not-found'));

function PageLoading() {
  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Spin size="large" tip="加载中…">
        <div style={{ width: 120, height: 60 }} />
      </Spin>
    </div>
  );
}

function lazyNode(node: ReactNode) {
  return <Suspense fallback={<PageLoading />}>{node}</Suspense>;
}

/** 路由表：/login 独立页；布局子路由全部 lazy；RequireRole 守卫（RB-07：按权限键裁剪）；404 兜底 */
export function AppRoutes() {
  const location = useLocation();
  return (
    <Routes location={location}>
      <Route path="/login" element={lazyNode(<LoginPage />)} />
      {/* SSO 凭据兑换页（RB-SSO）：桌面端超管带一次性 code 跳入，独立于布局 */}
      <Route path="/sso" element={lazyNode(<SsoPage />)} />
      <Route
        element={
          <RequireRole>
            <AdminLayout />
          </RequireRole>
        }
      >
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={lazyNode(<DashboardPage />)} />
        <Route
          path="/users"
          element={lazyNode(
            <RequireRole permission="admin.users.view">
              <UsersPage />
            </RequireRole>,
          )}
        />
        <Route
          path="/devices"
          element={lazyNode(
            <RequireRole permission="admin.devices.view">
              <DevicesPage />
            </RequireRole>,
          )}
        />
        <Route
          path="/orders"
          element={lazyNode(
            <RequireRole permission="admin.orders.view">
              <OrdersPage />
            </RequireRole>,
          )}
        />
        <Route
          path="/subscriptions"
          element={lazyNode(
            <RequireRole permission="admin.subscriptions.view">
              <SubscriptionsPage />
            </RequireRole>,
          )}
        />
        <Route
          path="/plans"
          element={lazyNode(
            <RequireRole permission="admin.plans.view">
              <PlansPage />
            </RequireRole>,
          )}
        />
        <Route
          path="/policies"
          element={lazyNode(
            <RequireRole permission="admin.configs.view">
              <PoliciesPage />
            </RequireRole>,
          )}
        />
        <Route
          path="/audit"
          element={lazyNode(
            <RequireRole permission="admin.audit.view">
              <AuditPage />
            </RequireRole>,
          )}
        />
        <Route
          path="/roles"
          element={lazyNode(
            <RequireRole permission="admin.roles.view">
              <RolesPage />
            </RequireRole>,
          )}
        />
        <Route
          path="/settings"
          element={lazyNode(
            <RequireRole permission={['admin.configs.view', 'admin.announce.send']}>
              <SettingsPage />
            </RequireRole>,
          )}
        />
        <Route
          path="/ops"
          element={lazyNode(
            <RequireRole permission="admin.ops.view">
              <OpsPage />
            </RequireRole>,
          )}
        />
      </Route>
      <Route path="*" element={lazyNode(<NotFoundPage />)} />
    </Routes>
  );
}
