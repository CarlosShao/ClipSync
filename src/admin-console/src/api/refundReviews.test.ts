/**
 * 退款审核失败提示（api/refundReviews.ts#refundReviewFailureHint）单测
 *
 * 锁 H3 冷却分支的接线：服务端在 REFUND_REQUEST_PROCESSING 的响应体里带
 * retryAfterSeconds（还差几秒可重试），提示必须把它用进去 —— 否则运营只能看到
 * 「请等约 2 分钟」这种无依据的估算，而真正剩余时间只有服务端知道。
 */
import { describe, expect, it } from 'vitest';
import { refundReviewFailureHint } from '@/api/refundReviews';

/** 构造 axios 形态的业务失败（拦截器 reject 的就是这个对象） */
function apiFailure(data: Record<string, unknown>): unknown {
  return { response: { status: 409, data } };
}

describe('refundReviewFailureHint —— 审核失败行内提示', () => {
  it('REFUND_REQUEST_PROCESSING 带 retryAfterSeconds → 提示用上确切秒数', () => {
    const hint = refundReviewFailureHint(
      apiFailure({
        code: 40904,
        message: '该申请正在处理中，请稍后重试',
        refundCode: 'REFUND_REQUEST_PROCESSING',
        status: 'processing',
        orderNo: 'ORD-X',
        retryAfterSeconds: 42,
      })
    );

    expect(hint).toContain('42');
    expect(hint).toContain('对账并重试');
  });

  it('拿不到 retryAfterSeconds → 回落到 FAILURE_HINTS 的通用文案', () => {
    const hint = refundReviewFailureHint(
      apiFailure({
        code: 40904,
        message: '该申请正在处理中，请稍后重试',
        refundCode: 'REFUND_REQUEST_PROCESSING',
      })
    );

    expect(hint).toContain('正在处理中');
    expect(hint).toContain('审核备注');
  });

  it('retryAfterSeconds 非法（0 / 负数 / 非数字）时按拿不到处理，不出现 undefined 秒', () => {
    for (const bad of [0, -3, 'soon', null]) {
      const hint = refundReviewFailureHint(
        apiFailure({ refundCode: 'REFUND_REQUEST_PROCESSING', retryAfterSeconds: bad })
      );
      expect(hint).not.toContain('undefined');
      expect(hint).toContain('正在处理中');
    }
  });

  it('字符串业务码走 FAILURE_HINTS；未知码回落服务端 message', () => {
    expect(refundReviewFailureHint(apiFailure({ code: 'ALREADY_REFUNDED' }))).toContain(
      '该订单已完成退款'
    );
    expect(refundReviewFailureHint(apiFailure({ code: 'WEIRD_NEW_CODE', message: '新校验未通过' }))).toBe(
      '新校验未通过'
    );
    // 连 message 都没有时的兜底
    expect(refundReviewFailureHint({})).toContain('请核对最新状态后重试');
  });
});
