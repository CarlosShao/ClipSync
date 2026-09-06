import { CreditCardOutlined, DesktopOutlined, RiseOutlined, TeamOutlined } from '@ant-design/icons';
import { Button, Card, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { ReactNode } from 'react';
import { OrderBarChart } from '@/components/charts/OrderBarChart';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { pendingItemTypeLabel, pendingItemTypeTone } from '@/components/StatusTag/mappers';
import { getOverview } from '@/api/overview';
import { queryKeys } from '@/queryKeys';
import type { PendingItem } from '@/api/types';
import styles from './dashboard.module.css';

const PENDING_COLUMNS: ColumnsType<PendingItem> = [
  {
    title: '事项',
    dataIndex: 'title',
    render: (value: string) => <strong>{value}</strong>,
  },
  {
    title: '类型',
    dataIndex: 'type',
    width: 90,
    render: (value: PendingItem['type']) => (
      <StatusTag tone={pendingItemTypeTone[value]}>{pendingItemTypeLabel[value]}</StatusTag>
    ),
  },
  {
    title: '关联对象',
    dataIndex: 'target',
    render: (value: string) => <span className={styles.pendingTarget}>{value}</span>,
  },
  {
    title: '发生时间',
    dataIndex: 'occurredAt',
    width: 150,
    render: (value: string) => <span className={styles.pendingTarget}>{value}</span>,
  },
  {
    title: '操作',
    dataIndex: 'id',
    width: 150,
    render: (_: string, record: PendingItem) =>
      record.actionLabel ? (
        <PendingItemAction record={record} />
      ) : (
        <Button size="small">查看详情</Button>
      ),
  },
];

function PendingItemAction({ record }: { record: PendingItem }) {
  const navigate = useNavigate();
  return (
    <Button
      size="small"
      type={record.type === 'payment' ? 'primary' : 'default'}
      onClick={() => {
        if (record.actionTo) void navigate(record.actionTo);
      }}
    >
      {record.actionLabel}
    </Button>
  );
}

interface KpiCardProps {
  tone: 'brand' | 'green' | 'blue' | 'amber';
  icon: ReactNode;
  label: string;
  value: string;
  delta: ReactNode;
}

function KpiCard({ tone, icon, label, value, delta }: KpiCardProps) {
  return (
    <div className={styles.kpi}>
      <div className={`${styles.kpiIco} ${styles[`ico${tone[0]!.toUpperCase()}${tone.slice(1)}`]}`}>
        {icon}
      </div>
      <div>
        <div className={styles.kpiLabel}>{label}</div>
        <div className={`${styles.kpiValue} num`}>{value}</div>
        <div className={styles.kpiDelta}>{delta}</div>
      </div>
    </div>
  );
}

const CONVERSION_RING_RADIUS = 46;
const CONVERSION_RING_C = 2 * Math.PI * CONVERSION_RING_RADIUS;

/** 数据看板（对照草图 B）：4 KPI 卡 + 近 14 天订单柱图 + 付费转化/渠道占比 + 待处理事项 */
export default function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.overview(),
    queryFn: getOverview,
  });

  if (isLoading || !data) {
    return (
      <>
        <PageHeader title="数据看板" description="统计加载中…" />
        <div style={{ minHeight: '40vh' }} />
      </>
    );
  }
  const { kpis } = data;
  const conversionOffset = CONVERSION_RING_C * (1 - kpis.conversionRate / 100);
  const planCount = (plan: string) => data.planDistribution.find((p) => p.plan === plan)?.count ?? 0;
  const paidShare = (plan: string) =>
    kpis.paidUsers > 0 ? Math.round((planCount(plan) / kpis.paidUsers) * 100) : 0;
  const proShare = paidShare('pro');
  const entShare = paidShare('enterprise');

  return (
    <>
      <PageHeader
        title="数据看板"
        description={`统计截至 ${data.statsAt} · 每日 02:00 生成离线快照`}
      />

      <div className={styles.kpis}>
        <KpiCard
          tone="brand"
          icon={<TeamOutlined />}
          label="注册用户"
          value={kpis.totalUsers.toLocaleString('zh-CN')}
          delta={
            <>
              本周 <b className={styles.up}>+{kpis.weekNewUsers}</b> · 环比 +
              {kpis.weekGrowthRate}%
            </>
          }
        />
        <KpiCard
          tone="green"
          icon={<RiseOutlined />}
          label="本月营收"
          value={`¥${kpis.monthRevenue.toLocaleString('zh-CN')}`}
          delta={
            <>
              环比 <b className={styles.up}>+{kpis.revenueGrowthRate}%</b> · 退款率{' '}
              {kpis.refundRate}%
            </>
          }
        />
        <KpiCard
          tone="blue"
          icon={<CreditCardOutlined />}
          label="MRR（月度经常性收入）"
          value={`¥${kpis.mrr.toLocaleString('zh-CN')}`}
          delta={
            <>
              年付占比 <b>{kpis.mrrYearlySharePercent}%</b>
            </>
          }
        />
        <KpiCard
          tone="amber"
          icon={<DesktopOutlined />}
          label="在线设备（实时）"
          value={kpis.onlineDevices.toLocaleString('zh-CN')}
          delta={
            <>
              昨日同时段 <b className={styles.down}>{kpis.devicesDelta}</b>
            </>
          }
        />
      </div>

      <div className={styles.grid2}>
        <Card
          title="近 14 天订单金额"
          styles={{ body: { padding: '14px 10px 6px' } }}
        >
          <OrderBarChart data={data.orders14d} />
        </Card>

        <div className={styles.col}>
          <Card title="付费转化" styles={{ body: { padding: 0 } }}>
            <div className={styles.ringWrap}>
              <div style={{ position: 'relative', width: 110, height: 110, flexShrink: 0 }}>
                <svg width="110" height="110" viewBox="0 0 110 110" style={{ transform: 'rotate(-90deg)' }}>
                  <circle cx="55" cy="55" r={CONVERSION_RING_RADIUS} fill="none" stroke="#eef0f6" strokeWidth="10" />
                  <circle
                    cx="55"
                    cy="55"
                    r={CONVERSION_RING_RADIUS}
                    fill="none"
                    stroke="#5a4bd1"
                    strokeWidth="10"
                    strokeLinecap="round"
                    strokeDasharray={CONVERSION_RING_C}
                    strokeDashoffset={conversionOffset}
                  />
                </svg>
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <span className={styles.ringCenter}>{kpis.conversionRate}%</span>
                  <span className={styles.ringLabel}>付费转化率</span>
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div className={styles.planRow}>
                  <span className={styles.planLabel}>Pro</span>
                  <div className={styles.planTrack}>
                    <div
                      className={styles.planFill}
                      style={{ width: `${proShare}%`, background: '#5a4bd1' }}
                    />
                  </div>
                  <span className={styles.planValue}>
                    {planCount('pro').toLocaleString('zh-CN')}
                  </span>
                </div>
                <div className={`${styles.planRow} ${styles.planRowLast}`}>
                  <span className={styles.planLabel}>Enterprise</span>
                  <div className={styles.planTrack}>
                    <div
                      className={styles.planFill}
                      style={{ width: `${entShare}%`, background: '#2563eb' }}
                    />
                  </div>
                  <span className={styles.planValue}>
                    {planCount('enterprise').toLocaleString('zh-CN')}
                  </span>
                </div>
                <div className={styles.planNote}>
                  付费用户 {kpis.paidUsers.toLocaleString('zh-CN')} /{' '}
                  {kpis.totalUsers.toLocaleString('zh-CN')} · 试用中 {kpis.trialingUsers}
                </div>
              </div>
            </div>
          </Card>

          <Card title="支付渠道占比" extra={<span style={{ fontSize: 11, color: 'var(--text-3)' }}>近 30 天</span>}>
            <div style={{ padding: '4px 0 2px' }}>
              {data.channels.map((c, index) => (
                <div
                  key={c.channel}
                  className={`${styles.channelRow} ${index === data.channels.length - 1 ? styles.channelRowLast : ''}`}
                >
                  <span className={styles.channelLabel}>{c.label}</span>
                  <div className={styles.channelTrack}>
                    <div
                      className={styles.channelFill}
                      style={{
                        width: `${c.percent}%`,
                        background: c.channel === 'wechat' ? '#16a34a' : c.channel === 'alipay' ? '#2563eb' : '#d97706',
                      }}
                    />
                  </div>
                  <span className={styles.channelValue}>{c.percent}%</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Card title="待处理事项" extra={<span style={{ fontSize: 11, color: 'var(--text-3)' }}>按优先级排序</span>}>
        <Table<PendingItem>
          rowKey="id"
          columns={PENDING_COLUMNS}
          dataSource={data.pendingItems}
          pagination={false}
          size="middle"
        />
      </Card>
    </>
  );
}
