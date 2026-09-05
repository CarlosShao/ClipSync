import { Spin } from 'antd';
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import AdminLayout from '@/layouts/AdminLayout';
import { RequireRole } from '@/router/RequireRole';

const LoginPage = lazy(() => import('@/pages/login'));
const DashboardPage = lazy(() => import('@/pages/dashboard'));
const UsersPage = lazy(() => import('@/pages/users'));
const OrdersPage = lazy(() => import('@/pages/orders'));
const AuditPage = lazy(() => import('@/pages/audit'));
const RolesPage = lazy(() => import('@/pages/roles'));
const SettingsPage = lazy(() => import('@/pages/settings'));
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

/** 路由表：/login 独立页；布局子路由全部 lazy；RequireRole 守卫；404 兜底 */
export function AppRoutes() {
  const location = useLocation();
  return (
    <Routes location={location}>
      <Route path="/login" element={lazyNode(<LoginPage />)} />
      <Route
        element={
          <RequireRole>
            <AdminLayout />
          </RequireRole>
        }
      >
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={lazyNode(<DashboardPage />)} />
        <Route path="/users" element={lazyNode(<UsersPage />)} />
        <Route path="/orders" element={lazyNode(<OrdersPage />)} />
        <Route path="/audit" element={lazyNode(<AuditPage />)} />
        <Route path="/roles" element={lazyNode(<RolesPage />)} />
        <Route path="/settings" element={lazyNode(<SettingsPage />)} />
      </Route>
      <Route path="*" element={lazyNode(<NotFoundPage />)} />
    </Routes>
  );
}
