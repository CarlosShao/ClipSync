import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { hasPerm } from '@/utils/permissions';

describe('hasPerm', () => {
  beforeEach(() => {
    useAuthStore.setState({ roleKey: null, permissions: [] });
  });

  it('super_admin 恒为 true（即使未下发权限列表）', () => {
    useAuthStore.setState({ roleKey: 'super_admin', permissions: [] });
    expect(hasPerm('admin.users.delete')).toBe(true);
    expect(hasPerm('anything.else')).toBe(true);
  });

  it('按权限列表判断', () => {
    useAuthStore.setState({ roleKey: 'admin', permissions: ['admin.users.view', 'admin.users.manage'] });
    expect(hasPerm('admin.users.view')).toBe(true);
    expect(hasPerm('admin.users.delete')).toBe(false);
  });

  it('权限列表含通配符 * 时全放行', () => {
    useAuthStore.setState({ roleKey: 'custom_support', permissions: ['*'] });
    expect(hasPerm('admin.orders.refund')).toBe(true);
  });

  it('未登录（无角色）恒为 false', () => {
    useAuthStore.setState({ roleKey: null, permissions: ['admin.users.view'] });
    expect(hasPerm('admin.users.view')).toBe(false);
  });
});
