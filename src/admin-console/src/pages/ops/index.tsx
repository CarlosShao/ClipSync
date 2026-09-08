import { Button, Card, Empty, Spin, Table, Tag, Tooltip } from 'antd';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useEffect } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { getOpsBackups, getOpsOverview, getSlowQueries } from '@/api/ops';
import { ApiError } from '@/api/client';
import { queryKeys } from '@/queryKeys';
import { hasPerm } from '@/utils/permissions';
import type { OpsProbe } from '@/api/types';
import styles from './ops.module.css';

/** 自动刷新间隔（CO-41：30s 轮询，卸载清理） */
const REFRESH_INTERVAL_MS = 30_000;

/** 状态徽标：ok 绿 / degraded 黄 / error 红 */
const STATUS_META: Record<'ok' | 'degraded' | 'error', { label: string; color: string }> = {
  ok: { label: '运行正常', color: 'green' },
  degraded: { label: '降级运行', color: 'gold' },
  error: { label: '服务异常', color: 'red' },
};

/** uptimeSec → 「N 天 N 时 N 分」（不足一天省略天，不足一小时省略时） */
function formatUptime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const total = Math.max(0, Math.floor(sec));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days} 天 ${hours} 时 ${minutes} 分`;
  if (hours > 0) return `${hours} 时 ${minutes} 分`;
  return `${minutes} 分`;
}

function formatMs(v: number | null | undefined): string {
  return v == null ? '—' : `${v} ms`;
}

/** 字节 → MB 文案（进程内存展示用） */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 字节 → 人性化大小（CO-33 备份文件：B/KB/MB/GB/TB 逐级换算） */
function humanBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** ISO 时间 → 「YYYY-MM-DD HH:mm」（与审计/订单页 dayjs 格式化惯例一致） */
function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = dayjs(iso);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : iso;
}

/** 慢查询语句展示截断（服务端已截 200 字符，表格再截 120） */
function truncateStmt(stmt: string): string {
  return stmt.length > 120 ? `${stmt.slice(0, 120)}…` : stmt;
}

/** 慢查询 403 判定：requirePerm 拒绝走 HTTP 403（AxiosError），错误壳则包成 ApiError */
function isForbiddenError(err: unknown): boolean {
  if (err instanceof ApiError) return err.code === 40301;
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 403;
}

/** 组件探针行：ok 绿点 + 延迟；不可达灰显 */
function ProbeRow({ label, probe }: { label: string; probe: OpsProbe | undefined }) {
  return (
    <div className={styles.kvRow}>
      <span className={styles.kvLabel}>{label}</span>
      <span className={styles.kvValue} style={{ color: probe?.ok ? 'var(--green)' : 'var(--red)' }}>
        {probe == null ? '—' : probe.ok ? `正常 · ${formatMs(probe.latencyMs)}` : '不可达'}
      </span>
    </div>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card size="small" title={label}>
      <div className={styles.metricValue}>{value}</div>
      {sub ? <div className={styles.metricSub}>{sub}</div> : null}
    </Card>
  );
}

/** 慢查询表格列（后端行无独立时间字段，仅响应级 timestamp；以调用次数列补充量级信息） */
const SLOW_QUERY_COLUMNS = [
  {
    title: '耗时(ms)',
    dataIndex: 'meanExecTime',
    key: 'meanExecTime',
    width: 100,
    render: (v: string) => <span className={styles.stmtCell}>{v ?? '—'}</span>,
  },
  {
    title: '语句',
    dataIndex: 'query',
    key: 'query',
    render: (v: string) => <span className={styles.stmtCell}>{truncateStmt(v ?? '')}</span>,
  },
  {
    title: '调用次数',
    dataIndex: 'calls',
    key: 'calls',
    width: 90,
    render: (v: number) => v.toLocaleString('zh-CN'),
  },
];

/**
 * 运维监控页（CO-41）：状态徽标 + DB/Redis 探针 + 请求/错误/p95 指标 +
 * 近 10 分钟趋势（AF-21：消费服务端 30s 采样序列）+ 部署形态/Grafana 跳转（AF-30）+
 * 备份概览（CO-33）+ 慢查询 TOP（CO-41，需 admin.audit.view）。
 * 数据源 GET /api/admin/ops/overview 等，30s 自动刷新。
 */
export default function OpsPage() {
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: queryKeys.opsOverview(),
    queryFn: getOpsOverview,
  });

  // CO-33 备份概览：与页面 30s 刷新节奏一致
  const { data: backupsData } = useQuery({
    queryKey: queryKeys.opsBackups(),
    queryFn: getOpsBackups,
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  // CO-41 慢查询：需要 admin.audit.view（ops 页路由守卫是 admin.ops.view，仅 ops.view 的自定义角色不渲染该卡）
  const canViewSlowQueries = hasPerm('admin.audit.view');
  const { data: slowData, error: slowError } = useQuery({
    queryKey: queryKeys.slowQueries(),
    queryFn: getSlowQueries,
    enabled: canViewSlowQueries,
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  // 30s 自动刷新；卸载时清理定时器
  useEffect(() => {
    const timer = window.setInterval(() => void refetch(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refetch]);

  // AF-21：趋势改为消费服务端 30s 增量序列（进程内环形缓冲，重启清零）
  const samples = data?.series ?? [];

  // AF-30：Grafana 地址由后台配置（system_configs.grafana_url），未配置则置灰
  const grafanaUrl = (data?.grafanaUrl ?? '').trim();

  const statusMeta = data ? STATUS_META[data.status] : null;
  const maxRequests = Math.max(1, ...samples.map((s) => s.requests));
  const maxErrors = Math.max(1, ...samples.map((s) => s.errors));

  return (
    <>
      <PageHeader
        title="运维监控"
        description={`服务健康与请求指标 · 每 ${REFRESH_INTERVAL_MS / 1000}s 自动刷新${isFetching ? ' · 刷新中…' : ''}`}
      />

      <Spin spinning={isLoading}>
        <div className={styles.grid}>
          {/* 状态徽标卡 */}
          <Card size="small" title="服务状态" className={styles.spanAll}>
            <div className={styles.kv}>
              <div className={styles.kvRow}>
                <span className={styles.kvLabel}>状态</span>
                <span className={styles.kvValue}>
                  {statusMeta ? <Tag color={statusMeta.color}>{statusMeta.label}</Tag> : '—'}
                </span>
              </div>
              <div className={styles.kvRow}>
                <span className={styles.kvLabel}>版本</span>
                <span className={styles.kvValue}>{data?.version ?? '—'}</span>
              </div>
              <div className={styles.kvRow}>
                <span className={styles.kvLabel}>运行时长</span>
                <span className={styles.kvValue}>{formatUptime(data?.uptimeSec)}</span>
              </div>
              <div className={styles.kvRow}>
                <span className={styles.kvLabel}>进程内存</span>
                <span className={styles.kvValue}>
                  {data
                    ? `RSS ${formatBytes(data.memory?.rss)} · Heap ${formatBytes(data.memory?.heapUsed)}`
                    : '—'}
                </span>
              </div>
            </div>
          </Card>

          {/* 依赖探针卡 */}
          <Card size="small" title="数据库（PostgreSQL）" className={styles.spanHalf}>
            <div className={styles.kv}>
              <ProbeRow label="连通性" probe={data?.db} />
              <div className={styles.kvRow}>
                <span className={styles.kvLabel}>查询延迟</span>
                <span className={styles.kvValue}>{formatMs(data?.db?.latencyMs)}</span>
              </div>
            </div>
          </Card>
          <Card size="small" title="缓存（Redis）" className={styles.spanHalf}>
            <div className={styles.kv}>
              <ProbeRow label="连通性" probe={data?.redis} />
              <div className={styles.kvRow}>
                <span className={styles.kvLabel}>PING 延迟</span>
                <span className={styles.kvValue}>{formatMs(data?.redis?.latencyMs)}</span>
              </div>
            </div>
          </Card>

          {/* 指标卡：请求 / 错误 / p95 */}
          <div className={styles.spanThird}>
            <MetricCard
              label="请求数"
              value={data?.metrics ? data.metrics.requests.toLocaleString('zh-CN') : '不可用'}
              sub={
                data?.metrics?.wsConnections != null
                  ? `WS 在线连接 ${data.metrics.wsConnections.toLocaleString('zh-CN')}`
                  : undefined
              }
            />
          </div>
          <div className={styles.spanThird}>
            <MetricCard
              label="错误数"
              value={data?.metrics ? data.metrics.errors.toLocaleString('zh-CN') : '不可用'}
              sub={
                data?.metrics && data.metrics.requests > 0
                  ? `错误率 ${((data.metrics.errors / data.metrics.requests) * 100).toFixed(2)}%`
                  : undefined
              }
            />
          </div>
          <div className={styles.spanThird}>
            <MetricCard
              label="p95 响应时间"
              value={data?.metrics?.p95 != null ? `${data.metrics.p95} ms` : '不可用'}
              sub={data?.metrics?.p50 != null ? `p50 ${data.metrics.p50} ms` : undefined}
            />
          </div>

          {/* 近 10 分钟趋势（AF-21：服务端 30s 增量采样，非 Prometheus 全量） */}
          <Card
            size="small"
            title="近 10 分钟趋势"
            className={styles.spanAll}
            extra={<span className={styles.metricSub}>服务端每 30s 采样 · 进程重启后重新累积</span>}
          >
            {samples.length === 0 ? (
              <div className={styles.emptyHint}>进程启动后不足 30 秒，等待首个采样点…</div>
            ) : (
              <>
                <div className={styles.trendWrap}>
                  {samples.map((s) => (
                    <div
                      key={s.t}
                      className={styles.trendGroup}
                      title={`${dayjs(s.t).format('HH:mm:ss')} · 请求 ${s.requests} · 错误 ${s.errors}`}
                    >
                      <div
                        className={styles.trendBar}
                        style={{
                          height: `${(s.requests / maxRequests) * 100}%`,
                          background: 'var(--blue)',
                        }}
                      />
                      <div
                        className={styles.trendBar}
                        style={{
                          height: `${(s.errors / maxErrors) * 100}%`,
                          background: 'var(--red)',
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className={styles.legend}>
                  <span>
                    <span className={styles.legendDot} style={{ background: 'var(--blue)' }} />
                    请求量
                  </span>
                  <span>
                    <span className={styles.legendDot} style={{ background: 'var(--red)' }} />
                    错误数
                  </span>
                  <span>两组各自按峰值归一化 · 最近 {samples.length} 个采样点</span>
                </div>
              </>
            )}
          </Card>

          {/* 部署形态（CO-42：overview.data.deployment）+ Grafana 只读跳转（AF-30：地址后台可配） */}
          <Card
            size="small"
            title="部署形态"
            className={styles.spanHalf}
            extra={
              grafanaUrl ? (
                <a href={grafanaUrl} target="_blank" rel="noreferrer">
                  <Button size="small">打开 Grafana 容器总览</Button>
                </a>
              ) : (
                <Tooltip title="未配置 Grafana 地址：系统设置 → 运维 → Grafana 地址">
                  <Button size="small" disabled>
                    打开 Grafana 容器总览
                  </Button>
                </Tooltip>
              )
            }
          >
            <div className={styles.kv}>
              <div className={styles.kvRow}>
                <span className={styles.kvLabel}>类型</span>
                <span className={styles.kvValue}>
                  {data?.deployment == null ? (
                    '—'
                  ) : data.deployment.type === 'k8s' ? (
                    <Tag color="blue">Kubernetes</Tag>
                  ) : (
                    <Tag>Docker Compose（单机）</Tag>
                  )}
                </span>
              </div>
              {data?.deployment?.type === 'k8s' ? (
                <div className={styles.kvRow}>
                  <span className={styles.kvLabel}>副本数</span>
                  <span className={styles.kvValue}>
                    {data.deployment.replicas ?? '副本数不可用'}
                  </span>
                </div>
              ) : null}
            </div>
          </Card>

          {/* 备份概览（CO-33） */}
          <Card size="small" title="备份概览" className={styles.spanHalf}>
            {backupsData == null ? null : backupsData.items.length === 0 ? (
              // AF-23：无备份任务产出时如实说明，不再使用「暂无备份文件」的歧义文案
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="未启用备份：当前 backups 目录无备份任务产出文件"
              />
            ) : (
              <>
                <div className={styles.kv}>
                  <div className={styles.kvRow}>
                    <span className={styles.kvLabel}>备份份数</span>
                    <span className={styles.kvValue}>
                      {backupsData.summary.total.toLocaleString('zh-CN')}
                    </span>
                  </div>
                  <div className={styles.kvRow}>
                    <span className={styles.kvLabel}>总大小</span>
                    <span className={styles.kvValue}>
                      {humanBytes(backupsData.summary.totalBytes)}
                    </span>
                  </div>
                  <div className={styles.kvRow}>
                    <span className={styles.kvLabel}>最近备份</span>
                    <span className={styles.kvValue}>
                      {formatDateTime(backupsData.summary.lastBackupAt)}
                    </span>
                  </div>
                </div>
                <div className={styles.backupList}>
                  {backupsData.items.slice(0, 10).map((item) => (
                    <div className={styles.backupRow} key={item.file}>
                      <span className={styles.backupName} title={item.file}>
                        {item.file}
                      </span>
                      <span className={styles.backupMeta}>
                        <Tag style={{ marginInlineEnd: 0 }}>{item.kind}</Tag>
                        <span>{humanBytes(item.sizeBytes)}</span>
                        <span>{formatDateTime(item.mtime)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>

          {/* 慢查询 TOP（CO-41）：仅持有 admin.audit.view 的角色渲染；403 兜底占位不红屏 */}
          {canViewSlowQueries ? (
            <Card
              size="small"
              title="慢查询 TOP"
              className={styles.spanAll}
              extra={
                slowData ? (
                  <span className={styles.metricSub}>
                    统计时间 {formatDateTime(slowData.timestamp)} · 阈值 1000ms
                  </span>
                ) : undefined
              }
            >
              {slowError ? (
                <div className={styles.emptyHint}>
                  {isForbiddenError(slowError)
                    ? '需要 admin.audit.view 权限，无法查看慢查询'
                    : '慢查询数据不可用（pg_stat_statements 未启用或查询失败）'}
                </div>
              ) : (
                <Table
                  size="small"
                  rowKey={(_, index) => String(index)}
                  columns={SLOW_QUERY_COLUMNS}
                  dataSource={slowData?.slowQueries ?? []}
                  pagination={false}
                  locale={{ emptyText: '暂无慢查询记录' }}
                />
              )}
            </Card>
          ) : null}
        </div>
      </Spin>
    </>
  );
}
