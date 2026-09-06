import { App as AntdApp, Button, Card, Checkbox, Empty, Spin } from 'antd';
import {
  CrownOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  StarOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { createRole, getPermissions, getRoles, updateRolePermissions } from '@/api/roles';
import { queryKeys } from '@/queryKeys';
import { CreateRoleModal } from './CreateRoleModal';
import type { CreateRolePayload, Permission, PermissionCategory, Role } from '@/api/types';
import styles from './roles.module.css';

/** 分组顺序与组头文案（对照草图 perm-tree 四组） */
const CATEGORY_ORDER: PermissionCategory[] = [
  'users_devices',
  'subscriptions_orders',
  'audit_security',
  'operations',
];

const CATEGORY_LABELS: Record<PermissionCategory, string> = {
  users_devices: '用户与设备',
  subscriptions_orders: '订阅与支付',
  audit_security: '审计与安全',
  operations: '平台运营',
};

const ROLE_ICONS: Record<string, { icon: ReactNode; color: string }> = {
  super_admin: { icon: <CrownOutlined />, color: 'var(--brand)' },
  admin: { icon: <TeamOutlined />, color: 'var(--blue)' },
  user: { icon: <UserOutlined />, color: 'var(--text-3)' },
  custom: { icon: <StarOutlined />, color: 'var(--amber)' },
};

function roleVisual(role: Role): { icon: ReactNode; color: string } {
  if (!role.isBuiltIn) return ROLE_ICONS['custom'] ?? { icon: <StarOutlined />, color: 'var(--amber)' };
  return ROLE_ICONS[role.roleKey] ?? ROLE_ICONS['user'] ?? { icon: <UserOutlined />, color: 'var(--text-3)' };
}

function roleBadge(role: Role): string {
  if (!role.isBuiltIn) return '可分配';
  return role.isDefault ? '默认' : '系统内置';
}

/** 角色与权限（对照草图 roles 区块）：左角色列表 + 右权限树 + 级别软约束 + 新建角色 */
export default function RolesPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);

  const rolesQuery = useQuery({ queryKey: queryKeys.roles(), queryFn: getRoles });
  const permsQuery = useQuery({ queryKey: queryKeys.permissions(), queryFn: getPermissions });

  const roles: Role[] = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);
  const permissions: Permission[] = useMemo(() => permsQuery.data ?? [], [permsQuery.data]);
  const role: Role | undefined = roles.find((r) => r.id === selectedId) ?? roles[0];
  const isSuper = role ? role.roleKey === 'super_admin' || role.level >= 100 : false;

  // 选中角色或服务端权限集合变化（保存后 invalidate）时，重置勾选为服务端状态
  useEffect(() => {
    setChecked(role?.permissions ?? []);
  }, [role?.id, role?.permissions]);

  const dirty = useMemo(() => {
    if (!role) return false;
    return [...role.permissions].sort().join('|') !== [...checked].sort().join('|');
  }, [role, checked]);

  const saveMutation = useMutation({
    mutationFn: (payload: { id: string; permissions: string[] }) =>
      updateRolePermissions(payload.id, { permissions: payload.permissions }),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      void message.success(`「${updated.name}」权限已保存并写入审计日志（admin.roles.update）`);
    },
  });

  const createMutation = useMutation({
    mutationFn: (payload: CreateRolePayload) => createRole(payload),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      void message.success(`角色「${created.name}」已创建，可为其分配权限`);
      setSelectedId(created.id);
      setCreateOpen(false);
    },
  });

  const toggle = (perm: Permission, next: boolean) => {
    if (next && perm.superAdminOnly && !isSuper) {
      void message.warning(
        `「${perm.name}」为高危权限，仅超级管理员（level 100）可持有，当前角色 level ${role?.level ?? '—'}`,
      );
      return;
    }
    setChecked((prev) => (next ? [...prev, perm.permKey] : prev.filter((key) => key !== perm.permKey)));
  };

  const grouped = CATEGORY_ORDER.map((category) => {
    const items = permissions.filter((p) => p.category === category);
    const prefixes = [...new Set(items.map((p) => p.permKey.split('.').slice(0, 2).join('.')))];
    return { category, items, prefixes: prefixes.join(' / ') };
  }).filter((group) => group.items.length > 0);

  const loading = rolesQuery.isLoading || permsQuery.isLoading;

  return (
    <>
      <PageHeader
        title="角色与权限"
        description="左侧选择角色，右侧编辑其权限 · 级别约束：低级别不可管理高级别"
      />

      <Spin spinning={loading}>
        <div className={styles.layout}>
          {/* 左卡片：角色列表 */}
          <Card className={styles.roleListCard} styles={{ body: { padding: 0 } }}>
            <div className={styles.cardHead}>
              <h3 className={styles.cardHeadTitle}>角色</h3>
              <div className={styles.headRight}>
                <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                  新建
                </Button>
              </div>
            </div>
            {roles.map((item) => {
              const visual = roleVisual(item);
              const active = role?.id === item.id;
              return (
                <div
                  key={item.id}
                  className={`${styles.roleItem} ${active ? styles.roleItemOn : ''}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className={styles.roleIcon} style={{ color: visual.color }}>
                    {visual.icon}
                  </span>
                  <span className={styles.roleMeta}>
                    <span className={styles.roleName}>
                      {item.name}
                      {!item.isBuiltIn ? <StatusTag tone="amber" dot={false}>自定义</StatusTag> : null}
                    </span>
                    <span className={styles.roleSub}>
                      level {item.level} · {item.memberCount.toLocaleString('zh-CN')} 人 · {roleBadge(item)}
                    </span>
                  </span>
                </div>
              );
            })}
          </Card>

          {/* 右卡片：当前角色权限配置 */}
          <Card style={{ flex: 1, minWidth: 0 }} styles={{ body: { padding: 0 } }}>
            <div className={styles.cardHead}>
              <h3 className={styles.cardHeadTitle}>{role ? `${role.name} · 权限配置` : '权限配置'}</h3>
              <span className={styles.cardHeadSub}>
                共 {permissions.length} 项权限 · 已选 {checked.length} 项
              </span>
              <div className={styles.headRight}>
                <Button
                  size="small"
                  disabled={isSuper || !dirty}
                  onClick={() => role && setChecked(role.permissions)}
                >
                  重置
                </Button>
                <Button
                  size="small"
                  type="primary"
                  disabled={isSuper || !dirty}
                  loading={saveMutation.isPending}
                  onClick={() => role && saveMutation.mutate({ id: role.id, permissions: checked })}
                >
                  保存（记入审计）
                </Button>
              </div>
            </div>

            {role ? (
              isSuper ? (
                <div className={styles.callout}>
                  <InfoCircleOutlined />
                  <span>
                    超级管理员拥有全部权限且不可修改；系统角色由 <b>super_admin</b>{' '}
                    专属维护。数据库触发器保证超管全局唯一。
                  </span>
                </div>
              ) : (
                <div className={styles.hintBar}>
                  级别约束：标注「高危 / 仅超管」的权限仅超级管理员（level 100）可持有；保存后写入审计日志
                  <span className={styles.permKey} style={{ marginLeft: 6 }}>
                    admin.roles.update
                  </span>
                </div>
              )
            ) : null}

            {role ? (
              <div className={`${styles.permTree} ${isSuper ? styles.treeDisabled : ''}`}>
                {grouped.map((group) => (
                  <div key={group.category}>
                    <div className={styles.treeCat}>
                      <span>
                        {CATEGORY_LABELS[group.category]}（{group.category}）
                      </span>
                      <span className={styles.treeCatKey}>{group.prefixes}</span>
                    </div>
                    {group.items.map((perm) => (
                      <div key={perm.permKey} className={styles.treeItem}>
                        <Checkbox
                          checked={checked.includes(perm.permKey)}
                          disabled={isSuper}
                          onChange={(e) => toggle(perm, e.target.checked)}
                        >
                          {perm.name}
                          {perm.description ? (
                            <span className={styles.permDesc}>{perm.description}</span>
                          ) : null}
                        </Checkbox>
                        <span className={styles.permKey}>{perm.permKey}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <Empty style={{ padding: '48px 0' }} description="暂无角色" />
            )}
          </Card>
        </div>
      </Spin>

      <CreateRoleModal
        open={createOpen}
        confirmLoading={createMutation.isPending}
        onCancel={() => setCreateOpen(false)}
        onConfirm={(payload) => createMutation.mutateAsync(payload)}
      />
    </>
  );
}
