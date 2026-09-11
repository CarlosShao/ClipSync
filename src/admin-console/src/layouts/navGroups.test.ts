import { describe, it, expect } from 'vitest';

/**
 * 侧边栏菜单分组与权限裁剪的纯逻辑回归。
 *
 * 背景：菜单从「顶栏平铺 14 项」改为「侧边栏 + 4 段分组」，并重排了顺序
 * （业务 → 配置 → 系统，系统设置置末）。本文件锁定两条不变量：
 *   1. 排序稳定：组顺序与组内顺序符合约定，系统设置必须是最后一项
 *   2. 裁剪不留空组：无权限组整组消失；单项组（概览）不渲染标题
 *
 * 不引入 React 渲染（那是 e2e 的职责），只测数据变换。
 */

interface NavItem {
  key: string;
  label: string;
  perm?: string | string[];
}
interface NavGroup {
  key: string;
  label: string;
  children: NavItem[];
}

// 与 AdminLayout.tsx 的 NAV_GROUPS 保持同构（标签顺序是本次验收要点）
const NAV_GROUPS: NavGroup[] = [
  {
    key: 'g-overview',
    label: '',
    children: [{ key: '/dashboard', label: '数据看板' }],
  },
  {
    key: 'g-business',
    label: '业务运营',
    children: [
      { key: '/users', label: '用户管理', perm: 'admin.users.view' },
      { key: '/devices', label: '设备管理', perm: 'admin.devices.view' },
      { key: '/orders', label: '订单与支付', perm: 'admin.orders.view' },
      { key: '/subscriptions', label: '订阅管理', perm: 'admin.subscriptions.view' },
    ],
  },
  {
    key: 'g-config',
    label: '配置',
    children: [
      { key: '/plans', label: '套餐与价格', perm: 'admin.plans.view' },
      { key: '/policies', label: '客户端策略', perm: 'admin.configs.view' },
    ],
  },
  {
    key: 'g-system',
    label: '系统',
    children: [
      { key: '/roles', label: '角色权限', perm: 'admin.roles.view' },
      { key: '/security', label: '管理员会话', perm: 'admin.users.view' },
      { key: '/audit', label: '审计日志', perm: 'admin.audit.view' },
      { key: '/releases', label: '版本发布', perm: 'admin.release.manage' },
      { key: '/ops', label: '运维监控', perm: 'admin.ops.view' },
      { key: '/ai', label: 'AI 平台', perm: 'admin.ai.manage' },
      { key: '/settings', label: '系统设置', perm: ['admin.configs.view', 'admin.announce.send'] },
    ],
  },
];

/** 复刻 AdminLayout 的裁剪逻辑 */
function visibleGroups(perms: string[], isSuperAdmin = false) {
  const canSee = (item: NavItem) => {
    if (!item.perm) return true;
    if (isSuperAdmin) return true;
    const list = Array.isArray(item.perm) ? item.perm : [item.perm];
    return list.some((p) => perms.includes(p));
  };
  return NAV_GROUPS.map((g) => ({ ...g, children: g.children.filter(canSee) })).filter(
    (g) => g.children.length > 0
  );
}

const ALL_PERMS = [
  'admin.users.view',
  'admin.devices.view',
  'admin.orders.view',
  'admin.subscriptions.view',
  'admin.plans.view',
  'admin.configs.view',
  'admin.announce.send',
  'admin.roles.view',
  'admin.audit.view',
  'admin.release.manage',
  'admin.ops.view',
  'admin.ai.manage',
];

