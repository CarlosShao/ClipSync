import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Card, Input, Select, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { deviceKeys, getDevices, getDeviceStats, offlineDevice } from '@/api/devices';
import type { AdminDevice, DeviceKind, DevicePlatform } from '@/api/types';
import { ConfirmReasonModal } from '@/components/ConfirmReasonModal';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { useTableQuery } from '@/hooks/useTableQuery';
import { fmtTime, relativeTime } from '@/utils/format';
import { hasPerm } from '@/utils/permissions';
import { kindLabel, platformIcon, platformLabel, PLATFORM_ORDER } from './platformMeta';
import styles from './devices.module.css';

interface DeviceFilters {
  q: string | undefined;
  platform: DevicePlatform | 'all' | undefined;
  status: 'online' | 'offline' | 'all' | undefined;
}

const DEFAULT_FILTERS: DeviceFilters = {
  q: undefined,
  platform: 'all',
  status: 'all',
};

/** 设备管理页（T-A6）：页头统计（总数/在线/平台徽章）+ 筛选 + 全量表格 + 远程下线（原因必填） */
export default function DevicesPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [offlineTarget, setOfflineTarget] = useState<AdminDevice | null>(null);
  const [draft, setDraft] = useState<DeviceFilters>(DEFAULT_FILTERS);

  const { tableProps, setFilters } = useTableQuery<AdminDevice, DeviceFilters>({
    buildKey: (params) => deviceKeys.list(params),
    fetcher: (params) => getDevices(params),
    defaultFilters: DEFAULT_FILTERS,
    defaultPageSize: 10,
  });

  const statsQuery = useQuery({ queryKey: deviceKeys.stats(), queryFn: getDeviceStats });
  const stats = statsQuery.data;

  const offlineMutation = useMutation({
    mutationFn: (payload: { id: string; reason: string }) => offlineDevice(payload.id, { reason: payload.reason }),
    onSuccess: (updated) => {
      // 失效 ['devices'] 前缀：列表与页头统计（在线数/徽章）同时刷新
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
      void message.success(`设备「${updated.name}」已下线`);
      setOfflineTarget(null);
    },
  });

  const applyFilters = () => {
    setFilters({
      q: draft.q?.trim() || undefined,
      platform: draft.platform,
      status: draft.status,
    });
  };

  const resetFilters = () => {
    setDraft(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
  };

  const canOffline = hasPerm('admin.devices.manage');

  const columns: ColumnsType<AdminDevice> = [
    {
      title: '设备名',
      dataIndex: 'name',
      render: (value: string) => <span className={styles.deviceName}>{value}</span>,
    },
    {
      title: '平台',
      dataIndex: 'platform',
      width: 120,
      render: (value: DevicePlatform) => {
        const Icon = platformIcon[value];
        return (
          <span className={styles.platformCell}>
            <Icon className={styles.chipIcon} />
            {platformLabel[value]}
          </span>
        );
      },
    },
    {
      title: '类型',
      dataIndex: 'kind',
      width: 84,
      render: (value: DeviceKind) => <span className={styles.mutedCell}>{kindLabel[value]}</span>,
    },
    {
      title: '系统版本',
      dataIndex: 'os',
      width: 150,
      render: (value: string) => <span className={styles.mutedCell}>{value}</span>,
    },
    {
      title: '应用版本',
      dataIndex: 'appVersion',
      width: 92,
      render: (value: string) => <span className={styles.monoCell}>{value}</span>,
    },
    {
      title: '属主',
      dataIndex: 'ownerNickname',
      width: 160,
      render: (_: string, record) => (
        <div className={styles.ownerCell}>
          <span className={styles.ownerName}>{record.ownerNickname}</span>
          <span className={styles.ownerPhone}>{record.ownerPhone}</span>
        </div>
      ),
    },
    {
      title: '最近活跃',
      dataIndex: 'lastActiveAt',
      width: 120,
      render: (value: string | null) => (
        <span className={styles.mutedCell} title={fmtTime(value)}>
          {relativeTime(value)}
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: AdminDevice['status']) => (
        <StatusTag tone={value === 'online' ? 'green' : 'gray'}>
          {value === 'online' ? '在线' : '离线'}
        </StatusTag>
      ),
    },
    {
      title: '操作',
      dataIndex: 'id',
      width: 104,
      render: (_: string, record) =>
        record.status === 'online' && canOffline ? (
          <Button size="small" danger onClick={() => setOfflineTarget(record)}>
            远程下线
          </Button>
        ) : (
          <span className={styles.mutedCell}>—</span>
        ),
    },
  ];

  const platformChips = (stats?.byPlatform ?? [])
    .slice()
    .sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform))
    .map((item) => {
      const Icon = platformIcon[item.platform];
      return (
        <span key={item.platform} className={styles.platformChip}>
          <Icon className={styles.chipIcon} />
          {platformLabel[item.platform]}
          <b>{item.count}</b>
        </span>
      );
    });

  return (
    <>
      <PageHeader
        title="设备管理"
        description="全部登录设备的在线状态与版本分布 · 远程下线属高危操作，原因写入审计日志"
      />

      <Card styles={{ body: { padding: 0 } }}>
        <div className={styles.statBar}>
          <span className={styles.statItem}>
            总设备 <b>{stats ? stats.total.toLocaleString('zh-CN') : '—'}</b>
          </span>
          <span className={styles.statItem}>
            在线 <b className={styles.onlineNum}>{stats ? stats.online.toLocaleString('zh-CN') : '—'}</b>
          </span>
          <span className={styles.statDivider} />
          {platformChips}
        </div>

        <div className={styles.filterBar}>
          <Input
            style={{ width: 240 }}
            placeholder="搜索设备名 / 属主昵称 / 手机号"
            allowClear
            value={draft.q ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
            onPressEnter={applyFilters}
          />
          <Select<DevicePlatform | 'all'>
            style={{ width: 150 }}
            value={draft.platform ?? 'all'}
            onChange={(v) => setDraft((d) => ({ ...d, platform: v }))}
            options={[
              { value: 'all', label: '平台：全部' },
              { value: 'windows', label: 'Windows' },
              { value: 'macos', label: 'macOS' },
              { value: 'android', label: 'Android' },
              { value: 'ios', label: 'iOS' },
              { value: 'linux', label: 'Linux' },
            ]}
          />
          <Select<'online' | 'offline' | 'all'>
            style={{ width: 130 }}
            value={draft.status ?? 'all'}
            onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
            options={[
              { value: 'all', label: '状态：全部' },
              { value: 'online', label: '在线' },
              { value: 'offline', label: '离线' },
            ]}
          />
          <Button type="primary" style={{ marginLeft: 'auto' }} onClick={applyFilters}>
            查询
          </Button>
          <Button onClick={resetFilters}>重置</Button>
        </div>

        <Table<AdminDevice> size="middle" columns={columns} {...tableProps} />
      </Card>

      <ConfirmReasonModal
        open={Boolean(offlineTarget)}
        title="远程下线设备"
        description={
          offlineTarget ? (
            <>
              即将下线设备 <b>{offlineTarget.name}</b>（{offlineTarget.os} · 应用{' '}
              {offlineTarget.appVersion}，属主 {offlineTarget.ownerNickname}）。
              下线后该设备立即退出登录，剪贴板同步中断。
            </>
          ) : null
        }
        confirmText="确认下线"
        confirmLoading={offlineMutation.isPending}
        onCancel={() => setOfflineTarget(null)}
        onConfirm={(reason) => offlineMutation.mutateAsync({ id: offlineTarget?.id ?? '', reason })}
      />
    </>
  );
}
