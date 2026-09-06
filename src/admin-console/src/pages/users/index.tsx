import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Card, Input, Select, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { UserDrawer } from '@/components/UserDrawer';
import { ConfirmReasonModal } from '@/components/ConfirmReasonModal';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { planLabel, planTone, userStatusLabel, userStatusTone } from '@/components/StatusTag/mappers';
import { getUsers, updateUserStatus } from '@/api/users';
import { useTableQuery } from '@/hooks/useTableQuery';
import { queryKeys } from '@/queryKeys';
import { fmtDate, fmtMoney } from '@/utils/format';
import type { AdminUser, PlanKey, UserStatus } from '@/api/types';
import styles from './users.module.css';

interface UserFilters {
  q: string | undefined;
  plan: PlanKey | 'all' | undefined;
  status: UserStatus | 'all' | undefined;
  registeredIn: '7d' | '30d' | 'all' | undefined;
}

const DEFAULT_FILTERS: UserFilters = {
  q: undefined,
  plan: 'all',
  status: 'all',
  registeredIn: 'all',
};

/** 用户管理页（对照草图 B）：筛选栏 + 表格 + 行点击抽屉 + 停用确认弹窗（原因必填） */
export default function UsersPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [drawerUserId, setDrawerUserId] = useState<string | null>(null);
  const [deactivateUser, setDeactivateUser] = useState<AdminUser | null>(null);
  const [draft, setDraft] = useState<UserFilters>(DEFAULT_FILTERS);

  const { tableProps, setFilters } = useTableQuery<AdminUser, UserFilters>({
    buildKey: (params) => queryKeys.users(params),
    fetcher: (params) => getUsers(params),
    defaultFilters: DEFAULT_FILTERS,
    defaultPageSize: 8,
  });

  const enableMutation = useMutation({
    mutationFn: (id: string) => updateUserStatus(id, { status: 'active' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void message.success('账号已启用');
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (payload: { id: string; reason: string }) =>
      updateUserStatus(payload.id, { status: 'disabled', reason: payload.reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void message.success('账号已停用');
      setDeactivateUser(null);
    },
  });

  const applyFilters = () => {
    setFilters({
      q: draft.q?.trim() || undefined,
      plan: draft.plan,
      status: draft.status,
      registeredIn: draft.registeredIn,
    });
  };

  const resetFilters = () => {
    setDraft(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
  };

  const columns: ColumnsType<AdminUser> = [
    {
      title: '用户',
      dataIndex: 'nickname',
      render: (value: string) => <span className={styles.nickname}>{value}</span>,
    },
    {
      title: '手机号',
      dataIndex: 'phone',
      width: 130,
      render: (value: string) => <span className={styles.monoCell}>{value}</span>,
    },
    {
      title: '套餐',
      dataIndex: 'subscription',
      width: 140,
      render: (_: unknown, record) => {
        const { plan, status, billingCycle, trialDaysLeft } = record.subscription;
        if (status === 'trialing') {
          return <StatusTag tone="amber">试用 · 剩 {trialDaysLeft ?? 0} 天</StatusTag>;
        }
        const suffix = plan === 'free' ? '' : ` · ${billingCycle === 'yearly' ? '年付' : '月付'}`;
        return (
          <StatusTag tone={planTone[plan]}>
            {planLabel[plan]}
            {suffix}
          </StatusTag>
        );
      },
    },
    {
      title: '设备',
      dataIndex: 'deviceCount',
      width: 70,
      align: 'right',
      render: (value: number) => <span className="num">{value}</span>,
    },
    {
      title: '累计消费',
      dataIndex: 'totalSpent',
      width: 110,
      align: 'right',
      render: (value: number) => (
        <span className={value > 0 ? styles.money : styles.moneyPlain}>{fmtMoney(value)}</span>
      ),
    },
    {
      title: '注册时间',
      dataIndex: 'createdAt',
      width: 120,
      render: (value: string) => <span className={styles.monoCell}>{fmtDate(value)}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: UserStatus) => (
        <StatusTag tone={userStatusTone[value]}>{userStatusLabel[value]}</StatusTag>
      ),
    },
    {
      title: '操作',
      dataIndex: 'id',
      width: 210,
      render: (_: string, record) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Button size="small" onClick={() => setDrawerUserId(record.id)}>
            详情
          </Button>
          {record.status === 'active' ? (
            <>
              {record.subscription.status === 'trialing' ? (
                <Button
                  size="small"
                  style={{ marginLeft: 6 }}
                  onClick={() => void message.info('转正套餐将在后续版本提供')}
                >
                  转正套餐
                </Button>
              ) : (
                <Button
                  size="small"
                  style={{ marginLeft: 6 }}
                  onClick={() => void message.info('改套餐将在后续版本提供')}
                >
                  改套餐
                </Button>
              )}
              <Button
                size="small"
                danger
                style={{ marginLeft: 6 }}
                onClick={() => setDeactivateUser(record)}
              >
                停用
              </Button>
            </>
          ) : (
            <>
              <Button
                size="small"
                style={{ marginLeft: 6 }}
                loading={enableMutation.isPending && enableMutation.variables === record.id}
                onClick={() => enableMutation.mutate(record.id)}
              >
                启用
              </Button>
              <Button
                size="small"
                danger
                style={{ marginLeft: 6 }}
                onClick={() => void message.info('删除账户将在后续版本提供')}
              >
                删除
              </Button>
            </>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="用户管理"
        description={`共 ${((tableProps.pagination as { total?: number } | undefined)?.total ?? 0).toLocaleString('zh-CN')} 名注册用户 · 手机号默认打码，明文查看将记入审计`}
      />

      <Card styles={{ body: { padding: 0 } }}>
        <div className={styles.filterBar}>
          <Input
            style={{ width: 250 }}
            placeholder="搜索手机号 / 昵称 / 用户 ID"
            allowClear
            value={draft.q ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
            onPressEnter={applyFilters}
          />
          <Select<PlanKey | 'all'>
            style={{ width: 140 }}
            value={draft.plan ?? 'all'}
            onChange={(v) => setDraft((d) => ({ ...d, plan: v }))}
            options={[
              { value: 'all', label: '套餐：全部' },
              { value: 'free', label: 'Free' },
              { value: 'pro', label: 'Pro' },
              { value: 'enterprise', label: 'Enterprise' },
            ]}
          />
          <Select<UserStatus | 'all'>
            style={{ width: 130 }}
            value={draft.status ?? 'all'}
            onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
            options={[
              { value: 'all', label: '状态：全部' },
              { value: 'active', label: '正常' },
              { value: 'disabled', label: '已停用' },
            ]}
          />
          <Select<'7d' | '30d' | 'all'>
            style={{ width: 150 }}
            value={draft.registeredIn ?? 'all'}
            onChange={(v) => setDraft((d) => ({ ...d, registeredIn: v }))}
            options={[
              { value: 'all', label: '注册时间：全部' },
              { value: '7d', label: '近 7 天' },
              { value: '30d', label: '近 30 天' },
            ]}
          />
          <Button type="primary" style={{ marginLeft: 'auto' }} onClick={applyFilters}>
            查询
          </Button>
          <Button onClick={resetFilters}>重置</Button>
        </div>

        <Table<AdminUser>
          size="middle"
          columns={columns}
          onRow={(record) => ({
            onClick: (e) => {
              const target = e.target as HTMLElement;
              if (target.closest('button') || target.closest('input')) return;
              setDrawerUserId(record.id);
            },
            style: { cursor: 'pointer' },
          })}
          {...tableProps}
        />
      </Card>

      <UserDrawer
        open={Boolean(drawerUserId)}
        userId={drawerUserId}
        onClose={() => setDrawerUserId(null)}
      />

      <ConfirmReasonModal
        open={Boolean(deactivateUser)}
        title="停用账号"
        description={
          deactivateUser ? (
            <>
              即将停用 <b>{deactivateUser.nickname}</b>（{deactivateUser.phone}）。
              停用后该用户全部设备将退出登录，剪贴板同步立即中断。
            </>
          ) : null
        }
        confirmText="确认停用"
        confirmLoading={deactivateMutation.isPending}
        onCancel={() => setDeactivateUser(null)}
        onConfirm={(reason) =>
          deactivateMutation.mutateAsync({ id: deactivateUser?.id ?? '', reason })
        }
      />
    </>
  );
}
