import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { App as AntdApp, Avatar, Button, Drawer, Skeleton, Table, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { getUserDetail, updateUserStatus } from '@/api/users';
import { ConfirmReasonModal } from '@/components/ConfirmReasonModal';
import { StatusTag } from '@/components/StatusTag';
import { planLabel, planTone } from '@/components/StatusTag/mappers';
import { queryKeys } from '@/queryKeys';
import { hasPerm } from '@/utils/permissions';
import { fmtDate, fmtMoney, fmtTime } from '@/utils/format';
import styles from './UserDrawer.module.css';

interface UserDrawerProps {
  open: boolean;
  userId: string | null;
  onClose: () => void;
}

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  os?: string;
  status: 'online' | 'offline';
  lastActiveAt?: string | null;
}

const DEVICE_COLUMNS: ColumnsType<DeviceRow> = [
  { title: '设备', dataIndex: 'name', render: (v: string) => <strong>{v}</strong> },
  {
    title: '平台',
    dataIndex: 'platform',
    width: 120,
    render: (v: string, record) => `${v}${record.os ? ` ${record.os.replace(/^\D+\s*/, '')}` : ''}`,
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 90,
    render: (v: DeviceRow['status']) => (
      <StatusTag tone={v === 'online' ? 'green' : 'gray'}>{v === 'online' ? '在线' : '离线'}</StatusTag>
    ),
  },
];

/**
 * 用户详情抽屉（对照草图 B）：资料 kv + 设备表 + 最近审计时间线 + 管理操作。
 * 「停用账号」走 ConfirmReasonModal（原因必填）→ PATCH /admin/users/:id/status。
 */
