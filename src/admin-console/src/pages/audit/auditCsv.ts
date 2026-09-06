import dayjs, { type Dayjs } from 'dayjs';
import type { AuditLog } from '@/api/types';

const CSV_HEADERS = ['时间', '操作者', '角色', '动作', '资源类型', '资源 ID', '详情', 'IP', '结果'];

const ROLE_LABELS: Record<string, string> = {
  super_admin: '超管',
  admin: '管理员',
  user: '终端用户',
};

/** CSV 单元格转义：包裹双引号并转义内部引号，防逗号/换行/注入 */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** 审计日志 → CSV 文本（含 BOM 头，Excel 直开不乱码；行尾 CRLF） */
export function buildAuditCsv(logs: AuditLog[]): string {
  const lines = [CSV_HEADERS.join(',')];
  for (const log of logs) {
    lines.push(
      [
        log.createdAt,
        log.operator,
        ROLE_LABELS[log.operatorRole ?? ''] ?? '',
        log.action,
        log.resourceType,
        log.resourceId,
        log.details,
        log.ipAddress,
        log.status === 'success' ? '成功' : '失败',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

/** 导出文件名：audit-YYYYMMDD.csv（按导出当日日期） */
export function buildAuditCsvFilename(now: Dayjs = dayjs()): string {
  return `audit-${now.format('YYYYMMDD')}.csv`;
}

/** 触发浏览器下载（Blob + 隐形 <a>） */
export function downloadTextFile(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
