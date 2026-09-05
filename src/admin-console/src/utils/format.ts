import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import dayjsRelativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(dayjsRelativeTime);
dayjs.locale('zh-cn');

/** 金额：千分位 + 两位小数 + ¥ 前缀；空值显示 — */
export function fmtMoney(amount: number | null | undefined, symbol = '¥'): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';
  return `${symbol}${amount.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** 时间：YYYY-MM-DD HH:mm；空值显示 — */
export function fmtTime(input?: string | null): string {
  if (!input) return '—';
  const d = dayjs(input);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : input;
}

/** 日期：YYYY-MM-DD */
export function fmtDate(input?: string | null): string {
  if (!input) return '—';
  const d = dayjs(input);
  return d.isValid() ? d.format('YYYY-MM-DD') : input;
}

/** 手机号打码：13812342765 → 138****2765；已是打码格式则原样返回 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && !phone.includes('*')) {
    return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  }
  return phone;
}

/** 相对时间：8 分钟前 / 3 天前 */
export function relativeTime(input?: string | null): string {
  if (!input) return '—';
  const d = dayjs(input);
  return d.isValid() ? d.fromNow() : input;
}
