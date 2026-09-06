import { describe, expect, it } from 'vitest';
import { fmtMoney, maskPhone, relativeTime } from '@/utils/format';

describe('fmtMoney', () => {
  it('千分位 + 两位小数 + ¥ 前缀', () => {
    expect(fmtMoney(426.6)).toBe('¥426.60');
    expect(fmtMoney(1788)).toBe('¥1,788.00');
    expect(fmtMoney(0)).toBe('¥0.00');
    expect(fmtMoney(1234567.891)).toBe('¥1,234,567.89');
  });

  it('空值显示 —', () => {
    expect(fmtMoney(null)).toBe('—');
    expect(fmtMoney(undefined)).toBe('—');
  });
});

describe('maskPhone', () => {
  it('11 位手机号打码', () => {
    expect(maskPhone('13812342765')).toBe('138****2765');
  });

  it('已是打码格式则原样返回', () => {
    expect(maskPhone('138****2765')).toBe('138****2765');
    expect(maskPhone('+44****9201')).toBe('+44****9201');
  });
});

describe('relativeTime', () => {
  it('空值显示 —', () => {
    expect(relativeTime(null)).toBe('—');
    expect(relativeTime(undefined)).toBe('—');
  });

  it('过去时间输出相对描述', () => {
    const result = relativeTime(new Date(Date.now() - 8 * 60 * 1000).toISOString());
    expect(result).toContain('8 分钟前');
  });
});
