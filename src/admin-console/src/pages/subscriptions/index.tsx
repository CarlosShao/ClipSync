import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Card, Input, Select, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { subscriptionKeys, getSubscriptions, getSubscriptionStats, grantSubscription } from '@/api/subscriptions';
import type { AdminSubscription, PlanKey, SubscriptionStatus } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag, type StatusTone } from '@/components/StatusTag';
import { planLabel, planTone } from '@/components/StatusTag/mappers';
import { useTableQuery } from '@/hooks/useTableQuery';
import { fmtDate } from '@/utils/format';
import { hasPerm } from '@/utils/permissions';
import { GrantSubscriptionModal, type GrantPlanId } from './GrantSubscriptionModal';
import styles from './subscriptions.module.css';

interface SubscriptionFilters {
  q: string | undefined;
  plan: PlanKey | 'all' | undefined;
  status: SubscriptionStatus | 'all' | undefined;
}

const DEFAULT_FILTERS: SubscriptionFilters = {
  q: undefined,
  plan: 'all',
  status: 'all',
};

/** 订阅页状态色（工单约定：active 绿 / trialing 琥珀 / past_due 红 / canceled·expired 灰） */
const statusTone: Record<SubscriptionStatus, StatusTone> = {
  active: 'green',
  trialing: 'amber',
  past_due: 'red',
  canceled: 'gray',
  expired: 'gray',
};

const statusLabel: Record<SubscriptionStatus, string> = {
  active: '生效中',
  trialing: '试用中',
  past_due: '逾期未付',
  canceled: '已取消',
  expired: '已过期',
};

const STATUS_OPTIONS: { value: SubscriptionStatus | 'all'; label: string }[] = [
  { value: 'all', label: '状态：全部' },
  { value: 'active', label: '生效中' },
  { value: 'trialing', label: '试用中' },
  { value: 'past_due', label: '逾期未付' },
  { value: 'canceled', label: '已取消' },
  { value: 'expired', label: '已过期' },
];

const PLAN_OPTIONS: { value: PlanKey | 'all'; label: string }[] = [
  { value: 'all', label: '套餐：全部' },
  { value: 'free', label: 'Free' },
  { value: 'pro', label: 'Pro' },
  { value: 'enterprise', label: 'Enterprise' },
];