describe('侧边栏菜单：分组与排序', () => {
  it('超管可见全部 14 项，分成 4 组', () => {
    const g = visibleGroups(ALL_PERMS, true);
    expect(g.map((x) => x.key)).toEqual(['g-overview', 'g-business', 'g-config', 'g-system']);
    expect(g.flatMap((x) => x.children)).toHaveLength(14);
  });

  it('组顺序为 概览 → 业务运营 → 配置 → 系统', () => {
    const g = visibleGroups(ALL_PERMS, true);
    expect(g.map((x) => x.label)).toEqual(['', '业务运营', '配置', '系统']);
  });

  it('系统设置必须是整个菜单的最后一项（管理台惯例）', () => {
    const flat = visibleGroups(ALL_PERMS, true).flatMap((x) => x.children);
    expect(flat.at(-1)?.key).toBe('/settings');
  });

  it('数据看板必须是第一项（概览组，无标题）', () => {
    const g = visibleGroups(ALL_PERMS, true);
    expect(g[0]?.children[0]?.key).toBe('/dashboard');
    expect(g[0]?.label).toBe('');
  });

  it('业务运营组内顺序：用户 → 设备 → 订单 → 订阅', () => {
    const biz = visibleGroups(ALL_PERMS, true).find((x) => x.key === 'g-business');
    expect(biz?.children.map((c) => c.key)).toEqual([
      '/users',
      '/devices',
      '/orders',
      '/subscriptions',
    ]);
  });

  it('配置组含套餐与价格、客户端策略（不再是历史的散落位置）', () => {
    const cfg = visibleGroups(ALL_PERMS, true).find((x) => x.key === 'g-config');
    expect(cfg?.children.map((c) => c.key)).toEqual(['/plans', '/policies']);
  });

  it('版本发布不再夹在业务与配置之间（已归入系统组）', () => {
    const g = visibleGroups(ALL_PERMS, true);
    const bizIdx = g.findIndex((x) => x.key === 'g-business');
    const cfgIdx = g.findIndex((x) => x.key === 'g-config');
    const releases = g
      .find((x) => x.key === 'g-system')
      ?.children.find((c) => c.key === '/releases');
    expect(releases).toBeTruthy();
    expect(cfgIdx).toBeGreaterThan(bizIdx); // 配置在业务之后
  });
});

describe('侧边栏菜单：权限裁剪不留空组', () => {
  it('普通 admin（无超管专属键）→ 系统组仍存在且非空', () => {
    const adminPerms = [
      'admin.users.view',
      'admin.devices.view',
      'admin.orders.view',
      'admin.subscriptions.view',
      'admin.plans.view',
      'admin.configs.view',
      'admin.announce.send',
      'admin.roles.view',
      'admin.audit.view',
    ];
    const g = visibleGroups(adminPerms);
    const sys = g.find((x) => x.key === 'g-system');
    expect(sys).toBeTruthy();
    expect(sys?.children.length).toBeGreaterThan(0);
    // 超管专属项必须不可见
    const sysKeys = (sys?.children ?? []).map((c) => c.key);
    expect(sysKeys).not.toContain('/releases');
    expect(sysKeys).not.toContain('/ops');
    expect(sysKeys).not.toContain('/ai');
    // 系统设置仍为最后一项
    const flat = g.flatMap((x) => x.children);
    expect(flat.at(-1)?.key).toBe('/settings');
  });

  it('仅有 users.view → 配置组整组消失，且不出现空组', () => {
    const g = visibleGroups(['admin.users.view']);
    expect(g.map((x) => x.key)).toEqual(['g-overview', 'g-business', 'g-system']);
    for (const group of g) {
      expect(group.children.length).toBeGreaterThan(0);
    }
  });

  it('无任何权限（非超管）→ 只剩概览组的数据看板', () => {
    const g = visibleGroups([]);
    expect(g).toHaveLength(1);
    expect(g[0]?.children.map((c) => c.key)).toEqual(['/dashboard']);
  });

  it('系统设置的数组权限满足任一即可见（configs.view 单独命中）', () => {
    const g = visibleGroups(['admin.configs.view']);
    const sys = g.find((x) => x.key === 'g-system');
    expect(sys?.children.map((c) => c.key)).toContain('/settings');
  });

  it('系统设置的数组权限满足任一即可见（announce.send 单独命中）', () => {
    const g = visibleGroups(['admin.announce.send']);
    const sys = g.find((x) => x.key === 'g-system');
    expect(sys?.children.map((c) => c.key)).toContain('/settings');
  });
});
