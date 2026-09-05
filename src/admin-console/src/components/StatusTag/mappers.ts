import type {
  OrderStatus,
  PendingItemType,
  PlanKey,
  SubscriptionStatus,
  UserStatus,
} from '@/api/types';
import type { StatusTone } from '@/components/StatusTag';

/** 域枚举 → StatusTag 色调/文案 的映射（对照草图 B 的状态色） */

export const planTone: Record<PlanKey | 'trial', StatusTone> = {
  free: 'gray',
  pro: 'brand',
  enterprise: 'blue',
  trial: 'amber',
};

export const planLabel: Record<PlanKey, string> = {
  free: 'Free',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

export function subscriptionTone(status: SubscriptionStatus): StatusTone {
  switch (status) {
    case 'active':
      return 'green';
    case 'trialing':
      return 'amber';
    case 'past_due':
      return 'amber';
    case 'expired':
      return 'gray';
    case 'canceled':
      return 'red';
    default:
      return 'gray';
  }
}

export const userStatusTone: Record<UserStatus, StatusTone> = {
  active: 'green',
  disabled: 'red',
};

export const userStatusLabel: Record<UserStatus, string> = {
  active: '正常',
  disabled: '已停用',
};

export const orderStatusTone: Record<OrderStatus, StatusTone> = {
  pending: 'amber',
  paid: 'green',
  failed: 'red',
  cancelled: 'gray',
  refunded: 'red',
};

export const orderStatusLabel: Record<OrderStatus, string> = {
  pending: '待支付',
  paid: '已支付',
  failed: '已失败',
  cancelled: '已关闭',
  refunded: '已退款',
};

export const channelLabel: Record<'wechat' | 'alipay' | 'stripe', string> = {
  wechat: '微信支付',
  alipay: '支付宝',
  stripe: 'Stripe',
};

export const pendingItemTypeTone: Record<PendingItemType, StatusTone> = {
  payment: 'red',
  subscription: 'amber',
  reconcile: 'amber',
  security: 'blue',
};

export const pendingItemTypeLabel: Record<PendingItemType, string> = {
  payment: '支付',
  subscription: '订阅',
  reconcile: '对账',
  security: '安全',
};

export const operatorRoleLabel: Record<'super_admin' | 'admin' | 'user', string> = {
  super_admin: '超管',
  admin: '管理员',
  user: '终端用户',
};

export const operatorRoleTone: Record<'super_admin' | 'admin' | 'user', StatusTone> = {
  super_admin: 'brand',
  admin: 'blue',
  user: 'gray',
};
