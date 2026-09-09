import type {
  AdminSessionListParams,
  AuditLogListParams,
  OrderListParams,
  UserListParams,
} from '@/api/types';

/**
 * 全局唯一 queryKey 工厂：禁止在组件里散落字符串 key。
 * 失效按域前缀进行，如 invalidateQueries({ queryKey: ['users'] }) 会同时命中列表与详情。
 */
export const queryKeys = {
  overview: () => ['overview'] as const,

  users: (params: UserListParams) => ['users', params] as const,
  user: (id: string) => ['users', 'detail', id] as const,

  orders: (params: OrderListParams) => ['orders', params] as const,

  auditLogs: (params: AuditLogListParams) => ['audit-logs', params] as const,

  // AN-12：管理员会话（安全策略）
  adminSessions: (params: AdminSessionListParams) => ['admin-sessions', params] as const,

  roles: () => ['roles'] as const,
  permissions: () => ['permissions'] as const,

  configs: () => ['configs'] as const,
  flags: () => ['flags'] as const,
  announcements: () => ['announcements'] as const,

  opsOverview: () => ['ops-overview'] as const,
  opsBackups: () => ['ops-backups'] as const,
  slowQueries: () => ['slow-queries'] as const,
  // AN-15 / AN-08：活跃告警 + 存储用量
  opsAlerts: () => ['ops-alerts'] as const,
  opsStorage: () => ['ops-storage'] as const,
};
