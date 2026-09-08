import dayjs, { type Dayjs } from 'dayjs';
import { channelLabel, orderDisplayStatus } from '@/components/StatusTag/mappers';
import type { Order } from '@/api/types';

const CSV_HEADERS = [
  '订单号',
  '用户',
  '套餐',
  '渠道',
  '金额',
  '已退款',
  '创建时间',
  '支付时间',
  '状态',
];

/** CSV 单元格转义（与 auditCsv.ts 同规则：双引号包裹 + 内部引号翻倍） */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** 订单列表 → CSV 文本（含 BOM 头，Excel 直开不乱码；行尾 CRLF） */
export function buildOrdersCsv(orders: Order[]): string {
  const lines = [CSV_HEADERS.join(',')];
  for (const order of orders) {
    lines.push(
      [
        order.orderNo,
        order.userLabel,
        order.planLabel,
        channelLabel[order.channel] ?? order.channel,
        order.amount.toFixed(2),
        order.refundAmount != null ? order.refundAmount.toFixed(2) : '',
        order.createdAt,
        order.paidAt ?? '',
        orderDisplayStatus(order).label,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

/** 导出文件名：orders-YYYYMMDD.csv */
export function buildOrdersCsvFilename(now: Dayjs = dayjs()): string {
  return `orders-${now.format('YYYYMMDD')}.csv`;
}

export { downloadTextFile } from '@/utils/download';
