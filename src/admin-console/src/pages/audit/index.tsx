import { App as AntdApp, Button, Card, DatePicker, Input, Select, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { operatorRoleLabel, operatorRoleTone } from '@/components/StatusTag/mappers';
import { fetchAllAuditLogs, getAuditLogs } from '@/api/audit';
import { useTableQuery } from '@/hooks/useTableQuery';
import { queryKeys } from '@/queryKeys';
import { buildAuditCsv, buildAuditCsvFilename, downloadTextFile } from './auditCsv';
import { isSensitiveAction } from './sensitive';
import { AuditDetailModal } from './AuditDetailModal';
import type { AuditActionFilter, AuditActorLevel, AuditLog, AuditOperatorFilter, AuditResult } from '@/api/types';
import styles from './audit.module.css';

/** CSS Modules + noUncheckedIndexedAccess：索引类名可能 undefined，兜底空串 */
const sensitiveRowClass = styles.sensitiveRow ?? '';

interface AuditFilters {
  action: AuditActionFilter;
  operator: AuditOperatorFilter;
  /** AN-11：操作者级别（super_admin / admin / user），all=不过滤 */
  actorLevel: AuditActorLevel | 'all';
  result: AuditResult | 'all';
  ip?: string;
  /** AF-34：按用户过滤（用户抽屉「查看审计日志」跳转带入） */
  userId?: string;
  dateFrom?: string;
  dateTo?: string;
}

/** 默认筛选：全部 + 近 7 天（对照草图日期范围） */
const DEFAULT_FILTERS: AuditFilters = {
  action: 'all',
  operator: 'all',
  actorLevel: 'all',
  result: 'all',
  dateFrom: dayjs().subtract(7, 'day').format('YYYY-MM-DD'),
  dateTo: dayjs().format('YYYY-MM-DD'),
};

const ACTION_OPTIONS: { value: AuditActionFilter; label: string }[] = [
  { value: 'all', label: '动作：全部' },
  { value: 'auth', label: '登录/登出' },
  { value: 'sensitive', label: '敏感操作' },
  { value: 'payment', label: '支付相关' },
];

const OPERATOR_OPTIONS: { value: AuditOperatorFilter; label: string }[] = [
  { value: 'all', label: '操作者：全部' },
  { value: 'Carlos', label: 'Carlos（超管）' },
  { value: 'Yuki', label: 'Yuki（管理员）' },
  { value: 'end_user', label: '终端用户' },
];

// AN-11：操作者级别筛选（超管操作审计：superAdminAudit 写入的 super_admin_action 行可按此过滤）
const ACTOR_LEVEL_OPTIONS: { value: AuditActorLevel | 'all'; label: string }[] = [
  { value: 'all', label: '级别：全部' },
  { value: 'super_admin', label: '超管（super_admin）' },
  { value: 'admin', label: '管理员（admin）' },
  { value: 'user', label: '终端用户（user）' },
];

const RESULT_OPTIONS: { value: AuditResult | 'all'; label: string }[] = [
  { value: 'all', label: '结果：全部' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
];

/** 审计日志（对照草图 audit 区块）：筛选区 + 敏感行高亮表格 + CSV 导出 + 详情弹窗 */
export default function AuditPage() {
  const { message } = AntdApp.useApp();
  // AF-34：支持 /audit?userId=xxx（用户抽屉「查看审计日志」跳转）
  const [searchParams] = useSearchParams();
  const initialFilters = useMemo<AuditFilters>(
    () => ({
      ...DEFAULT_FILTERS,
      userId: searchParams.get('userId')?.trim() || undefined,
    }),
    [searchParams]
  );
  const [draft, setDraft] = useState<AuditFilters>(initialFilters);
  const [detailLog, setDetailLog] = useState<AuditLog | null>(null);
  const [exporting, setExporting] = useState(false);

  const { tableProps, filters, setFilters } = useTableQuery<AuditLog, AuditFilters>({
    buildKey: (params) => queryKeys.auditLogs(params),
    fetcher: (params) => getAuditLogs(params),
    defaultFilters: initialFilters,
    defaultPageSize: 10,
  });

  // URL 筛选变化（查询/重置/前进后退）时同步回草稿区；翻页不覆盖未应用的草稿
  const appliedJson = JSON.stringify(filters);
  const lastAppliedRef = useRef(appliedJson);
  useEffect(() => {
    if (appliedJson !== lastAppliedRef.current) {
      lastAppliedRef.current = appliedJson;
      setDraft(filters);
    }
  }, [appliedJson, filters]);

  const applyDraft = () => {
    setFilters({ ...draft, ip: draft.ip?.trim() || undefined });
  };

  const resetFilters = () => {
    const next: AuditFilters = { ...DEFAULT_FILTERS, ip: undefined, userId: undefined };
    setDraft(next);
    setFilters(next);
  };

  /** AF-34：清除用户过滤（tag ×） */
  const clearUserFilter = () => {
    const next: AuditFilters = { ...filters, userId: undefined };
    setDraft(next);
    setFilters(next);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const logs = await fetchAllAuditLogs({ ...filters, page: 1, pageSize: 200 });
      downloadTextFile(buildAuditCsvFilename(), buildAuditCsv(logs));
      void message.success(`已导出 ${logs.length.toLocaleString('zh-CN')} 条审计日志`);
    } catch {
      // 请求失败：错误提示由 client 拦截器统一 toast
    } finally {
      setExporting(false);
    }
  };

  const columns: ColumnsType<AuditLog> = [
    {
      title: '',
      dataIndex: 'id',
      width: 30,
      align: 'center',
      render: (_: string, record) =>
        isSensitiveAction(record.action) ? <span className={styles.riskDot}>●</span> : null,
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 122,
      render: (value: string) => (
        <span className={styles.monoCell}>{dayjs(value).format('MM-DD HH:mm:ss')}</span>
      ),
    },
    {
      title: '操作者',
      dataIndex: 'operator',
      width: 172,
      render: (_: string, record) => (
        <>
          <span className={isSensitiveAction(record.action) ? styles.strongCell : undefined}>
            {record.operator}
          </span>
          {record.operatorRole === 'super_admin' || record.operatorRole === 'admin' ? (
            <span style={{ marginLeft: 4 }}>
              <StatusTag tone={operatorRoleTone[record.operatorRole]} dot={false}>
                {operatorRoleLabel[record.operatorRole]}
              </StatusTag>
            </span>
          ) : null}
        </>
      ),
    },
    {
      title: '动作',
      dataIndex: 'action',
      width: 188,
      render: (value: string) => (
        <span
          className={`${styles.actionCell} ${isSensitiveAction(value) ? styles.actionSensitive : styles.strongCell}`}
        >
          {value}
        </span>
      ),
    },
    {
      title: '资源',
      dataIndex: 'resourceId',
      width: 168,
      ellipsis: true,
      render: (value: string) => <span className={styles.monoCell}>{value}</span>,
    },
    {
      title: '详情摘要',
      dataIndex: 'details',
      ellipsis: true,
      render: (value: string) => <span className={styles.mutedCell}>{value}</span>,
    },
    {
      title: 'IP',
      dataIndex: 'ipAddress',
      width: 108,
      render: (value: string) => <span className={styles.monoCell}>{value}</span>,
    },
    {
      title: '结果',
      dataIndex: 'status',
      width: 78,
      render: (value: AuditResult) =>
        value === 'success' ? (
          <StatusTag tone="green">成功</StatusTag>
        ) : (
          <StatusTag tone="red">失败</StatusTag>
        ),
    },
    {
      title: '操作',
      dataIndex: 'id',
      width: 68,
      render: (_: string, record) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Button size="small" onClick={() => setDetailLog(record)}>
            详情
          </Button>
        </span>
      ),
    },
  ];

  const auditTotal = (tableProps.pagination as { total?: number } | undefined)?.total ?? 0;

  return (
    <>
      <PageHeader
        title="审计日志"
        description={
          <>
            保留 1 年 · 共 {auditTotal.toLocaleString('zh-CN')} 条（当前筛选范围）·{' '}
            <b style={{ color: 'var(--red)' }}>红点为敏感操作</b>
          </>
        }
      />

      <Card styles={{ body: { padding: 0 } }}>
        <div className={styles.filterBar}>
          <Select<AuditActionFilter>
            style={{ width: 128 }}
            value={draft.action}
            onChange={(value) => setDraft((prev) => ({ ...prev, action: value }))}
            options={ACTION_OPTIONS}
          />
          <Select<AuditOperatorFilter>
            style={{ width: 140 }}
            value={draft.operator}
            onChange={(value) => setDraft((prev) => ({ ...prev, operator: value }))}
            options={OPERATOR_OPTIONS}
          />
          <Select<AuditActorLevel | 'all'>
            style={{ width: 168 }}
            value={draft.actorLevel}
            onChange={(value) => setDraft((prev) => ({ ...prev, actorLevel: value }))}
            options={ACTOR_LEVEL_OPTIONS}
          />
          <Select<AuditResult | 'all'>
            style={{ width: 122 }}
            value={draft.result}
            onChange={(value) => setDraft((prev) => ({ ...prev, result: value }))}
            options={RESULT_OPTIONS}
          />
          <Input
            style={{ width: 176 }}
            placeholder="IP 地址，如 116.24.*.*"
            allowClear
            value={draft.ip ?? ''}
            onChange={(e) => setDraft((prev) => ({ ...prev, ip: e.target.value }))}
            onPressEnter={applyDraft}
          />
          <DatePicker.RangePicker
            value={[
              draft.dateFrom ? dayjs(draft.dateFrom) : null,
              draft.dateTo ? dayjs(draft.dateTo) : null,
            ]}
            onChange={(dates: [Dayjs | null, Dayjs | null] | null) =>
              setDraft((prev) => ({
                ...prev,
                dateFrom: dates?.[0]?.format('YYYY-MM-DD'),
                dateTo: dates?.[1]?.format('YYYY-MM-DD'),
              }))
            }
            allowClear={false}
          />
          <Button type="primary" onClick={applyDraft}>
            查询
          </Button>
          <Button onClick={resetFilters}>重置</Button>
          {filters.userId ? (
            <Tag closable onClose={clearUserFilter} color="purple" style={{ marginInlineEnd: 0 }}>
              仅看该用户相关日志
            </Tag>
          ) : null}
          <Button
            style={{ marginLeft: 'auto' }}
            loading={exporting}
            onClick={() => void handleExport()}
          >
            导出 CSV
          </Button>
        </div>

        <Table<AuditLog>
          size="middle"
          columns={columns}
          {...tableProps}
          rowKey="id"
          rowClassName={(record) => (isSensitiveAction(record.action) ? sensitiveRowClass : '')}
          onRow={(record) => ({
            onClick: (e) => {
              const target = e.target as HTMLElement;
              if (target.closest('button') || target.closest('input')) return;
              setDetailLog(record);
            },
            style: { cursor: 'pointer' },
          })}
        />
      </Card>

      <AuditDetailModal
        open={Boolean(detailLog)}
        log={detailLog}
        onClose={() => setDetailLog(null)}
      />
    </>
  );
}
