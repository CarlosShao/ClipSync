import { App as AntdApp, Button, Card, Input, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { ConfirmReasonModal } from '@/components/ConfirmReasonModal';
import { operatorRoleLabel, operatorRoleTone } from '@/components/StatusTag/mappers';
import { getAdminSessions, revokeAdminSession } from '@/api/security';
import { useTableQuery } from '@/hooks/useTableQuery';
import { queryKeys } from '@/queryKeys';
import { hasPerm } from '@/utils/permissions';
import type { AdminSession } from '@/api/types';

/**
 * AN-12 管理员安全策略 · 管理员会话页
 * 管理角色（admin/super_admin）活跃会话列表 + 单会话强制下线。
 * 权限：查看 admin.users.view / 下线 admin.users.manage（复用既有键）。
 * 自己的会话不允许下线（isCurrent，防自锁）；后端同口径二次校验。
 */
interface SecurityFilters {
  q?: string;
}

const DEFAULT_FILTERS: SecurityFilters = {};

export default function SecurityPage() {
  const { message } = AntdApp.useApp();
  const [draftQ, setDraftQ] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<AdminSession | null>(null);
  const canManage = hasPerm('admin.users.manage');

  const { tableProps, data, filters, setFilters } = useTableQuery<
    AdminSession,
    SecurityFilters
  >({
    buildKey: (params) => queryKeys.adminSessions(params),
    fetcher: (params) => getAdminSessions(params),
    defaultFilters: DEFAULT_FILTERS,
    defaultPageSize: 10,
  });

  const applyFilters = () => {
    setFilters({ q: draftQ.trim() || undefined });
  };

  const revokeMutationLike = async (target: AdminSession, reason: string) => {
    await revokeAdminSession(target.id, { reason });
    void message.success(`已下线 ${target.nickname || target.phone} 的会话`);
    setRevokeTarget(null);
  };

  const columns: ColumnsType<AdminSession> = [
    {
      title: '操作者',
      dataIndex: 'nickname',
      width: 170,
      render: (value: string, record) => (
        <>
          <span style={{ fontWeight: 500 }}>{value || record.phone || '—'}</span>
          {record.roleKey === 'super_admin' || record.roleKey === 'admin' ? (
            <span style={{ marginLeft: 4 }}>
              <StatusTag tone={operatorRoleTone[record.roleKey]} dot={false}>
                {operatorRoleLabel[record.roleKey]}
              </StatusTag>
            </span>
          ) : null}
        </>
      ),
    },
    {
      title: '账号',
      dataIndex: 'phone',
      width: 130,
      render: (value: string) => <span style={{ fontFamily: 'var(--font-mono)' }}>{value || '—'}</span>,
    },
    {
      title: '设备',
      dataIndex: 'deviceName',
      width: 190,
      ellipsis: true,
      render: (value: string, record) => (
        <span>
          {value}
          <span style={{ color: 'var(--text-3)', marginLeft: 6 }}>
            {record.platform} · {record.deviceType}
          </span>
        </span>
      ),
    },
    {
      title: 'IP',
      dataIndex: 'ipAddress',
      width: 130,
      render: (value: string) => <span style={{ fontFamily: 'var(--font-mono)' }}>{value || '—'}</span>,
    },
    {
      title: '登录时间',
      dataIndex: 'createdAt',
      width: 165,
      render: (value: string | null) => <span style={{ fontFamily: 'var(--font-mono)' }}>{value ?? '—'}</span>,
    },
    {
      title: '最近活跃',
      dataIndex: 'lastActiveAt',
      width: 165,
      render: (value: string | null) => <span style={{ fontFamily: 'var(--font-mono)' }}>{value ?? '—'}</span>,
    },
    {
      title: '操作',
      dataIndex: 'id',
      width: 150,
      render: (_: string, record) =>
        record.isCurrent ? (
          <StatusTag tone="gray" dot={false}>
            当前会话
          </StatusTag>
        ) : (
          <Button
            size="small"
            danger
            disabled={!canManage}
            title={canManage ? undefined : '缺少权限'}
            onClick={() => setRevokeTarget(record)}
          >
            强制下线
          </Button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="管理员会话"
        description={
          <>
            管理角色（超管 / 管理员）的活跃登录会话 · 共{' '}
            {(data?.total ?? 0).toLocaleString('zh-CN')} 个 · AN-12 安全策略
            （配套开关：系统设置 → 功能开关 →「强制管理员两步验证」）
          </>
        }
      />

      <Card styles={{ body: { padding: 0 } }}>
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: '14px 16px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <Input
            style={{ width: 220 }}
            placeholder="按昵称 / 用户 ID 过滤"
            allowClear
            value={draftQ}
            onChange={(e) => setDraftQ(e.target.value)}
            onPressEnter={applyFilters}
          />
          <Button type="primary" onClick={applyFilters}>
            查询
          </Button>
          <Button
            onClick={() => {
              setDraftQ('');
              if (filters.q) setFilters({ q: undefined });
            }}
          >
            重置
          </Button>
        </div>

        <Table<AdminSession> size="middle" columns={columns} {...tableProps} />
      </Card>

      <ConfirmReasonModal
        open={Boolean(revokeTarget)}
        title="强制下线会话"
        description={
          revokeTarget ? (
            <>
              即将下线 <b>{revokeTarget.nickname || revokeTarget.phone}</b> 的会话
              {revokeTarget.deviceName ? <>（设备：{revokeTarget.deviceName}）</> : null}。
              该设备将立即退出登录，需重新登录才能继续操作。
            </>
          ) : null
        }
        confirmText="确认下线"
        confirmLoading={false}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={(reason) => {
          if (!revokeTarget) return Promise.resolve();
          return revokeMutationLike(revokeTarget, reason);
        }}
      />
    </>
  );
}
