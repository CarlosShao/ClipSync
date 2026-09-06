import { Modal, Skeleton, Timeline } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getOrder } from '@/api/orders';
import { StatusTag } from '@/components/StatusTag';
import { channelLabel, orderDisplayStatus } from '@/components/StatusTag/mappers';
import { fmtMoney, fmtTime } from '@/utils/format';
import type { Order } from '@/api/types';
import styles from './OrderDetailModal.module.css';

interface OrderDetailModalProps {
  open: boolean;
  orderNo: string | null;
  onClose: () => void;
}

interface TimelineEntry {
  color: string;
  children: ReactNode;
}

/** 状态时间线：创建 → 支付/失败/关闭 → 退款（按订单字段推导，无额外接口） */
function buildOrderTimeline(order: Order): TimelineEntry[] {
  const items: TimelineEntry[] = [
    {
      color: 'green',
      children: (
        <>
          创建订单 <span className={styles.tlTime}>{fmtTime(order.createdAt)}</span>
        </>
      ),
    },
  ];

  if (order.paidAt) {
    items.push({
      color: 'green',
      children: (
        <>
          支付成功 <span className={styles.tlTime}>{fmtTime(order.paidAt)}</span>
        </>
      ),
    });
  } else if (order.status === 'failed') {
    items.push({ color: 'red', children: <>支付失败（渠道侧未完成扣款）</> });
  } else if (order.status === 'cancelled') {
    items.push({ color: 'gray', children: <>订单关闭（超时未支付）</> });
  } else {
    items.push({ color: 'gray', children: <>等待支付</> });
  }

  if (order.status === 'refunded') {
    items.push(
      order.refundAmount === null
        ? { color: '#d97706', children: <>退款处理中（已受理，等待渠道退回）</> }
        : {
            color: 'green',
            children: (
              <>
                退款完成 <span className={styles.tlTime}>{fmtMoney(order.refundAmount)}</span>
              </>
            ),
          },
    );
  }

  return items;
}

/** 订单详情弹窗（T-A4）：全字段 + 状态时间线，数据走 GET /admin/orders/:orderNo */
export function OrderDetailModal({ open, orderNo, onClose }: OrderDetailModalProps) {
  const { data, isLoading } = useQuery({
    // queryKeys 工厂未提供订单详情键，沿用域前缀 ['orders', ...] 以便退款后随前缀一起失效
    queryKey: ['orders', 'detail', orderNo],
    queryFn: () => getOrder(orderNo as string),
    enabled: open && Boolean(orderNo),
  });

  const status = data ? orderDisplayStatus(data) : null;

  return (
    <Modal
      open={open}
      title="订单详情"
      footer={null}
      onCancel={onClose}
      width={480}
      destroyOnHidden
    >
      {isLoading || !data ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : (
        <>
          <div className={styles.header}>
            <span className={`${styles.orderNo} mono`}>{data.orderNo}</span>
            {status ? <StatusTag tone={status.tone}>{status.label}</StatusTag> : null}
          </div>
          <dl className={styles.kv}>
            <dt>用户</dt>
            <dd>
              {data.userLabel} <span className={styles.dim}>{data.userId}</span>
            </dd>
            <dt>套餐</dt>
            <dd>{data.planLabel}</dd>
            <dt>渠道</dt>
            <dd>{channelLabel[data.channel]}</dd>
            <dt>商户单号</dt>
            <dd className="mono">{data.outTradeNo}</dd>
            <dt>第三方流水号</dt>
            <dd className="mono">{data.transactionId ?? '—'}</dd>
            <dt>币种</dt>
            <dd>{data.currency}</dd>
            <dt>金额</dt>
            <dd className={styles.money}>{fmtMoney(data.amount)}</dd>
            <dt>已退款</dt>
            <dd>{fmtMoney(data.refundAmount)}</dd>
            <dt>创建时间</dt>
            <dd>{fmtTime(data.createdAt)}</dd>
            <dt>支付时间</dt>
            <dd>{fmtTime(data.paidAt)}</dd>
          </dl>
          <div className={styles.sectTitle}>状态时间线</div>
          <Timeline
            items={buildOrderTimeline(data).map((item) => ({ color: item.color, children: item.children }))}
          />
        </>
      )}
    </Modal>
  );
}