/** 订阅管理页（T-A6）：页头统计 + 筛选 + 订阅表格 + 赠期/调整弹窗（原因必填） */
export default function SubscriptionsPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [grantTarget, setGrantTarget] = useState<AdminSubscription | null>(null);
  const [draft, setDraft] = useState<SubscriptionFilters>(DEFAULT_FILTERS);

  const { tableProps, setFilters } = useTableQuery<AdminSubscription, SubscriptionFilters>({
    buildKey: (params) => subscriptionKeys.list(params),
    fetcher: (params) => getSubscriptions(params),
    defaultFilters: DEFAULT_FILTERS,
    defaultPageSize: 10,
  });

  const statsQuery = useQuery({ queryKey: subscriptionKeys.stats(), queryFn: getSubscriptionStats });
  const stats = statsQuery.data;

  const grantMutation = useMutation({
    mutationFn: (payload: { id: string; planId: GrantPlanId; months: number; reason: string }) =>
      grantSubscription(payload.id, {
        planId: payload.planId,
        months: payload.months,
        reason: payload.reason,
      }),
    onSuccess: (updated, variables) => {
      // 失效 ['subscriptions'] 前缀：列表与页头统计同时刷新
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      void message.success(
        `已为 ${updated.userLabel} 调整为 ${planLabel[updated.planKey?.toLowerCase() as PlanKey] ?? updated.planName} 并赠期 ${variables.months} 个月`,
      );
      setGrantTarget(null);
    },
  });

  const applyFilters = () => {
    setFilters({
      q: draft.q?.trim() || undefined,
      plan: draft.plan,
      status: draft.status,
    });
  };

  const resetFilters = () => {
    setDraft(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
  };

  const canGrant = hasPerm('admin.subscriptions.grant');

  const columns: ColumnsType<AdminSubscription> = [
    {
      title: '用户',
      dataIndex: 'nickname',
      render: (_: string, record) => (
        <span className={styles.ownerName}>{record.userLabel}</span>
      ),
    },
    {
      title: '当前套餐',
      dataIndex: 'planKey',
      width: 110,
      render: (value: string, record) => {
        const key = (value || '').toLowerCase() as PlanKey;
        const label = planLabel[key] ?? record.planName ?? '—';
        return <StatusTag tone={planTone[key] ?? 'gray'}>{label}</StatusTag>;
      },
    },
    {
      title: '计费周期',
      dataIndex: 'billingCycle',
      width: 90,
      render: (value: AdminSubscription['billingCycle']) => (
        <span className={styles.mutedCell}>
          {value === 'yearly' ? '年付' : value === 'monthly' ? '月付' : '—'}
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 130,
      render: (value: SubscriptionStatus) => (
        <StatusTag tone={statusTone[value]}>
          {value === 'trialing' ? statusLabel.trialing : statusLabel[value] ?? value}
        </StatusTag>
      ),
    },
    {
      title: '当前周期止',
      dataIndex: 'currentPeriodEnd',
      width: 170,
      render: (value: string | null, record) =>
        value ? (
          <span className={styles.periodCell}>
            {fmtDate(value)}
            <StatusTag tone={record.autoRenew ? 'brand' : 'gray'} dot={false}>
              {record.autoRenew ? '自动续费' : '不续费'}
            </StatusTag>
          </span>
        ) : (
          <span className={styles.mutedCell}>—</span>
        ),
    },
    {
      title: '开始时间',
      dataIndex: 'createdAt',
      width: 115,
      render: (value: string) => <span className={styles.monoCell}>{fmtDate(value)}</span>,
    },
    {
      title: '操作',
      dataIndex: 'id',
      width: 104,
      render: (_: string, record) =>
        canGrant ? (
          <Button size="small" onClick={() => setGrantTarget(record)}>
            赠期/调整
          </Button>
        ) : (
          <span className={styles.mutedCell}>—</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="订阅管理"
        description="付费与试用订阅的全生命周期视图 · 赠期/调整写入审计日志"
      />

      <Card styles={{ body: { padding: 0 } }}>
        <div className={styles.statBar}>
          <span className={styles.statItem}>
            活跃订阅 <b className={styles.greenNum}>{stats ? stats.active.toLocaleString('zh-CN') : '—'}</b>
          </span>
          <span className={styles.statItem}>
            本月到期 <b className={styles.amberNum}>{stats ? stats.expiringThisMonth.toLocaleString('zh-CN') : '—'}</b>
          </span>
          <span className={styles.statItem}>
            试用中 <b className={styles.brandNum}>{stats ? stats.trialing.toLocaleString('zh-CN') : '—'}</b>
          </span>
        </div>

        <div className={styles.filterBar}>
          <Input
            style={{ width: 240 }}
            placeholder="搜索用户昵称 / 手机号 / 用户 ID"
            allowClear
            value={draft.q ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
            onPressEnter={applyFilters}
          />
          <Select<PlanKey | 'all'>
            style={{ width: 140 }}
            value={draft.plan ?? 'all'}
            onChange={(v) => setDraft((d) => ({ ...d, plan: v }))}
            options={PLAN_OPTIONS}
          />
          <Select<SubscriptionStatus | 'all'>
            style={{ width: 140 }}
            value={draft.status ?? 'all'}
            onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
            options={STATUS_OPTIONS}
          />
          <Button type="primary" style={{ marginLeft: 'auto' }} onClick={applyFilters}>
            查询
          </Button>
          <Button onClick={resetFilters}>重置</Button>
        </div>

        <Table<AdminSubscription> size="middle" columns={columns} {...tableProps} />
      </Card>

      <GrantSubscriptionModal
        open={Boolean(grantTarget)}
        subscription={grantTarget}
        confirmLoading={grantMutation.isPending}
        onCancel={() => setGrantTarget(null)}
        onConfirm={(planId, months, reason) =>
          grantMutation.mutateAsync({ id: grantTarget?.id ?? '', planId, months, reason })
        }
      />
    </>
  );
}
