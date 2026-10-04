import { Alert, Modal, Skeleton, Timeline } from 'antd';
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
    // M6 之后 cancelled 至少有两条来源，笼统写「超时未支付」会把渠道关单
    // 说成用户没付钱（进而误导运营按"用户忘了付"处理），故按留痕标记分流
    items.push({
      color: 'gray',
      children:
        order.autoClosed === 'timeout_unpaid' ? (
          <>订单关闭（超时未支付，服务端自动关单）</>
        ) : order.closedByChannel ? (
          <>渠道关单（支付宝 TRADE_CLOSED 通知，渠道侧交易已关闭）</>
        ) : (
          <>订单关闭（无关闭原因留痕，属历史数据）</>
        ),
    });
  } else {
    items.push({
      color: 'gray',
      children: order.channelReportsPaid ? (
        <>本地等待支付（渠道侧已报告付款，见上方异常到账告警）</>
      ) : (
        <>等待支付</>
      ),
    });
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
          {/*
            异常到账（H2）：orderCloseSweep 查渠道时发现「渠道已付款、本地仍 pending」，
            于是**没有关单**并打上 metadata.channel_reports_paid。这是最容易变成
            客诉 + 对账不平的一类单（钱收了、货没给），必须比状态标签更显眼，
            且即便订单不是 cancelled/refunded 也要提示。
          */}
          {data.channelReportsPaid ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message="异常到账：渠道已付款，但本地订单未履约"
              description="渠道侧确认收到款项，本地订单却仍是「待支付」（钱收了、货没给）。请立即核对：能履约就补履约，不能履约必须在支付宝商户后台原路退款后再人工核账；切勿直接关单。"
            />
          ) : null}
          <dl className={styles.kv}>
            <dt>用户</dt>
            <dd>
              {data.userLabel} <span className={styles.dim}>{data.userId}</span>
            </dd>
            <dt>套餐</dt>
            <dd>{data.planLabel}</dd>
            <dt>渠道</dt>
            <dd>{channelLabel[data.channel]}</dd>
            {/*
              商户单号（out_trade_no）：后端 create-order 从不写 payment_orders.out_trade_no，
              真实支付宝单的商户单号就是 order_no（buildPagePayUrl 以 out_trade_no=order_no 下单），
              故空值回退「—」而非留白；要按商户单号检索可直接用订单号列。
            */}
            <dt>商户单号</dt>
            <dd className="mono">{data.outTradeNo || '—'}</dd>
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
