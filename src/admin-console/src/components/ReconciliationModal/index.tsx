import { Modal, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useQuery } from '@tanstack/react-query';
import { getReconciliation } from '@/api/orders';
import { fmtMoney } from '@/utils/format';
import type { ReconciliationRow } from '@/api/types';
import styles from './ReconciliationModal.module.css';

const COLUMNS: ColumnsType<ReconciliationRow> = [
  {
    title: '渠道',
    dataIndex: 'label',
    render: (value: string) => <strong>{value}</strong>,
  },
  {
    title: '笔数',
    dataIndex: 'paidCount',
    width: 90,
    align: 'right',
    render: (value: number) => <span className="num">{value.toLocaleString('zh-CN')}</span>,
  },
  {
    title: '成交额',
    dataIndex: 'paidAmount',
    width: 130,
    align: 'right',
    render: (value: number) => <span className={`${styles.money} num`}>{fmtMoney(value)}</span>,
  },
  {
    title: '退款额',
    dataIndex: 'refundAmount',
    width: 120,
    align: 'right',
    render: (value: number) => <span className="num">{fmtMoney(value)}</span>,
  },
];

/**
 * 对账报告弹窗（T-A4）：微信 / 支付宝 / Stripe 三行汇总，数据走 GET /admin/reconciliation。
 *
 * ⚠️ 口径（对照服务端 routes/admin/orders.js 的 reconciliationRouter，2026-09-19 核对）：
 * 数字来自**本站 payment_orders** 按渠道聚合的近 30 天 paid/refunded 订单
 * （成交额按 paid_at 归日，退款额取 metadata.refund_amount 同样归到支付当日），
 * generatedAt 是**本次请求的服务器时刻**——不是渠道日终对账文件，也不是凌晨快照。
 * 故本报告仅供运营自查，不能当作与支付宝账单的核销依据（差异需另行人工核对）。
 */
export function ReconciliationModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['reconciliation'],
    queryFn: getReconciliation,
    enabled: open,
  });

  const totals = data?.rows.reduce(
    (acc, row) => ({
      paidCount: acc.paidCount + row.paidCount,
      paidAmount: acc.paidAmount + row.paidAmount,
      refundAmount: acc.refundAmount + row.refundAmount,
    }),
    { paidCount: 0, paidAmount: 0, refundAmount: 0 },
  );

  return (
    <Modal open={open} title="对账报告" footer={null} onCancel={onClose} width={560}>
      <Table<ReconciliationRow>
        size="small"
        rowKey="channel"
        columns={COLUMNS}
        dataSource={data?.rows ?? []}
        loading={isLoading}
        pagination={false}
      />
      <div className={styles.note}>
        {totals ? (
          <p className={styles.total}>
            合计 <span className="num">{totals.paidCount}</span> 笔 · 成交{' '}
            <span className="num">{fmtMoney(totals.paidAmount)}</span> · 退款{' '}
            <span className="num">{fmtMoney(totals.refundAmount)}</span>
          </p>
        ) : null}
        快照生成于 {data?.generatedAt ?? '—'} · 口径：本站订单表近 30 天聚合（按支付日期归属），
        非渠道对账单核销依据
      </div>
    </Modal>
  );
}