export function UserDrawer({ open, userId, onClose }: UserDrawerProps) {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [deactivateOpen, setDeactivateOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.user(userId ?? ''),
    queryFn: () => getUserDetail(userId as string),
    enabled: open && Boolean(userId),
  });

  const statusMutation = useMutation({
    mutationFn: (payload: { id: string; status: 'active' | 'disabled'; reason?: string }) =>
      updateUserStatus(payload.id, { status: payload.status, reason: payload.reason }),
    onSuccess: (updated, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void message.success(variables.status === 'disabled' ? '账号已停用' : '账号已启用');
      if (updated.status === 'disabled') setDeactivateOpen(false);
    },
  });

  useEffect(() => {
    if (!open) setDeactivateOpen(false);
  }, [open]);

  const user = data?.user;
  const disabled = user?.status === 'disabled';

  // RB-07：管理操作按钮按权限键裁剪（对齐 devices 页 canOffline 模式）
  const canManage = hasPerm('admin.users.manage');
  const canDelete = hasPerm('admin.users.delete');

  const renderBody = () => {
    if (isLoading || !user) {
      return <Skeleton active paragraph={{ rows: 8 }} />;
    }
    return (
      <>
        <dl className={styles.kv}>
          <dt>手机号</dt>
          <dd className={styles.mono}>{user.phone}</dd>
          <dt>邮箱</dt>
          <dd>{user.email ?? '—'}</dd>
          <dt>注册时间</dt>
          <dd className={styles.num}>{fmtDate(user.createdAt)}</dd>
          <dt>最近活跃</dt>
          <dd>{user.lastActiveDesc ?? fmtTime(user.lastActiveAt)}</dd>
          <dt>订阅</dt>
          <dd>
            {user.subscription.status === 'trialing' ? (
              <StatusTag tone="amber">试用 · 剩 {user.subscription.trialDaysLeft ?? 0} 天</StatusTag>
            ) : user.subscription.plan === 'free' ? (
              <StatusTag tone="gray">Free</StatusTag>
            ) : (
              <StatusTag tone="brand">
                {planLabel[user.subscription.plan]} ·{' '}
                {user.subscription.billingCycle === 'yearly' ? '年付' : '月付'} ·{' '}
                {fmtDate(user.subscription.currentPeriodEnd)} 到期
              </StatusTag>
            )}
          </dd>
          <dt>累计消费</dt>
          <dd className={`${styles.num} ${styles.strong}`}>
            {fmtMoney(user.totalSpent)} · {user.orderCount} 笔订单
          </dd>
          <dt>风险标记</dt>
          <dd>
            {user.riskFlag ? <StatusTag tone="red">{user.riskFlag}</StatusTag> : <StatusTag tone="green">无</StatusTag>}
          </dd>
        </dl>

        <div className={styles.sectTitle}>设备（{data?.devices.length ?? 0} 台）</div>
        <Table<DeviceRow>
          rowKey="id"
          size="small"
          columns={DEVICE_COLUMNS}
          dataSource={data?.devices ?? []}
          pagination={false}
        />

        <div className={styles.sectTitle}>最近动态</div>
        {data?.recentAuditLogs.length ? (
          <ul className={styles.timeline}>
            {data.recentAuditLogs.map((log) => (
              <li key={log.id} className={styles.timelineItem}>
                <span className={styles.timelineTime}>{fmtTime(log.createdAt)}</span>
                <span className={styles.timelineAction}>{log.action}</span>
                <span className={styles.timelineDetail}>{log.details}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className={styles.emptyText}>暂无相关审计记录</div>
        )}

        <div className={styles.sectTitle}>管理操作</div>
        <div className={styles.actions}>
          <Button onClick={() => void message.info('调整套餐将在后续版本提供')}>调整套餐</Button>
          <Button onClick={() => void message.info('赠期将在后续版本提供')}>赠期 1 个月</Button>
          <Tooltip title={canManage ? '' : '缺少权限'}>
            <span>
              <Button disabled={!canManage} onClick={() => void message.info('强制下线将在后续版本提供')}>
                强制下线
              </Button>
            </span>
          </Tooltip>
          {disabled ? (
            <Tooltip title={canManage ? '' : '缺少权限'}>
              <span>
                <Button
                  type="primary"
                  disabled={!canManage}
                  loading={statusMutation.isPending}
                  onClick={() =>
                    statusMutation.mutate({ id: user.id, status: 'active' })
                  }
                >
                  启用账号
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Tooltip title={canManage ? '' : '缺少权限'}>
              <span>
                <Button danger disabled={!canManage} onClick={() => setDeactivateOpen(true)}>
                  停用账号
                </Button>
              </span>
            </Tooltip>
          )}
          <Tooltip title={canDelete ? '' : '缺少权限'}>
            <span>
              <Button danger disabled onClick={() => void message.info('删除账户将在后续版本提供')}>
                删除账户
              </Button>
            </span>
          </Tooltip>
          <Button type="link" onClick={() => void navigate('/audit')}>
            查看审计日志
          </Button>
        </div>

        <ConfirmReasonModal
          open={deactivateOpen}
          title="停用账号"
          description={
            <>
              即将停用 <b>{user.nickname}</b>（{user.phone}）。停用后该用户全部设备将退出登录，
              剪贴板同步立即中断；订阅保留至当前周期结束。
            </>
          }
          confirmText="确认停用"
          confirmLoading={statusMutation.isPending}
          onCancel={() => setDeactivateOpen(false)}
          onConfirm={(reason) => statusMutation.mutateAsync({ id: user.id, status: 'disabled', reason })}
        />
      </>
    );
  };

  return (
    <Drawer open={open} onClose={onClose} width={460} closable={false} styles={{ body: { padding: 18 } }}>
      <div className={styles.header}>
        <Avatar size={34} style={{ background: 'linear-gradient(135deg, #6e5ce8, #5a4bd1)' }}>
          {user?.nickname?.slice(0, 1) ?? '·'}
        </Avatar>
        <div className={styles.headerInfo}>
          <div className={styles.headerName}>
            {user?.nickname ?? '加载中…'}
            {user ? (
              <span className={styles.headerTag}>
                {user.subscription.status === 'trialing' ? (
                  <StatusTag tone="amber">试用</StatusTag>
                ) : (
                  <StatusTag tone={planTone[user.subscription.plan]}>{planLabel[user.subscription.plan]}</StatusTag>
                )}
              </span>
            ) : null}
          </div>
          <div className={`${styles.headerId} ${styles.mono}`}>{user?.id ?? ''}</div>
        </div>
        <Button size="small" type="text" onClick={onClose} aria-label="关闭">
          ✕
        </Button>
      </div>
      {renderBody()}
    </Drawer>
  );
}
