import { App as AntdApp, Button, Card, Input, Select, Table, Tabs, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { OrderDetailModal } from '@/components/OrderDetailModal';
import { PageHeader } from '@/components/PageHeader';
import { RefundModal } from '@/components/RefundModal';
import { ReconciliationModal } from '@/components/ReconciliationModal';
import { StatusTag } from '@/components/StatusTag';
import { channelLabel, orderDisplayStatus } from '@/components/StatusTag/mappers';
import { fetchAllOrders, getOrders, refundOrder } from '@/api/orders';
import { buildOrdersCsv, buildOrdersCsvFilename, downloadTextFile } from './ordersCsv';
import { useTableQuery } from '@/hooks/useTableQuery';
import { queryKeys } from '@/queryKeys';
import { hasPerm } from '@/utils/permissions';
import { fmtMoney } from '@/utils/format';
import type {
  Order,
  OrderListParams,
  OrderListQuery,
  OrderStatusFilter,
  PaymentChannel,
  RefundPayload,
} from '@/api/types';
import styles from './orders.module.css';

interface OrderFilters {
  q: string | undefined;
  status: OrderStatusFilter | undefined;
  channel: PaymentChannel | 'all' | undefined;
  range: '7d' | '30d' | undefined;
}

const DEFAULT_FILTERS: OrderFilters = {
  q: undefined,
  status: 'all',
  channel: 'all',
  range: '7d',
};

const STATUS_TABS: { key: OrderStatusFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待支付' },
  { key: 'paid', label: '已支付' },
  { key: 'refunding', label: '退款处理中' },
  { key: 'refunded', label: '已退款' },
  { key: 'failed', label: '已失败' },
];

const CHANNEL_OPTIONS: { value: PaymentChannel | 'all'; label: string }[] = [
  { value: 'all', label: '渠道：全部' },
  { value: 'wechat', label: '微信支付' },
  { value: 'alipay', label: '支付宝' },
  { value: 'stripe', label: 'Stripe' },
];

const RANGE_OPTIONS: { value: '7d' | '30d'; label: string }[] = [
  { value: '7d', label: '时间：近 7 天' },
  { value: '30d', label: '时间：近 30 天' },
];

function rangeToDateFrom(range: OrderFilters['range']): string | undefined {
  if (range === '7d') return dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  if (range === '30d') return dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  return undefined;
}

/** 组装接口查询参数：range 是页面本地筛选，需换算为 dateFrom */
function toOrderQuery(params: { page: number; pageSize: number } & OrderFilters): OrderListQuery {
  const { range, ...rest } = params;
  return { ...rest, dateFrom: rangeToDateFrom(range) };
}

/**
 * queryKeys 工厂（T-A0 建）的入参类型尚未含 refunding 伪状态，此处收窄仅为通过类型检查；
 * 工厂只做 ['orders', params] 拼接，运行时无影响。
 */
function ordersKey(query: OrderListQuery): readonly unknown[] {
  return queryKeys.orders(query as OrderListParams);
}

/** 订单与支付（对照草图 B）：状态 Tabs + 筛选 + 表格 + 详情/退款弹窗 + 对账报告 */
export default function OrdersPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [draftQ, setDraftQ] = useState<string>('');
  const [detailNo, setDetailNo] = useState<string | null>(null);
  const [refundTarget, setRefundTarget] = useState<Order | null>(null);
  const [reconcileOpen, setReconcileOpen] = useState(false);

  const { tableProps, filters, setFilters } = useTableQuery<Order, OrderFilters>({
    buildKey: (params) => ordersKey(toOrderQuery(params)),
    fetcher: (params) => getOrders(toOrderQuery(params)),
    defaultFilters: DEFAULT_FILTERS,
    defaultPageSize: 10,
  });

  // 各状态 Tab 计数：同一列表接口 pageSize=1 取 total（与列表同筛选条件）
  const countQueries = useQueries({
    queries: STATUS_TABS.map((tab) => {
      const query = toOrderQuery({ ...filters, page: 1, pageSize: 1, status: tab.key });
      return {
        queryKey: [...ordersKey(query), 'count'],
        queryFn: () => getOrders(query),
      };
    }),
  });

  const refundMutation = useMutation({
    mutationFn: (payload: { orderNo: string; payload: RefundPayload }) =>
      refundOrder(payload.orderNo, payload.payload),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      // AF-40：口径对齐——系统不做渠道退款，仅人工标记
      void message.success(`已标记退款：${fmtMoney(order.refundAmount)}（线下退款完成后标记）`);
      setRefundTarget(null);
    },
  });

  // RB-07：退款为高危操作（admin.orders.refund superAdminOnly），按钮按权限裁剪
  const canRefund = hasPerm('admin.orders.refund');

  // AF-14：导出当前筛选下的全部订单（pageSize=200 分页拉取，上限 1 万条）
  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    setExporting(true);
    try {
      const orders = await fetchAllOrders(toOrderQuery({ ...filters, page: 1, pageSize: 1 }));
      downloadTextFile(buildOrdersCsvFilename(), buildOrdersCsv(orders));
      void message.success(`已导出 ${orders.length.toLocaleString('zh-CN')} 条订单`);
    } finally {
      setExporting(false);
    }
  };

  const applyQ = () => {
    setFilters({ q: draftQ.trim() || undefined });
  };

  const columns: ColumnsType<Order> = [
    {
      title: '订单号',
      dataIndex: 'orderNo',
      width: 175,
      render: (value: string) => (
        <span className={`${styles.monoCell} ${styles.strongCell}`}>{value}</span>
      ),
    },
    { title: '用户', dataIndex: 'userLabel', width: 130 },
    { title: '套餐', dataIndex: 'planLabel', width: 130 },
    {
      title: '渠道',
      dataIndex: 'channel',
      width: 90,
      render: (value: PaymentChannel) => channelLabel[value],
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 100,
      align: 'right',
      render: (value: number) => <span className={styles.money}>{fmtMoney(value)}</span>,
    },
    {
      title: '退款',
      dataIndex: 'refundAmount',
      width: 100,
      align: 'right',
      render: (value: number | null) => (
        <span className={styles.moneyPlain}>{fmtMoney(value)}</span>
      ),
    },
    {
      title: '支付时间',
      dataIndex: 'paidAt',
      width: 110,
      render: (value: string | null) => (
        <span className={styles.monoCell}>{value ? dayjs(value).format('MM-DD HH:mm') : '—'}</span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (_: unknown, record) => {
        const display = orderDisplayStatus(record);
        return <StatusTag tone={display.tone}>{display.label}</StatusTag>;
      },
    },
    {
      title: '操作',
      dataIndex: 'orderNo',
      width: 140,
      render: (_: string, record) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Button size="small" onClick={() => setDetailNo(record.orderNo)}>
            详情
          </Button>
          {record.status === 'paid' ? (
            <Tooltip title={canRefund ? '' : '缺少权限'}>
              <span>
                <Button
                  danger
                  size="small"
                  style={{ marginLeft: 6 }}
                  disabled={!canRefund}
                  onClick={() => setRefundTarget(record)}
                >
                  退款
                </Button>
              </span>
            </Tooltip>
          ) : null}
          {record.status === 'pending' ? (
            <Button
              size="small"
              disabled
              style={{ marginLeft: 6 }}
              title="自动关单将在后续版本提供"
            >
              关闭
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="订单与支付"
        description="订单与退款流水 · 支持按状态/渠道/时间筛选 · 退款等敏感操作写入审计日志"
      />

      <Card styles={{ body: { padding: 0 } }}>
        <Tabs
          className={styles.tabs}
          activeKey={filters.status ?? 'all'}
          onChange={(key) => setFilters({ status: key as OrderStatusFilter })}
          items={STATUS_TABS.map((tab, index) => ({
            key: tab.key,
            label: (
              <span>
                {tab.label}{' '}
                <span className={styles.tabCount}>{countQueries[index]?.data?.total ?? 0}</span>
              </span>
            ),
          }))}
        />

        <div className={styles.filterBar}>
          <Input
            style={{ width: 230 }}
            placeholder="订单号 / 第三方流水号"
            allowClear
            value={draftQ}
            onChange={(e) => {
              setDraftQ(e.target.value);
              if (!e.target.value) setFilters({ q: undefined });
            }}
            onPressEnter={applyQ}
          />
          <Select<PaymentChannel | 'all'>
            style={{ width: 130 }}
            value={filters.channel ?? 'all'}
            onChange={(value) => setFilters({ channel: value })}
            options={CHANNEL_OPTIONS}
          />
          <Select<'7d' | '30d'>
            style={{ width: 140 }}
            value={filters.range ?? '7d'}
            onChange={(value) => setFilters({ range: value })}
            options={RANGE_OPTIONS}
          />
          <Button style={{ marginLeft: 'auto' }} onClick={() => setReconcileOpen(true)}>
            对账报告
          </Button>
          {/* AF-14：导出已接线（此前为「后续版本提供」占位） */}
          <Button loading={exporting} onClick={() => void handleExport()}>
            导出
          </Button>
        </div>

        <Table<Order>
          size="middle"
          columns={columns}
          {...tableProps}
          rowKey="orderNo"
          onRow={(record) => ({
            onClick: (e) => {
              const target = e.target as HTMLElement;
              if (target.closest('button') || target.closest('input')) return;
              setDetailNo(record.orderNo);
            },
            style: { cursor: 'pointer' },
          })}
        />
      </Card>

      <OrderDetailModal
        open={Boolean(detailNo)}
        orderNo={detailNo}
        onClose={() => setDetailNo(null)}
      />

      <RefundModal
        open={Boolean(refundTarget)}
        order={refundTarget}
        confirmLoading={refundMutation.isPending}
        onCancel={() => setRefundTarget(null)}
        onConfirm={(amount, reason) =>
          refundMutation.mutateAsync({
            orderNo: refundTarget?.orderNo ?? '',
            payload: { amount, reason },
          })
        }
      />

      <ReconciliationModal open={reconcileOpen} onClose={() => setReconcileOpen(false)} />
    </>
  );
}
